import json
import os
import sys
import threading
import time
from urllib.parse import urlparse

from yt_dlp import YoutubeDL


class DownloadCancelled(Exception):
    pass


def safe_http_url(value):
    if not isinstance(value, str):
        return False
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def require_path_within(value, root, name):
    if not isinstance(value, str) or not os.path.isabs(value):
        raise SystemExit(f"Invalid {name}")
    path = os.path.abspath(value)
    if os.path.commonpath([path, root]) != root:
        raise SystemExit(f"Invalid {name}")
    return path


def best_thumbnail(info):
    thumbnails = info.get("thumbnails") or []
    for item in reversed(thumbnails):
        url = item.get("url")
        if url:
            return url
    return info.get("thumbnail")


def print_metadata(info, fallback_url):
    metadata = {
        "id": info.get("id"),
        "title": info.get("title"),
        "description": info.get("description"),
        "webpage_url": info.get("webpage_url") or info.get("original_url") or fallback_url,
        "thumbnail": best_thumbnail(info),
    }
    print("MEDIA_DOWNLOADER_METADATA " + json.dumps(metadata, ensure_ascii=False))


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Missing config path")

    config_path = os.path.abspath(sys.argv[1])
    task_root = os.path.dirname(config_path)
    with open(config_path, "r", encoding="utf-8") as file:
        config = json.load(file)

    source_url = config.get("url")
    output_directory = require_path_within(config.get("paths"), task_root, "output directory")
    if not safe_http_url(source_url):
        raise SystemExit("Invalid media URL")
    if not isinstance(config.get("format"), str) or not config["format"]:
        raise SystemExit("Invalid media format")
    if not isinstance(config.get("output"), str) or not config["output"]:
        raise SystemExit("Invalid output template")
    progress_path = require_path_within(config.get("progress_path"), task_root, "progress path")
    cancel_flag = require_path_within(config.get("cancel_flag"), task_root, "cancel path")

    finished_paths = []

    def write_progress(status):
        if not progress_path:
            return
        downloaded = status.get("downloaded_bytes") or 0
        total = status.get("total_bytes") or status.get("total_bytes_estimate")
        fragment_index = status.get("fragment_index")
        fragment_count = status.get("fragment_count")
        percent = None
        if total:
            percent = max(0, min(100, downloaded * 100 / total))
        elif fragment_index and fragment_count:
            percent = max(0, min(100, fragment_index * 100 / fragment_count))
        elif status.get("_percent_str"):
            try:
                percent = float(str(status.get("_percent_str")).strip().replace("%", ""))
            except Exception:
                percent = None
        payload = {
            "status": status.get("status"),
            "percent": percent,
            "downloadedBytes": downloaded,
            "totalBytes": total,
            "speed": status.get("speed"),
            "eta": status.get("eta"),
            "fragmentIndex": fragment_index,
            "fragmentCount": fragment_count,
            "updatedAt": time.time(),
        }
        tmp_path = f"{progress_path}.{threading.get_ident()}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as file:
            json.dump(payload, file)
        os.replace(tmp_path, progress_path)

    def progress_hook(status):
        write_progress(status)
        if cancel_flag and os.path.exists(cancel_flag):
            raise DownloadCancelled("Download canceled")
        if status.get("status") != "finished":
            return
        filename = status.get("filename")
        if filename:
            finished_paths.append(os.path.abspath(filename))

    options = {
        "format": config["format"],
        "format_sort": config.get("format_sort") or [],
        "noplaylist": True,
        "quiet": False,
        "no_warnings": False,
        "nocheckcertificate": bool(config.get("no_check_certificates", False)),
        "retries": 3,
        "fragment_retries": 3,
        "overwrites": False,
    }

    cookiefile = config.get("cookiefile")
    if cookiefile:
        cookiefile = require_path_within(cookiefile, task_root, "cookie file")
        if not os.path.isfile(cookiefile):
            raise SystemExit("Cookie file is unavailable")
        options["cookiefile"] = cookiefile

    if config.get("extract_audio"):
        options.update({
            "format": "bestaudio/best",
            "postprocessors": [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "0",
            }],
        })

    options["concurrent_fragment_downloads"] = min(8, max(1, int(config.get("concurrent_fragments", 2))))
    options.update({
        "outtmpl": config["output"],
        "paths": {"home": output_directory},
        "progress_hooks": [progress_hook],
    })

    try:
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(config["url"], download=True)
    except DownloadCancelled as error:
        print("MEDIA_DOWNLOADER_CANCELLED " + str(error))
        raise SystemExit(130)
    except BaseException:
        if cancel_flag and os.path.exists(cancel_flag):
            print("MEDIA_DOWNLOADER_CANCELLED Download canceled")
            raise SystemExit(130)
        raise

    print_metadata(info, source_url)

    with YoutubeDL(options) as ydl:
        for item in info.get("requested_downloads") or []:
            path = item.get("filepath") or item.get("_filename")
            if path:
                finished_paths.append(os.path.abspath(path))
        if not finished_paths:
            path = ydl.prepare_filename(info)
            if path:
                finished_paths.append(os.path.abspath(path))

    seen = set()
    for path in finished_paths:
        if not os.path.exists(path):
            continue
        if path in seen:
            continue
        seen.add(path)
        print(path)


if __name__ == "__main__":
    main()
