"""Worker tests. No real agent: a stub hermes on PATH stands in for it.

The real hermes is one process per turn and costs money and minutes, so these
tests drive the protocol itself - the marker line, the stdin answer, the exit
codes - which is exactly the part that can silently break.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_task


def wait_for_status(job_dir, wanted, timeout):
    """Poll status.json until it reports wanted. Wall clock, not iterations:
    the worker starts two processes, so a fixed iteration count races it."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            status = json.loads((job_dir / "status.json").read_text(encoding="utf-8"))
            if status.get("status") == wanted:
                return True
        except (OSError, ValueError):
            pass
        time.sleep(0.05)
    return False

STUB = '''import sys, os
args = sys.argv[1:]
# the worker must pin every turn to the job dir, otherwise parallel jobs
# continue each other's sessions
if "--in" not in args:
    sys.stderr.write("no --in pin\\n"); sys.exit(9)
job = args[args.index("--in") + 1]
turn_file = os.environ.get("STUB_TURN_FILE", job + "/turn")
turn = int(open(turn_file).read() or 0) if os.path.exists(turn_file) else 0
marker = "PULSEPILOT_ASK:"
if turn == 0:
    open(turn_file, "w").write("1")
    print("Считаю, нужен выбор.", flush=True)
    print(marker + " Какой вариант?", flush=True)
else:
    answer = sys.stdin.readline()
    print("Готово после ответа: " + answer.strip(), flush=True)
'''


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.job = self.root / "job"
        self.job.mkdir()
        self.prompt = self.job / "prompt.txt"
        self.prompt.write_text("Сделай отчёт", encoding="utf-8")
        # The stub is a .py run by this same interpreter: on Windows a .cmd
        # cannot be launched without a shell, which would hide the real argv.
        self.stub = self.root / "stub_hermes.py"
        self.stub.write_text(STUB, encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def worker_env(self):
        # Forward slashes are required: PULSEPILOT_HERMES_CMD is split with
        # POSIX rules, so a Windows backslash path is eaten as an escape.
        env = dict(os.environ)
        env["PULSEPILOT_HERMES_CMD"] = f"{sys.executable.replace(chr(92), '/')} {self.stub.as_posix()}"
        return env

    def test_marker_line_becomes_a_question(self):
        body, question = run_task.split_question("Ход работы\nPULSEPILOT_ASK: Какой вариант?")
        self.assertEqual(body, "Ход работы")
        self.assertEqual(question, "Какой вариант?")

    def test_no_marker_means_finished(self):
        body, question = run_task.split_question("Готово. Что дальше?")
        self.assertEqual(question, "")
        self.assertEqual(body, "Готово. Что дальше?")

    def test_empty_marker_tail_is_not_a_question(self):
        # An empty question would park the run in waiting_input forever.
        _, question = run_task.split_question("строка\nPULSEPILOT_ASK:")
        self.assertEqual(question, "")

    def test_question_is_taken_from_the_last_marker(self):
        _, question = run_task.split_question("PULSEPILOT_ASK: первый\nPULSEPILOT_ASK: второй")
        self.assertEqual(question, "второй")

    def test_first_turn_starts_and_later_turns_continue(self):
        job = Path(self.root / "job")
        first = run_task.hermes_argv(0, job, "", "", False)
        second = run_task.hermes_argv(1, job, "", "", False)
        self.assertNotIn("--continue", first)
        self.assertIn("--continue", second)
        self.assertEqual(first[first.index("--in") + 1], str(job))
        self.assertEqual(second[second.index("--in") + 1], str(job))

    def test_agent_command_override_is_used(self):
        """A server may keep hermes off PATH; the override must reach argv."""
        os.environ["PULSEPILOT_HERMES_CMD"] = "/opt/hermes-venv/bin/hermes --quiet"
        try:
            argv = run_task.hermes_argv(0, Path("/j"), "", "", False)
            self.assertEqual(argv[0], "/opt/hermes-venv/bin/hermes")
            self.assertEqual(argv[1], "--quiet")
        finally:
            del os.environ["PULSEPILOT_HERMES_CMD"]

    def test_approval_prompt_is_bypassed_only_when_asked(self):
        self.assertIn("--yolo", run_task.hermes_argv(0, Path("/j"), "", "", True))
        self.assertNotIn("--yolo", run_task.hermes_argv(0, Path("/j"), "", "", False))

    def test_status_write_is_atomic_and_bounded(self):
        run_task.write_status(self.job, "waiting_input", "s" * 9000, "q" * 9000)
        status = json.loads((self.job / "status.json").read_text(encoding="utf-8"))
        self.assertEqual(status["status"], "waiting_input")
        self.assertEqual(len(status["summary"]), 4000)
        self.assertEqual(len(status["question"]), 4000)
        self.assertFalse((self.job / "status.tmp").exists())

    def test_status_rejects_nothing_but_skips_empty_tail(self):
        run_task.write_status(self.job, "running", "работаю")
        self.assertEqual(
            json.loads((self.job / "status.json").read_text(encoding="utf-8"))["status"], "running")

    def test_empty_prompt_is_refused(self):
        empty = self.job / "empty.txt"
        empty.write_text("   ", encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(Path(run_task.__file__).resolve()),
             "--prompt-file", str(empty), "--job-dir", str(self.job)],
            capture_output=True, text=True, env=self.worker_env())
        self.assertEqual(proc.returncode, 2)
        self.assertFalse((self.job / "result.txt").exists())

    def test_question_then_answer_completes_the_run(self):
        """End to end over the real stdin/stdout contract with a stub agent."""
        proc = subprocess.Popen(
            [sys.executable, str(Path(run_task.__file__).resolve()),
             "--prompt-file", str(self.prompt), "--job-dir", str(self.job),
             "--run-id", "abc123"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", env=self.worker_env())
        try:
            asked = wait_for_status(self.job, "waiting_input", timeout=60)
            self.assertTrue(asked, "worker never asked the operator")
            # The operator only ever sees the run card: the question itself has
            # to be in status.json, not just on our stdout.
            status = json.loads((self.job / "status.json").read_text(encoding="utf-8"))
            self.assertEqual(status["question"], "Какой вариант?")
            out, _ = proc.communicate(json.dumps({"input_id": "a1", "answer": "синий"}) + "\n", timeout=60)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        self.assertEqual(proc.returncode, 0, out)
        self.assertIn("Готово после ответа", (self.job / "result.txt").read_text(encoding="utf-8"))
        self.assertNotIn("PULSEPILOT_ASK", (self.job / "result.txt").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()