import html
import re
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.desktop_auth_callback import router


class DesktopAuthCallbackTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(router, prefix="/api/desktop/auth")
        self.client = TestClient(app)
        self.path = "/api/desktop/auth/callback/" + "a" * 48

    def app_link(self, response):
        target = re.search(r'id="return-to-app" href="([^"]+)"', response.text).group(1)
        return urlparse(html.unescape(target))

    def test_code_goes_only_to_fixed_app_and_never_forwards_tokens_or_destinations(self):
        response = self.client.get(
            self.path,
            params={
                "code": "synthetic-code",
                "next": "https://untrusted.invalid/",
                "access_token": "do-not-forward",
                "refresh_token": "do-not-forward",
            },
        )
        self.assertEqual(response.status_code, 200)
        link = self.app_link(response)
        self.assertEqual(
            (link.scheme, link.netloc, link.path), ("context-desktop", "auth", "/callback")
        )
        self.assertEqual(parse_qs(link.query), {"state": ["a" * 48], "code": ["synthetic-code"]})
        self.assertNotIn("do-not-forward", response.text)
        self.assertNotIn("untrusted.invalid", response.text)

    def test_cancel_is_forwarded_without_upstream_description(self):
        response = self.client.get(
            self.path, params={"error": "access_denied", "error_description": "private details"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            parse_qs(self.app_link(response).query),
            {"state": ["a" * 48], "error": ["access_denied"]},
        )
        self.assertNotIn("private details", response.text)

    def test_missing_ambiguous_or_duplicate_codes_are_rejected(self):
        for query in [
            "",
            "?code=one&error=denied",
            "?code=one&code=two",
            "?error=one&error=two",
            "?code=%00",
        ]:
            with self.subTest(query=query):
                self.assertEqual(self.client.get(self.path + query).status_code, 400)
        self.assertEqual(
            self.client.get("/api/desktop/auth/callback/invalid?code=x").status_code, 422
        )

    def test_active_content_is_encoded_and_response_is_private(self):
        response = self.client.get(
            self.path, params={"code": '</script><script>alert("x")</script>'}
        )
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("</script><script>alert", response.text)
        self.assertEqual(
            parse_qs(self.app_link(response).query)["code"],
            ['</script><script>alert("x")</script>'],
        )
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(response.headers["referrer-policy"], "no-referrer")
        self.assertIn("frame-ancestors 'none'", response.headers["content-security-policy"])
        nonce = re.search(r'<script nonce="([^"]+)"', response.text).group(1)
        self.assertIn("'nonce-" + nonce + "'", response.headers["content-security-policy"])
        self.assertIn("history.replaceState", response.text)

    def test_real_auth_router_advertises_and_mounts_the_server_callback(self):
        from app.api.ai import auth_router

        app = FastAPI()
        app.include_router(auth_router)
        settings = SimpleNamespace(
            supabase_url="https://auth.example.test",
            supabase_publishable_key="synthetic-public-key",
            unified_api_url="",
            web_base_url="",
        )
        with patch("app.api.ai.get_settings", return_value=settings), TestClient(app) as client:
            response = client.get("/api/desktop/auth/config")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["desktop_callback_path"], "/api/desktop/auth/callback")
            self.assertEqual(
                client.get(self.path, params={"code": "synthetic-code"}).status_code, 200
            )


if __name__ == "__main__":
    unittest.main()
