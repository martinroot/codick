using System.IO;
using System.Net.Http.Headers;
using System.Net.Http;
using System.Net;
using System.Text.Json.Serialization;
using System.Text.Json;
using System.Text;

namespace HermesChat;

public sealed class HermesException(string message, int status = 0) : Exception(message)
{
    public int Status { get; } = status;
}

/// <summary>Клиент api_server Hermes: создание run, SSE событий, остановка, опрос статуса.</summary>
public sealed class HermesClient(ChatSettings settings, string? baseUrl = null, string? token = null)
{
    public ChatSettings Config { get; } = settings;

    /// <summary>Куда реально ходим. Пусто — локальный шлюз из настроек.
    /// Иначе диалог с внешним агентом ушёл бы на localhost, и «переехать туда»
    /// было бы негде.</summary>
    public string TargetBase { get; } = (baseUrl is { Length: > 0 } ? baseUrl : settings.NormalizedBase).TrimEnd('/');

    /// <summary>Ключ этого адреса. У каждого шлюза свой: общий на тринадцать машин
    /// означал бы, что любой сервер исполнит задачу от чужого имени.</summary>
    public string TargetToken { get; } = token is { Length: > 0 } ? token : settings.ApiKey;

    /// <summary>HttpClient один на клиент и переиспользуется. Раньше он создавался
    /// на каждый запрос и не освобождался: сокеты копились в TIME_WAIT, и во время
    /// длинного ответа (поток держится минутами) новое соединение ждало свободного
    /// — приложение «думало» уже после того, как шлюз принял сообщение.
    /// Timeout 120 с: он покрывает и открытие потока, и обычные запросы.</summary>
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(120) };

    private HttpClient NewClient() => _http;

    private void Authorize(HttpRequestMessage request, string sessionKey = "")
    {
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", TargetToken);
        // У профиля своя память: без своего session key диалоги разных направлений
        // попадали бы в один namespace и путали контекст.
        var key = sessionKey.Length > 0 ? sessionKey : Config.DefaultSessionKey;
        if (key.Length > 0) request.Headers.TryAddWithoutValidation("X-Hermes-Session-Key", key);
    }

    /// <summary>Навыки с диска. Эндпоинт /v1/skills у шлюза падает500, поэтому читаем каталог.</summary>
    public List<SkillInfo> ReadSkills()
    {
        var list = new List<SkillInfo>();
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "hermes", "skills");
        if (!Directory.Exists(root)) return list;
        foreach (var file in Directory.EnumerateFiles(root, "SKILL.md", SearchOption.AllDirectories))
        {
            try
            {
                var head = File.ReadLines(file).Take(12).ToArray();
                string name = "", description = "";
                foreach (var line in head)
                {
                    if (line.StartsWith("name:", StringComparison.Ordinal)) name = line[5..].Trim().Trim('"');
                    else if (line.StartsWith("description:", StringComparison.Ordinal)) description = line[12..].Trim().Trim('"');
                    if (name.Length > 0 && description.Length > 0) break;
                }
                if (name.Length == 0) continue;
                var relative = Path.GetRelativePath(root, Path.GetDirectoryName(file)!).Replace('\\', '/');
                list.Add(new SkillInfo { Name = name, Description = description, Category = relative });
            }
            catch (Exception) { /* нечитаемый SKILL.md не должен ломать весь список */ }
        }
        return list.OrderBy(s => s.Category).ThenBy(s => s.Name).ToList();
    }

    /// <summary>Тулсеты, которые шлюз реально отдал агенту: /v1/toolsets.</summary>
    public async Task<List<ToolsetInfo>> ReadToolsetsAsync(CancellationToken cancel)
    {
        var http = NewClient();   // общий, не using: using закрыл бы его для всех
        using var request = new HttpRequestMessage(HttpMethod.Get, TargetBase + "/v1/toolsets");
        Authorize(request);
        using var response = await http.SendAsync(request, cancel);
        if (!response.IsSuccessStatusCode) return new List<ToolsetInfo>();
        var body = await response.Content.ReadAsStringAsync(cancel);
        using var doc = JsonDocument.Parse(body);
        var list = new List<ToolsetInfo>();
        if (!doc.RootElement.TryGetProperty("data", out var data)) return list;
        foreach (var item in data.EnumerateArray())
        {
            var tools = new List<string>();
            if (item.TryGetProperty("tools", out var toolArray) && toolArray.ValueKind == JsonValueKind.Array)
                foreach (var tool in toolArray.EnumerateArray())
                    if (tool.GetString() is { Length: > 0 } name) tools.Add(name);
            list.Add(new ToolsetInfo
            {
                Name = item.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "",
                Enabled = item.TryGetProperty("enabled", out var e) && e.ValueKind == JsonValueKind.True,
                Configured = item.TryGetProperty("configured", out var c) && c.ValueKind == JsonValueKind.True,
                Tools = tools
            });
        }
        return list;
    }

    /// <summary>Сессии шлюза: GET /api/sessions. Настоящая история разговоров
    /// живёт там, а не в state.json, поэтому список диалогов приложения без
    /// этого запроса видел бы только собственные переписки.</summary>
    public async Task<List<RemoteSession>> ReadSessionsAsync(CancellationToken cancel)
    {
        var http = NewClient();   // общий, не using: using закрыл бы его для всех
        using var request = new HttpRequestMessage(HttpMethod.Get, TargetBase + "/api/sessions?limit=100");
        Authorize(request);
        using var response = await http.SendAsync(request, cancel);
        var body = await response.Content.ReadAsStringAsync(cancel);
        if (!response.IsSuccessStatusCode) throw new HermesException(Explain(response.StatusCode, body), (int)response.StatusCode);
        using var doc = JsonDocument.Parse(body);
        var list = new List<RemoteSession>();
        if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array) return list;
        foreach (var item in data.EnumerateArray())
            list.Add(new RemoteSession
            {
                Id = Text(item, "id"),
                Title = Text(item, "title"),
                Source = Text(item, "source"),
                Model = Text(item, "model"),
                MessageCount = Num(item, "message_count"),
                ToolCallCount = Num(item, "tool_call_count"),
                StartedAt = Dbl(item, "started_at"),
                LastActive = Dbl(item, "last_active"),
                Preview = Text(item, "preview")
            });
        // Порядок — по последней активности: свежие разговоры первыми, иначе
        // список выглядит мёртвым, хотя работа идёт прямо сейчас.
        return list.OrderByDescending(s => s.LastActive > 0 ? s.LastActive : s.StartedAt).ToList();
    }

    /// <summary>История одной сессии: GET /api/sessions/{id}/messages.
    /// Страницы приходят по limit/offset — длинная консольная сессия не влезает
    /// в один ответ, и молчаливый обрыв на середине означал бы потерю диалога.</summary>
    public async Task<List<RemoteMessage>> ReadSessionMessagesAsync(string sessionId, CancellationToken cancel)
    {
        var all = new List<RemoteMessage>();
        for (var offset = 0; offset < 5000; offset += 200)
        {
            var http = NewClient();   // общий, не using: using закрыл бы его для всех
            using var request = new HttpRequestMessage(HttpMethod.Get,
                $"{TargetBase}/api/sessions/{Uri.EscapeDataString(sessionId)}/messages?limit=200&offset={offset}");
            Authorize(request);
            using var response = await http.SendAsync(request, cancel);
            var body = await response.Content.ReadAsStringAsync(cancel);
            if (!response.IsSuccessStatusCode) throw new HermesException(Explain(response.StatusCode, body), (int)response.StatusCode);
            using var doc = JsonDocument.Parse(body);
            if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array) break;
            foreach (var item in data.EnumerateArray())
                all.Add(ReadMessage(item));
            var more = doc.RootElement.TryGetProperty("has_more", out var flag) && flag.ValueKind == JsonValueKind.True;
            if (!more) break;
        }
        return all;
    }

    private static RemoteMessage ReadMessage(JsonElement item)
    {
        var message = new RemoteMessage
        {
            Id = Text(item, "id"),
            Role = Text(item, "role"),
            ToolName = Text(item, "tool_name"),
            ToolCallId = Text(item, "tool_call_id"),
            Timestamp = Dbl(item, "timestamp")
        };
        message.Content = Content(item);
        // У вызова инструмента полезного текста нет: содержание в result/output.
        if (item.TryGetProperty("tool_calls", out var calls) && calls.ValueKind == JsonValueKind.Array)
        {
            foreach (var call in calls.EnumerateArray())
            {
                var name = Text(call, "function").Length > 0 ? Text(call, "function") : Text(call, "name");
                message.ToolCall = name.Length > 0 ? name : message.ToolCall;
            }
        }
        message.Result = item.TryGetProperty("result", out var result) ? Content(result)
            : item.TryGetProperty("output", out var output) ? Content(output) : "";
        if (message.ToolCall.Length == 0 && message.ToolName.Length > 0) message.ToolCall = message.ToolName;
        return message;
    }

    /// <summary>Текст поля. Контент приходит и строкой, и массивом частей
    /// ({type:text, text:...}) — оба вида надо принять, иначе сообщение
    /// отрисуется пустым.</summary>
    private static string Content(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.String => element.GetString() ?? "",
        JsonValueKind.Array => string.Concat(element.EnumerateArray().Select(part =>
            part.ValueKind == JsonValueKind.String ? part.GetString() ?? ""
            : part.TryGetProperty("text", out var text) ? text.GetString() ?? ""
            : part.TryGetProperty("content", out var content) ? Content(content) : "")),
        JsonValueKind.Object => element.TryGetProperty("text", out var single) ? single.GetString() ?? ""
            : element.TryGetProperty("content", out var inner) ? Content(inner) : "",
        _ => ""
    };

    private static string Text(JsonElement item, string name) =>
        item.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";

    private static int Num(JsonElement item, string name) =>
        item.TryGetProperty(name, out var value) && value.TryGetInt32(out var number) ? number : 0;

    private static double Dbl(JsonElement item, string name) =>
        item.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number ? value.GetDouble() : 0;

    public async Task<RunProbe> ProbeAsync(CancellationToken cancel)
    {
        var http = NewClient();   // общий, не using: using закрыл бы его для всех
        using var request = new HttpRequestMessage(HttpMethod.Get, TargetBase + "/v1/capabilities");
        Authorize(request);
        try
        {
            using var response = await http.SendAsync(request, cancel);
            if (response.StatusCode == HttpStatusCode.Unauthorized)
                return new RunProbe(false, "Ключ отклонён (401). Проверь API_SERVER_KEY.", 401);
            if (!response.IsSuccessStatusCode)
                return new RunProbe(false, $"HTTP {(int)response.StatusCode} от /v1/capabilities.", (int)response.StatusCode);
            var body = await response.Content.ReadAsStringAsync(cancel);
            using var doc = JsonDocument.Parse(body);
            var model = doc.RootElement.TryGetProperty("model", out var m) ? m.GetString() ?? "" : "";
            return new RunProbe(true, "Шлюз отвечает. Модель: " + (model.Length == 0 ? "?" : model), 200);
        }
        catch (TaskCanceledException) { return new RunProbe(false, "Таймаут. Шлюз не отвечает.", 0); }
        catch (HttpRequestException error) { return new RunProbe(false, "Шлюз недоступен: " + error.Message, 0); }
    }

    public async Task<string> StartRunAsync(
        string input, string sessionId, string model, string instructions, string sessionKey, CancellationToken cancel)
    {
        var http = NewClient();   // общий, не using: using закрыл бы его для всех
        var payload = new Dictionary<string, object?>
        {
            // model приходит из диалога: пусто — берётся модель по умолчанию из настроек
            ["model"] = model.Length > 0 ? model : Config.Model,
            ["input"] = input,
            ["session_id"] = sessionId
        };
        // instructions — «мозг» профиля. Шлюз наслаивает его поверх системного промпта,
        // поэтому инструменты и память агента сохраняются.
        if (instructions.Length > 0) payload["instructions"] = instructions;
        using var request = new HttpRequestMessage(HttpMethod.Post, TargetBase + "/v1/runs")
        {
            Content = new StringContent(JsonSerializer.Serialize(payload, JsonOpts), Encoding.UTF8, "application/json")
        };
        Authorize(request, sessionKey);
        using var response = await http.SendAsync(request, cancel);
        var body = await response.Content.ReadAsStringAsync(cancel);
        if (!response.IsSuccessStatusCode) throw new HermesException(Explain(response.StatusCode, body), (int)response.StatusCode);
        using var doc = JsonDocument.Parse(body);
        return doc.RootElement.GetProperty("run_id").GetString()
               ?? throw new HermesException("Шлюз не вернул run_id.");
    }

    /// <summary>Стримит событий. onEvent вызывается на UI-потоке через переданный делегат.</summary>
    public async Task StreamAsync(string runId, Action<RunEvent> onEvent, Action<string> onTerminal, CancellationToken cancel)
    {
        var http = NewClient();   // общий, не using: using закрыл бы его для всех
        using var request = new HttpRequestMessage(HttpMethod.Get, $"{TargetBase}/v1/runs/{runId}/events");
        Authorize(request);
        request.Headers.Accept.ParseAdd("text/event-stream");
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancel);
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(cancel);
            throw new HermesException(Explain(response.StatusCode, body), (int)response.StatusCode);
        }
        using var stream = await response.Content.ReadAsStreamAsync(cancel);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        while (!reader.EndOfStream)
        {
            var line = await reader.ReadLineAsync(cancel);
            if (line is null) break;
            if (!line.StartsWith("data: ", StringComparison.Ordinal)) continue;
            var payload = line[6..].Trim();
            if (payload.Length == 0) continue;
            RunEvent? parsed;
            try { parsed = JsonSerializer.Deserialize<RunEvent>(payload, JsonOpts); }
            catch (JsonException) { continue; }
            if (parsed is null) continue;
            onEvent(parsed);
            if (parsed.Event is "run.completed" or "run.failed" or "run.cancelled" or "run.interrupted")
            {
                onTerminal(parsed.Event);
                return;
            }
        }
        onTerminal("closed");   // поток закрылся без терминального события — финальный статус узнаем опросом
    }

    public async Task<RunEvent> StatusAsync(string runId, CancellationToken cancel)
    {
        var http = NewClient();   // общий, не using: using закрыл бы его для всех
        using var request = new HttpRequestMessage(HttpMethod.Get, $"{TargetBase}/v1/runs/{runId}");
        Authorize(request);
        using var response = await http.SendAsync(request, cancel);
        var body = await response.Content.ReadAsStringAsync(cancel);
        if (!response.IsSuccessStatusCode) throw new HermesException(Explain(response.StatusCode, body), (int)response.StatusCode);
        return JsonSerializer.Deserialize<RunEvent>(body, JsonOpts) ?? new RunEvent();
    }

    /// <summary>Ответ на запрос одобрения. choice: once | session | always | deny.
    /// Без этого run остаётся в waiting_for_approval навсегда.</summary>
    public async Task ApproveAsync(string runId, string choice, string? requestId)
    {
        var http = NewClient();   // общий, не using: using закрыл бы его для всех
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{TargetBase}/v1/runs/{runId}/approval")
        {
            Content = new StringContent(
                JsonSerializer.Serialize(new { choice, request_id = requestId }, JsonOpts), Encoding.UTF8, "application/json")
        };
        Authorize(request);
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        using var response = await http.SendAsync(request, cts.Token);
        var body = await response.Content.ReadAsStringAsync(cts.Token);
        if (!response.IsSuccessStatusCode) throw new HermesException(Explain(response.StatusCode, body), (int)response.StatusCode);
    }

    /// <summary>Подсказка в уже идущий запуск — как в консоли, где можно вмешаться на лету.</summary>
    public async Task SteerAsync(string runId, string input)
    {
        var http = NewClient();   // общий, не using: using закрыл бы его для всех
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{TargetBase}/v1/runs/{runId}/steer")
        {
            Content = new StringContent(
                JsonSerializer.Serialize(new { input }, JsonOpts), Encoding.UTF8, "application/json")
        };
        Authorize(request);
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        using var response = await http.SendAsync(request, cts.Token);
        var body = await response.Content.ReadAsStringAsync(cts.Token);
        if (!response.IsSuccessStatusCode) throw new HermesException(Explain(response.StatusCode, body), (int)response.StatusCode);
    }

    public async Task StopAsync(string runId)
    {
        var http = NewClient();   // общий, не using: using закрыл бы его для всех
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{TargetBase}/v1/runs/{runId}/stop")
        {
            Content = new StringContent("{}", Encoding.UTF8, "application/json")
        };
        Authorize(request);
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        try { await http.SendAsync(request, cts.Token); }
        catch (Exception) { /* остановка best-effort: пользователь уже нажал «стоп», результат узнаем опросом */ }
    }

    private static StringContent JsonContent(object value) =>
        new(JsonSerializer.Serialize(value, JsonOpts), Encoding.UTF8, "application/json");

    internal static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private static string Explain(HttpStatusCode status, string body)
    {
        var detail = "";
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("error", out var error))
            {
                if (error.ValueKind == JsonValueKind.Object && error.TryGetProperty("message", out var message))
                    detail = message.GetString() ?? "";
                else detail = error.ToString();
            }
        }
        catch (JsonException) { detail = body.Length > 200 ? body[..200] : body; }
        return $"HTTP {(int)status} от шлюза." + (detail.Length > 0 ? " " + detail : "");
    }
}

public sealed record RunProbe(bool Ok, string Note, int Status);

public sealed class ToolsetInfo
{
    public string Name { get; set; } = "";
    public bool Enabled { get; set; }
    public bool Configured { get; set; }
    public List<string> Tools { get; set; } = new();
}