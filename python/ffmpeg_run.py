#!/usr/bin/env python3
"""ffmpeg 取消包装：Shell 无中断 API 时，取消文件出现则 SIGKILL ffmpeg 子进程。

用法:
    python3 ffmpeg_run.py [--cancel-file PATH] -- ffmpeg <args...>

- 轮询 cancel 文件（0.5s）：存在 → 杀 ffmpeg（含进程组）→ 打印 CANCELLED → exit 130
- 正常：转发 ffmpeg 退出码
- 不传 --cancel-file 时等同直接执行 ffmpeg（透传）
"""
import os
import signal
import subprocess
import sys


def main():
    args = sys.argv[1:]
    cancel_file = None
    if "--cancel-file" in args:
        i = args.index("--cancel-file")
        if i + 1 < len(args):
            cancel_file = args[i + 1]
        del args[i:i + 2]
    if args and args[0] == "--":
        args = args[1:]
    if not args:
        print("ERR: usage ffmpeg_run.py [--cancel-file PATH] -- ffmpeg <args...>", file=sys.stderr)
        return 2

    if not cancel_file:
        return subprocess.call(args)

    proc = subprocess.Popen(args)
    try:
        while True:
            try:
                return proc.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                if os.path.exists(cancel_file):
                    # 取消：杀 ffmpeg 及其子进程（-process-group 防残留）
                    try:
                        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                    except Exception:
                        try:
                            proc.kill()
                        except Exception:
                            pass
                    try:
                        proc.wait(timeout=5)
                    except Exception:
                        pass
                    print("CANCELLED", file=sys.stderr, flush=True)
                    return 130
    finally:
        pass


if __name__ == "__main__":
    sys.exit(main())
