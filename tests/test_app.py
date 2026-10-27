"""Smoke tests the server runs before deploying a new version.

Run: python -m unittest discover -s tests -t .
"""
import io
import os
import shutil
import tempfile
import threading
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
os.environ["ADMIN_DISCORD_IDS"] = "900"

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
        for path in ("/", "/dashboard.html", "/admin.html", "/styles.css", "/dashboard.css", "/admin.css", "/script.js", "/dashboard.js", "/admin.js"):
            with self.subTest(path=path):
                self.assertEqual(self.status(path), 200)

    def test_source_stays_private(self):
        for path in ("/main.py", "/requirements.txt", "/.gitignore", "/tests/test_app.py"):
            with self.subTest(path=path):
                self.assertEqual(self.status(path), 404)

    def test_orders_need_login(self):
        self.assertEqual(self.client.get("/api/orders").status_code, 401)


class OrderTest(unittest.TestCase):
    def setUp(self):
        self.client = main.app.test_client()
        main.PRODUCTS_FILE.unlink(missing_ok=True)
        main.ORDERS_FILE.unlink(missing_ok=True)

    def status(self, path, headers=None):
        with self.client.get(path, headers=headers) as response:
            return response.status_code

    def place_order(self, items, headers=AUTH):
        return self.client.post("/api/orders", headers=headers, json={"items": items})

    def ship(self, order_id, headers=AUTH):
        return self.client.post("/api/shipments", headers=headers, data={
            "orderId": order_id,
            "carrier": "UPS",
            "tracking": "1z 999 aa1",
            "before": (io.BytesIO(PNG), "before.png"),
            "after": (io.BytesIO(PNG), "after.png"),
        })

    def test_order_total_comes_from_the_buy_list(self):
        # The browser sends only ids and quantities; a made-up price is ignored.
        response = self.place_order([{"id": "want-151-mini-tin", "quantity": 2, "cashout": 1_000_000},
                                     {"id": "want-151-mini-tin", "quantity": 1}])
        self.assertEqual(response.status_code, 201, response.get_json())
        order = response.get_json()
        self.assertEqual((order["id"], order["total"], order["status"]), ("ORD-00001", 1470, "submitted"))
        self.assertEqual(order["items"], [{"productId": "want-151-mini-tin", "name": "Pokemon 151 Mini Tin Collection 10 Pack",
                                           "cashout": 490, "quantity": 3, "round": 1}])
        self.assertEqual(self.place_order([{"id": "want-prismatic-etb", "quantity": 1}]).get_json()["id"], "ORD-00002")

    def test_rejects_hidden_unknown_and_too_many(self):
        self.assertEqual(self.place_order([{"id": "sample-journey-together-bundle", "quantity": 1}]).status_code, 409)
        self.assertEqual(self.place_order([{"id": "nope", "quantity": 1}]).status_code, 409)
        too_many = self.place_order([{"id": "sample-charizard-psa10", "quantity": 6}])
        self.assertEqual(too_many.status_code, 409)
        self.assertEqual(too_many.get_json()["remaining"], {"sample-charizard-psa10": 5})
        self.assertEqual(self.place_order([]).status_code, 400)

    def remaining(self, product_id):
        products = self.client.get("/api/admin/products", headers=ADMIN).get_json()["products"]
        return next(product["remaining"] for product in products if product["id"] == product_id)

    def test_rush_is_first_come_first_served(self):
        # 25 members order 1 unit each of a product wanting 10, all at the same moment.
        product = self.client.post("/api/admin/products", headers=ADMIN, json={
            "name": "Drop", "category": "Sealed", "cashout": 50, "quantity": 10}).get_json()
        results = []
        start = threading.Barrier(25)

        def member(n):
            client = main.app.test_client()
            start.wait()
            response = client.post("/api/orders", headers={"Authorization": f"Bearer dev:{1000 + n}"},
                                   json={"items": [{"id": product["id"], "quantity": 1}]})
            results.append(response.status_code)

        threads = [threading.Thread(target=member, args=(n,)) for n in range(25)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(results.count(201), 10)
        self.assertEqual(results.count(409), 15)
        self.assertEqual(self.remaining(product["id"]), 0)
        refused = self.place_order([{"id": product["id"], "quantity": 1}]).get_json()
        self.assertEqual(refused["error"], "Drop is fully claimed.")

    def test_cancel_frees_units_and_restock_starts_a_new_round(self):
        order = self.place_order([{"id": "sample-charizard-psa10", "quantity": 5}]).get_json()
        self.assertEqual(self.remaining("sample-charizard-psa10"), 0)

        self.client.patch(f"/api/admin/orders/{order['id']}", headers=ADMIN, json={"status": "cancelled"})
        self.assertEqual(self.remaining("sample-charizard-psa10"), 5)
        self.client.patch(f"/api/admin/orders/{order['id']}", headers=ADMIN, json={"status": "submitted"})
        self.assertEqual(self.remaining("sample-charizard-psa10"), 0)

        # The next day: 3 more. Earlier orders stay, but don't count against the new round.
        restocked = self.client.post("/api/admin/products/sample-charizard-psa10/restock", headers=ADMIN, json={"quantity": 3}).get_json()
        self.assertEqual((restocked["round"], restocked["quantity"], restocked["remaining"]), (2, 3, 3))
        self.assertEqual(self.place_order([{"id": "sample-charizard-psa10", "quantity": 3}]).status_code, 201)
        self.assertEqual(self.remaining("sample-charizard-psa10"), 0)
        self.assertEqual(self.client.post("/api/admin/products/sample-charizard-psa10/restock", headers=MEMBER, json={"quantity": 3}).status_code, 403)
        self.assertEqual(self.client.post("/api/admin/products/sample-charizard-psa10/restock", headers=ADMIN, json={"quantity": 0}).status_code, 400)

    def test_buy_list_answers_not_modified_when_nothing_changed(self):
        first = self.client.get("/api/products", headers=AUTH)
        etag = first.headers["ETag"]
        self.assertEqual(self.client.get("/api/products", headers={**AUTH, "If-None-Match": etag}).status_code, 304)
        self.place_order([{"id": "want-151-mini-tin", "quantity": 1}])
        changed = self.client.get("/api/products", headers={**AUTH, "If-None-Match": etag})
        self.assertEqual(changed.status_code, 200)
        mini_tin = next(p for p in changed.get_json()["products"] if p["id"] == "want-151-mini-tin")
        self.assertEqual((mini_tin["claimed"], mini_tin["remaining"]), (1, 964))

    def test_ship_then_admin_moves_it_along(self):
        order_id = self.place_order([{"id": "want-151-mini-tin", "quantity": 1}]).get_json()["id"]

        # Another member can't ship or see someone else's order.
        self.assertEqual(self.ship(order_id, {"Authorization": "Bearer dev:456"}).status_code, 404)
        self.assertEqual(self.client.get("/api/orders", headers={"Authorization": "Bearer dev:456"}).get_json()["orders"], [])

        response = self.ship(order_id)
        self.assertEqual(response.status_code, 201, response.get_json())
        shipped = response.get_json()
        self.assertEqual((shipped["status"], shipped["tracking"], shipped["carrier"]), ("transit", "1Z999AA1", "UPS"))
        self.assertEqual(self.ship(order_id).status_code, 409)

        photo = shipped["photos"]["before"][0]
        self.assertEqual(self.status(f"/api/shipments/{order_id}/photos/{photo}", AUTH), 200)
        self.assertEqual(self.status(f"/api/shipments/{order_id}/photos/{photo}", {"Authorization": "Bearer dev:456"}), 404)
        self.assertEqual(self.status(f"/api/admin/orders/{order_id}/photos/{photo}", ADMIN), 200)

        # Members can't use the admin endpoints.
        self.assertEqual(self.client.get("/api/admin/orders", headers=MEMBER).status_code, 403)
        self.assertEqual(self.client.patch(f"/api/admin/orders/{order_id}", headers=MEMBER, json={"status": "paid"}).status_code, 403)

        admin_view = self.client.get("/api/admin/orders", headers=ADMIN).get_json()["orders"][0]
        self.assertEqual((admin_view["seller"]["id"], admin_view["tracking"]), ("123", "1Z999AA1"))

        self.assertEqual(self.client.patch(f"/api/admin/orders/{order_id}", headers=ADMIN, json={"status": "bogus"}).status_code, 400)
        for status in ("received", "paid"):
            updated = self.client.patch(f"/api/admin/orders/{order_id}", headers=ADMIN, json={"status": status}).get_json()
            self.assertEqual(updated["status"], status)
        self.assertEqual([entry["status"] for entry in updated["history"]], ["submitted", "transit", "received", "paid"])
        self.assertEqual(updated["history"][-1]["by"], "900")

        # The member sees the new status.
        self.assertEqual(self.client.get("/api/orders", headers=AUTH).get_json()["orders"][0]["status"], "paid")



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
        self.assertEqual(self.client.get("/api/orders").status_code, 200)

        self.client.post("/auth/logout")
        self.assertEqual(self.client.get("/api/me").status_code, 401)

    def test_cancelled_on_discord(self):
        self.start_login()
        response = self.client.get("/auth/discord/callback?error=access_denied")
        self.assertEqual(response.headers["Location"], "/?login=cancelled")



ADMIN = {"Authorization": "Bearer dev:900", "X-Requested-With": "fetch"}
MEMBER = {"Authorization": "Bearer dev:123", "X-Requested-With": "fetch"}


class CatalogTest(unittest.TestCase):
    def setUp(self):
        self.client = main.app.test_client()
        main.PRODUCTS_FILE.unlink(missing_ok=True)
        shutil.rmtree(main.PRODUCT_IMAGE_DIR, ignore_errors=True)

    def create(self, **fields):
        body = {"name": "Surging Sparks ETB", "category": "Sealed", "cashout": 95, "quantity": 40, **fields}
        response = self.client.post("/api/admin/products", headers=ADMIN, json=body)
        self.assertEqual(response.status_code, 201, response.get_json())
        return response.get_json()

    def member_product_ids(self):
        return [p["id"] for p in self.client.get("/api/products", headers=MEMBER).get_json()["products"]]

    def test_members_see_the_starter_list(self):
        # Every starter product except the one that starts hidden
        self.assertEqual(len(self.member_product_ids()), len(main.DEFAULT_PRODUCTS) - 1)

    def test_only_admins_can_change_products(self):
        self.assertEqual(self.client.get("/api/admin/products", headers=MEMBER).status_code, 403)
        self.assertEqual(self.client.post("/api/admin/products", headers=MEMBER, json={"name": "x"}).status_code, 403)
        # Without the custom header (e.g. a form on another site) even an admin is refused.
        self.assertEqual(self.client.post("/api/admin/products", headers={"Authorization": "Bearer dev:900"}, json={}).status_code, 403)

    def test_create_edit_hide_and_delete(self):
        product = self.create(retailPrice="49.99")
        self.assertEqual((product["retailPrice"], product["active"]), (49.99, True))
        self.assertIn(product["id"], self.member_product_ids())

        updated = self.client.patch(f"/api/admin/products/{product['id']}", headers=ADMIN, json={"cashout": 110, "active": False}).get_json()
        self.assertEqual((updated["cashout"], updated["active"], updated["name"]), (110, False, "Surging Sparks ETB"))
        self.assertNotIn(product["id"], self.member_product_ids())

        self.assertEqual(self.client.delete(f"/api/admin/products/{product['id']}", headers=ADMIN).status_code, 204)
        self.assertEqual(self.client.patch(f"/api/admin/products/{product['id']}", headers=ADMIN, json={}).status_code, 404)

    def test_rejects_bad_fields(self):
        for body in ({"name": "", "category": "Sealed", "cashout": 1, "quantity": 1},
                     {"name": "x", "category": "Toys", "cashout": 1, "quantity": 1},
                     {"name": "x", "category": "Sealed", "cashout": -5, "quantity": 1},
                     {"name": "x", "category": "Sealed", "cashout": 1, "quantity": 1, "image": "javascript:alert(1)"}):
            with self.subTest(body=body):
                self.assertEqual(self.client.post("/api/admin/products", headers=ADMIN, json=body).status_code, 400)

    def test_image_upload_replaces_old_file(self):
        product = self.create()
        first = self.client.post(f"/api/admin/products/{product['id']}/image", headers=ADMIN,
                                 data={"image": (io.BytesIO(PNG), "a.png")}).get_json()["image"]
        self.assertEqual(self.status(first), 200)
        second = self.client.post(f"/api/admin/products/{product['id']}/image", headers=ADMIN,
                                  data={"image": (io.BytesIO(PNG), "b.png")}).get_json()["image"]
        self.assertNotEqual(first, second)
        self.assertEqual(self.status(first), 404)
        bad = self.client.post(f"/api/admin/products/{product['id']}/image", headers=ADMIN,
                               data={"image": (io.BytesIO(b"not an image"), "x.png")})
        self.assertEqual(bad.status_code, 400)

    def status(self, path):
        with self.client.get(path) as response:
            return response.status_code


if __name__ == "__main__":
    unittest.main()
