"""Worker for Agent Bridge: runs one Hermes agent task per submitted run.

Contract with agent_bridge.Bridge (do not change one side alone):

  argv placeholders   {prompt_file} {job_dir} {run_id} are substituted by the
                      bridge before the process starts.
  stdout             every line becomes the run summary, so progress must be
                      printed as it happens, flushed.
  status.json        written atomically while the job is alive. status must be
                      one of running / waiting_input / blocked, plus summary and
                      question. A partial write is tolerated and retried.
  stdin              one JSON line {"input_id": ..., "answer": ...} is delivered
                      when the operator answers a waiting_input question. The
                      bridge never redelivers the same input_id, so the worker
                      must treat each line as the only copy of that answer.
  result.txt         final answer. Its presence with a zero exit code is what
                      turns the run into completed.
  exit code          0 completed, non-zero failed. An interrupted process is
                      reported by the bridge as unknown, never as completed.

Worker policy: a task that needs a human decision must ask, not guess. The agent
is told to end a question with the marker line below; the worker converts that
into waiting_input and resumes the same session once the operator answers.
"""

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path

ASK_MARKER = "PULSEPILOT_ASK:"
MAX_TURNS = 12
RESULT_LIMIT = 60000
SUMMARY_LIMIT = 4000


def log(message):
    """One line to stdout becomes the run summary in the operator's UI."""
    print(str(message)[:SUMMARY_LIMIT], flush=True)


def write_status(job_dir, status, summary="", question=""):
    """Atomic: the bridge may read this file while we write it."""
    path = job_dir / "status.json"
    temp = path.with_suffix(".tmp")
    temp.write_text(
        json.dumps(
            {"status": status, "summary": str(summary)[:SUMMARY_LIMIT],
             "question": str(question)[:SUMMARY_LIMIT], "at": int(time.time())},
            ensure_ascii=False),
        encoding="utf-8")
    temp.replace(path)


def split_question(text):
    """Return (body, question). The question is the marker line's tail, if any.

    No marker means the agent finished; guessing a question from a trailing
    '?' would turn every rhetorical sentence into a stalled run.
    """
    lines = text.splitlines()
    for index in range(len(lines) - 1, -1, -1):
        stripped = lines[index].strip()
        if stripped.startswith(ASK_MARKER):
            question = stripped[len(ASK_MARKER):].strip()
            if not question:
                continue
            return "\n".join(lines[:index]).strip(), question
    return text.strip(), ""


def hermes_prefix():
    """Command that starts one agent turn.

    Defaults to hermes on PATH. PULSEPILOT_HERMES_CMD overrides it as a shell-
    style command line, because a fleet server may keep hermes outside PATH,
    and because a .cmd stub cannot be launched without a shell on Windows.
    Use forward slashes: the value is split with POSIX rules, so a Windows
    backslash path would be read as an escape and silently mangled."""
    override = os.environ.get("PULSEPILOT_HERMES_CMD", "").strip()
    if not override:
        return ["hermes"]
    parts = shlex.split(override)
    if not parts:
        return ["hermes"]
    return parts


def hermes_argv(turn, job_dir, model, toolsets, yolo):
    """First turn starts a session in the job dir; later turns continue it.

    -z keeps stdout to the final response only, which is what the marker
    protocol needs. --in pins the session to this job's directory, so parallel
    jobs cannot resume each other's conversation.
    """
    argv = hermes_prefix()
    if turn == 0:
        argv += ["--in", str(job_dir)]
    else:
        argv += ["--continue", "--in", str(job_dir)]
    if model:
        argv += ["--model", model]
    if toolsets:
        argv += ["--toolsets", toolsets]
    if yolo:
        # Autonomous fleet runs cannot answer an approval prompt: the process
        # would sit forever and the card would read as "agent is working".
        argv.append("--yolo")
    return argv


def run_turn(prompt, turn, job_dir, model, toolsets, yolo):
    result = subprocess.run(
        hermes_argv(turn, job_dir, model, toolsets, yolo) + ["-z", prompt],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", shell=False)
    return result.returncode, result.stdout or ""


def await_answer(job_dir, question):
    """Block for the operator's answer. Returns (answer, answered)."""
    log("Жду ответа оператора")
    # The question must travel in status.json: the operator sees the run card,
    # not our stdout, and "ждёт оператора" without the question is a dead end.
    write_status(job_dir, "waiting_input", "Агент задал вопрос, ждёт оператора", question)
    line = sys.stdin.readline()
    if not line.strip():
        # stdin closed: the bridge is gone or the run was cancelled. Exiting
        # non-zero keeps the run out of 'completed'.
        return "", False
    try:
        answer = json.loads(line).get("answer", "")
    except ValueError:
        return "", False
    return str(answer), bool(answer.strip())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt-file", required=True)
    parser.add_argument("--job-dir", required=True)
    parser.add_argument("--run-id", default="")
    parser.add_argument("--model", default=os.environ.get("PULSEPILOT_WORKER_MODEL", ""))
    parser.add_argument("--toolsets", default=os.environ.get("PULSEPILOT_WORKER_TOOLSETS", ""))
    parser.add_argument("--yolo", default="1" if os.environ.get("PULSEPILOT_WORKER_YOLO", "1") == "1" else "0")
    args = parser.parse_args()

    job_dir = Path(args.job_dir).resolve()
    job_dir.mkdir(parents=True, exist_ok=True)
    task = Path(args.prompt_file).read_text(encoding="utf-8").strip()
    if not task:
        log("Пустое поручение")
        return 2

    contract = (
        "\n\n---\nТы работаешь как автономный исполнитель воркера PulsePilot. "
        f"Запуск {args.run_id or 'без id'}. "
        f"Если тебе нужен ответ человека, последней строкой выведи ровно "
        f"`{ASK_MARKER} <вопрос>`. Без этой строки считается, что ты закончил."
    )
    current = task + contract
    yolo = args.yolo == "1"

    for turn in range(MAX_TURNS):
        write_status(job_dir, "running", f"Запуск {turn + 1}")
        log(f"Запуск агента, ход {turn + 1}")
        code, output = run_turn(current, turn, job_dir, args.model, args.toolsets, yolo)
        body, question = split_question(output)
        if body:
            log(body[-SUMMARY_LIMIT:])
        if question:
            answer, ok = await_answer(job_dir, question)
            if not ok:
                log("Ответ оператора не получен")
                return 3
            log("Ответ получен, продолжаю")
            current = answer + contract
            continue
        (job_dir / "result.txt").write_text(body[:RESULT_LIMIT], encoding="utf-8")
        if code != 0:
            log(f"Агент завершился с кодом {code}")
            return code
        log("Задача выполнена")
        return 0

    log(f"Превышен лимит ходов: {MAX_TURNS}")
    return 4


if __name__ == "__main__":
    sys.exit(main())