#!/usr/bin/env python3
"""verify_ump_cancel_fast.py — UMP 取消进程退出保证验证。

环境限制：ios_system python3 在非主线程（Dummy-1）执行脚本，signal.signal 不可用，
因此取消依赖「检查点 + socket 短超时」：取消文件出现后驱动最迟 ~5-8s 退出。

断言：
1. v2/v1 驱动**不**调用 signal.signal（非主线程会 ValueError 崩溃）
2. v2/v1 驱动 monkey-patch fetch_media：每轮 POST 前检查 cancel（_fetch_media_with_cancel）
3. v1/v2 包 fetch_media 的 open_request 显式 timeout=5（阻塞最多 5s 醒一次）
4. 驱动 fetch_player timeout=8（reload 路径取消等待上限）
5. ffmpeg_run.py 存在且 SIGKILL 子进程（合并阶段取消）
6. media.ts previewYouTubeUMPClip 支持 cancelPath + ump-cancelled 事件（预览兜底可取消）
"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.abspath(__file__))


class TestUmpCancelFast(unittest.TestCase):
    def test_drivers_do_not_use_signal(self):
        # 非主线程（Dummy-1）执行：signal.signal 必抛 ValueError，驱动绝不能调用
        for name in ("yt_sabr_download_v2.py", "yt_sabr_download.py"):
            with open(os.path.join(ROOT, "python", name), encoding="utf-8") as fh:
                src = fh.read()
            self.assertNotIn("signal.signal", src, f"{name} 不得调用 signal.signal")
            self.assertNotIn("signal.setitimer", src, f"{name} 不得调用 signal.setitimer")

    def test_drivers_patch_fetch_media_with_cancel_check(self):
        for name in ("yt_sabr_download_v2.py", "yt_sabr_download.py"):
            with open(os.path.join(ROOT, "python", name), encoding="utf-8") as fh:
                src = fh.read()
            self.assertIn("_fetch_media_with_cancel", src, f"{name} 必须带 fetch_media 取消检查点")
            self.assertIn("ServerAbrStream.fetch_media = _fetch_media_with_cancel", src, f"{name} 必须替换 fetch_media")
            # reload 循环（SABR_RELOAD PENDING 重试）无入口检查点，必须 patch reload 每轮检查
            self.assertIn("_reload_with_cancel", src, f"{name} 必须带 reload 检查点")
            self.assertIn("ServerAbrStream.reload = _reload_with_cancel", src, f"{name} 必须替换 reload")

    def test_drivers_have_internal_time_budget(self):
        # UMP 优先 60s 预算：JS timer / Shell.run 超时在阻塞期间不可靠，必须驱动进程内自计时
        for name in ("yt_sabr_download_v2.py", "yt_sabr_download.py"):
            with open(os.path.join(ROOT, "python", name), encoding="utf-8") as fh:
                src = fh.read()
            self.assertIn("--max-run-sec", src, f"{name} 必须支持 --max-run-sec")
            self.assertIn("check_time_budget", src, f"{name} 必须有 check_time_budget")
            self.assertIn("TIME_BUDGET", src, f"{name} 必须输出 TIME_BUDGET 标记")
            self.assertIn("sys.exit(3)", src, f"{name} 预算耗尽必须 exit 3")
            # 停止标志：常驻 python 拦截 SystemExit，daemon 线程会残留（SABR_RELOAD 污染），
            # TIME_BUDGET 必须先置位停止标志让线程在检查点自行退出
            self.assertIn("_stop_requested", src, f"{name} 必须有停止标志")
            self.assertIn("t.join(5)", src, f"{name} 置位后必须给 5s 收敛窗口")

    def test_fetch_media_socket_timeout_short(self):
        for pkg in ("yt_sabr2", "yt_sabr"):
            with open(os.path.join(ROOT, "python", pkg, "core", "server_abr_stream.py"), encoding="utf-8") as fh:
                src = fh.read()
            self.assertIn("open_request(request, timeout=5)", src, f"{pkg} fetch_media 必须 5s 超时")

    def test_fetch_player_timeout_short(self):
        for name in ("yt_sabr_download_v2.py", "yt_sabr_download.py"):
            with open(os.path.join(ROOT, "python", name), encoding="utf-8") as fh:
                src = fh.read()
            self.assertIn("open_request(req, timeout=8)", src, f"{name} fetch_player 必须 8s 超时")

    def test_ffmpeg_run_kills_child(self):
        path = os.path.join(ROOT, "python", "ffmpeg_run.py")
        self.assertTrue(os.path.exists(path), "ffmpeg_run.py 必须存在")
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("SIGKILL", src)
        self.assertIn("killpg", src)
        self.assertIn("cancel_file", src)

    def test_preview_ump_clip_supports_cancel(self):
        with open(os.path.join(ROOT, "services", "media.ts"), encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("cancelPath?: string", src)
        self.assertIn("preview.youtube.ump-cancelled", src)
        self.assertIn("ffmpeg_run.py", src)

    def test_cancel_paths_in_index(self):
        with open(os.path.join(ROOT, "index.tsx"), encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("umpPreviewCancelPathRef", src, "index.tsx 必须管理预览兜底取消路径")
        self.assertIn("cancelStaleUmpPreview", src, "index.tsx 必须有取消旧兜底 helper")


if __name__ == "__main__":
    unittest.main(verbosity=2)
