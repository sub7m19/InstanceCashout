import json
import logging
import logging.handlers
import os
import re
import secrets
import subprocess
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode

import requests
from flask import Flask, abort, jsonify, redirect, request, send_from_directory, session
from waitress import serve

import carriers

SITE_DIR = Path(__file__).resolve().parent


def load_settings_file():
    """Reads KEY=VALUE lines from the settings file into the environment (real env vars win).

    On the server that's C:\\instancecashout\\instancecashout.env, next to the app folder.
    """
    path = Path(os.environ.get("INSTANCE_ENV") or SITE_DIR.parent / "instancecashout.env")
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.partition("=")
        if sep and not key.strip().startswith("#"):
            os.environ.setdefault(key.strip(), value.strip())


load_settings_file()

UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", SITE_DIR / "uploads")).resolve()
DISCORD_API_BASE = "https://discord.com/api/v10"

# Discord sign-in happens on the server (authorization code flow): the browser never sees a
# Discord token, only our own session cookie.
PUBLIC_URL = os.environ.get("PUBLIC_URL", "http://127.0.0.1:8000").rstrip("/")
DISCORD_CLIENT_ID = os.environ.get("DISCORD_CLIENT_ID", "")
DISCORD_CLIENT_SECRET = os.environ.get("DISCORD_CLIENT_SECRET", "")
DISCORD_REDIRECT_URI = f"{PUBLIC_URL}/auth/discord/callback"

# Discord user ids (comma-separated) that get the admin dashboard.
ADMIN_IDS = {part.strip() for part in os.environ.get("ADMIN_DISCORD_IDS", "").split(",") if part.strip()}

# Local testing only: lets "Bearer dev:<id>" stand in for a signed-in user.
DEV_AUTH = os.environ.get("INSTANCE_DEV_AUTH") == "1"

# The buy list members sell from, edited on the admin dashboard. It lives with the uploads so
# the nightly backup covers it; "_catalog" can't clash with a user folder (those are ids).
CATALOG_DIR = UPLOAD_DIR / "_catalog"
PRODUCTS_FILE = CATALOG_DIR / "products.json"
PRODUCT_IMAGE_DIR = CATALOG_DIR / "images"
PRODUCT_IMAGE_PATTERN = re.compile(r"^[0-9a-f]{32}\.(jpg|png|webp)$")
MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024
CATEGORIES = ["Pokemon", "One Piece", "Sealed", "Slabs"]
DEFAULT_PRODUCTS = [
    {"id": "want-151-mini-tin", "name": "Pokemon 151 Mini Tin Collection 10 Pack", "category": "Pokemon",
     "upc": "151151151515", "retailer": "Sam's Club", "retailPrice": 74.98, "cashout": 490, "quantity": 965},
    {"id": "want-prismatic-etb", "name": "Prismatic Evolutions Elite Trainer Box", "category": "Sealed",
     "upc": "196214105195", "retailer": "Pokemon Center", "retailPrice": 54.99, "cashout": 320, "quantity": 2047},
    {"id": "want-destined-rivals", "name": "Pokemon Destined Rivals Booster Box", "category": "Pokemon",
     "upc": "196214111189", "retailer": "Target", "retailPrice": 119.99, "cashout": 330, "quantity": 940},
    {"id": "want-blooming-waters", "name": "Pokemon 151 Blooming Waters Premium Collection", "category": "Sealed",
     "upc": "196214119017", "retailer": "Best Buy", "retailPrice": 59.99, "cashout": 300, "quantity": 4070},
    # Sample products to try the admin dashboard with (made-up prices; edit or delete freely).
    {"id": "sample-surging-sparks-etb", "name": "Surging Sparks Elite Trainer Box", "category": "Sealed",
     "upc": "196214109810", "retailer": "Target", "retailPrice": 49.99, "cashout": 85, "quantity": 300},
    {"id": "sample-op09-booster-box", "name": "One Piece OP-09 Emperors in the New World Booster Box", "category": "One Piece",
     "upc": "810059784553", "retailer": "Bandai", "retailPrice": 107.76, "cashout": 165, "quantity": 120},
    {"id": "sample-op-starter-deck", "name": "One Piece Starter Deck ST-21 Gear 5", "category": "One Piece",
     "upc": "810059785512", "retailer": "Walmart", "retailPrice": 11.99, "cashout": 18, "quantity": 500},
    {"id": "sample-charizard-psa10", "name": "Charizard ex 199/165 PSA 10", "category": "Slabs",
     "upc": "", "retailer": "", "retailPrice": None, "cashout": 650, "quantity": 5},
    {"id": "sample-journey-together-bundle", "name": "Journey Together Booster Bundle", "category": "Pokemon",
     "upc": "196214129115", "retailer": "Pokemon Center", "retailPrice": 26.94, "cashout": 40, "quantity": 800,
     "active": False},
]

MAX_PHOTOS_PER_SET = 8
MAX_PHOTO_BYTES = 8 * 1024 * 1024
PHOTO_SETS = ("before", "after")
CARRIERS = {"UPS", "USPS", "FedEx", "Other"}
ORDER_ID_PATTERN = re.compile(r"^ORD-\d{5}$")
PHOTO_NAME_PATTERN = re.compile(r"^(before|after)-[0-9a-f]{32}\.(jpg|png|webp)$")
TRACKING_PATTERN = re.compile(r"^[A-Z0-9-]{6,40}$")

# Static files the site needs; everything else in the repo (code, uploads, venv) stays private.
PUBLIC_FILES = {
    "index.html", "dashboard.html", "admin.html",
    "styles.css", "dashboard.css", "admin.css",
    "script.js", "dashboard.js", "admin.js",
}

def git(*args):
    """Runs git in the app folder; returns its output, or "" if git isn't there or fails."""
    try:
        out = subprocess.run(["git", *args], cwd=SITE_DIR, capture_output=True, text=True, timeout=5)
        return out.stdout.strip() if out.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def commit_info(ref):
    """{version, fullVersion, subject, committedAt} for a git ref, or None."""
    fields = git("log", "-1", "--format=%h%x1f%H%x1f%s%x1f%cI", ref).split("\x1f")
    if len(fields) != 4:
        return None
    return dict(zip(("version", "fullVersion", "subject", "committedAt"), fields))


# The commit this process is running, shown by /api/health and the admin dashboard.
VERSION = git("rev-parse", "--short", "HEAD")
RUNNING = commit_info("HEAD")
STARTED_AT = datetime.now(timezone.utc).isoformat()
# deploy.ps1 writes its log and the commit it skipped here (C:\instancecashout\logs on the server).
DEPLOY_LOG_DIR = Path(os.environ.get("LOG_DIR") or SITE_DIR.parent / "logs")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_PHOTOS_PER_SET * len(PHOTO_SETS) * MAX_PHOTO_BYTES + 1024 * 1024
# Signs the session cookie. Without SESSION_SECRET everyone is signed out on each restart.
app.secret_key = os.environ.get("SESSION_SECRET") or secrets.token_hex(32)
app.config.update(
    SESSION_COOKIE_NAME="ic_session",
    SESSION_COOKIE_HTTPONLY=True,
    # Lax: sent when Discord redirects back to us, but not on cross-site form posts.
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=PUBLIC_URL.startswith("https://"),
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)


class ApiError(Exception):
    def __init__(self, status, message, **details):
        super().__init__(message)
        self.status = status
        self.message = message
        self.details = details  # extra fields for the page, e.g. what's left of each product


@app.errorhandler(ApiError)
def handle_api_error(error):
    return jsonify(error=error.message, **error.details), error.status


@app.errorhandler(413)
def handle_too_large(_error):
    return jsonify(error="Upload is too large. Try fewer or smaller photos."), 413


def current_user_id():
    """The signed-in Discord user's id, from the session cookie."""
    user = session.get("user")
    if user:
        return user["id"]

    header = request.headers.get("Authorization", "")
    if DEV_AUTH and header.startswith("Bearer dev:"):
        user_id = header.removeprefix("Bearer dev:")
        if not user_id.isalnum():
            raise ApiError(401, "Invalid dev token.")
        return user_id

    raise ApiError(401, "Log in with Discord to continue.")


@app.get("/auth/discord")
def discord_login():
    if not (DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET):
        return redirect("/?login=unavailable")

    state = secrets.token_urlsafe(24)
    session["oauth_state"] = state
    params = urlencode({
        "client_id": DISCORD_CLIENT_ID,
        "response_type": "code",
        "scope": "identify",
        "redirect_uri": DISCORD_REDIRECT_URI,
        "state": state,
    })
    return redirect(f"https://discord.com/oauth2/authorize?{params}")


@app.get("/auth/discord/callback")
def discord_callback():
    expected_state = session.pop("oauth_state", None)

    if request.args.get("error"):
        return redirect("/?login=cancelled")
    if not expected_state or request.args.get("state") != expected_state or not request.args.get("code"):
        return redirect("/?login=failed")

    try:
        token_response = requests.post(
            f"{DISCORD_API_BASE}/oauth2/token",
            data={
                "grant_type": "authorization_code",
                "code": request.args["code"],
                "redirect_uri": DISCORD_REDIRECT_URI,
            },
            auth=(DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET),
            timeout=10,
        )
        token_response.raise_for_status()
        user_response = requests.get(
            f"{DISCORD_API_BASE}/users/@me",
            headers={"Authorization": f"Bearer {token_response.json()['access_token']}"},
            timeout=10,
        )
        user_response.raise_for_status()
        user = user_response.json()
    except (requests.RequestException, KeyError, ValueError):
        logging.exception("Discord sign-in failed")
        return redirect("/?login=failed")

    # We only keep the public profile; the Discord token is dropped here.
    session.clear()
    session.permanent = True
    session["user"] = {
        "id": str(user["id"]),
        "username": user.get("username", ""),
        "globalName": user.get("global_name"),
        "avatar": user.get("avatar"),
        "discriminator": user.get("discriminator", "0"),
    }
    return redirect("/dashboard.html")


@app.get("/api/me")
def me():
    user = session.get("user")
    if not user:
        raise ApiError(401, "Log in with Discord to continue.")
    return jsonify({**user, "isAdmin": user["id"] in ADMIN_IDS})


def require_admin():
    if current_user_id() not in ADMIN_IDS:
        raise ApiError(403, "Admins only.")
    # A custom header can't be sent by another site's form, so admin changes can't be forged.
    if request.method != "GET" and request.headers.get("X-Requested-With") != "fetch":
        raise ApiError(403, "Admins only.")


@app.post("/auth/logout")
def logout():
    session.clear()
    return "", 204


def photo_extension(data):
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


# Orders: members sell from the buy list, then ship with photos and tracking. Admins see every
# order, move it along (received, paid) and can cancel it. Stored with the uploads like the catalog.

ORDERS_FILE = UPLOAD_DIR / "_orders" / "orders.json"
ORDER_STATUSES = ("submitted", "transit", "received", "paid", "cancelled")
MAX_ORDER_LINES = 50
_orders_lock = threading.Lock()


def read_orders():
    if not ORDERS_FILE.is_file():
        return []
    return json.loads(ORDERS_FILE.read_text(encoding="utf-8"))


def count_claimed(orders):
    """Units claimed per (product, round) by orders that aren't cancelled."""
    claimed = {}
    for order in orders:
        if order["status"] == "cancelled":
            continue
        for item in order["items"]:
            key = (item["productId"], item.get("round", 1))
            claimed[key] = claimed.get(key, 0) + item["quantity"]
    return claimed


_claimed_cache = (None, {})


def claimed_now():
    """count_claimed for the saved orders, reused until the orders file changes.

    Members' dashboards ask for the buy list every few seconds, so this saves re-reading
    every order on each of those requests.
    """
    global _claimed_cache
    try:
        stat = ORDERS_FILE.stat()
    except FileNotFoundError:
        return {}
    key = (stat.st_mtime_ns, stat.st_size)
    if _claimed_cache[0] != key:
        _claimed_cache = (key, count_claimed(read_orders()))
    return _claimed_cache[1]


def with_stock(product, claimed):
    """The product plus how many units are claimed and left in its current round."""
    product_round = product.get("round", 1)
    taken = claimed.get((product["id"], product_round), 0)
    return {**product, "round": product_round, "claimed": taken, "remaining": max(0, product["quantity"] - taken)}


def find_order(orders, order_id, user_id=None):
    for order in orders:
        if order["id"] == order_id and (user_id is None or order["userId"] == user_id):
            return order
    raise ApiError(404, "Order not found.")


def current_profile():
    """The signed-in user's public Discord profile, as stored on their orders."""
    user = session.get("user")
    if user:
        return {key: user.get(key) for key in ("id", "username", "globalName", "avatar")}
    user_id = current_user_id()  # dev token in tests
    return {"id": user_id, "username": user_id, "globalName": None, "avatar": None}


def display_name(profile):
    return profile.get("globalName") or profile.get("username") or profile.get("id")


def add_history(order, status, by):
    order["status"] = status
    order.setdefault("history", []).append({"status": status, "at": now_iso(), "by": by})


@app.get("/api/orders")
def list_my_orders():
    user_id = current_user_id()
    return jsonify(orders=[order for order in read_orders() if order["userId"] == user_id])


@app.post("/api/orders")
def create_order():
    profile = current_profile()
    lines = (request.get_json(silent=True) or {}).get("items")
    if not isinstance(lines, list) or not lines or len(lines) > MAX_ORDER_LINES:
        raise ApiError(400, "Add at least one item to your order.")

    quantities = {}
    for line in lines:
        try:
            quantity = int((line or {}).get("quantity"))
        except (TypeError, ValueError):
            raise ApiError(400, "Quantities must be whole numbers.")
        if quantity < 1:
            raise ApiError(400, "Quantities must be at least 1.")
        product_id = str(line.get("id"))
        quantities[product_id] = quantities.get(product_id, 0) + quantity

    # First come, first served: orders are checked and saved one at a time, against what's
    # left in this round, so two members can never claim the same units.
    with _orders_lock:
        orders = read_orders()
        claimed = count_claimed(orders)
        # Prices come from the buy list, never from the browser.
        catalog = {product["id"]: with_stock(product, claimed) for product in read_products() if product.get("active", True)}

        items = []
        short = {}
        for product_id, quantity in quantities.items():
            product = catalog.get(product_id)
            if not product:
                raise ApiError(409, "An item in your order is no longer on the buy list. Refresh and try again.")
            if quantity > product["remaining"]:
                short[product_id] = product["remaining"]
                continue
            items.append({"productId": product_id, "name": product["name"], "cashout": product["cashout"],
                          "quantity": quantity, "round": product["round"]})

        if short:
            first = catalog[next(iter(short))]
            message = (f"{first['name']} is fully claimed." if not first["remaining"]
                       else f"Only {first['remaining']} of {first['name']} left.")
            raise ApiError(409, message, remaining=short)

        number = max((int(order["id"].removeprefix("ORD-")) for order in orders), default=0) + 1
        order = {
            "id": f"ORD-{number:05d}",
            "userId": profile["id"],
            "seller": profile,
            "items": items,
            "total": round(sum(item["cashout"] * item["quantity"] for item in items), 2),
            "createdAt": now_iso(),
        }
        add_history(order, "submitted", display_name(profile))
        orders.insert(0, order)
        write_json_atomic(ORDERS_FILE, orders)
    return jsonify(order), 201


def shipment_dir(user_id, order_id):
    if not ORDER_ID_PATTERN.match(order_id):
        raise ApiError(400, "Unknown order.")
    return UPLOAD_DIR / user_id / order_id


@app.post("/api/shipments")
def create_shipment():
    profile = current_profile()
    user_id = profile["id"]
    order_id = request.form.get("orderId", "")
    folder = shipment_dir(user_id, order_id)

    carrier = request.form.get("carrier", "")
    tracking = re.sub(r"\s+", "", request.form.get("tracking", "")).upper()

    if carrier not in CARRIERS:
        raise ApiError(400, "Choose a carrier.")
    if not TRACKING_PATTERN.match(tracking):
        raise ApiError(400, "Enter a valid tracking number.")

    # Validate every file before writing anything, so a bad photo never leaves a half-saved shipment.
    accepted = {}
    for photo_set in PHOTO_SETS:
        files = request.files.getlist(photo_set)
        if not files:
            raise ApiError(400, f"Add at least one photo {photo_set} packing.")
        if len(files) > MAX_PHOTOS_PER_SET:
            raise ApiError(400, f"Add up to {MAX_PHOTOS_PER_SET} photos {photo_set} packing.")

        accepted[photo_set] = []
        for upload in files:
            data = upload.read(MAX_PHOTO_BYTES + 1)
            if len(data) > MAX_PHOTO_BYTES:
                raise ApiError(400, "Each photo must be under 8 MB.")
            extension = photo_extension(data)
            if not extension:
                raise ApiError(400, "Photos must be JPEG, PNG, or WebP images.")
            accepted[photo_set].append((f"{photo_set}-{uuid.uuid4().hex}.{extension}", data))

    with _orders_lock:
        orders = read_orders()
        order = find_order(orders, order_id, user_id)
        if order["status"] != "submitted":
            raise ApiError(409, "Tracking was already submitted for this order.")

        folder.mkdir(parents=True, exist_ok=True)
        photos = {}
        for photo_set, entries in accepted.items():
            photos[photo_set] = []
            for name, data in entries:
                (folder / name).write_bytes(data)
                photos[photo_set].append(name)

        order.update(carrier=carrier, tracking=tracking, photos=photos, shippedAt=now_iso())
        add_history(order, "transit", display_name(profile))
        write_json_atomic(ORDERS_FILE, orders)
    return jsonify(order), 201


def send_order_photo(order, name):
    folder = shipment_dir(order["userId"], order["id"])
    if not PHOTO_NAME_PATTERN.match(name) or not (folder / name).is_file():
        raise ApiError(404, "Photo not found.")
    response = send_from_directory(folder, name)
    response.headers["Cache-Control"] = "private, max-age=3600"
    return response


@app.get("/api/shipments/<order_id>/photos/<name>")
def shipment_photo(order_id, name):
    return send_order_photo(find_order(read_orders(), order_id, current_user_id()), name)


@app.get("/api/admin/orders")
def admin_list_orders():
    require_admin()
    return jsonify(orders=read_orders(), statuses=ORDER_STATUSES)


@app.patch("/api/admin/orders/<order_id>")
def admin_update_order(order_id):
    require_admin()
    status = (request.get_json(silent=True) or {}).get("status")
    if status not in ORDER_STATUSES:
        raise ApiError(400, "Choose a valid status.")

    with _orders_lock:
        orders = read_orders()
        order = find_order(orders, order_id)
        if order["status"] != status:
            add_history(order, status, display_name(current_profile()))
            write_json_atomic(ORDERS_FILE, orders)
    return jsonify(order)


@app.get("/api/admin/orders/<order_id>/photos/<name>")
def admin_order_photo(order_id, name):
    require_admin()
    return send_order_photo(find_order(read_orders(), order_id), name)


# Live carrier tracking: each shipped order keeps the carrier's latest status in
# order["carrierStatus"] (see carriers.py). Admins can update it; a background thread also
# checks packages still on their way every few hours.

TRACKING_REFRESH_SECONDS = 3 * 60 * 60
RECHECK_AFTER_SECONDS = 30  # a second click within this time reuses the result


def needs_tracking_check(order):
    """Shipped, not yet received by us, and the carrier hasn't said delivered."""
    return (order.get("tracking") and order["status"] == "transit"
            and (order.get("carrierStatus") or {}).get("status") != "delivered")


def refresh_tracking(order_id, force=False):
    """Asks the carrier for the order's package status and saves it on the order."""
    order = find_order(read_orders(), order_id)
    if not order.get("tracking"):
        raise ApiError(400, "This order doesn't have a tracking number yet.")

    previous = order.get("carrierStatus") or {}
    if not force and previous.get("checkedAt") and not previous.get("error"):
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(previous["checkedAt"])).total_seconds()
        if age < RECHECK_AFTER_SECONDS:
            return order

    try:
        status = carriers.track(order["carrier"], order["tracking"])
    except carriers.CarrierUnavailable as error:
        # Keep the last good status, and say why this check failed.
        status = {**{k: v for k, v in previous.items() if k != "error"}, "error": str(error),
                  "carrier": order["carrier"], "checkedAt": now_iso()}

    with _orders_lock:
        orders = read_orders()
        order = find_order(orders, order_id)
        order["carrierStatus"] = status
        write_json_atomic(ORDERS_FILE, orders)
    return order


@app.post("/api/admin/orders/<order_id>/tracking")
def admin_refresh_tracking(order_id):
    require_admin()
    return jsonify(refresh_tracking(order_id))


@app.post("/api/admin/tracking/refresh")
def admin_refresh_all_tracking():
    """Updates every package still on its way to us."""
    require_admin()
    checked = failed = 0
    for order in [order for order in read_orders() if needs_tracking_check(order)]:
        result = refresh_tracking(order["id"], force=True)
        checked += 1
        failed += bool(result["carrierStatus"].get("error"))
    return jsonify(orders=read_orders(), checked=checked, failed=failed)


def track_in_background():
    """Checks packages still on their way every few hours, so statuses stay current."""
    time.sleep(5 * 60)  # let the site start (and settle after deploys) first
    while True:
        for order in [order for order in read_orders() if needs_tracking_check(order)]:
            checked_at = (order.get("carrierStatus") or {}).get("checkedAt")
            if checked_at and (datetime.now(timezone.utc) - datetime.fromisoformat(checked_at)).total_seconds() < TRACKING_REFRESH_SECONDS:
                continue
            try:
                refresh_tracking(order["id"], force=True)
            except Exception:
                logging.exception("Background tracking check failed for %s", order["id"])
            time.sleep(2)  # gentle on the carriers' rate limits
        time.sleep(15 * 60)


# Product catalog

_catalog_lock = threading.Lock()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def read_products():
    if not PRODUCTS_FILE.is_file():
        # A fixed time, so the starter list is identical on every request (dashboards compare it).
        return [{"image": None, "active": True, **product, "updatedAt": "2026-10-26T00:00:00+00:00"}
                for product in DEFAULT_PRODUCTS]
    return json.loads(PRODUCTS_FILE.read_text(encoding="utf-8"))


def write_json_atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write then rename, so a crash mid-write never leaves a half-written file.
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(temp, path)


def write_products(products):
    write_json_atomic(PRODUCTS_FILE, products)


def find_product(products, product_id):
    for product in products:
        if product["id"] == product_id:
            return product
    raise ApiError(404, "Product not found.")


def number_field(data, key, *, minimum=0, integer=False, optional=False):
    value = data.get(key)
    if value in (None, "") and optional:
        return None
    try:
        number = int(value) if integer else round(float(value), 2)
    except (TypeError, ValueError):
        raise ApiError(400, f"Enter a number for {key}.")
    if number < minimum or number > 1_000_000:
        raise ApiError(400, f"{key} is out of range.")
    return number


def text_field(data, key, limit, *, required=False):
    value = str(data.get(key) or "").strip()
    if required and not value:
        raise ApiError(400, f"Enter a {key}.")
    if len(value) > limit:
        raise ApiError(400, f"{key} is too long (max {limit}).")
    return value


def clean_product(data, current=None):
    """Validates a new product, or the changed fields of an existing one."""
    product = dict(current or {})
    fields = data.keys() if current else {"name", "category", "upc", "retailer", "retailPrice", "cashout", "quantity", "image", "active"}

    for key in fields:
        if key == "name":
            product["name"] = text_field(data, "name", 120, required=True)
        elif key == "category":
            if data.get("category") not in CATEGORIES:
                raise ApiError(400, "Choose a category.")
            product["category"] = data["category"]
        elif key == "upc":
            product["upc"] = text_field(data, "upc", 40)
        elif key == "retailer":
            product["retailer"] = text_field(data, "retailer", 60)
        elif key == "retailPrice":
            product["retailPrice"] = number_field(data, "retailPrice", optional=True)
        elif key == "cashout":
            product["cashout"] = number_field(data, "cashout")
        elif key == "quantity":
            product["quantity"] = number_field(data, "quantity", integer=True)
        elif key == "image":
            image = data.get("image") or None
            if image and not (image.startswith("https://") and len(image) <= 500
                              or image.startswith("/product-images/") and PRODUCT_IMAGE_PATTERN.match(image.removeprefix("/product-images/"))):
                raise ApiError(400, "Image must be an https:// link or an uploaded image.")
            product["image"] = image
        elif key == "active":
            product["active"] = bool(data.get("active", True))

    product["updatedAt"] = now_iso()
    return product


def delete_uploaded_image(product):
    image = product.get("image") or ""
    if image.startswith("/product-images/"):
        (PRODUCT_IMAGE_DIR / image.removeprefix("/product-images/")).unlink(missing_ok=True)


@app.get("/api/products")
def list_products():
    current_user_id()
    claimed = claimed_now()
    products = [with_stock(product, claimed) for product in read_products() if product.get("active", True)]
    response = jsonify(products=products, categories=CATEGORIES)
    # Dashboards check every few seconds; when nothing changed they get a tiny "304 Not Modified".
    response.headers["Cache-Control"] = "no-cache"
    response.add_etag()
    return response.make_conditional(request)


@app.get("/api/admin/products")
def admin_list_products():
    require_admin()
    claimed = claimed_now()
    return jsonify(products=[with_stock(product, claimed) for product in read_products()], categories=CATEGORIES)


@app.post("/api/admin/products")
def admin_create_product():
    require_admin()
    with _catalog_lock:
        products = read_products()
        product = {"id": f"prod-{uuid.uuid4().hex[:12]}", "round": 1, **clean_product(request.get_json(silent=True) or {})}
        products.insert(0, product)
        write_products(products)
    return jsonify(with_stock(product, claimed_now())), 201


@app.post("/api/admin/products/<product_id>/restock")
def admin_restock_product(product_id):
    """Starts a new round: a fresh number of units to fill, first come first served again."""
    require_admin()
    quantity = number_field(request.get_json(silent=True) or {}, "quantity", minimum=1, integer=True)
    with _catalog_lock:
        products = read_products()
        current = find_product(products, product_id)
        updated = {**current, "round": current.get("round", 1) + 1, "quantity": quantity, "active": True,
                   "restockedAt": now_iso(), "updatedAt": now_iso()}
        products[products.index(current)] = updated
        write_products(products)
    return jsonify(with_stock(updated, claimed_now()))


@app.patch("/api/admin/products/<product_id>")
def admin_update_product(product_id):
    require_admin()
    changes = request.get_json(silent=True) or {}
    with _catalog_lock:
        products = read_products()
        current = find_product(products, product_id)
        updated = clean_product(changes, current)
        if "image" in changes and current.get("image") != updated.get("image"):
            delete_uploaded_image(current)
        products[products.index(current)] = updated
        write_products(products)
    return jsonify(with_stock(updated, claimed_now()))


@app.delete("/api/admin/products/<product_id>")
def admin_delete_product(product_id):
    require_admin()
    with _catalog_lock:
        products = read_products()
        product = find_product(products, product_id)
        products.remove(product)
        write_products(products)
        delete_uploaded_image(product)
    return "", 204


@app.post("/api/admin/products/<product_id>/image")
def admin_upload_product_image(product_id):
    require_admin()
    upload = request.files.get("image")
    data = upload.read(MAX_PRODUCT_IMAGE_BYTES + 1) if upload else b""
    if not data:
        raise ApiError(400, "Choose an image.")
    if len(data) > MAX_PRODUCT_IMAGE_BYTES:
        raise ApiError(400, "Images must be under 5 MB.")
    extension = photo_extension(data)
    if not extension:
        raise ApiError(400, "Images must be JPEG, PNG, or WebP.")

    with _catalog_lock:
        products = read_products()
        current = find_product(products, product_id)
        PRODUCT_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
        name = f"{uuid.uuid4().hex}.{extension}"
        (PRODUCT_IMAGE_DIR / name).write_bytes(data)
        delete_uploaded_image(current)
        updated = {**current, "image": f"/product-images/{name}", "updatedAt": now_iso()}
        products[products.index(current)] = updated
        write_products(products)
    return jsonify(with_stock(updated, claimed_now()))


@app.get("/product-images/<name>")
def product_image(name):
    if not PRODUCT_IMAGE_PATTERN.match(name) or not (PRODUCT_IMAGE_DIR / name).is_file():
        abort(404)
    response = send_from_directory(PRODUCT_IMAGE_DIR, name)
    # Each upload gets a new name, so a cached copy never goes stale.
    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


@app.get("/api/admin/version")
def admin_version():
    """Which update is running, the newest one on GitHub, and whether it's live yet.

    The server's deploy task fetches GitHub every minute and tests a new commit before
    switching to it, so "latest" is as of that last check.
    """
    require_admin()
    latest = commit_info("origin/main")

    if not RUNNING or not latest:
        status = "unknown"
    elif latest["fullVersion"] == RUNNING["fullVersion"]:
        status = "live"
    else:
        skip_file = DEPLOY_LOG_DIR / "skip-commit.txt"
        skipped = skip_file.is_file() and skip_file.read_text(encoding="utf-8", errors="replace").strip() == latest["fullVersion"]
        status = "skipped" if skipped else "pending"

    deploy_log = DEPLOY_LOG_DIR / "deploy.log"
    recent = []
    if deploy_log.is_file():
        lines = deploy_log.read_text(encoding="utf-8", errors="replace").splitlines()
        # "2026-10-26 21:50:01 Tests passed, deploying abc1234" -> time + message, newest first
        recent = [{"at": line[:19], "message": line[20:]} for line in reversed(lines[-8:]) if len(line) > 20]

    return jsonify(running=RUNNING, startedAt=STARTED_AT, latest=latest, status=status, recentDeploys=recent)


@app.get("/api/health")
def health():
    # For the deploy script: is the site up, and which version. Visitors come in through the
    # Cloudflare tunnel (which adds CF-Connecting-IP), so only the server itself sees the version.
    local = request.remote_addr == "127.0.0.1" and "CF-Connecting-IP" not in request.headers
    return jsonify(ok=True, version=VERSION if local else None)


def send_page_file(filename):
    response = send_from_directory(SITE_DIR, filename)
    if filename.endswith(".html"):
        # Pages name their scripts and styles with ?v= versions. Without this, browsers guess how
        # long to reuse a saved page, and keep loading the old scripts after a deploy.
        # "no-cache" still lets them reuse it when the server says it hasn't changed (a 304).
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/")
def home():
    return send_page_file("index.html")


@app.get("/<path:filename>")
def static_file(filename):
    if filename not in PUBLIC_FILES and not filename.startswith("assets/"):
        abort(404)
    return send_page_file(filename)


def setup_logging():
    """Logs go to the console, or to LOG_DIR/app.log when LOG_DIR is set (as on the server)."""
    log_dir = os.environ.get("LOG_DIR")
    if log_dir:
        Path(log_dir).mkdir(parents=True, exist_ok=True)
        handler = logging.handlers.RotatingFileHandler(Path(log_dir) / "app.log", maxBytes=5_000_000, backupCount=5, encoding="utf-8")
    else:
        handler = logging.StreamHandler()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s", handlers=[handler], force=True)


def main():
    setup_logging()
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    logging.info("Instance Cashout %s is running at http://%s:%s/", VERSION or "(no git)", host, port)
    logging.info("Carrier tracking: %s", ", ".join(
        f"{name} {'on' if carriers.configured(name) else 'off'}" for name in ("FedEx", "UPS", "USPS")))
    threading.Thread(target=track_in_background, daemon=True, name="tracking").start()
    serve(app, host=host, port=port, threads=8, max_request_body_size=app.config["MAX_CONTENT_LENGTH"])


if __name__ == "__main__":
    main()
