from pathlib import Path

root = Path(__file__).parent
media = (root / "services" / "media.ts").read_text()
driver = (root / "python" / "yt_sabr_download_v2.py").read_text()

checks = {
    "driver accepts cancel file": '"--cancel-file" in sys.argv' in driver,
    "driver exits 130 on cancel": "sys.exit(130)" in driver,
    "driver checks cancellation while writing": "def write_chunk(chunk, remaining):\n                check_cancelled()" in driver,
    "typescript passes cancel file": "--cancel-file ${quote(options.cancelPath)}" in media,
    "typescript rechecks cancellation after UMP": "if (options.isCancelFlagSet()) throw new Error(\"下载已取消\")" in media,
    "session errors classified separately": "下载任务会话已失效，请重新打开 Yoinks 后重试" in media,
}

failed = [name for name, ok in checks.items() if not ok]
for name, ok in checks.items():
    print(("PASS" if ok else "FAIL"), name)
if failed:
    raise SystemExit(f"{len(failed)} checks failed: {', '.join(failed)}")
print(f"PASS {len(checks)}/{len(checks)}")
