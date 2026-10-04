# HermesChat — виндовс-чат под Hermes агента

Отдельное настольное приложение для Windows: окно чата, в котором Hermes-агент
работает с твоей машиной — файлы, команды, веб, инструменты. Это тонкий клиент
к `api_server` Hermes, а не своя реализация агента.

## Что нужно для работы

На машине должен быть запущен шлюз Hermes:

```
API_SERVER_ENABLED=true
API_SERVER_KEY=<длинный случайный ключ>
```

и команда `hermes gateway run` (или `hermes gateway install`, чтобы был автостарт).
Проверка: `hermes gateway status` должен показать, что шлюз работает.

## Установка и запуск

```
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o dist
```

Запускается `dist\HermesChat.exe` — внешних зависимостей нет.

При первом старте приложение само читает `API_SERVER_KEY` из
`%LOCALAPPDATA%\hermes\.env`. Если ключа там нет — впиши его в настройках.

## Как это устроено

Приложение не держит своего агента. Оно говорит шлюзу Hermes:

- `POST /v1/runs` с `input` и `session_id` диалога → `run_id`
- `GET /v1/runs/{id}/events` — SSE: `tool.started`, `tool.completed`,
  `message.delta`, `reasoning.available`, `run.completed`
- `POST /v1/runs/{id}/stop` — кнопка «Остановить»
- `GET /v1/runs/{id}` — финальный статус, если поток закрылся молча

`session_id` = id диалога, поэтому агент помнит контекст переписки между
сообщениями. Заголовок `X-Hermes-Session-Key` задаёт общий namespace памяти —
если указать его такой же, как у Telegram-разговора, память совпадёт.

## Файлы

| Файл | Что делает |
|---|---|
| `Models.cs` | Сообщения, диалоги, настройки |
| `HermesClient.cs` | HTTP + SSE к шлюзу, разбор событий |
| `Store.cs` | `state.json` в `%APPDATA%\HermesChat`, атомарная запись, `error.log` |
| `MainWindow.xaml/.cs` | Лента, ввод, стоп, статус шлюза |
| `SettingsWindow.xaml/.cs` | Адрес, ключ, session key, модель |

## Чего приложение не делает

- Не хранит ключ в открытом виде в репозитории — только в `%APPDATA%\HermesChat\state.json`.
- Не открывает портов наружу: это клиент, а не сервер.
- Не отвечает за работу шлюза. Если шлюз выключен — приложение скажет об этом в панели слева.