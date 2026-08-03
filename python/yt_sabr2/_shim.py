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
    """urllib.request.urlopen 包装，信任链级联：
    1) AppGroup cacert（信任 MITM 根 CA）→ 2) Python 默认 store → 3) 不验证（兜底）。
    googlevideo 走直通（非 MITM），呈现 Google 真实证书但缺 WR2 中间证书，
    默认 store 也验不过；媒体流本身为公开内容且经用户自己的代理，最终兜底对齐
    yt-dlp --no-check-certificate 行为。
    """
    from urllib.request import urlopen

    last_error = None
    ctx = ssl_context()
    if ctx is not None:
        try:
            return urlopen(request, context=ctx, timeout=timeout)
        except Exception as e:
            last_error = e
    try:
        return urlopen(request, timeout=timeout)
    except Exception as e:
        last_error = e
    try:
        unverified = ssl._create_unverified_context()
        return urlopen(request, context=unverified, timeout=timeout)
    except Exception as e:
        raise e


class Monostate:
    """最小单例容器：youtube 由驱动注入（含 server_abr_streaming_url /
    video_playback_ustreamer_config 属性，供 reload 使用）。"""

    def __init__(self, youtube=None):
        self.youtube = youtube
