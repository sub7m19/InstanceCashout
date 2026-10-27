"""Live package status from the FedEx, UPS and USPS tracking APIs, in one shape for the site.

Each carrier needs its own API keys in the settings file. A carrier without keys, or whose
keys don't have tracking access yet, raises CarrierUnavailable with a message for the admin.

Every result looks like:
    {"status": "transit", "label": "In transit", "location": "Memphis, TN",
     "deliveredAt": None, "estimatedDelivery": "2026-10-29", "events": [...],
     "carrier": "FedEx", "checkedAt": "..."}
where status is one of: label, transit, out_for_delivery, delivered, exception, not_found.
"""
import base64
import os
import threading
import time
import uuid
from datetime import datetime, timezone

import requests

FEDEX_BASE = "https://apis.fedex.com"
UPS_BASE = "https://onlinetools.ups.com"
USPS_BASE = "https://api.usps.com"
MAX_EVENTS = 30


class CarrierUnavailable(Exception):
    """Tracking can't be checked with this carrier right now; the message says why."""


def configured(carrier):
    keys = {
        "FedEx": ("FEDEX_TRACK_API_KEY", "FEDEX_TRACK_SECRET"),
        "UPS": ("UPS_TRACK_CLIENT_ID", "UPS_TRACK_CLIENT_SECRET"),
        "USPS": ("USPS_CLIENT_ID", "USPS_CLIENT_SECRET"),
    }.get(carrier)
    return bool(keys) and all(os.environ.get(key) for key in keys)


def track(carrier, number):
    """The current status of one package, or CarrierUnavailable."""
    lookup = {"FedEx": _fedex, "UPS": _ups, "USPS": _usps}.get(carrier)
    if not lookup:
        raise CarrierUnavailable("Live tracking isn't available for this carrier. Use the tracking link instead.")
    if not configured(carrier):
        raise CarrierUnavailable(f"{carrier} tracking isn't set up yet: its API keys aren't in the settings file.")
    try:
        result = lookup(number)
    except CarrierUnavailable:
        raise
    except (requests.RequestException, KeyError, IndexError, TypeError, ValueError) as error:
        raise CarrierUnavailable(f"Couldn't reach {carrier} tracking right now. Try again in a few minutes.") from error
    result["events"] = result.get("events", [])[:MAX_EVENTS]
    result.update(carrier=carrier, checkedAt=datetime.now(timezone.utc).isoformat())
    return result


# OAuth tokens last about an hour. Reusing them matters: FedEx briefly blocks servers that ask
# for new tokens too often.

_tokens = {}
_token_lock = threading.Lock()


def _token(carrier, fetch):
    with _token_lock:
        token, expires = _tokens.get(carrier, (None, 0))
        if token and time.time() < expires - 60:
            return token
        data = fetch()
        _tokens[carrier] = (data["access_token"], time.time() + int(data.get("expires_in", 3600)))
        return data["access_token"]


def _forget_token(carrier):
    with _token_lock:
        _tokens.pop(carrier, None)


def _place(city, state):
    city = (city or "").strip().title()
    state = (state or "").strip().upper()
    return ", ".join(part for part in (city, state) if part)


# FedEx: Basic Integrated Visibility (Track API)

FEDEX_STATUS = {
    "DL": "delivered",
    "OD": "out_for_delivery",
    "IN": "label", "OC": "label",
    "DE": "exception", "SE": "exception", "CA": "exception", "RS": "exception", "DY": "exception",
}


def _fedex(number):
    def fetch():
        response = requests.post(f"{FEDEX_BASE}/oauth/token", timeout=15, data={
            "grant_type": "client_credentials",
            "client_id": os.environ["FEDEX_TRACK_API_KEY"],
            "client_secret": os.environ["FEDEX_TRACK_SECRET"],
        })
        if response.status_code in (401, 403):
            raise CarrierUnavailable("FedEx didn't accept the tracking keys. They must be the project's production keys.")
        response.raise_for_status()
        return response.json()

    response = requests.post(
        f"{FEDEX_BASE}/track/v1/trackingnumbers",
        json={"includeDetailedScans": True, "trackingInfo": [{"trackingNumberInfo": {"trackingNumber": number}}]},
        headers={"Authorization": f"Bearer {_token('FedEx', fetch)}", "X-locale": "en_US"},
        timeout=20,
    )
    if response.status_code in (401, 403):
        _forget_token("FedEx")
        raise CarrierUnavailable("FedEx refused the tracking request. Check the project includes Basic Integrated Visibility.")
    response.raise_for_status()
    return parse_fedex(response.json()["output"]["completeTrackResults"][0]["trackResults"][0])


def parse_fedex(result):
    if result.get("error"):
        return {"status": "not_found", "label": "Not in FedEx's system yet", "location": "", "deliveredAt": None,
                "estimatedDelivery": None, "events": []}

    latest = result.get("latestStatusDetail") or {}
    code = latest.get("derivedCode") or latest.get("code") or ""
    status = FEDEX_STATUS.get(code, "transit")
    times = {entry.get("type"): entry.get("dateTime") for entry in result.get("dateAndTimes") or []}
    window = ((result.get("estimatedDeliveryTimeWindow") or {}).get("window") or {})
    scan = latest.get("scanLocation") or {}

    events = []
    for event in result.get("scanEvents") or []:
        place = event.get("scanLocation") or {}
        description = event.get("eventDescription") or event.get("derivedStatus") or ""
        if event.get("exceptionDescription"):
            description = f"{description}: {event['exceptionDescription']}"
        events.append({"at": event.get("date"), "description": description,
                       "location": _place(place.get("city"), place.get("stateOrProvinceCode"))})

    return {
        "status": status,
        "label": latest.get("statusByLocale") or latest.get("description") or "In transit",
        "location": _place(scan.get("city"), scan.get("stateOrProvinceCode")),
        "deliveredAt": times.get("ACTUAL_DELIVERY") if status == "delivered" else None,
        "estimatedDelivery": times.get("ESTIMATED_DELIVERY") or window.get("ends"),
        "events": events,
    }


# UPS: Tracking API (included with every UPS developer subscription tier)

def _ups(number):
    def fetch():
        credentials = f"{os.environ['UPS_TRACK_CLIENT_ID']}:{os.environ['UPS_TRACK_CLIENT_SECRET']}"
        response = requests.post(f"{UPS_BASE}/security/v1/oauth/token", timeout=15,
                                 data={"grant_type": "client_credentials"},
                                 headers={"Authorization": f"Basic {base64.b64encode(credentials.encode()).decode()}"})
        if response.status_code in (401, 403):
            raise CarrierUnavailable("UPS didn't accept the tracking keys.")
        response.raise_for_status()
        return response.json()

    response = requests.get(
        f"{UPS_BASE}/api/track/v1/details/{number}",
        params={"locale": "en_US", "returnSignature": "false"},
        headers={"Authorization": f"Bearer {_token('UPS', fetch)}",
                 "transId": uuid.uuid4().hex[:32], "transactionSrc": "InstanceCashout"},
        timeout=20,
    )
    if response.status_code in (401, 403):
        _forget_token("UPS")
        raise CarrierUnavailable("UPS hasn't enabled tracking for this app yet. Check its subscription tier in the UPS developer portal.")
    if response.status_code == 404:
        return parse_ups({})
    response.raise_for_status()
    return parse_ups(response.json())


def _ups_time(date, time_of_day=""):
    if not date or len(date) != 8:
        return None
    stamp = f"{date[:4]}-{date[4:6]}-{date[6:]}"
    if time_of_day and len(time_of_day) >= 4:
        stamp += f"T{time_of_day[:2]}:{time_of_day[2:4]}:{time_of_day[4:6] or '00'}"
    return stamp


def parse_ups(data):
    shipments = (data.get("trackResponse") or {}).get("shipment") or []
    packages = (shipments[0].get("package") or []) if shipments else []
    if not packages:
        return {"status": "not_found", "label": "Not in UPS's system yet", "location": "", "deliveredAt": None,
                "estimatedDelivery": None, "events": []}

    package = packages[0]
    activity = package.get("activity") or []
    latest = (activity[0].get("status") or {}) if activity else {}
    current = package.get("currentStatus") or {}
    label = current.get("description") or latest.get("description") or "In transit"
    kind = latest.get("type", "")

    if kind == "D":
        status = "delivered"
    elif kind == "X":
        status = "exception"
    elif kind == "M":
        status = "label"
    elif "out for delivery" in label.lower():
        status = "out_for_delivery"
    else:
        status = "transit"

    events = []
    for entry in activity:
        address = ((entry.get("location") or {}).get("address") or {})
        events.append({"at": _ups_time(entry.get("date"), entry.get("time")),
                       "description": (entry.get("status") or {}).get("description", "").strip(),
                       "location": _place(address.get("city"), address.get("stateProvince"))})

    dates = {entry.get("type"): entry.get("date") for entry in package.get("deliveryDate") or []}
    delivery_time = (package.get("deliveryTime") or {}).get("endTime", "")
    return {
        "status": status,
        "label": label.strip().capitalize() if label.isupper() else label.strip(),
        "location": events[0]["location"] if events else "",
        "deliveredAt": _ups_time(dates.get("DEL"), delivery_time) if status == "delivered" else None,
        "estimatedDelivery": _ups_time(dates.get("SDD") or dates.get("RDD")),
        "events": events,
    }


# USPS: Tracking API v3. Since April 2026 USPS only allows packages under your own mailer ID
# unless you've signed their tracking access agreement, so others' labels may be refused.

USPS_STATUS = {
    "delivered": "delivered",
    "out for delivery": "out_for_delivery",
    "pre-shipment": "label",
    "pre-transit": "label",
    "alert": "exception",
}


def _usps(number):
    def fetch():
        response = requests.post(f"{USPS_BASE}/oauth2/v3/token", timeout=15, data={
            "grant_type": "client_credentials",
            "client_id": os.environ["USPS_CLIENT_ID"],
            "client_secret": os.environ["USPS_CLIENT_SECRET"],
        })
        if response.status_code in (401, 403):
            raise CarrierUnavailable("USPS didn't accept the API keys.")
        response.raise_for_status()
        return response.json()

    response = requests.get(f"{USPS_BASE}/tracking/v3/tracking/{number}", params={"expand": "DETAIL"},
                            headers={"Authorization": f"Bearer {_token('USPS', fetch)}"}, timeout=20)
    if response.status_code == 403:
        raise CarrierUnavailable("USPS hasn't approved tracking for packages shipped by others yet "
                                 "(their tracking access agreement). Use the USPS link for now.")
    if response.status_code == 401:
        _forget_token("USPS")
        raise CarrierUnavailable("USPS didn't accept the API keys.")
    if response.status_code == 404:
        return parse_usps({})
    response.raise_for_status()
    return parse_usps(response.json())


def parse_usps(data):
    if not data.get("trackingNumber") and not data.get("trackingEvents"):
        return {"status": "not_found", "label": "Not in USPS's system yet", "location": "", "deliveredAt": None,
                "estimatedDelivery": None, "events": []}

    category = (data.get("statusCategory") or "").strip().lower()
    status = USPS_STATUS.get(category, "transit")
    events = [{"at": event.get("eventTimestamp"), "description": event.get("eventType", ""),
               "location": _place(event.get("eventCity"), event.get("eventState"))}
              for event in data.get("trackingEvents") or []]

    return {
        "status": status,
        "label": data.get("status") or data.get("statusCategory") or "In transit",
        "location": events[0]["location"] if events else "",
        "deliveredAt": events[0]["at"] if status == "delivered" and events else None,
        "estimatedDelivery": data.get("expectedDeliveryDate"),
        "events": events,
    }
