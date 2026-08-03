#!/usr/bin/env python3
"""Yoinks UMP/SABR 单轨下载驱动（Python 复用 pytubefix/sabr，纯 stdlib）。

用法:
    python3 yt_sabr_download.py <videoId> <itag> <output_path> <audio|video>

流程:
1. innertube IOS player → serverAbrStreamingUrl / videoPlaybackUstreamerConfig / adaptiveFormats
2. 取目标 itag 的 format 元数据（lastModified/xtags/duration/contentLength）
3. ServerAbrStream.start() 流式下载 → write_chunk 写文件（只写该 itag 的媒体分片）
4. 输出一行结果: OK <bytes>  或  ERR <reason>
"""
import sys
import os
import json
import base64
import time
import threading
import urllib.request
from types import SimpleNamespace

# ios_system python3 是常驻进程，sys.modules 跨命令缓存：强制清除本包旧模块，
# 确保本次运行 import 到磁盘上的最新代码（否则可能加载上一会话的旧版）。
for _m in list(sys.modules):
    if _m == "yt_sabr" or _m.startswith("yt_sabr."):
        del sys.modules[_m]

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from yt_sabr.core.server_abr_stream import ServerAbrStream
from yt_sabr._shim import Monostate
from yt_sabr._shim import open_request

IOS_UA = "com.google.ios.youtube/20.10.38 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X; en_US)"
IOS_CLIENT = {
    "clientName": "IOS", "clientVersion": "20.10.38", "deviceMake": "Apple",
    "deviceModel": "iPhone16,2", "osName": "iPhone", "osVersion": "17.5.1.21F90",
    "hl": "en", "timeZone": "UTC", "utcOffsetMinutes": 0,
}


def fetch_player(video_id):
    body = json.dumps({
        "context": {"client": IOS_CLIENT},
        "videoId": video_id,
        "playbackContext": {"contentPlaybackContext": {
            "html5Preference": "HTML5_PREF_WANTS", "signatureTimestamp": 20476}},
        "contentCheckOk": True,
        "racyCheckOk": True,
    }).encode()
    req = urllib.request.Request(
        "https://www.youtube.com/youtubei/v1/player?prettyPrint=false", data=body,
        headers={"Content-Type": "application/json", "User-Agent": IOS_UA,
                 "X-Youtube-Client-Name": "5", "X-Youtube-Client-Version": IOS_CLIENT["clientVersion"]},
    )
    with open_request(req, timeout=8) as resp:
        return json.loads(resp.read())


class YoutubeShim:
    """供 ServerAbrStream.reload() 刷新 URL/config 的最小 youtube 对象。

    reload 时重新 fetch player（拿新 serverAbrStreamingUrl），配合调大的
    maximum_reload_attempt 实现“无 potoken 每轮 ~5MB 续传”下载完整视频。
    """

    def __init__(self, video_id, initial_player, fetch):
        self._video_id = video_id
        self._player = initial_player
        self._fetch = fetch
        self.vid_info = None

    @property
    def server_abr_streaming_url(self):
        try:
            self._player = self._fetch(self._video_id)
        except Exception:
            pass
        return (self._player.get("streamingData") or {}).get("serverAbrStreamingUrl")

    @property
    def video_playback_ustreamer_config(self):
        pc = self._player.get("playerConfig") or {}
        mcc = pc.get("mediaCommonConfig") or {}
        murc = mcc.get("mediaUstreamerRequestConfig") or {}
        return murc.get("videoPlaybackUstreamerConfig") or ""


class _Cancelled(BaseException):
    pass


class _TimeBudgetExceeded(Exception):
    """UMP 优先时间预算耗尽：进程内自计时（不依赖 JS timer / Shell 宿主超时）。"""
    pass


# 停止标志：TIME_BUDGET 主线程退出前置位，工作线程在检查点自行退出。
# ios_system 常驻 python 拦截 SystemExit（解释器不退出），daemon 线程会残留并继续
# 下载/输出（实测 SABR_RELOAD 空转污染后续命令）——必须靠线程自己停。
_stop_requested = threading.Event()


def main():
    # 进程级时间预算兜底：工作线程 + join(预算)。
    # 实测：JS timer 在 Shell.run 阻塞期间不触发、Shell 宿主超时不可靠、fetch_player 等阶段
    # 可能卡死且检查点覆盖不到——只有 join 超时能保证驱动在预算内退出，不占死 Shell 串行队列。

    max_run_sec = 0
    if "--max-run-sec" in sys.argv:
        try:
            max_run_sec = int(sys.argv[sys.argv.index("--max-run-sec") + 1])
        except (IndexError, ValueError):
            pass
    if not max_run_sec:
        _run_work()
        return

    _exit_code = [0]

    def _body():
        try:
            _run_work()
        except SystemExit as e:
            _exit_code[0] = int(e.code or 0)
        except Exception:
            import traceback
            traceback.print_exc()
            _exit_code[0] = 1

    t = threading.Thread(target=_body, daemon=True)
    t.start()
    t.join(max_run_sec)
    if t.is_alive():
        # 预算耗尽且工作线程仍卡死（player/网络等）：先置停止标志让线程在检查点自行退出
        # （socket 5s 超时后必醒一次），再给 5s 收敛窗口，最后 sys.exit 兜底。
        # ⚠️ 不能用 os._exit（被常驻 python 拦截卡死）；sys.exit 后线程可能残留（常驻拦截
        # SystemExit），所以必须以停止标志为主，线程在检查点抛 _TimeBudgetExceeded 正常退出。
        _stop_requested.set()
        t.join(5)
        print("TIME_BUDGET", flush=True)
        sys.exit(3)
    sys.exit(_exit_code[0])


def _run_work():
    if len(sys.argv) < 5:
        print("ERR: usage yt_sabr_download.py <videoId> <itag> <out> <audio|video> [--insecure] [--cancel-file PATH] [--max-run-sec N]")
        sys.exit(2)
    video_id, itag = sys.argv[1], int(sys.argv[2])
    out_path, stream_type = sys.argv[3], sys.argv[4]
    cancel_file = None
    max_run_sec = 0
    _start_time = time.time()
    if "--cancel-file" in sys.argv:
        try:
            cancel_file = sys.argv[sys.argv.index("--cancel-file") + 1]
        except IndexError:
            pass
    if "--max-run-sec" in sys.argv:
        try:
            max_run_sec = int(sys.argv[sys.argv.index("--max-run-sec") + 1])
        except (IndexError, ValueError):
            pass
    # 对齐 yt-dlp --insecure/--no-check-certificate：直接跳过证书验证。
    if "--insecure" in sys.argv or "--no-check-certificate" in sys.argv:
        os.environ["YOINKS_UMP_INSECURE"] = "1"
        print("INFO insecure_tls=1", flush=True)

    def check_cancelled():
        if cancel_file and os.path.exists(cancel_file):
            raise _Cancelled()

    def check_time_budget():
        # 进程内自计时：Shell 无中断 API 且 JS timer 在 Shell.run 阻塞期间不触发，
        # 预算必须由驱动自己保证（每轮 socket 5s 超时后必醒一次检查）。
        # 停止标志（TIME_BUDGET 主线程置位）与自计时都走同一异常，保证线程自行退出不残留。
        if _stop_requested.is_set():
            raise _TimeBudgetExceeded()
        if max_run_sec and time.time() - _start_time > max_run_sec:
            raise _TimeBudgetExceeded()

    if cancel_file and os.path.exists(cancel_file):
        print("CANCELLED", flush=True)
        sys.exit(130)

    try:
        player = fetch_player(video_id)
    except Exception as e:
        print(f"ERR: player {e!r}")
        sys.exit(2)

    sd = player.get("streamingData") or {}
    server_url = sd.get("serverAbrStreamingUrl")
    yt = YoutubeShim(video_id, player, fetch_player)
    ustreamer = yt.video_playback_ustreamer_config
    if not server_url or not ustreamer:
        print("ERR: no SABR fields (serverAbrStreamingUrl / videoPlaybackUstreamerConfig)")
        sys.exit(2)

    adaptive = sd.get("adaptiveFormats") or []
    fmt = next((f for f in adaptive if f.get("itag") == itag), None)
    if not fmt:
        print(f"ERR: itag {itag} not found in adaptiveFormats")
        sys.exit(2)

    duration_ms = int(fmt.get("durationMs") or fmt.get("approxDurationMs") or 0)
    if duration_ms <= 0:
        print("ERR: no durationMs")
        sys.exit(2)

    # pytubefix 默认 WEB/Windows；这里改用 IOS 身份（与 serverAbrStreamingUrl 的 IOS 签名匹配，
    # 降低 GVS PoToken 保护触发概率）。若仍 PENDING_MISSING 可换回 WEB 尝试。
    abr_client_info = {
        'clientName': 5,
        'clientVersion': '20.10.38',
        'osName': 'iPhone',
        'osVersion': '17.5.1.21F90',
        'platform': 'MOBILE',
    }

    stream = SimpleNamespace(
        url=server_url,
        video_playback_ustreamer_config=ustreamer,
        durationMs=str(duration_ms),
        filesize=int(fmt.get("contentLength") or 0),
        itag=itag,
        last_Modified=int(fmt.get("lastModified") or 0),
        xtags=fmt.get("xtags") or "",
        type=stream_type,
        resolution=str(fmt.get("height") or 720) + "p",
        is_drc=False,
        po_token=None,
        _abr_client_info=abr_client_info,
    )
    monostate = Monostate(YoutubeShim(video_id, player, fetch_player))

    written = [0]
    try:
        with open(out_path, "wb") as fh:
            def write_chunk(chunk, remaining):
                check_cancelled()
                check_time_budget()
                fh.write(chunk)
                written[0] += len(chunk)

            abr = ServerAbrStream(stream, write_chunk, monostate)
            abr.maximum_reload_attempt = 40  # 无 potoken 时每轮 ~5MB，调大 reload 次数以续传完整视频
            # ios_system python3 在非主线程执行（signal 不可用），取消只能靠检查点：
            # monkey-patch fetch_media 让每轮 POST 前检查 cancel（socket 5s idle 超时后必醒一次）。
            _orig_fetch_media = ServerAbrStream.fetch_media

            def _fetch_media_with_cancel(self, client_abr_state, audio_format, video_format):
                check_cancelled()
                check_time_budget()
                return _orig_fetch_media(self, client_abr_state, audio_format, video_format)

            ServerAbrStream.fetch_media = _fetch_media_with_cancel
            # reload 循环（SABR_RELOAD PENDING 重试）在 fetch_media 内部多处调用，入口检查点覆盖不到；
            # 每轮 reload 前检查取消/预算/停止标志，避免 TIME_BUDGET 后残留线程在 reload 空转（实测 12 次/53s）。
            _orig_reload = ServerAbrStream.reload

            def _reload_with_cancel(self):
                check_cancelled()
                check_time_budget()
                return _orig_reload(self)

            ServerAbrStream.reload = _reload_with_cancel
            check_cancelled()
            check_time_budget()
            abr.start()
    except _Cancelled:
        try:
            if os.path.exists(out_path):
                os.remove(out_path)
        except OSError:
            pass
        print("CANCELLED", flush=True)
        sys.exit(130)
    except _TimeBudgetExceeded:
        # 时间预算耗尽（UMP 优先回退场景）：删半成品，exit 3 + TIME_BUDGET 标记，TS 侧识别后回退 yt-dlp
        try:
            if os.path.exists(out_path):
                os.remove(out_path)
        except OSError:
            pass
        print("TIME_BUDGET", flush=True)
        sys.exit(3)
    except Exception as e:
        print(f"ERR: sabr {e!r} (written {written[0]})")
        sys.exit(1)

    if written[0] <= 0:
        print("ERR: zero bytes written")
        sys.exit(1)
    print(f"OK {written[0]}")


if __name__ == "__main__":
    main()
