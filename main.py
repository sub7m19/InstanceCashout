import json
import logging
import logging.handlers
import os
import re
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import requests
from flask import Flask, abort, jsonify, request, send_from_directory
from waitress import serve

SITE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", SITE_DIR / "uploads")).resolve()
DISCORD_API_BASE = "https://discord.com/api/v10"

# Local testing only: lets "Bearer dev:<id>" stand in for a Discord token.
DEV_AUTH = os.environ.get("INSTANCE_DEV_AUTH") == "1"

MAX_PHOTOS_PER_SET = 8
MAX_PHOTO_BYTES = 8 * 1024 * 1024
PHOTO_SETS = ("before", "after")
CARRIERS = {"UPS", "USPS", "FedEx", "Other"}
ORDER_ID_PATTERN = re.compile(r"^ORD-\d{5}$")
PHOTO_NAME_PATTERN = re.compile(r"^(before|after)-[0-9a-f]{32}\.(jpg|png|webp)$")
TRACKING_PATTERN = re.compile(r"^[A-Z0-9-]{6,40}$")

# Static files the site needs; everything else in the repo (code, uploads, venv) stays private.
PUBLIC_FILES = {"index.html", "dashboard.html", "styles.css", "dashboard.css", "script.js", "dashboard.js"}

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

_token_cache = {}
TOKEN_CACHE_SECONDS = 300


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
    """Resolve the Discord user behind the request's bearer token."""
    header = request.headers.get("Authorization", "")
    token = header.removeprefix("Bearer ").strip() if header.startswith("Bearer ") else ""

    if not token:
        raise ApiError(401, "Log in with Discord to continue.")

    if DEV_AUTH and token.startswith("dev:"):
        user_id = token.removeprefix("dev:")
        if not user_id.isalnum():
            raise ApiError(401, "Invalid dev token.")
        return user_id

    cached = _token_cache.get(token)
    if cached and cached[1] > time.time():
        return cached[0]

    try:
        response = requests.get(
            f"{DISCORD_API_BASE}/users/@me",
            headers={"Authorization": f"Bearer {token}"},
            timeout=10,
        )
    except requests.RequestException:
        raise ApiError(502, "Couldn't reach Discord to verify your login. Try again.")

    if response.status_code != 200:
        raise ApiError(401, "Your Discord login expired. Log in again.")

    user_id = str(response.json()["id"])
    _token_cache[token] = (user_id, time.time() + TOKEN_CACHE_SECONDS)
    return user_id


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
