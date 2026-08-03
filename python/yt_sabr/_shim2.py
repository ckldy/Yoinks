"""Yoinks 本地 shim：替代 pytubefix.monostate / pytubefix.exceptions 依赖。

ServerAbrStream 依赖 Monostate（提供 youtube 对象供 reload 刷新 URL/config）
与 SABRError。这里用最小实现替代，避免引入整个 pytubefix 包。
"""
import os
import ssl


class SABRError(Exception):
    pass


def ssl_context():
    """MITM/抓包环境（iOS 代理替换证书）下 Python 默认 trust store 不含代理根证书，
    显式使用 AppGroup cacert.pem（已含代理根 CA）。找不到或加载失败时返回 None（走默认）。"""
    cafile = os.environ.get("SSL_CERT_FILE") or os.environ.get("REQUESTS_CA_BUNDLE")
    if cafile and os.path.exists(cafile):
        try:
            return ssl.create_default_context(cafile=cafile)
        except Exception:
            pass
    return None


def open_request(request, timeout=None):
    """urllib.request.urlopen 包装：优先使用 AppGroup cacert（信任 MITM 根证书）。"""
    from urllib.request import urlopen
    ctx = ssl_context()
    if ctx is not None:
        return urlopen(request, context=ctx, timeout=timeout)
    return urlopen(request, timeout=timeout)


class Monostate:
    """最小单例容器：youtube 由驱动注入（含 server_abr_streaming_url /
    video_playback_ustreamer_config 属性，供 reload 使用）。"""

    def __init__(self, youtube=None):
        self.youtube = youtube
