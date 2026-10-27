"""Smoke tests the server runs before deploying a new version.

Run: python -m unittest discover -s tests -t .
"""
import io
import os
import shutil
import tempfile
import unittest

# Before importing main: a throwaway upload folder, and dev tokens instead of Discord.
UPLOADS = tempfile.mkdtemp(prefix="instance-cashout-tests-")
os.environ["UPLOAD_DIR"] = UPLOADS
os.environ["INSTANCE_DEV_AUTH"] = "1"

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


if __name__ == "__main__":
    unittest.main()
