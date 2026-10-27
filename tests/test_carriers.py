"""Carrier tracking: parsing each carrier's reply, and the admin endpoints (carriers mocked)."""
import io
import os
import unittest
from unittest import mock

from tests.test_app import ADMIN, AUTH, MEMBER, PNG
import carriers
import main


class ParseTest(unittest.TestCase):
    def test_fedex_in_transit(self):
        # Shape of a real FedEx Track API result (trackResults[0]).
        result = carriers.parse_fedex({
            "latestStatusDetail": {"code": "PU", "derivedCode": "HP", "statusByLocale": "We have your package",
                                   "scanLocation": {"city": "PLAINFIELD", "stateOrProvinceCode": "IN"}},
            "dateAndTimes": [{"type": "ESTIMATED_DELIVERY", "dateTime": "2026-10-29T20:00:00-04:00"}],
            "scanEvents": [{"date": "2026-10-27T18:21:18-04:00", "eventDescription": "Picked up",
                            "scanLocation": {"city": "PLAINFIELD", "stateOrProvinceCode": "IN"}}],
        })
        self.assertEqual((result["status"], result["label"], result["location"]), ("transit", "We have your package", "Plainfield, IN"))
        self.assertEqual(result["estimatedDelivery"], "2026-10-29T20:00:00-04:00")
        self.assertEqual(result["events"][0]["description"], "Picked up")

    def test_fedex_delivered_and_not_found(self):
        delivered = carriers.parse_fedex({
            "latestStatusDetail": {"derivedCode": "DL", "statusByLocale": "Delivered"},
            "dateAndTimes": [{"type": "ACTUAL_DELIVERY", "dateTime": "2026-10-28T14:02:00-04:00"}],
        })
        self.assertEqual((delivered["status"], delivered["deliveredAt"]), ("delivered", "2026-10-28T14:02:00-04:00"))
        missing = carriers.parse_fedex({"error": {"code": "TRACKING.TRACKINGNUMBER.NOTFOUND"}})
        self.assertEqual(missing["status"], "not_found")

    def test_ups(self):
        result = carriers.parse_ups({"trackResponse": {"shipment": [{"package": [{
            "currentStatus": {"description": "Out For Delivery Today", "code": "OT"},
            "deliveryDate": [{"type": "SDD", "date": "20261028"}],
            "activity": [
                {"location": {"address": {"city": "SAN JOSE", "stateProvince": "CA"}},
                 "status": {"type": "I", "description": "Out For Delivery Today"}, "date": "20261028", "time": "071500"},
                {"location": {"address": {"city": "OAKLAND", "stateProvince": "CA"}},
                 "status": {"type": "I", "description": "Arrived at Facility"}, "date": "20261027", "time": "220000"},
            ]}]}]}})
        self.assertEqual((result["status"], result["location"], result["estimatedDelivery"]),
                         ("out_for_delivery", "San Jose, CA", "2026-10-28"))
        self.assertEqual(result["events"][1]["at"], "2026-10-27T22:00:00")
        delivered = carriers.parse_ups({"trackResponse": {"shipment": [{"package": [{
            "deliveryDate": [{"type": "DEL", "date": "20261028"}], "deliveryTime": {"endTime": "141500"},
            "activity": [{"status": {"type": "D", "description": "DELIVERED"}, "date": "20261028", "time": "141500"}]}]}]}})
        self.assertEqual((delivered["status"], delivered["deliveredAt"], delivered["label"]),
                         ("delivered", "2026-10-28T14:15:00", "Delivered"))
        self.assertEqual(carriers.parse_ups({})["status"], "not_found")

    def test_usps(self):
        result = carriers.parse_usps({
            "trackingNumber": "9400100000000000000000", "statusCategory": "Delivered", "status": "Delivered, In/At Mailbox",
            "trackingEvents": [{"eventType": "Delivered, In/At Mailbox", "eventTimestamp": "2026-10-28T13:05:00",
                                "eventCity": "FRESNO", "eventState": "CA"}],
        })
        self.assertEqual((result["status"], result["deliveredAt"], result["location"]),
                         ("delivered", "2026-10-28T13:05:00", "Fresno, CA"))

    def test_unconfigured_or_unsupported_carriers_say_why(self):
        with mock.patch.dict(os.environ, {"FEDEX_TRACK_API_KEY": "", "FEDEX_TRACK_SECRET": ""}):
            with self.assertRaisesRegex(carriers.CarrierUnavailable, "isn't set up"):
                carriers.track("FedEx", "123")
        with self.assertRaisesRegex(carriers.CarrierUnavailable, "isn't available for this carrier"):
            carriers.track("Other", "123")


TRANSIT = {"status": "transit", "label": "In transit", "location": "Memphis, TN", "deliveredAt": None,
           "estimatedDelivery": None, "events": [], "carrier": "FedEx", "checkedAt": "2026-01-01T10:00:00+00:00"}


class TrackingEndpointTest(unittest.TestCase):
    def setUp(self):
        self.client = main.app.test_client()
        main.PRODUCTS_FILE.unlink(missing_ok=True)
        main.ORDERS_FILE.unlink(missing_ok=True)

    def shipped_order(self, carrier="FedEx"):
        order_id = self.client.post("/api/orders", headers=AUTH, json={"items": [{"id": "want-151-mini-tin", "quantity": 1}]}).get_json()["id"]
        self.client.post("/api/shipments", headers=AUTH, data={
            "orderId": order_id, "carrier": carrier, "tracking": "123456789012",
            "before": (io.BytesIO(PNG), "b.png"), "after": (io.BytesIO(PNG), "a.png")})
        return order_id

    def test_update_tracking_saves_status_for_admin_and_member(self):
        order_id = self.shipped_order()
        with mock.patch.object(carriers, "track", return_value=dict(TRANSIT)) as track:
            order = self.client.post(f"/api/admin/orders/{order_id}/tracking", headers=ADMIN).get_json()
        track.assert_called_once_with("FedEx", "123456789012")
        self.assertEqual(order["carrierStatus"]["location"], "Memphis, TN")
        member_view = self.client.get("/api/orders", headers=AUTH).get_json()["orders"][0]
        self.assertEqual(member_view["carrierStatus"]["status"], "transit")
        self.assertEqual(self.client.post(f"/api/admin/orders/{order_id}/tracking", headers=MEMBER).status_code, 403)

    def test_failed_check_keeps_last_status_and_says_why(self):
        order_id = self.shipped_order()
        with mock.patch.object(carriers, "track", return_value=dict(TRANSIT)):
            self.client.post(f"/api/admin/orders/{order_id}/tracking", headers=ADMIN)
        with mock.patch.object(carriers, "track", side_effect=carriers.CarrierUnavailable("FedEx is down")):
            order = self.client.post(f"/api/admin/orders/{order_id}/tracking", headers=ADMIN).get_json()
        self.assertEqual((order["carrierStatus"]["location"], order["carrierStatus"]["error"]), ("Memphis, TN", "FedEx is down"))

    def test_refresh_all_only_checks_packages_on_the_way(self):
        on_the_way = self.shipped_order()
        received = self.shipped_order()
        self.client.patch(f"/api/admin/orders/{received}", headers=ADMIN, json={"status": "received"})
        self.client.post("/api/orders", headers=AUTH, json={"items": [{"id": "want-151-mini-tin", "quantity": 1}]})  # not shipped

        with mock.patch.object(carriers, "track", return_value=dict(TRANSIT)) as track:
            result = self.client.post("/api/admin/tracking/refresh", headers=ADMIN).get_json()
        self.assertEqual((result["checked"], result["failed"], track.call_count), (1, 0, 1))
        self.assertIn("carrierStatus", next(o for o in result["orders"] if o["id"] == on_the_way))

    def test_order_without_tracking_is_refused(self):
        order_id = self.client.post("/api/orders", headers=AUTH, json={"items": [{"id": "want-151-mini-tin", "quantity": 1}]}).get_json()["id"]
        self.assertEqual(self.client.post(f"/api/admin/orders/{order_id}/tracking", headers=ADMIN).status_code, 400)


if __name__ == "__main__":
    unittest.main()
