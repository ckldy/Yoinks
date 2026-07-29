import base64
import hashlib
import json
import math
import random
import ssl
import string
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

# 在 MITM/抓包环境下允许自签名证书
SSL_CONTEXT = ssl.create_default_context()
SSL_CONTEXT.check_hostname = False
SSL_CONTEXT.verify_mode = ssl.CERT_NONE

MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

DESKTOP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://space.bilibili.com/",
    "Origin": "https://space.bilibili.com",
    "Accept-Language": "en,zh-CN;q=0.9,zh;q=0.8",
}


def get_mixin_key(orig: str) -> str:
    return "".join([orig[i] for i in MIXIN_KEY_ENC_TAB])[:32]


def http_get(url: str, timeout: int = 30) -> dict[str, Any]:
    req = urllib.request.Request(url, headers=DESKTOP_HEADERS)
    with urllib.request.urlopen(req, context=SSL_CONTEXT, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_wbi_keys() -> tuple[str, str]:
    data = http_get("https://api.bilibili.com/x/web-interface/nav")
    wbi = data.get("data", {}).get("wbi_img", {})
    img_url = wbi.get("img_url", "")
    sub_url = wbi.get("sub_url", "")
    img_key = Path(img_url).stem
    sub_key = Path(sub_url).stem
    if not img_key or not sub_key:
        raise RuntimeError("无法获取 WBI 签名密钥")
    return img_key, sub_key


def screen_dimensions() -> tuple[int, int]:
    # 与 yt-dlp 保持一致：提供一组常见桌面分辨率供随机选择
    dims = [
        (3840, 2160), (2560, 1440), (1920, 1080), (1600, 900),
        (1440, 900), (1366, 768), (1536, 864),
    ]
    prefs = [2, 4, 35, 28, 14, 10, 7]
    return random.choices(dims, weights=prefs, k=1)[0]


def dm_params() -> dict[str, Any]:
    # 参考 yt-dlp bilibili extractor 的风控参数实现
    def get_wh(width: int = 1920, height: int = 1080) -> list[int]:
        res0, res1 = width, height
        rnd = math.floor(114 * random.random())
        return [2 * res0 + 2 * res1 + 3 * rnd, 4 * res0 - res1 + rnd, rnd]

    def get_of(scroll_top: int = 10, scroll_left: int = 10) -> list[int]:
        res0, res1 = scroll_top, scroll_left
        rnd = math.floor(514 * random.random())
        return [3 * res0 + 2 * res1 + rnd, 4 * res0 - 4 * res1 + 2 * rnd, rnd]

    w, h = screen_dimensions()
    return {
        "dm_img_list": "[]",
        "dm_img_str": base64.b64encode(
            "".join(random.choices(string.printable, k=random.randint(16, 64))).encode()
        )[:-2].decode(),
        "dm_cover_img_str": base64.b64encode(
            "".join(random.choices(string.printable, k=random.randint(32, 128))).encode()
        )[:-2].decode(),
        "dm_img_inter": json.dumps(
            {
                "ds": [],
                "wh": get_wh(w, h),
                "of": get_of(random.randint(0, 100), 0),
            },
            separators=(",", ":"),
        ),
    }


def sign_params(params: dict[str, Any], img_key: str, sub_key: str) -> dict[str, Any]:
    mixin = get_mixin_key(img_key + sub_key)
    params = dict(params)
    params["wts"] = int(time.time())
    sorted_params = dict(sorted(params.items()))
    query = urllib.parse.urlencode(sorted_params)
    w_rid = hashlib.md5((query + mixin).encode("utf-8")).hexdigest()
    sorted_params["w_rid"] = w_rid
    return sorted_params


def duration_to_seconds(length: str) -> float | None:
    # length format: "MM:SS" or "HH:MM:SS"
    parts = length.split(":")
    try:
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    except (ValueError, IndexError):
        pass
    return None


def fetch_space_videos(mid: str, max_items: int, start_page: int = 1) -> tuple[list[dict[str, Any]], int]:
    collected: list[dict[str, Any]] = []
    total_count = 0
    page = start_page
    page_size = min(30, max(1, max_items))
    attempts = 0
    api_attempts = 0

    while len(collected) < max_items and attempts < 20:
        # 每次请求都刷新 WBI keys 与风控参数，避免同一签名被风控
        img_key, sub_key = get_wbi_keys()
        params = {
            "keyword": "",
            "mid": mid,
            "order": "pubdate",
            "order_avoided": "true",
            "platform": "web",
            "pn": page,
            "ps": page_size,
            "tid": 0,
            "web_location": "333.1387",
            "special_type": "",
            "index": 0,
            **dm_params(),
        }
        signed = sign_params(params, img_key, sub_key)
        url = "https://api.bilibili.com/x/space/wbi/arc/search?" + urllib.parse.urlencode(signed)

        last_error: Exception | None = None
        for retry in range(3):
            try:
                data = http_get(url, timeout=30)
                break
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", errors="ignore")[:500]
                last_error = RuntimeError(f"B 站空间 API 请求失败 ({e.code}): {body}")
                # 412/352 风控通常短暂，等待后重试
                if e.code in (412, 352):
                    time.sleep(1.5 * (retry + 1))
                    # 刷新 keys 重新签名
                    img_key, sub_key = get_wbi_keys()
                    signed = sign_params(params, img_key, sub_key)
                    url = "https://api.bilibili.com/x/space/wbi/arc/search?" + urllib.parse.urlencode(signed)
                    continue
                raise last_error
        else:
            if last_error:
                raise last_error
            raise RuntimeError("B 站空间 API 请求重试耗尽")

        if data.get("code") != 0:
            raise RuntimeError(f"B 站空间 API 返回错误: {data.get('message')}")

        page_info = data.get("data", {}).get("page", {})
        if isinstance(page_info, dict):
            total_count = max(total_count, page_info.get("count") or 0)

        vlist = data.get("data", {}).get("list", {}).get("vlist") or []
        if not isinstance(vlist, list):
            break

        for video in vlist:
            if not isinstance(video, dict):
                continue
            bvid = video.get("bvid")
            title = video.get("title")
            if not bvid or not title:
                continue
            collected.append({
                "id": f"bili-{bvid}",
                "url": f"https://www.bilibili.com/video/{bvid}",
                "title": title,
                "uploader": video.get("author"),
                "duration": duration_to_seconds(video.get("length", "")),
                "thumbnail": video.get("pic"),
                "index": len(collected),
            })
            if len(collected) >= max_items:
                break

        if len(vlist) < page_size:
            break

        page += 1
        attempts += 1

    return collected, total_count


def main() -> None:
    args = sys.argv[1:]
    if len(args) < 2 or len(args) > 3:
        print(json.dumps({"ok": False, "error": "用法: bilibili_space_discover.py <mid> <max_items> [page]"}))
        raise SystemExit(2)

    mid = args[0]
    try:
        max_items = max(1, min(50, int(args[1])))
    except ValueError:
        print(json.dumps({"ok": False, "error": "max_items 必须是整数"}))
        raise SystemExit(2)

    start_page = 1
    if len(args) >= 3:
        try:
            start_page = max(1, int(args[2]))
        except ValueError:
            print(json.dumps({"ok": False, "error": "page 必须是整数"}))
            raise SystemExit(2)

    try:
        items, total_count = fetch_space_videos(mid, max_items, start_page)
        print(json.dumps({
            "ok": True,
            "kind": "author",
            "items": items,
            "totalAvailable": total_count or len(items),
        }, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)[:1000]}, ensure_ascii=False))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
