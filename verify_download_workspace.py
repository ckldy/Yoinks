import importlib.util
import os
import tempfile

module_path = os.path.join(os.path.dirname(__file__), "ytdlp_runner.py")
spec = importlib.util.spec_from_file_location("ytdlp_runner", module_path)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

checks = []
checks.append(("accepts public https URL", runner.safe_http_url("https://example.com/video")))
checks.append(("rejects file URL", not runner.safe_http_url("file:///tmp/video.mp4")))
checks.append(("rejects non-string URL", not runner.safe_http_url(None)))
with tempfile.TemporaryDirectory() as directory:
    workspace = os.path.join(directory, "task")
    os.mkdir(workspace)
    checks.append(("accepts task-local workspace", runner.require_path_within(workspace, directory, "workspace") == os.path.abspath(workspace)))
    try:
        runner.require_path_within("relative/path", directory, "workspace")
        checks.append(("rejects relative workspace", False))
    except SystemExit:
        checks.append(("rejects relative workspace", True))
    try:
        runner.require_path_within("/tmp/outside", directory, "workspace")
        checks.append(("rejects workspace outside task", False))
    except SystemExit:
        checks.append(("rejects workspace outside task", True))

failed = [name for name, passed in checks if not passed]
if failed:
    raise SystemExit("Download workspace checks failed: " + ", ".join(failed))
print(f"Download workspace checks passed ({len(checks)})")
