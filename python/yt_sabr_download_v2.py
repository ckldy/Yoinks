#!/usr/bin/env python3
"""Yoinks UMP/SABR 单轨下载驱动 v2（yt_sabr2 包 + cold start PoToken + SSL cacert 适配）。

用法:
    python3 yt_sabr_download_v2.py <videoId> <itag> <output_path> <audio|video> [--max-bytes N] [--max-duration-sec N] [--cancel-file PATH] [--insecure]

v2 变更（2026-08-02）:
- create_cold_start_token：bgutils-js 纯函数移植，UMP 请求 streamerContext.poToken 携带
  cold start token（sps=2 ATTESTATION_PENDING 场景），实测 10MB 零 reload（无 token 时每
  ~1.75MB 触发 PENDING_MISSING reload）。
- --max-bytes：写满后提前结束（用于本地预览/小样本实验）。
- 全部 urllib 请求走 yt_sabr2._shim_v2.open_request（信任链级联：AppGroup cacert → 默认
  store → 不验证兜底；googlevideo 走直通缺 WR2 中间证书，兜底对齐 yt-dlp --insecure）。
- --insecure（等价 --no-check-certificate，对齐 yt-dlp）：直接跳过证书验证，
  不尝试验证（open_request 不再做级联重试）。
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
    if _m == "yt_sabr2" or _m.startswith("yt_sabr2."):
        del sys.modules[_m]

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from yt_sabr2.core.server_abr_stream import ServerAbrStream
from yt_sabr2._shim_v2 import Monostate
from yt_sabr2._shim_v2 import open_request

IOS_UA = "com.google.ios.youtube/20.10.38 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X; en_US)"
IOS_CLIENT = {
    "clientName": "IOS", "clientVersion": "20.10.38", "deviceMake": "Apple",
    "deviceModel": "iPhone16,2", "osName": "iPhone", "osVersion": "17.5.1.21F90",
    "hl": "en", "timeZone": "UTC", "utcOffsetMinutes": 0,
}


def create_cold_start_token(content_binding: str, client_state: int = 1) -> str:
    """bgutils-js WebPoMinter.createColdStartToken 的纯 Python 移植。

    包结构: [34, len, key0, key1, 0, clientState, ts(4), contentBinding...]
    payload = packet[2:]，前 2 字节为 key，其后用 key 做重复 XOR（payload[i] ^= payload[i%2]）。
    返回 base64url（无 padding）。sps=2（ATTESTATION_PENDING）时可代替完整 poToken，
    sps=3（ATTESTATION_REQUIRED）后失效。
    """
    binding = content_binding.encode("utf-8")
    timestamp = int(time.time())
    keys = [os.urandom(1)[0], os.urandom(1)[0]]
    header = keys + [0, client_state] + [
        (timestamp >> 24) & 0xFF,
        (timestamp >> 16) & 0xFF,
        (timestamp >> 8) & 0xFF,
        timestamp & 0xFF,
    ]
    packet = bytearray(2 + len(header) + len(binding))
    packet[0] = 34
    packet[1] = len(header) + len(binding)
    packet[2:2 + len(header)] = bytes(header)
    packet[2 + len(header):] = binding
    for j in range(4, len(packet)):
        packet[j] ^= packet[2 + (j & 1)]
    return base64.urlsafe_b64encode(bytes(packet)).rstrip(b"=").decode()


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
    """供 ServerAbrStream.reload() 刷新 URL/config 的最小 youtube 对象。"""

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


class _MaxBytesReached(Exception):
    def __init__(self, written):
        super().__init__(f"max bytes {written}")
        self.written = written


class _TimeBudgetExceeded(Exception):
    """UMP 优先时间预算耗尽：进程内自计时（不依赖 JS timer / Shell 宿主超时）。"""
    pass


# 停止标志：TIME_BUDGET 主线程退出前置位，工作线程在检查点自行退出。
# ios_system 常驻 python 拦截 SystemExit（解释器不退出），daemon 线程会残留并继续
# 下载/输出（实测 SABR_RELOAD 空转污染后续命令）——必须靠线程自己停。
_stop_requested = threading.Event()


class _Cancelled(BaseException):
    pass


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
        print("ERR: usage yt_sabr_download_v2.py <videoId> <itag> <out> <audio|video> [--max-bytes N] [--max-duration-sec N] [--max-run-sec N] [--cancel-file PATH] [--insecure]")
        sys.exit(2)
    video_id, itag = sys.argv[1], int(sys.argv[2])
    out_path, stream_type = sys.argv[3], sys.argv[4]
    max_bytes = 0
    max_duration_sec = 0
    max_run_sec = 0
    cancel_file = None
    _start_time = time.time()
    # 对齐 yt-dlp --insecure/--no-check-certificate：直接跳过证书验证，不尝试验证失败再兑底。
    if "--insecure" in sys.argv or "--no-check-certificate" in sys.argv:
        os.environ["YOINKS_UMP_INSECURE"] = "1"
        print("INFO insecure_tls=1", flush=True)
    if "--max-bytes" in sys.argv:
        try:
            max_bytes = int(sys.argv[sys.argv.index("--max-bytes") + 1])
        except (IndexError, ValueError):
            pass
    if "--max-duration-sec" in sys.argv:
        try:
            max_duration_sec = int(sys.argv[sys.argv.index("--max-duration-sec") + 1])
        except (IndexError, ValueError):
            pass
    if "--max-run-sec" in sys.argv:
        try:
            max_run_sec = int(sys.argv[sys.argv.index("--max-run-sec") + 1])
        except (IndexError, ValueError):
            pass
    if "--cancel-file" in sys.argv:
        try:
            cancel_file = sys.argv[sys.argv.index("--cancel-file") + 1]
        except IndexError:
            pass

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
    import yt_sabr2 as _pkg
    from yt_sabr2.core import server_abr_stream as _sas
    print('DIAG pkg:', _pkg.__file__, flush=True)
    print('DIAG sas_has_shim_v2:', 'shim_v2' in open(_sas.__file__, encoding='utf-8').read(), 'file:', _sas.__file__, flush=True)

    cold_token = create_cold_start_token(video_id)
    print(f"INFO cold_start_token_len={len(cold_token)}", flush=True)

    try:
        check_cancelled()
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
        po_token=cold_token,
        max_duration_ms=max_duration_sec * 1000 if max_duration_sec else 0,
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
                if max_bytes and written[0] >= max_bytes:
                    raise _MaxBytesReached(written[0])

            abr = ServerAbrStream(stream, write_chunk, monostate)
            abr.maximum_reload_attempt = 120
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
    except _MaxBytesReached as e:
        print(f"OK {e.written} (max-bytes reached)")
        sys.exit(0)
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"ERR: sabr {e!r} (written {written[0]})")
        sys.exit(1)

    if written[0] <= 0:
        print("ERR: zero bytes written")
        sys.exit(1)
    print(f"OK {written[0]}")


if __name__ == "__main__":
    main()
