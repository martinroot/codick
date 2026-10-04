using System.IO;
using System.Net.Http;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace HermesChat;

public sealed class TuiRpcException(int code, string message) : Exception(message)
{
    public int Code { get; } = code;
}

/// <summary>
/// Клиент TUI gateway — документированный протокол для кастомного десктоп-хоста
/// (website/docs/developer-guide/programmatic-integration.md, раздел «Which one
/// should I use?»). Транспорт — WebSocket /api/ws, кадры — JSON-RPC построчно.
///
/// Почему не api_server: тот рассчитан на OpenAI-совместимые HTTP-фронтенды и
/// сознательно не покрывает approvals/clarify/session branching. Здесь approvals
/// приходят запросами от шлюза к клиенту, а не POST-ом с таймаутом и 409, а
/// `client.capabilities {server_requests:true}` — обязательное условие: без него
/// шлюз отклоняет все approvals (в отличие от нашего прежнего клиента, который
/// этого вызова не делал вовсе).
/// </summary>
public sealed class TuiGateway : IDisposable
{
    private readonly Uri _httpBase;
    private ClientWebSocket? _ws;
    private readonly SemaphoreSlim _writeLock = new(1);
    private readonly CancellationTokenSource _stop = new();
    private int _nextId;

    /// <summary>Живой runtime id, выданный шлюзом. Обязателен в каждом prompt.submit.</summary>
    public string SessionId { get; private set; } = "";

    /// <summary>Долговечный ключ сессии для хранения в приложении и session.resume.</summary>
    public string StoredSessionId { get; private set; } = "";

    /// <summary>Событие шлюза: type из params.type (message.delta, tool.start, …).</summary>
    public event Action<string, JsonNode?>? OnEvent;
    public event Action? OnDisconnected;

    /// <summary>Запрос шлюза к клиенту (approval, clarify, secret, …).</summary>
    public event Action<string, string, JsonNode?>? OnServerRequest;

    public bool Connected => _ws is { State: WebSocketState.Open };

    public TuiGateway(Uri httpBase) => _httpBase = httpBase;

    /// <summary>Подключение: WS-handshake на /api/ws с сессионным токеном.</summary>
    public async Task ConnectAsync(CancellationToken ct = default)
    {
        var token = await FetchSessionTokenAsync(ct).ConfigureAwait(false);
        if (string.IsNullOrEmpty(token))
            throw new InvalidOperationException("serve не отдал __HERMES_SESSION_TOKEN__ на " + _httpBase);

        var wsBase = (_httpBase.Scheme == "https") ? "wss" : "ws";
        var uri = new Uri($"{wsBase}://{_httpBase.Host}:{_httpBase.Port}/api/ws?token={Uri.EscapeDataString(token)}");
        var socket = new ClientWebSocket();
        await socket.ConnectAsync(uri, ct).ConfigureAwait(false);
        _ws = socket;

        // Без этого вызова шлюз отклоняет ВСЕ approvals: он не знает, что клиент
        // умеет их показывать, и не считает их «не показанными».
        await SendAsync(new JsonObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = NextId(),
            ["method"] = "client.capabilities",
            ["params"] = new JsonObject { ["server_requests"] = true },
        }, ct).ConfigureAwait(false);

        _ = PumpAsync();
    }

    private string NextId() => "c" + Interlocked.Increment(ref _nextId);

    /// <summary>Сессионный токен отдаётся на GET /, когда auth gate выключен (loopback).</summary>
    private async Task<string> FetchSessionTokenAsync(CancellationToken ct)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        var html = await http.GetStringAsync(new Uri(_httpBase, "/"), ct).ConfigureAwait(false);
        var at = html.IndexOf("__HERMES_SESSION_TOKEN__", StringComparison.Ordinal);
        if (at < 0) return "";
        var open = html.IndexOf('"', at);
        var close = open < 0 ? -1 : html.IndexOf('"', open + 1);
        return open > 0 && close > open ? html[(open + 1)..close] : "";
    }

    /// <summary>Создать сессию на шлюзе. Модель намеренно не задаётся: при явном
    /// model=идентификаторе шлюз пытался резолвить его как внешний и отдавал ошибку
    /// «Model '…'» вместо ответа.</summary>
    public async Task<string> CreateSessionAsync(
        string title,
        CancellationToken ct = default,
        IEnumerable<(string role, string content)>? history = null)
    {
        var parameters = new JsonObject { ["title"] = title };
        var seed = history?
            .Where(message => (message.role is "user" or "assistant") && !string.IsNullOrWhiteSpace(message.content))
            .Select(message => new Dictionary<string, string> { ["role"] = message.role, ["content"] = message.content })
            .ToList();
        if (seed is { Count: > 0 }) parameters["messages"] = JsonSerializer.SerializeToNode(seed);
        var answer = await RequestAsync("session.create", parameters, ct).ConfigureAwait(false);
        var sid = (string?)answer?["session_id"] ?? "";
        if (sid.Length == 0) throw new InvalidOperationException("session.create не вернул session_id");
        SessionId = sid;
        StoredSessionId = (string?)answer?["stored_session_id"] ?? sid;
        return sid;
    }

    /// <summary>Восстановить долговечную сессию после переподключения или перезапуска шлюза.</summary>
    public async Task ResumeSessionAsync(string storedSessionId, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(storedSessionId))
            throw new ArgumentException("Нужен долговечный id сессии.", nameof(storedSessionId));
        var result = await RequestAsync("session.resume", new JsonObject
        {
            ["session_id"] = storedSessionId,
            ["defer_history"] = true,
        }, ct).ConfigureAwait(false);
        var runtimeId = (string?)result?["session_id"] ?? "";
        if (runtimeId.Length == 0) throw new InvalidOperationException("session.resume не вернул session_id");
        SessionId = runtimeId;
        StoredSessionId = (string?)result?["stored_session_id"] ?? storedSessionId;
    }

    /// <summary>Подписаться на сессию, которая уже активна в этом процессе gateway.</summary>
    public async Task ActivateSessionAsync(string sessionId, CancellationToken ct = default)
    {
        var result = await RequestAsync("session.activate", new JsonObject { ["session_id"] = sessionId }, ct)
            .ConfigureAwait(false);
        var activated = (string?)result?["session_id"] ?? "";
        if (activated.Length > 0) SessionId = activated;
        StoredSessionId = (string?)result?["stored_session_id"] ?? StoredSessionId;
    }

    /// <summary>Отправить реплику. Ответ агента приходит событиями message.delta.</summary>
    public Task SubmitAsync(string text, CancellationToken ct = default) =>
        RequestAsync("prompt.submit", new JsonObject { ["session_id"] = SessionId, ["text"] = text }, ct);

    /// <summary>Зафиксировать один ответ batch-clarify. Последний lock разрешает исходный запрос.</summary>
    public Task<JsonNode?> LockClarifyAnswerAsync(string requestId, string questionId, string? answer,
        CancellationToken ct = default) => RequestAsync("clarify.lock", new JsonObject
    {
        ["request_id"] = requestId,
        ["question_id"] = questionId,
        ["answer"] = answer is null ? null : JsonValue.Create(answer),
    }, ct);

    /// <summary>Ответ на запрос шлюза (approval и прочие): тот же id, выбор пользователя.</summary>
    public Task AnswerAsync(string id, JsonNode result) =>
        SendAsync(new JsonObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = id,
            ["result"] = result,
        }, CancellationToken.None);

    private async Task<JsonNode?> RequestAsync(string method, JsonObject parameters, CancellationToken ct)
    {
        var id = NextId();
        var waiter = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[id] = waiter;
        try
        {
            await SendAsync(new JsonObject
            {
                ["jsonrpc"] = "2.0", ["id"] = id, ["method"] = method, ["params"] = parameters,
            }, ct).ConfigureAwait(false);
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct, _stop.Token);
            limit.CancelAfter(TimeSpan.FromSeconds(60));
            using var registration = limit.Token.Register(() =>
            {
                if (ct.IsCancellationRequested) waiter.TrySetCanceled(ct);
                else if (_stop.IsCancellationRequested) waiter.TrySetException(new IOException("Соединение со шлюзом закрыто."));
                else waiter.TrySetException(new TimeoutException("Шлюз не подтвердил " + method + " за 60 секунд."));
            });
            return await waiter.Task.ConfigureAwait(false);
        }
        finally { _pending.TryRemove(id, out _); }
    }

    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, TaskCompletionSource<JsonNode?>> _pending = new();

    private async Task SendAsync(JsonObject message, CancellationToken ct)
    {
        var socket = _ws ?? throw new InvalidOperationException("WebSocket не подключён");
        var bytes = Encoding.UTF8.GetBytes(message.ToJsonString());
        await _writeLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await socket.SendAsync(bytes, WebSocketMessageType.Text, true, ct).ConfigureAwait(false);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    private async Task PumpAsync()
    {
        try
        {
        var buffer = new byte[64 * 1024];
        while (!_stop.IsCancellationRequested && _ws is { State: WebSocketState.Open })
        {
            try
            {
                using var stream = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await _ws.ReceiveAsync(new ArraySegment<byte>(buffer), _stop.Token).ConfigureAwait(false);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        _stop.Cancel();
                        return;
                    }
                    stream.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);

                if (stream.Length == 0) continue;
                Dispatch(Encoding.UTF8.GetString(stream.ToArray()));
            }
            catch (OperationCanceledException) { return; }
            catch (Exception) { try { _stop.Cancel(); } catch (ObjectDisposedException) { } return; }
        }
        }
        finally { OnDisconnected?.Invoke(); }
    }

    /// <summary>Разбор входящего кадра: ответ на наш запрос, событие или запрос к нам.</summary>
    private void Dispatch(string text)
    {
        JsonNode? node;
        try { node = JsonNode.Parse(text); } catch (JsonException) { return; }
        if (node is not JsonObject message) return;

        var id = (string?)message["id"];
        var method = (string?)message["method"];

        if (method is null && id is not null)
        {
            if (_pending.TryRemove(id, out var waiter))
            {
                if (message["error"] is JsonObject error)
                {
                    var code = error["code"] is JsonValue codeNode && codeNode.TryGetValue<int>(out var parsedCode)
                        ? parsedCode : 0;
                    var detail = error["message"]?.GetValue<string>() ?? "JSON-RPC запрос отклонён шлюзом.";
                    waiter.TrySetException(new TuiRpcException(code, detail));
                }
                else
                {
                    waiter.TrySetResult(message["result"]);
                }
            }
            return;
        }

        var parameters = message["params"] as JsonObject;

        // Запрос шлюза к клиенту: метод + id → обязан ответить тем же id.
        if (method is not null && id is not null && method != "event")
        {
            OnServerRequest?.Invoke(id, method, parameters);
            return;
        }

        // Событие: тип лежит в params.type.
        var type = (string?)parameters?["type"];
        if (type is not null) OnEvent?.Invoke(type, parameters);
    }

    public void Dispose()
    {
        _stop.Cancel();
        _ws?.Dispose();
        _writeLock.Dispose();
        _stop.Dispose();
    }
}
