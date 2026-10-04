#!/usr/bin/env python3
"""Legacy launcher disabled: HermesWorkspace owns the two selected chat sessions."""
import sys
print("HermesWorkspace 1.2: поручения переносит приложение через выбранные чаты. "
      "В настройках проекта выберите чат оркестратора и чат исполнителя, затем START. "
      "Оркестратор отвечает в своём чате JSON-схемой из сообщения приложения. "
      "Не запускайте отдельные мосты/API-скрипты. Старый код сохранён в tools/legacy/gateway_chat.py.", file=sys.stderr)
sys.exit(2)
