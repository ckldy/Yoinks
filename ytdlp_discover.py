import json
import os
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


def compact_entry(item: dict[str, Any], index: int) -> dict[str, Any] | None:
    url = item.get("webpage_url") or item.get("url")
    if not url or not isinstance(url, str):
        return None
    title = item.get("title") or "未命名视频"
    uploader = item.get("uploader") or item.get("channel") or item.get("uploader_id")
    duration = item.get("duration")
    thumbnails = item.get("thumbnails") or []
    thumbnail = thumbnails[-1].get("url") if isinstance(thumbnails, list) and thumbnails else item.get("thumbnail")
    return {
        "id": f"entry-{index}-{item.get('id') or index}",
        "url": url,
        "title": title,
        "uploader": uploader,
        "duration": duration,
        "thumbnail": thumbnail,
        "index": index,
    }


def main() -> None:
    # 抑制 stderr：Scripting 的 Shell.run 可能因 stderr 缓冲区满而 hang。
    sys.stderr = open(os.devnull, "w")
    args = sys.argv[1:]
    insecure = False
    flat_playlist = False
    search_mode = False
    related_mode = False
    max_items = 20
    start = 1

    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--insecure":
            insecure = True
        elif arg == "--flat-playlist":
            flat_playlist = True
        elif arg == "--search":
            search_mode = True
        elif arg == "--related":
            related_mode = True
        elif arg == "--max":
            i += 1
            if i < len(args):
                try:
                    max_items = max(1, min(50, int(args[i])))
                except ValueError:
                    pass
        elif arg == "--start":
            i += 1
            if i < len(args):
                try:
                    start = max(1, int(args[i]))
                except ValueError:
                    pass
        elif not arg.startswith("-"):
            break
        else:
            i += 1
            continue
        i += 1

    remaining = args[i:]
    if len(remaining) != 1:
        print(json.dumps({"ok": False, "error": "missing URL or query"}))
        raise SystemExit(2)

    raw_input = remaining[0]
    if search_mode:
        target = f"ytsearch{max_items}:{raw_input}"
        kind = "search"
    elif related_mode:
        if not safe_url(raw_input):
            print(json.dumps({"ok": False, "error": "invalid public http or https URL"}))
            raise SystemExit(2)
        target = raw_input
        kind = "related"
    else:
        if not safe_url(raw_input):
            print(json.dumps({"ok": False, "error": "invalid public http or https URL"}))
            raise SystemExit(2)
        target = raw_input
        kind = "playlist"

    options: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "socket_timeout": 45,
        "retries": 3,
        "extractor_retries": 3,
        "nocheckcertificate": insecure,
        "playliststart": start,
        "playlistend": start + max_items - 1,
    }
    if flat_playlist:
        options["extract_flat"] = True

    try:
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(target, download=False)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)[:1000]}))
        raise SystemExit(1)

    if not isinstance(info, dict):
        print(json.dumps({"ok": False, "error": "unexpected response from extractor"}))
        raise SystemExit(1)

    # related mode: derive a query from the source video title and search for related videos.
    if related_mode:
        title = info.get("title") or ""
        uploader = info.get("uploader") or ""
        if not isinstance(title, str) or not title.strip():
            # 第一次尝试可能因网络/反爬拿不到 title；用 flat 模式再快速试一次。
            try:
                with YoutubeDL({**options, "extract_flat": True, "playlist_items": "1"}) as ydl_flat:
                    flat_info = ydl_flat.extract_info(target, download=False)
                    if isinstance(flat_info, dict):
                        flat_entries = flat_info.get("entries") or []
                        if isinstance(flat_entries, list) and flat_entries and isinstance(flat_entries[0], dict):
                            title = flat_entries[0].get("title") or ""
                            uploader = flat_entries[0].get("uploader") or uploader
            except Exception:
                pass
        if not isinstance(title, str) or not title.strip():
            print(json.dumps({"ok": False, "error": "无法获取原视频标题，无法查找相关推荐"}))
            raise SystemExit(1)

        def _search_related(query: str) -> tuple[dict[str, Any] | None, int]:
            target_query = f"ytsearch{max_items}:{query}"
            try:
                with YoutubeDL({**options, "playlistend": max_items}) as ydl_q:
                    ri = ydl_q.extract_info(target_query, download=False)
            except Exception:
                return None, 0
            if not isinstance(ri, dict):
                return None, 0
            entries = ri.get("entries") or []
            if isinstance(ri, dict) and not entries and ri.get("webpage_url"):
                entries = [ri]
            return ri, len(entries)

        related_query = title.strip()
        related_info, item_count = _search_related(related_query)

        # B 站等中文平台的长标题在 YouTube 搜索效果极差；回退用 uploader 名再搜一次。
        if item_count <= 1 and isinstance(uploader, str) and uploader.strip():
            fallback_query = uploader.strip()
            fallback_info, fallback_count = _search_related(fallback_query)
            if fallback_count > item_count:
                related_info = fallback_info
                related_query = fallback_query

        if related_info is None:
            print(json.dumps({"ok": False, "error": "相关推荐搜索失败，请重试"}))
            raise SystemExit(1)

        info = related_info
        kind = "related"

    entries = info.get("entries") or []
    if isinstance(info, dict) and not entries and info.get("webpage_url"):
        # Single entry treated as a one-item playlist
        entries = [info]

    items: list[dict[str, Any]] = []
    for idx, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        compact = compact_entry(entry, idx)
        if compact:
            items.append(compact)

    total_available = info.get("playlist_count") or len(items)

    print(json.dumps({
        "ok": True,
        "kind": kind,
        "sourceURL": raw_input,
        "query": raw_input if search_mode else (related_query if related_mode else None),
        "items": items,
        "totalAvailable": total_available,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
