"""
B站 Web 发现工具: search + related.
不走 yt-dlp, 直接 HTTP 调 B站 API, 与 bilibili_space_discover.py 共用 SSL 配置.
"""
import base64
import hashlib
import html as _html
import json
import math
import random
import re
import ssl
import string
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

SSL_CONTEXT = ssl.create_default_context()
SSL_CONTEXT.check_hostname = False
SSL_CONTEXT.verify_mode = ssl.CERT_NONE

DESKTOP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.bilibili.com/",
    "Origin": "https://www.bilibili.com",
    "Accept-Language": "en,zh-CN;q=0.9,zh;q=0.8",
}

MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]


def _clean_html(text: str) -> str:
    """去掉 B站搜索返回的 <em> 高亮标签并反转义."""
    return _html.unescape(re.sub(r"<[^>]+>", "", text)).strip()


def _full_url(u: str) -> str:
    """补全 // 开头的 URL."""
    if u.startswith("//"):
        return f"https:{u}"
    return u


def http_get(url: str, timeout: int = 20) -> dict[str, Any]:
    req = urllib.request.Request(url, headers=DESKTOP_HEADERS)
    with urllib.request.urlopen(req, context=SSL_CONTEXT, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_mixin_key(orig: str) -> str:
    return "".join([orig[i] for i in MIXIN_KEY_ENC_TAB])[:32]


def enc_wbi(params: dict[str, Any], img_key: str, sub_key: str) -> dict[str, Any]:
    mixin = get_mixin_key(img_key + sub_key)
    cur_time = int(time.time())
    params["wts"] = cur_time
    params = dict(sorted(params.items()))
    query = urllib.parse.urlencode(params)
    params["w_rid"] = hashlib.md5((query + mixin).encode()).hexdigest()
    return params


def get_wbi_keys() -> tuple[str, str]:
    data = http_get("https://api.bilibili.com/x/web-interface/nav")
    wbi = data.get("data", {}).get("wbi_img", {})
    img_key = Path(wbi.get("img_url", "")).stem
    sub_key = Path(wbi.get("sub_url", "")).stem
    if not img_key or not sub_key:
        raise RuntimeError("无法获取 WBI 签名密钥")
    return img_key, sub_key


def extract_bvid(url: str) -> str | None:
    m = re.search(r"BV[0-9A-Za-z]{10}", url)
    return m.group(0) if m else None


def discover_search(query: str, max_items: int, page: int = 1) -> dict[str, Any]:
    """B站关键词搜索 (WBI 签名)."""
    img_key, sub_key = get_wbi_keys()
    params = enc_wbi({
        "search_type": "video",
        "keyword": query,
        "page": page,
        "page_size": max_items,
    }, img_key, sub_key)
    url = f"https://api.bilibili.com/x/web-interface/wbi/search/type?{urllib.parse.urlencode(params)}"
    data = http_get(url, timeout=30)
    if data.get("code") != 0:
        return {"ok": False, "error": f"B站搜索失败 (code={data.get('code')}): {data.get('message', '')}"}

    result = data.get("data", {}).get("result") or []
    if isinstance(result, dict):
        result = result.get("result") or result.get("video") or []

    num_results = data.get("data", {}).get("numResults") or 0
    num_pages = data.get("data", {}).get("numPages") or 1

    items: list[dict[str, Any]] = []
    for idx, v in enumerate(result[:max_items]):
        if not isinstance(v, dict):
            continue
        bvid = v.get("bvid") or ""
        url_v = f"https://www.bilibili.com/video/{bvid}" if bvid else (v.get("arcurl") or "")
        if not url_v:
            continue
        dur = v.get("duration")
        duration_seconds = 0
        if isinstance(dur, (int, float)):
            duration_seconds = int(dur)
        elif isinstance(dur, str):
            parts = dur.split(":")
            try:
                if len(parts) == 2:
                    duration_seconds = int(parts[0]) * 60 + int(parts[1])
                elif len(parts) == 3:
                    duration_seconds = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
            except ValueError:
                duration_seconds = 0
        items.append({
            "id": f"search-{idx}-{bvid or idx}",
            "url": url_v,
            "title": _clean_html(v.get("title") or "未命名"),
            "uploader": v.get("author") or "",
            "duration": duration_seconds,
            "thumbnail": _full_url(v.get("pic") or ""),
            "index": idx,
        })

    # API 偶发不返回 numResults，兜底用当前页条数避免 totalPages 变成 0
    if num_results < len(items):
        num_results = len(items)
    if num_pages < 1:
        num_pages = 1

    return {
        "ok": True, "kind": "search", "query": query,
        "items": items, "totalAvailable": num_results,
        "totalPages": num_pages, "page": page,
    }


def discover_related(bvid: str, max_items: int) -> dict[str, Any]:
    """B站相关推荐 (无需签名)."""
    url = f"https://api.bilibili.com/x/web-interface/archive/related?bvid={bvid}"
    data = http_get(url, timeout=20)
    if data.get("code") != 0:
        return {"ok": False, "error": f"B站相关推荐失败 (code={data.get('code')}): {data.get('message', '')}"}

    result = data.get("data") or []
    items: list[dict[str, Any]] = []
    for idx, v in enumerate(result[:max_items]):
        if not isinstance(v, dict):
            continue
        bv = v.get("bvid") or ""
        url_v = f"https://www.bilibili.com/video/{bv}" if bv else (v.get("short_link_v2") or v.get("short_link") or "")
        if not url_v:
            continue
        owner = v.get("owner") or {}
        items.append({
            "id": f"related-{idx}-{bv or idx}",
            "url": url_v,
            "title": v.get("title") or "未命名",
            "uploader": owner.get("name") if isinstance(owner, dict) else "",
            "duration": v.get("duration") if isinstance(v.get("duration"), (int, float)) else 0,
            "thumbnail": _full_url(v.get("pic") or ""),
            "index": idx,
        })

    return {
        "ok": True, "kind": "related",
        "sourceURL": f"https://www.bilibili.com/video/{bvid}",
        "items": items, "totalAvailable": len(items),
    }


def main() -> None:
    args = sys.argv[1:]
    mode = ""
    max_items = 20
    page = 1

    i = 0
    while i < len(args):
        a = args[i]
        if a in ("--search", "--related"):
            mode = a.lstrip("-")
        elif a == "--max":
            i += 1
            if i < len(args):
                try:
                    max_items = max(1, min(50, int(args[i])))
                except ValueError:
                    pass
        elif a == "--page":
            i += 1
            if i < len(args):
                try:
                    page = max(1, int(args[i]))
                except ValueError:
                    pass
        elif not a.startswith("-"):
            break
        i += 1

    remaining = args[i:]
    if not mode or not remaining:
        print(json.dumps({"ok": False, "error": "missing mode or argument"}))
        raise SystemExit(2)

    raw = remaining[0].strip()

    try:
        if mode == "search":
            result = discover_search(raw, max_items, page)
        elif mode == "related":
            bvid = extract_bvid(raw)
            if not bvid:
                print(json.dumps({"ok": False, "error": "URL 中未找到 BV 号，仅支持 B站视频"}))
                raise SystemExit(1)
            result = discover_related(bvid, max_items)
        else:
            result = {"ok": False, "error": f"unknown mode: {mode}"}
    except Exception as exc:
        result = {"ok": False, "error": str(exc)[:1000]}

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
