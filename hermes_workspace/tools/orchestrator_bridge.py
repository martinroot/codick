#!/usr/bin/env python3
"""Мост «оркестратор → исполнитель» для HermesWorkspace.

Две сущности: чат владельца с оркестратором и чат шлюза, куда оркестратор
пишет задачи. Мост даёт оркестратору три вещи, которых у него иначе нет:

* ``status`` — привязка проекта, шлюз, сессии, ход цикла и счётчики дерева;
* ``read``   — последние сообщения чата исполнителя (то, что агент сделал);
* ``send``   — поставить задачу в очередь чата исполнителя;
* ``tree``   — незакрытые TODO по проекту.

Чтение идёт напрямую из state.json приложения: это локальная копия истории, и
такой способ ничего не ломает. А вот запись в чужой диалог идёт через
ОЧЕРЕДЬ, а не через соединение с сессией: соединение на сессию шлюза
принадлежит приложению, и второй клиент, подключившийся к нему, начал бы
драться с ним за ввод. Очередь же просто помечает сообщение, и приложение
отправляет его тем же путём, что и сообщение из интерфейса.

Только стандартная библиотека: скрипт запускается агентом на машине шлюза,
где может не быть ни pip, ни venv.

    python orchestrator_bridge.py status
    python orchestrator_bridge.py read 15
    python orchestrator_bridge.py tree
    python orchestrator_bridge.py send "Проверь статус оркестрации и вернись с итогом"
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path

APPDATA = os.environ.get("APPDATA") or str(Path.home())
STATE = Path(APPDATA) / "HermesWorkspace" / "state.json"
SNAPSHOT_NAME = "tree-snapshot.json"


# ── состояние приложения ────────────────────────────────────────────────────

def load_state() -> dict:
    if not STATE.exists():
        die(f"Не найден {STATE}. Приложение HermesWorkspace ещё не запускалось?")
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        # Битый state — это состояние падения приложения, а не наша ошибка.
        die(f"state.json не читается: {exc}")


def die(message: str) -> None:
    print(f"ОШИБКА: {message}", file=sys.stderr)
    raise SystemExit(1)


def save_state(state: dict) -> None:
    """Пишем атомарно: падение на середине оставило бы приложению нечитаемый
    state.json и потеряло бы всю переписку, а не одну задачу."""
    tmp = STATE.with_suffix(".json.mstmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, STATE)


# ── поиск своей пары диалогов ───────────────────────────────────────────────

def resolve_pair(state: dict) -> tuple[dict, dict]:
    """Находит чат оркестратора и чат исполнителя.

    Сначала идём по имени: агент обычно сам знает, в каком диалоге стоит.
    Иначе берём единственную привязку проекта — при нескольких такое молча
    выбрало бы чужой диалог, и задача ушла бы не туда.
    """
    threads = state.get("Threads") or []
    bindings = state.get("ChatBindings") or {}

    wanted = ""
    for arg in sys.argv[1:]:
        if arg.startswith("--profile="):
            wanted = arg.split("=", 1)[1]
    orch = exec_chat = None
    if wanted:
        binding = bindings.get(wanted)
        if binding:
            orch = by_id(threads, binding.get("OrchestratorThreadId"))
            exec_chat = by_id(threads, binding.get("ExecutorThreadId"))

    if orch is None and len(bindings) == 1:
        binding = next(iter(bindings.values()))
        orch = by_id(threads, binding.get("OrchestratorThreadId"))
        exec_chat = by_id(threads, binding.get("ExecutorThreadId"))

    if orch is None or exec_chat is None:
        pairs = ", ".join(sorted(bindings)) or "(нет)"
        die(f"Не нашёл пару «оркестратор + исполнитель». Привязанные проекты: {pairs}. "
            f"Укажи --profile=<id>.")
    return orch, exec_chat


def by_id(threads: list, thread_id) -> dict | None:
    return next((t for t in threads if t.get("Id") == thread_id), None)


def gateway_of(state: dict, thread: dict) -> dict:
    return next((g for g in (state.get("Gateways") or [])
                 if g.get("Id") == thread.get("GatewayId")), {})


def messages_of(thread: dict) -> list:
    return thread.get("Messages") or []


def show(thread: dict, limit: int) -> None:
    rows = [m for m in messages_of(thread) if (m.get("Text") or m.get("Streaming") or "").strip()]
    if not rows:
        print("(в диалоге нет сообщений)")
        return
    print(f"=== «{thread.get('Title')}» · сессия {thread.get('RemoteSessionId') or '(нет)'} · "
          f"сообщений {len(messages_of(thread))} ===")
    for message in rows[-limit:]:
        who = "Hermes" if message.get("Role") == "agent" else "Ты"
        text = (message.get("Streaming") or message.get("Text") or "").strip()
        mark = " [в очереди]" if message.get("Queued") else ""
        print(f"\n--- {who} ({message.get('Status') or '-'}){mark} ---")
        print(text)


# ── команды ─────────────────────────────────────────────────────────────────

def cmd_status(state: dict) -> None:
    orch, executor = resolve_pair(state)
    gw = gateway_of(state, executor)
    profiles = {p.get("Id"): p for p in (state.get("Profiles") or [])}
    binding = next((k for k, v in (state.get("ChatBindings") or {}).items()
                    if v.get("OrchestratorThreadId") == orch.get("Id")), "")
    profile = profiles.get(binding, {})

    print("ОРКЕСТРАЦИЯ")
    print(f"  профиль       : {profile.get('Name') or binding or '(без профиля)'}")
    print(f"  шлюз          : {gw.get('Name') or '(локальный)'}  {gw.get('Url')}")
    print(f"  статус шлюза  : {gw.get('Status') or 'не проверен'}")
    print(f"  папка шлюза   : {executor.get('WorkingDir') or '(папка сессии по умолчанию)'}")
    print()
    print("ЧАТ ОРКЕСТРАТОРА (ты здесь)")
    print(f"  сессия        : {orch.get('RemoteSessionId') or '(нет)'}")
    print(f"  сообщений     : {len(messages_of(orch))}")
    print()
    print("ЧАТ ИСПОЛНИТЕЛЯ (шлюз)")
    print(f"  сессия        : {executor.get('RemoteSessionId') or '(нет)'}")
    print(f"  сообщений     : {len(messages_of(executor))}")
    queued = [m for m in messages_of(executor) if m.get("Queued")]
    print(f"  в очереди     : {len(queued)}")
    running = [m for m in messages_of(executor) if m.get("Status") == "running"]
    print(f"  отвечает      : {'да' if running else 'нет'}")

    jobs = [j for j in (state.get("Iterations") or []) if not binding or j.get("ProfileId") == binding]
    if jobs:
        print()
        print("ХОД ЦИКЛА")
        for job in jobs[-8:]:
            print(f"  #{job.get('NodeId')} [{job.get('Status')}] {job.get('Title')}")

    counts = tree_counts(state, project_id_of(state))
    print()
    print(f"ДЕРЕВО: всего TODO {counts['total']}, закрыто {counts['done']}, "
          f"в работе {counts['todo']}, цели {counts['goal']}")


def tree_counts(state: dict, project_id: str = "") -> dict:
    """Считает дерево по снимку. Структура снимка — projects[].nodes[],
    а done приходит строкой "0"/"1", поэтому приводим явно: иначе "0"
    считалось бы истиной и всё дерево выглядело бы закрытым."""
    out = {"total": 0, "done": 0, "todo": 0, "goal": 0, "deferred": 0,
           "source": "(снимок не найден)", "projects": 0}
    path = snapshot_path(state)
    if path is None:
        return out
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return out
    out["source"] = str(path)

    def flag(value) -> bool:
        if isinstance(value, bool):
            return value
        return str(value).strip() in ("1", "true", "True")

    for project in data.get("projects") or []:
        if project_id and str(project.get("id")) != str(project_id):
            continue
        out["projects"] += 1
        for node in project.get("nodes") or []:
            out["total"] += 1
            if flag(node.get("done")):
                out["done"] += 1
            elif (node.get("lane") or "").lower() == "goal":
                out["goal"] += 1
            elif "@deferred" in (node.get("body") or ""):
                out["deferred"] += 1
            else:
                out["todo"] += 1
    return out


def snapshot_path(state: dict) -> Path | None:
    """Снимок берём из состояния, иначе ищем рядом со скриптом. Порядок важен:
    в состоянии лежит тот, по которому приложение реально работает."""
    recorded = state.get("TreeSnapshot") or ""
    if recorded and Path(recorded).exists():
        return Path(recorded)
    # Снимок лежит в apps/, а скрипт — в tools/, поэтому ищем ВВЕРХ по дереву
    # проекта, а не рядом с собой: rglob от tools/ до apps/ не доходит.
    here = Path(__file__).resolve()
    for parent in list(here.parents)[:5]:
        direct = parent / "apps" / "pulsepilot" / SNAPSHOT_NAME
        if direct.exists():
            return direct
        for candidate in parent.glob(f"**/{SNAPSHOT_NAME}"):
            return candidate
    return None


def project_id_of(state: dict) -> str:
    binding = next((k for k, v in (state.get("ChatBindings") or {}).items()
                    if v.get("ExecutorThreadId")), "")
    profile = next((p for p in (state.get("Profiles") or []) if p.get("Id") == binding), {})
    return str(profile.get("ProjectId") or "")


def cmd_tree(state: dict) -> None:
    counts = tree_counts(state, project_id_of(state))
    print(f"источник: {counts['source']}")
    print(f"всего {counts['total']} | закрыто {counts['done']} | к работе {counts['todo']} "
          f"| цели {counts['goal']} | отложено {counts['deferred']}")


def cmd_read(state: dict, limit: int) -> None:
    _, executor = resolve_pair(state)
    show(executor, limit)


def cmd_send(state: dict, text: str) -> None:
    _, executor = resolve_pair(state)
    if not text.strip():
        die("Пустая задача. usage: send \"текст\"")
    if executor.get("GatewayId") and not executor.get("RemoteSessionId"):
        print("ВНИМАНИЕ: у чата исполнителя ещё нет сессии на шлюзе — задача дождётся "
              "первой отправки из интерфейса.", file=sys.stderr)
    stamp = datetime.now().strftime("%H:%M:%S")
    message = {
        "Id": f"bridge-{stamp}-{len(messages_of(executor))}",
        "Role": "user",
        "Text": text.strip(),
        "Status": "",
        "Note": f"задача от оркестратора, {stamp}",
        "CreatedAt": int(datetime.now().timestamp()),
        "Queued": True,
    }
    messages_of(executor).append(message)
    save_state(state)
    print(f"Задача поставлена в очередь чата «{executor.get('Title')}» ({message['Id']}).")
    print("Приложение отправит её тем же путём, что и сообщение из интерфейса.")


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--profile=")]
    command = args[0] if args else "status"
    state = load_state()
    if command == "status":
        cmd_status(state)
    elif command == "tree":
        cmd_tree(state)
    elif command == "read":
        cmd_read(state, int(args[1]) if len(args) > 1 and args[1].isdigit() else 12)
    elif command == "send":
        cmd_send(state, args[1] if len(args) > 1 else "")
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())