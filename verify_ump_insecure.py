#!/usr/bin/env python3
"""verify_ump_insecure.py — UMP --insecure（yt-dlp 风格）绕开 TLS 验证。

断言：
1. insecure=True → 直接使用 ssl._create_unverified_context()（verify_mode=CERT_NONE），单次调用
2. insecure=False + 默认 store SSL 证书失败 → 降级 unverified 兜底
3. insecure=False + HTTP 错误 → 直接抛出，不降级（不重复请求）
4. 环境变量 YOINKS_UMP_INSECURE=1 → 等效 insecure=True（驱动 --insecure 设该变量）
5. v2/v1 驱动源码支持 --insecure / --no-check-certificate 解析
"""
import os
import ssl
import sys
import unittest
from unittest import mock
from urllib.error import HTTPError, URLError

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "python"))
# ios_system python3 是常驻进程，sys.modules 跨命令缓存：先清除旧模块再 import，
# 否则可能验证到上一会话缓存的旧代码（驱动运行时同样受此影响，驱动已自带清除）。
for _m in list(sys.modules):
    if _m == "yt_sabr2" or _m.startswith("yt_sabr2."):
        del sys.modules[_m]
from yt_sabr2 import _shim_v2

DRIVER_V2 = os.path.join(os.path.dirname(os.path.abspath(__file__)), "python", "yt_sabr_download_v2.py")
DRIVER_V1 = os.path.join(os.path.dirname(os.path.abspath(__file__)), "python", "yt_sabr_download.py")


def _ssl_error():
    return URLError(ssl.SSLCertVerificationError(1, "certificate verify failed"))


class TestOpenRequestInsecure(unittest.TestCase):
    def setUp(self):
        os.environ.pop("YOINKS_UMP_INSECURE", None)
        os.environ.pop("SSL_CERT_FILE", None)
        os.environ.pop("REQUESTS_CA_BUNDLE", None)

    def _run(self, insecure=None, env_insecure=False):
        calls = []

        def fake_urlopen(request, context=None, timeout=None):
            calls.append((context, timeout))
            if len(calls) == 1 and env_insecure is False and insecure is False:
                raise _ssl_error()
            return mock.MagicMock()

        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
            _shim_v2.open_request(mock.MagicMock(), insecure=insecure)
        return calls

    def test_insecure_direct_unverified_single_call(self):
        calls = self._run(insecure=True)
        self.assertEqual(len(calls), 1, "insecure 模式必须单次调用，不做级联")
        self.assertEqual(calls[0][0].verify_mode, ssl.CERT_NONE, "必须使用不验证 context")
        self.assertEqual(calls[0][0].check_hostname, False)

    def test_default_store_ssl_failure_degrades_to_unverified(self):
        calls = self._run(insecure=False)
        self.assertEqual(len(calls), 2, "默认 store 失败后降级 unverified 兜底")
        self.assertEqual(calls[-1][0].verify_mode, ssl.CERT_NONE)

    def test_http_error_not_degraded(self):
        calls = []

        def fake_urlopen(request, context=None, timeout=None):
            calls.append(context)
            raise HTTPError("https://x", 403, "Forbidden", None, None)

        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
            with self.assertRaises(HTTPError):
                _shim_v2.open_request(mock.MagicMock(), insecure=False)
        self.assertEqual(len(calls), 1, "HTTP 403 必须直接抛出，不重复请求")

    def test_env_var_equivalent_to_insecure(self):
        os.environ["YOINKS_UMP_INSECURE"] = "1"
        calls = self._run(insecure=None)
        self.assertEqual(len(calls), 1, "环境变量必须等效 insecure=True")
        self.assertEqual(calls[0][0].verify_mode, ssl.CERT_NONE)

    def test_drivers_support_insecure_flag(self):
        for path, name in ((DRIVER_V2, "v2"), (DRIVER_V1, "v1")):
            with open(path, encoding="utf-8") as fh:
                src = fh.read()
            self.assertIn("--insecure", src, f"{name} 驱动必须解析 --insecure")
            self.assertIn("--no-check-certificate", src, f"{name} 驱动必须兼容 --no-check-certificate")
            self.assertIn('YOINKS_UMP_INSECURE', src, f"{name} 驱动必须设置 YOINKS_UMP_INSECURE")
            self.assertIn("sys.modules", src, f"{name} 驱动必须带常驻进程模块缓存清除（sys.modules）")


if __name__ == "__main__":
    unittest.main(verbosity=2)
