import json
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse

# ios_system 常驻 python 进程跨命令缓存 sys.modules：清掉 yt_dlp 全家与 protobug，
# 让 --plugin-dir（项目 UMP 插件目录）每次都被重新扫描并从此加载。
for _m in list(sys.modules):
    if _m.startswith('yt_dlp') or _m.startswith('protobug'):
        del sys.modules[_m]

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


def is_x_status_host(netloc: str) -> bool:
    host = (netloc or "").lower().split(":")[0]
    return host == "x.com" or host == "twitter.com" or host.endswith(".x.com") or host.endswith(".twitter.com")


def x_status_video_url(url: str, video_index: int = 1) -> str:
    """Pin an X/Twitter status URL to a concrete /video/N media item.

    Multi-video posts are extracted by yt-dlp as a playlist with empty top-level
    formats. Downloading the bare status URL with a format id from video 1 fails
    on later items. /video/N forces a single-video extract.
    """
    try:
        parsed = urlparse(url)
    except Exception:
        return url
    if not is_x_status_host(parsed.netloc):
        return url
    match = re.match(
        r"^(/(?:[^/]+|i)/status/\d+)(?:/video/(\d+))?/?$",
        parsed.path or "",
        flags=re.IGNORECASE,
    )
    if not match:
        return url
    existing = match.group(2)
    index = int(existing) if existing else max(1, int(video_index or 1))
    path = f"{match.group(1)}/video/{index}"
    return urlunparse((parsed.scheme, parsed.netloc, path, "", parsed.query, ""))


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


def select_media_info(info: dict[str, Any], source_url: str) -> dict[str, Any]:
    """Return the info dict that actually carries formats.

    X/Twitter multi-video posts come back as `_type=playlist` with formats only
    on entries. Prefer the first entry that has formats, and rewrite webpage_url
    to /video/N so subsequent downloads stay single-item.
    """
    top_formats = info.get("formats") or []
    if top_formats:
        return info

    entries = [entry for entry in (info.get("entries") or []) if isinstance(entry, dict)]
    selected = next((entry for entry in entries if entry.get("formats")), None)
    if not selected:
        # Some extractors put a single direct url on the entry without formats[].
        selected = next(
            (
                entry
                for entry in entries
                if entry.get("url") and (entry.get("ext") or entry.get("format_id") or entry.get("height"))
            ),
            None,
        )
    if not selected:
        return info

    merged = dict(selected)
    # Keep human title from the parent post when entry title is only a fragment.
    if not merged.get("title"):
        merged["title"] = info.get("title")
    if not merged.get("uploader"):
        merged["uploader"] = info.get("uploader") or info.get("channel")
    if not merged.get("thumbnail"):
        merged["thumbnail"] = info.get("thumbnail")
    if not merged.get("duration"):
        merged["duration"] = info.get("duration")

    playlist_index = selected.get("playlist_index") or 1
    try:
        playlist_index = int(playlist_index)
    except Exception:
        playlist_index = 1
    base_webpage = (
        selected.get("webpage_url")
        or info.get("webpage_url")
        or info.get("original_url")
        or source_url
    )
    merged["webpage_url"] = x_status_video_url(str(base_webpage), playlist_index)
    # Expose parent multi-count for UI/logging without changing MediaProbe schema yet.
    merged["_yoinks_playlist_count"] = info.get("playlist_count") or len(entries)
    merged["_yoinks_playlist_index"] = playlist_index
    return merged


def formats_from_info(info: dict[str, Any]) -> list[dict[str, Any]]:
    formats = [
        compact_format(item, info)
        for item in (info.get("formats") or [])
        if item.get("format_id")
    ]
    if formats:
        return formats
    # Fallback: single direct media url with no formats list.
    if info.get("url") and (info.get("format_id") or info.get("ext") or info.get("height")):
        synthetic = {
            "format_id": info.get("format_id") or "0",
            "ext": info.get("ext"),
            "vcodec": info.get("vcodec"),
            "acodec": info.get("acodec"),
            "height": info.get("height"),
            "width": info.get("width"),
            "fps": info.get("fps"),
            "abr": info.get("abr"),
            "tbr": info.get("tbr"),
            "filesize": info.get("filesize") or info.get("filesize_approx"),
            "url": info.get("url"),
            "http_headers": info.get("http_headers"),
            "referer": info.get("referer"),
        }
        return [compact_format(synthetic, info)]
    return []


def main() -> None:
    args = sys.argv[1:]
    insecure = False
    referer: str | None = None
    user_agent: str | None = None
    plugin_dirs: list[str] = []
    positional: list[str] = []
    index = 0
    while index < len(args):
        value = args[index]
        if value == "--insecure":
            insecure = True
        elif value == "--plugin-dir":
            if index + 1 >= len(args):
                print(json.dumps({"ok": False, "error": f"missing value for {value}"}))
                raise SystemExit(2)
            plugin_dir = args[index + 1]
            if not Path(plugin_dir).is_dir():
                print(json.dumps({"ok": False, "error": f"plugin dir not found: {plugin_dir}"}))
                raise SystemExit(2)
            plugin_dirs.append(str(Path(plugin_dir).resolve()))
            index += 1
        elif value in {"--referer", "--user-agent"}:
            if index + 1 >= len(args):
                print(json.dumps({"ok": False, "error": f"missing value for {value}"}))
                raise SystemExit(2)
            header_value = args[index + 1]
            if "\r" in header_value or "\n" in header_value:
                print(json.dumps({"ok": False, "error": f"unsafe value for {value}"}))
                raise SystemExit(2)
            if value == "--referer":
                referer = header_value if safe_url(header_value) else None
                if referer is None:
                    print(json.dumps({"ok": False, "error": "invalid public Referer"}))
                    raise SystemExit(2)
            else:
                user_agent = header_value
            index += 1
        elif value.startswith("--"):
            print(json.dumps({"ok": False, "error": f"unknown option: {value}"}))
            raise SystemExit(2)
        else:
            positional.append(value)
        index += 1

    if len(positional) not in {1, 2}:
        print(json.dumps({"ok": False, "error": "missing URL"}))
        raise SystemExit(2)

    url = positional[0]
    cookiefile = positional[1] if len(positional) == 2 else None
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
        "nocheckcertificate": insecure,
        # This device has no JS runtime; use android_vr so YouTube formats do not depend on web nsig decryption.
        "extractor_args": {"youtube": {"player_client": ["android_vr"]}},
    }
    if plugin_dirs:
        options["plugin_dirs"] = plugin_dirs
    if cookiefile:
        options["cookiefile"] = cookiefile
    if referer:
        options["http_headers"] = {"Referer": referer}
        if user_agent:
            options["http_headers"]["User-Agent"] = user_agent
    try:
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)[:1000]}))
        raise SystemExit(1)

    if not isinstance(info, dict):
        print(json.dumps({"ok": False, "error": "媒体探测返回了空结果"}))
        raise SystemExit(1)

    media = select_media_info(info, url)
    formats = formats_from_info(media)
    if not formats:
        print(json.dumps({
            "ok": False,
            "error": "未找到可下载的视频格式（该帖可能是纯文字/图文，或需要登录后才能访问媒体）",
        }, ensure_ascii=False))
        raise SystemExit(1)
    payload = {
        "ok": True,
        "title": media.get("title") or info.get("title") or "未命名媒体",
        "uploader": media.get("uploader") or media.get("channel") or info.get("uploader") or info.get("channel"),
        "duration": media.get("duration") if media.get("duration") is not None else info.get("duration"),
        "thumbnail": media.get("thumbnail") or info.get("thumbnail"),
        "webpageUrl": media.get("webpage_url") or info.get("webpage_url") or url,
        "formats": formats,
    }
    playlist_count = media.get("_yoinks_playlist_count")
    playlist_index = media.get("_yoinks_playlist_index")
    if isinstance(playlist_count, int) and playlist_count > 1:
        payload["playlistCount"] = playlist_count
        if isinstance(playlist_index, int):
            payload["playlistIndex"] = playlist_index
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
