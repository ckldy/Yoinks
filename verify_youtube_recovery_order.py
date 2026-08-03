from pathlib import Path

root = Path(__file__).parent
media = (root / "services" / "media.ts").read_text()
index = (root / "index.tsx").read_text()

checks = {
    "TLS verification escapes before UMP": (
        "if (!options.insecureTLS && isCertificateVerifyFailure(videoResult.output || \"\"))" in media
        and media.index("if (!options.insecureTLS && isCertificateVerifyFailure(videoResult.output || \"\"))")
        < media.index("if (isYouTubeUMPChoice(sourceURL, options.choice))", media.index("download.video.command.completed"))
    ),
    "TLS retry is logged": "download.tls-retry.requested" in media,
    "recoverable YouTube preview failure is recognized": "isRecoverableYouTubePreviewFailure" in index,
    "preview refresh retry reprobes": "preview.youtube.refresh-retry.started" in index and "probeWithPlatformSession" in index,
    "preview refresh retry preserves selected format": "youtubeVideoItag" in index and "refreshedProbe.choices.find" in index,
    "UMP preview runs only after refresh retry": (
        "preview.youtube.refresh-retry.failed" in index
        and index.index("preview.youtube.refresh-retry.failed") < index.index("preview.youtube.ump-entry")
    ),
}

failed = [name for name, ok in checks.items() if not ok]
for name, ok in checks.items():
    print(("PASS" if ok else "FAIL"), name)
print(f"PASS {len(checks)-len(failed)}/{len(checks)}")
raise SystemExit(1 if failed else 0)
