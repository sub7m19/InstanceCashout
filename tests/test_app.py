"""Smoke tests the server runs before deploying a new version.

Run: python -m unittest discover -s tests -t .
"""
import io
import os
import shutil
import tempfile
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlparse

# Before importing main: a throwaway upload folder, dev tokens, a test Discord app, and no
# settings file (the server's real one sits next to the folder the tests run in).
UPLOADS = tempfile.mkdtemp(prefix="instance-cashout-tests-")
os.environ["UPLOAD_DIR"] = UPLOADS
os.environ["INSTANCE_DEV_AUTH"] = "1"
os.environ["INSTANCE_ENV"] = os.path.join(UPLOADS, "no-settings.env")
os.environ["PUBLIC_URL"] = "https://cashout.test"
os.environ["DISCORD_CLIENT_ID"] = "client-id"
os.environ["DISCORD_CLIENT_SECRET"] = "client-secret"

import main  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32
AUTH = {"Authorization": "Bearer dev:123"}


def tearDownModule():
    shutil.rmtree(UPLOADS, ignore_errors=True)


class AppTest(unittest.TestCase):
    def setUp(self):
        self.client = main.app.test_client()

    def status(self, path, headers=None):
        with self.client.get(path, headers=headers) as response:
            return response.status_code

    def test_health(self):
        self.assertTrue(self.client.get("/api/health").get_json()["ok"])

    def test_pages_are_served(self):
        for path in ("/", "/dashboard.html", "/styles.css", "/dashboard.css", "/script.js", "/dashboard.js"):
            with self.subTest(path=path):
                self.assertEqual(self.status(path), 200)

    def test_source_stays_private(self):
        for path in ("/main.py", "/requirements.txt", "/.gitignore", "/tests/test_app.py"):
            with self.subTest(path=path):
                self.assertEqual(self.status(path), 404)

    def test_shipments_need_login(self):
        self.assertEqual(self.client.get("/api/shipments").status_code, 401)

    def test_submit_and_list_shipment(self):
        response = self.client.post("/api/shipments", headers=AUTH, data={
            "orderId": "ORD-00001",
            "carrier": "UPS",
            "tracking": "1z 999 aa1",
            "order": "{}",
            "before": (io.BytesIO(PNG), "before.png"),
            "after": (io.BytesIO(PNG), "after.png"),
        })
        self.assertEqual(response.status_code, 201, response.get_json())
        shipment = response.get_json()
        self.assertEqual(shipment["tracking"], "1Z999AA1")

        listed = self.client.get("/api/shipments", headers=AUTH).get_json()["shipments"]
        self.assertEqual([s["orderId"] for s in listed], ["ORD-00001"])

        photo = shipment["photos"]["before"][0]
        self.assertEqual(self.status(f"/api/shipments/ORD-00001/photos/{photo}", AUTH), 200)
        # Another user can't see it.
        self.assertEqual(self.status(f"/api/shipments/ORD-00001/photos/{photo}", {"Authorization": "Bearer dev:456"}), 404)



def fake_response(payload):
    response = mock.Mock()
    response.json.return_value = payload
    response.raise_for_status.return_value = None
    return response


class DiscordLoginTest(unittest.TestCase):
    def setUp(self):
        self.client = main.app.test_client()

    def start_login(self):
        response = self.client.get("/auth/discord")
        self.assertEqual(response.status_code, 302)
        return parse_qs(urlparse(response.headers["Location"]).query)

    def test_login_uses_code_flow(self):
        query = self.start_login()
        self.assertEqual(query["response_type"], ["code"])
        self.assertEqual(query["redirect_uri"], ["https://cashout.test/auth/discord/callback"])
        self.assertTrue(query["state"][0])

    def test_callback_rejects_wrong_state(self):
        self.start_login()
        response = self.client.get("/auth/discord/callback?code=abc&state=wrong")
        self.assertEqual(response.headers["Location"], "/?login=failed")
        self.assertEqual(self.client.get("/api/me").status_code, 401)

    def test_callback_signs_in_and_logout_signs_out(self):
        state = self.start_login()["state"][0]
        user = {"id": "42", "username": "buffy", "global_name": "BUFFY", "avatar": None, "discriminator": "0"}

        with mock.patch.object(main.requests, "post", return_value=fake_response({"access_token": "t"})) as post,                 mock.patch.object(main.requests, "get", return_value=fake_response(user)):
            response = self.client.get(f"/auth/discord/callback?code=abc&state={state}")

        self.assertEqual(response.headers["Location"], "/dashboard.html")
        self.assertEqual(post.call_args.kwargs["auth"], ("client-id", "client-secret"))
        me = self.client.get("/api/me").get_json()
        self.assertEqual((me["id"], me["globalName"]), ("42", "BUFFY"))
        self.assertNotIn("t", me.values())  # the Discord token never reaches the browser
        self.assertEqual(self.client.get("/api/shipments").status_code, 200)

        self.client.post("/auth/logout")
        self.assertEqual(self.client.get("/api/me").status_code, 401)

    def test_cancelled_on_discord(self):
        self.start_login()
        response = self.client.get("/auth/discord/callback?error=access_denied")
        self.assertEqual(response.headers["Location"], "/?login=cancelled")


if __name__ == "__main__":
    unittest.main()
