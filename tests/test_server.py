"""Testen van server.py. Start met: tests/run.sh"""
import http.client
import json
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        data = Path(cls.tmp.name)
        server.DATA, server.DB, server.SEED, server.BACKUPS = data, data / "db.json", data / "seed.json", data / "backups"
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        server.PORT = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def call(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", server.PORT)
        conn.request(method, path, body=body, headers=headers or {})
        res = conn.getresponse()
        text = res.read().decode()
        conn.close()
        return res.status, text

    def test_opslaan_en_lezen(self):
        doc = json.dumps({"version": 2, "hospitals": [{"id": "a"}]})
        self.assertEqual(self.call("PUT", "/api/data", doc)[0], 200)
        self.assertEqual(json.loads(self.call("GET", "/api/data")[1])["hospitals"][0]["id"], "a")

    def test_ongeldige_data_wordt_geweigerd(self):
        self.assertEqual(self.call("PUT", "/api/data", '{"x":1}')[0], 400)
        self.assertEqual(self.call("PUT", "/api/data", "geen json")[0], 400)

    def test_back_ups(self):
        self.call("PUT", "/api/data", json.dumps({"hospitals": [{"id": "b"}]}))
        days = json.loads(self.call("GET", "/api/backups")[1])
        self.assertTrue(days)
        self.assertEqual(self.call("GET", f"/api/backups/{days[0]}")[0], 200)
        self.assertEqual(self.call("GET", "/api/backups/1999-01-01")[0], 404)
        self.assertEqual(self.call("GET", "/api/backups/..%2F..%2Fsecret")[0], 404)

    def test_ander_domein_en_andere_website_geweigerd(self):
        self.assertEqual(self.call("GET", "/api/data", headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(self.call("PUT", "/api/data", "{}", {"Host": "evil.example"})[0], 403)
        self.assertEqual(self.call("PUT", "/api/data", "{}", {"Origin": "https://evil.example"})[0], 403)


if __name__ == "__main__":
    unittest.main()
