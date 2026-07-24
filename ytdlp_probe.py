import json
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

try:
    from yt_dlp import YoutubeDL
except ImportError:
    print(json.dumps({"ok": False, "error": "yt-dlp is unavailable"}))
    raise SystemExit(2)


def safe_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
        return parsed.scheme in {"http", "https"} and bool(parsed.netloc)
    except Exception:
        return False


def compact_format(item: dict[str, Any], info: dict[str, Any]) -> dict[str, Any]:
    result = {
        "formatId": str(item.get("format_id") or ""),
        "ext": item.get("ext"),
        "vcodec": item.get("vcodec"),
        "acodec": item.get("acodec"),
        "height": item.get("height"),
        "width": item.get("width"),
        "fps": item.get("fps"),
        "abr": item.get("abr"),
        "tbr": item.get("tbr"),
        "filesize": item.get("filesize") or item.get("filesize_approx"),
        "previewURL": item.get("url"),
    }
    # 预览请求头：yt-dlp 可能在 format 中提供 http_headers
    http_headers = item.get("http_headers") if isinstance(item.get("http_headers"), dict) else {}
    info_headers = info.get("http_headers") if isinstance(info.get("http_headers"), dict) else {}
    if http_headers:
        # 过滤掉浏览器受限字段，只保留可通过 JS 注入的自定义头
        restricted = {
            "referer", "origin", "host", "connection", "content-length",
            "user-agent", "cookie", "sec-fetch-dest", "sec-fetch-mode",
            "sec-fetch-site", "sec-fetch-user", "upgrade-insecure-requests"
        }
        filtered = {}
        for k, v in http_headers.items():
            if isinstance(v, str) and k.lower() not in restricted:
                filtered[k] = v
        if filtered:
            result["previewHeaders"] = filtered
    # Referer：item.referer → http_headers.Referer → info.referer → webpage_url
    # B 站 bilivideo 常只在 http_headers 里带 Referer；丢掉会导致画面 403、音频仍可能播。
    header_referer = None
    for headers in (http_headers, info_headers):
        for key, value in headers.items():
            if isinstance(value, str) and key.lower() == "referer" and value:
                header_referer = value
                break
        if header_referer:
            break
    referer = item.get("referer") or header_referer or info.get("referer") or info.get("webpage_url")
    if referer and isinstance(referer, str):
        result["previewReferer"] = referer
    return result


def main() -> None:
    if len(sys.argv) not in {2, 3}:
        print(json.dumps({"ok": False, "error": "missing URL"}))
        raise SystemExit(2)

    url = sys.argv[1]
    cookiefile = sys.argv[2] if len(sys.argv) == 3 else None
    if not safe_url(url):
        print(json.dumps({"ok": False, "error": "invalid public http or https URL"}))
        raise SystemExit(2)
    if cookiefile and not Path(cookiefile).is_file():
        print(json.dumps({"ok": False, "error": "cookie file is unavailable"}))
        raise SystemExit(2)

    options = {
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        # Short links (TikTok/vm) often need a longer first-hop; default is too tight on mobile nets.
        "socket_timeout": 45,
        "retries": 3,
        "extractor_retries": 3,
    }
    if cookiefile:
        options["cookiefile"] = cookiefile
    try:
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)[:1000]}))
        raise SystemExit(1)

    formats = [compact_format(item, info) for item in (info.get("formats") or []) if item.get("format_id")]
    print(json.dumps({
        "ok": True,
        "title": info.get("title") or "未命名媒体",
        "uploader": info.get("uploader") or info.get("channel"),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "webpageUrl": info.get("webpage_url") or url,
        "formats": formats,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
