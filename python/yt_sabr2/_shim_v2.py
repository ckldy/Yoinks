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


def _is_ssl_cert_error(exc):
    """仅 SSL 证书类错误才降级；HTTP 4xx/5xx、超时等直接抛出（避免重复请求 3 次）。"""
    reason = getattr(exc, "reason", None)
    return isinstance(reason, ssl.SSLError)


def open_request(request, timeout=None, insecure=None):
    """urllib.request.urlopen 包装，对齐 yt-dlp --insecure/--no-check-certificate。

    insecure=True（或环境变量 YOINKS_UMP_INSECURE=1）时直接使用
    ssl._create_unverified_context()，跳过一切证书验证（yt-dlp 同款行为），
    一步到位，不做任何级联尝试。

    未开启 insecure 时保留信任链级联：
    1) AppGroup cacert（信任 MITM 根 CA）→ 2) Python 默认 store → 3) 不验证兜底。
    级联只对 SSL 证书类错误降级；HTTP 4xx/5xx、超时等非 SSL 错误直接抛出。
    googlevideo 走直通（非 MITM），呈现 Google 真实证书但缺 WR2 中间证书，
    默认 store 也验不过；媒体流本身为公开内容且经用户自己的代理，最终兜底对齐
    yt-dlp --no-check-certificate 行为。未显式传 timeout 时默认 60s，避免 POST 挂死。
    """
    from urllib.error import HTTPError, URLError
    from urllib.request import urlopen

    if timeout is None:
        timeout = 10
    if insecure is None:
        insecure = os.environ.get("YOINKS_UMP_INSECURE") == "1"
    if insecure:
        return urlopen(request, context=ssl._create_unverified_context(), timeout=timeout)
    ctx = ssl_context()
    if ctx is not None:
        try:
            return urlopen(request, context=ctx, timeout=timeout)
        except HTTPError:
            raise
        except URLError as e:
            if not _is_ssl_cert_error(e):
                raise
    try:
        return urlopen(request, timeout=timeout)
    except HTTPError:
        raise
    except URLError as e:
        if not _is_ssl_cert_error(e):
            raise
    unverified = ssl._create_unverified_context()
    return urlopen(request, context=unverified, timeout=timeout)


class Monostate:
    """最小单例容器：youtube 由驱动注入（含 server_abr_streaming_url /
    video_playback_ustreamer_config 属性，供 reload 使用）。"""

    def __init__(self, youtube=None):
        self.youtube = youtube
