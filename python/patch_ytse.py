#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
yt-dlp-ytse UMP 组件 检测 / 补丁工具（幂等，保守失败）

用法:
  python3 patch_ytse.py check   # 输出 JSON 状态
  python3 patch_ytse.py patch   # 应用缺失补丁（幂等；形态不匹配时保守报错，不写文件）

背景: yt-dlp-ytse==0.4.3 与 yt-dlp 2026.07.04 有 4 处 API 不兼容，
另需稳定 -ump 后缀与插件导出补丁，共 6 处，全部位于
<site-packages>/yt_dlp_plugins/extractor/:
  ytse.py                  —— PO_TOKEN 别名 / _list_formats 5→4 值 / -ump 后缀 / __all__ 导出
  _ytse/sabr.py            —— traverse_obj import 路径
  _ytse/downloader/ump.py  —— traverse_obj import 路径

补丁规则仅针对 yt-dlp-ytse 0.4.3 的原始形态；若检测到文件形态与预期不符
（例如用户升级了 yt-dlp-ytse），保守失败并输出 error，不修改文件。
"""
import json
import os
import re
import sys


def site_packages():
    """返回当前 python 环境的 site-packages（以 yt_dlp 实际加载位置为准）。"""
    try:
        import yt_dlp  # noqa: F401
        sp = os.path.dirname(os.path.dirname(os.path.abspath(yt_dlp.__file__)))
        if os.path.isdir(os.path.join(sp, "yt_dlp")):
            return sp
    except Exception:
        pass
    return None


def plugin_dir(sp):
    return os.path.join(sp, "yt_dlp_plugins", "extractor") if sp else None


def read(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def write(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def installed_version(sp):
    """检测 yt-dlp-ytse 是否安装；返回版本号或 None。"""
    dirs = [n for n in os.listdir(sp) if n.startswith("yt_dlp_ytse-") and n.endswith(".dist-info")]
    if not dirs:
        return None
    return dirs[0][len("yt_dlp_ytse-"):-len(".dist-info")]


# ---- 补丁检测 ----

def check_patches(sp):
    d = plugin_dir(sp)
    patches = {}
    missing = []
    ytse = read(os.path.join(d, "ytse.py"))
    sabr = read(os.path.join(d, "_ytse", "sabr.py"))
    ump = read(os.path.join(d, "_ytse", "downloader", "ump.py"))

    def mark(name, ok):
        patches[name] = bool(ok)
        if not ok:
            missing.append(name)

    mark("ytse_po_token",
         ytse is not None
         and "STREAMING_DATA_FETCH_GVS_PO_TOKEN" in ytse
         and "STREAMING_DATA_INITIAL_PO_TOKEN = STREAMING_DATA_FETCH_GVS_PO_TOKEN" in ytse)
    mark("ytse_list_formats",
         ytse is not None
         and "live_status, formats, _ = self._list_formats" in ytse
         and "return live_broadcast_details, live_status, formats, subtitles" in ytse)
    mark("ytse_ump_suffix",
         ytse is not None and 'format_copy[\'format_id\'] = f"{f.get(\'format_id\')}-ump"' in ytse)
    mark("ytse_export",
         ytse is not None and "__all__ = ['YTSE']" in ytse)
    mark("sabr_traverse",
         sabr is not None and "from yt_dlp.utils import traverse_obj" in sabr)
    mark("ump_traverse",
         ump is not None and "from yt_dlp.utils import traverse_obj" in ump)
    return patches, missing


def check():
    sp = site_packages()
    if not sp:
        print(json.dumps({"installed": False, "version": None, "patches": {},
                          "patched": False, "missing": [], "error": "yt_dlp 未安装"}))
        return 1
    version = installed_version(sp)
    installed = version is not None
    patches, missing = check_patches(sp)
    print(json.dumps({
        "installed": installed,
        "version": version,
        "patches": patches,
        "patched": installed and len(missing) == 0,
        "missing": missing,
    }))
    return 0


# ---- 补丁应用（每个返回 (新内容, ok)；ok=False 表示形态不匹配，保守失败） ----

def patch_ytse_po_token(text):
    if "STREAMING_DATA_FETCH_GVS_PO_TOKEN" in text and "STREAMING_DATA_INITIAL_PO_TOKEN = STREAMING_DATA_FETCH_GVS_PO_TOKEN" in text:
        return text, True
    m = re.search(r"from yt_dlp\.extractor\.youtube\._video import \(\n([^)]*?)\)", text)
    if not m or "STREAMING_DATA_INITIAL_PO_TOKEN" not in m.group(1):
        return text, False
    alias = ("    # yt-dlp 2026.07.04 移除了 STREAMING_DATA_INITIAL_PO_TOKEN，用 FETCH_GVS 语义替代\n"
             "    STREAMING_DATA_INITIAL_PO_TOKEN = STREAMING_DATA_FETCH_GVS_PO_TOKEN")
    replacement = m.group(0).replace("STREAMING_DATA_INITIAL_PO_TOKEN,", "STREAMING_DATA_FETCH_GVS_PO_TOKEN,") + "\n" + alias
    text = text[:m.start(0)] + replacement + text[m.end(0):]
    return text, True


def patch_list_formats(text):
    if "live_status, formats, _ = self._list_formats" in text and "return live_broadcast_details, live_status, formats, subtitles" in text:
        return text, True
    text, n1 = re.subn(r"_, live_status, \w+, formats, _ = self\._list_formats", "_, live_status, formats, _ = self._list_formats", text)
    if n1 != 1:
        return text, False
    text, n2 = re.subn(r"live_broadcast_details, live_status, \w+, formats, subtitles = super\(\)\._list_formats", "live_broadcast_details, live_status, formats, subtitles = super()._list_formats", text)
    if n2 != 1:
        return text, False
    text, n3 = re.subn(r"return live_broadcast_details, live_status, \w+, formats, subtitles", "return live_broadcast_details, live_status, formats, subtitles", text)
    if n3 != 1:
        return text, False
    return text, True


def patch_ump_suffix(text):
    marker = 'format_copy[\'format_id\'] = f"{f.get(\'format_id\')}-ump"'
    if marker in text:
        return text, True
    anchor = "format_copy['url'] = update_url_query(format_copy['url'], {'ump': 1, 'srfvp': 1})"
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if anchor in line:
            indent = line[:len(line) - len(line.lstrip())]
            lines.insert(i, indent + marker)
            return "\n".join(lines), True
    return text, False


def patch_export(text):
    if "__all__ = ['YTSE']" in text:
        return text, True
    if "class _YTSE" not in text:
        return text, False
    suffix = ("\n\n\n# yt-dlp 插件发现要求：类名非下划线开头且在 __all__ 中（见 yt_dlp/plugins.py）\n"
              "__all__ = ['YTSE']\n"
              "YTSE = _YTSE\n")
    return text.rstrip() + suffix, True


def patch_traverse_import(text):
    if "from yt_dlp.utils import traverse_obj" in text:
        return text, True
    m = re.search(r"^from yt_dlp import ([^\n]+)$", text, re.M)
    if not m:
        return text, False
    names = [x.strip() for x in m.group(1).split(",")]
    if "traverse_obj" not in names:
        return text, False
    names.remove("traverse_obj")
    if names:
        new_line = "from yt_dlp import " + ", ".join(names) + "\nfrom yt_dlp.utils import traverse_obj"
    else:
        new_line = "from yt_dlp.utils import traverse_obj"
    return text.replace(m.group(0), new_line, 1), True


def patch():
    sp = site_packages()
    if not sp:
        print(json.dumps({"ok": False, "error": "yt_dlp 未安装"}))
        return 1
    d = plugin_dir(sp)
    ytse_path = os.path.join(d, "ytse.py")
    sabr_path = os.path.join(d, "_ytse", "sabr.py")
    ump_path = os.path.join(d, "_ytse", "downloader", "ump.py")

    ytse = read(ytse_path)
    sabr = read(sabr_path)
    ump = read(ump_path)
    if ytse is None or sabr is None or ump is None:
        print(json.dumps({"ok": False, "error": "插件文件缺失（yt-dlp-ytse 未完整安装？）"}))
        return 1

    applied = []
    failed = []

    new_ytse, ok = patch_ytse_po_token(ytse)
    if not ok:
        failed.append("ytse_po_token")
    elif new_ytse != ytse:
        applied.append("ytse_po_token")
        ytse = new_ytse

    new_ytse, ok = patch_list_formats(ytse)
    if not ok:
        failed.append("ytse_list_formats")
    elif new_ytse != ytse:
        applied.append("ytse_list_formats")
        ytse = new_ytse

    new_ytse, ok = patch_ump_suffix(ytse)
    if not ok:
        failed.append("ytse_ump_suffix")
    elif new_ytse != ytse:
        applied.append("ytse_ump_suffix")
        ytse = new_ytse

    new_ytse, ok = patch_export(ytse)
    if not ok:
        failed.append("ytse_export")
    elif new_ytse != ytse:
        applied.append("ytse_export")
        ytse = new_ytse

    new_sabr, ok = patch_traverse_import(sabr)
    if not ok:
        failed.append("sabr_traverse")
    elif new_sabr != sabr:
        applied.append("sabr_traverse")
        sabr = new_sabr

    new_ump, ok = patch_traverse_import(ump)
    if not ok:
        failed.append("ump_traverse")
    elif new_ump != ump:
        applied.append("ump_traverse")
        ump = new_ump

    if failed:
        # 保守失败：不写任何文件，避免半补丁状态
        print(json.dumps({"ok": False, "applied": applied, "failed": failed,
                          "error": "补丁形态与 yt-dlp-ytse 0.4.3 预期不符（可能版本已升级）；已放弃修改，请人工处理"}))
        return 1

    if applied:
        write(ytse_path, ytse)
        write(sabr_path, sabr)
        write(ump_path, ump)

    # 应用后复检
    _, missing = check_patches(sp)
    print(json.dumps({"ok": True, "applied": applied, "missing": missing}))
    return 0 if not missing else 1


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "check"
    if mode == "check":
        return check()
    if mode == "patch":
        return patch()
    print(json.dumps({"ok": False, "error": "用法: patch_ytse.py check|patch"}))
    return 2


if __name__ == "__main__":
    sys.exit(main())
