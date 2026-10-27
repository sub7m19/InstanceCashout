import json
import logging
import logging.handlers
import os
import re
import secrets
import subprocess
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode

import requests
from flask import Flask, abort, jsonify, redirect, request, send_from_directory, session
from waitress import serve

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

def _version():
    """The git commit this copy of the code is at, shown by /api/health."""
    try:
        out = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=SITE_DIR, capture_output=True, text=True, timeout=5)
        return out.stdout.strip() if out.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


VERSION = _version()

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
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


@app.errorhandler(ApiError)
def handle_api_error(error):
    return jsonify(error=error.message), error.status


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


def shipment_dir(user_id, order_id):
    if not ORDER_ID_PATTERN.match(order_id):
        raise ApiError(400, "Unknown order.")
    return UPLOAD_DIR / user_id / order_id


def read_shipment(folder):
    meta_path = folder / "shipment.json"
    if not meta_path.is_file():
        raise ApiError(404, "No shipment for this order.")
    return json.loads(meta_path.read_text(encoding="utf-8"))


@app.post("/api/shipments")
def create_shipment():
    user_id = current_user_id()
    order_id = request.form.get("orderId", "")
    folder = shipment_dir(user_id, order_id)

    if (folder / "shipment.json").exists():
        raise ApiError(409, "Tracking was already submitted for this order.")

    carrier = request.form.get("carrier", "")
    tracking = re.sub(r"\s+", "", request.form.get("tracking", "")).upper()

    if carrier not in CARRIERS:
        raise ApiError(400, "Choose a carrier.")
    if not TRACKING_PATTERN.match(tracking):
        raise ApiError(400, "Enter a valid tracking number.")

    try:
        order = json.loads(request.form.get("order", "{}"))
    except json.JSONDecodeError:
        raise ApiError(400, "Order details are malformed.")

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

    folder.mkdir(parents=True, exist_ok=True)
    photos = {}
    for photo_set, entries in accepted.items():
        photos[photo_set] = []
        for name, data in entries:
            (folder / name).write_bytes(data)
            photos[photo_set].append(name)

    shipment = {
        "orderId": order_id,
        "userId": user_id,
        "carrier": carrier,
        "tracking": tracking,
        "photos": photos,
        "order": {
            "items": order.get("items", []),
            "total": order.get("total"),
            "createdAt": order.get("createdAt"),
        },
        "submittedAt": datetime.now(timezone.utc).isoformat(),
    }
    (folder / "shipment.json").write_text(json.dumps(shipment, indent=2), encoding="utf-8")

    return jsonify(shipment), 201


@app.get("/api/shipments")
def list_shipments():
    user_folder = UPLOAD_DIR / current_user_id()
    shipments = []

    if user_folder.is_dir():
        for meta_path in sorted(user_folder.glob("ORD-*/shipment.json")):
            shipments.append(json.loads(meta_path.read_text(encoding="utf-8")))

    return jsonify(shipments=shipments)


@app.get("/api/shipments/<order_id>/photos/<name>")
def shipment_photo(order_id, name):
    folder = shipment_dir(current_user_id(), order_id)

    if not PHOTO_NAME_PATTERN.match(name) or not (folder / name).is_file():
        raise ApiError(404, "Photo not found.")

    response = send_from_directory(folder, name)
    response.headers["Cache-Control"] = "private, max-age=3600"
    return response


# Product catalog

_catalog_lock = threading.Lock()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def read_products():
    if not PRODUCTS_FILE.is_file():
        return [{**product, "image": None, "active": True, "updatedAt": now_iso()} for product in DEFAULT_PRODUCTS]
    return json.loads(PRODUCTS_FILE.read_text(encoding="utf-8"))


def write_products(products):
    CATALOG_DIR.mkdir(parents=True, exist_ok=True)
    # Write then rename, so a crash mid-write never leaves a half-written catalog.
    temp = PRODUCTS_FILE.with_suffix(".tmp")
    temp.write_text(json.dumps(products, indent=2), encoding="utf-8")
    os.replace(temp, PRODUCTS_FILE)


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
    products = [product for product in read_products() if product.get("active", True)]
    return jsonify(products=products, categories=CATEGORIES)


@app.get("/api/admin/products")
def admin_list_products():
    require_admin()
    return jsonify(products=read_products(), categories=CATEGORIES)


@app.post("/api/admin/products")
def admin_create_product():
    require_admin()
    with _catalog_lock:
        products = read_products()
        product = {"id": f"prod-{uuid.uuid4().hex[:12]}", **clean_product(request.get_json(silent=True) or {})}
        products.insert(0, product)
        write_products(products)
    return jsonify(product), 201


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
    return jsonify(updated)


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
    return jsonify(updated)


@app.get("/product-images/<name>")
def product_image(name):
    if not PRODUCT_IMAGE_PATTERN.match(name) or not (PRODUCT_IMAGE_DIR / name).is_file():
        abort(404)
    response = send_from_directory(PRODUCT_IMAGE_DIR, name)
    # Each upload gets a new name, so a cached copy never goes stale.
    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


@app.get("/api/health")
def health():
    # For the deploy script: is the site up, and which version. Visitors come in through the
    # Cloudflare tunnel (which adds CF-Connecting-IP), so only the server itself sees the version.
    local = request.remote_addr == "127.0.0.1" and "CF-Connecting-IP" not in request.headers
    return jsonify(ok=True, version=VERSION if local else None)


@app.get("/")
def home():
    return send_from_directory(SITE_DIR, "index.html")


@app.get("/<path:filename>")
def static_file(filename):
    if filename not in PUBLIC_FILES and not filename.startswith("assets/"):
        abort(404)
    return send_from_directory(SITE_DIR, filename)


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
    serve(app, host=host, port=port, threads=8, max_request_body_size=app.config["MAX_CONTENT_LENGTH"])


if __name__ == "__main__":
    main()
