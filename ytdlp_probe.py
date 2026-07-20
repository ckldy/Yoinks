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


def compact_format(item: dict[str, Any]) -> dict[str, Any]:
    return {
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
    }
    if cookiefile:
        options["cookiefile"] = cookiefile
    try:
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)[:1000]}))
        raise SystemExit(1)

    formats = [compact_format(item) for item in (info.get("formats") or []) if item.get("format_id")]
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
