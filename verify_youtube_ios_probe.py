from pathlib import Path

root = Path(__file__).parent
youtube = (root / "services/youtube.ts").read_text()
media = (root / "services/media.ts").read_text()

checks = [
    ("adaptive formats are separated", "const adaptiveFormats = player.streamingData.adaptiveFormats || []" in youtube and "const videoFormats = adaptiveFormats.filter" in youtube and "const audioFormats = adaptiveFormats.filter" in youtube),
    ("H264 prefers MP4 audio", "codec === \"h264\" ? bestMp4Audio || bestAudio" in youtube),
    ("health check returns status and reason", "type YouTubeURLCheckResult" in media and 'reason: "ok" | "http" | "timeout" | "network"' in media),
    ("health check prioritizes itag 137", "youtubeVideoItag === 137" in media),
    ("health check caps video candidates", ".slice(0, 2)" in media),
    ("health check logs safe diagnostics", 'event: "probe.youtube.direct.url-check"' in media and "stream" in media and "itag" in media and "host" in media and "status" in media and "reason" in media),
    ("failed choices can be filtered", "failedVideoChoiceIds" in media and "availableChoices" in media),
    ("yt-dlp fallback remains", 'event: "probe.youtube.direct.url-blocked"' in media),
]

passed = 0
for name, ok in checks:
    print(("PASS" if ok else "FAIL"), name)
    passed += int(ok)
print(f"PASS {passed}/{len(checks)}")
raise SystemExit(0 if passed == len(checks) else 1)
