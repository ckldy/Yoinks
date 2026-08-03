#!/usr/bin/env python3
"""verify_ump_first.py — UMP 优先（失败回退 yt-dlp）测试版接线验证。

断言：
1. downloadMedia 含 UMP 优先块（ump-first.completed / .fallback / .error 事件）
2. UMP 优先块位于 muxed native 分支之后（先 muxed 再 UMP 再 direct/yt-dlp）
3. downloadYouTubeUMPFallback 支持 fallbackAfterMs（180s 时间预算）
4. 超时用独立 cancel 文件终止驱动（ump-timeout），不阻塞 Shell 串行队列
5. UMP 优先失败后不中断流程（继续回退 yt-dlp/direct）
"""
import os
import unittest

ROOT = os.path.dirname(os.path.abspath(__file__))
MEDIA = os.path.join(ROOT, "services", "media.ts")


class TestUmpFirst(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(MEDIA, encoding="utf-8") as fh:
            cls.src = fh.read()

    def test_ump_first_block_present(self):
        for marker in (
            'formatExpression: "ump-first"',
            "umpFirstAttempted = true",
            "UMP 优先（测试版",
            "yt-dlp-ytse",
        ):
            self.assertIn(marker, self.src, f"必须包含 {marker}")

    def test_ump_first_after_muxed_before_direct(self):
        i_muxed = self.src.index("download.youtube.native-fallback")
        i_ump = self.src.index('formatExpression: "ump-first"')
        # 锚定 muxed 分支之后的 direct 分支（文件更早处也有 formatExpression === "direct" 判断）
        i_direct = self.src.index('formatExpression === "direct"', i_muxed)
        self.assertLess(i_muxed, i_ump, "UMP 优先必须位于 muxed native 分支之后")
        self.assertLess(i_ump, i_direct, "UMP 优先必须位于 direct 分支之前")

    def test_fallback_after_ms_budget(self):
        # 方案 A：UMP 优先改用 yt-dlp-ytse（UMP-wrapped GET），每流失败回退普通 yt-dlp 重跑一次
        self.assertIn("fallbackAfterMs?: number", self.src, "自研 SABR 驱动兜底仍保留预算参数")
        self.assertIn("toUMPFormatExpression", self.src, "必须有 UMP 格式表达式转换")
        self.assertIn("-ump", self.src, "UMP 格式必须用稳定 -ump 后缀选择副本")
        self.assertIn('formats: ["ump"]', self.src, "必须传 extractor_args youtube.formats=ump")
        self.assertIn('format_sort = ["proto:ump"]', self.src, "必须优先 UMP 协议排序")
        self.assertIn("download.youtube.ump-ytdlp-fallback", self.src, "UMP 失败必须记录回退事件")
        self.assertIn("retriedAfterUMP", self.src, "回退重跑必须标记")

    def test_ump_first_toggle(self):
        # 设置开关：preferences.umpFirst 默认开启；media 条件必须读开关
        with open(os.path.join(ROOT, "services", "preferences.ts"), encoding="utf-8") as fh:
            prefs = fh.read()
        self.assertIn("umpFirst: boolean", prefs)
        self.assertIn("umpFirst: true", prefs)
        self.assertIn("getPreferences().umpFirst", self.src, "UMP 优先必须受设置开关控制")

    def test_timeout_uses_independent_cancel_file(self):
        self.assertIn("ump-timeout.cancel", self.src)
        self.assertIn("download.direct.ump-timeout", self.src)
        self.assertIn("runWithTimeoutBudget", self.src)

    def test_driver_internal_time_budget(self):
        # 主机制：驱动 --max-run-sec 自计时（JS timer 阻塞期不可靠），TIME_BUDGET → 回退
        self.assertIn("--max-run-sec", self.src)
        self.assertIn("runBudgetArg", self.src)
        self.assertIn("download.direct.ump-time-budget", self.src)
        self.assertIn('includes("TIME_BUDGET")', self.src)
        self.assertIn("v.exitCode === 3", self.src)

    def test_no_second_ump_after_ump_first(self):
        # UMP 优先尝试后：yt-dlp 直连失败不再二次 UMP 兜底（无预算会卡死，实测需手动取消 20 分钟）
        self.assertIn("umpFirstAttempted", self.src)
        self.assertIn("download.youtube.ump-second-skipped", self.src)
        self.assertIn("fallbackAfterMs: 120000", self.src, "保留的 UMP 兜底也必须有预算")

    def test_failure_continues_to_fallback(self):
        self.assertIn("// 回退：继续走下方 yt-dlp 下载分支。", self.src)
        self.assertIn("removeDownloadResiduals", self.src, "UMP 失败必须清理残留再重跑")
        self.assertIn("每流失败回退普通参数重跑一次", self.src, "UMP 优先失败必须继续回退")


if __name__ == "__main__":
    unittest.main(verbosity=2)
