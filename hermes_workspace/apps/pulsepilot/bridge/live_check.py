"""Live check: real Agent Bridge + real worker + real agent, one task.

This is the chain the fleet depends on and the one nothing else proves:
submit over HTTP, the worker starts a real hermes process, the agent does the
work, the answer comes back through run.json. No stub agent anywhere.
"""

import json
import os
import sys
import threading
import time
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from agent_bridge import Bridge, handler  # noqa: E402

TOKEN = "live-check-token-0123456789"
TASK = "Ответь ровно одним словом: работает"


def post(port, path, payload):
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def get(port, path):
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", headers={"Authorization": "Bearer " + TOKEN})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def main():
    root = Path(os.environ.get("LIVE_STATE", HERE / "live-state"))
    root.mkdir(parents=True, exist_ok=True)
    worker = HERE / "run_task.py"
    argv = [sys.executable, str(worker), "--prompt-file", "{prompt_file}",
            "--job-dir", "{job_dir}", "--run-id", "{run_id}"]
    bridge = Bridge(root / "runs", argv, 7)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler(bridge, TOKEN))
    port = server.server_port
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.05), daemon=True)
    thread.start()
    print(f"bridge on 127.0.0.1:{port}, real agent behind it", flush=True)

    run_id = os.urandom(16).hex()
    created = post(port, "/runs", {"client_job_id": run_id, "prompt": TASK,
                                   "resource": "live-check"})
    print(f"submitted: {created['status']}", flush=True)

    deadline = time.monotonic() + 900
    state = created
    while time.monotonic() < deadline:
        time.sleep(3)
        state = get(port, f"/runs/{run_id}")
        print(f"  {state['status']:14} {state.get('summary', '')[:90]!r}", flush=True)
        if state["status"] in ("completed", "failed", "cancelled", "unknown"):
            break
    server.shutdown()
    server.server_close()

    print("---")
    print("status:", state["status"])
    print("result:", (state.get("result") or "")[:400])
    ok = state["status"] == "completed" and "работ" in (state.get("result") or "").lower()
    print("VERDICT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())