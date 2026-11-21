import io
import os
import runpy
import unittest
from pathlib import Path
from unittest import mock
from urllib.request import HTTPRedirectHandler


fetch = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/check-vendor-advisories.py"))["fetch"]


class AdvisoryCredentialsTest(unittest.TestCase):
    @mock.patch.dict(os.environ, {"GH_TOKEN": "test-only"})
    def test_token_is_limited_to_the_original_api_request(self):
        with mock.patch("urllib.request.urlopen", side_effect=lambda *a, **kw: io.BytesIO(b"{}")) as send:
            fetch("https://api.github.com/advisories")
            original = send.call_args.args[0]
            self.assertEqual(original.get_header("Authorization"), "Bearer test-only")
            redirect = HTTPRedirectHandler().redirect_request(
                original, None, 302, "", {}, "https://example.invalid/"
            )
            self.assertIsNone(redirect.get_header("Authorization"))
            fetch("https://registry.npmjs.org/example")
            self.assertIsNone(send.call_args.args[0].get_header("Authorization"))
