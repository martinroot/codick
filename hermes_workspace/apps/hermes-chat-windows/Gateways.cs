using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows.Media;

namespace HermesChat;

/// <summary>
/// Внешний шлюз: отдельный агент Hermes на другой машине. Реестр нужен, чтобы
/// подключить, проверить и протестировать работу со всеми внешними агентами,
/// а не держать адреса в голове.
/// </summary>
public sealed class Gateway
{
    public string Id { get; set; } = "gw-" + Guid.NewGuid().ToString("N")[..8];
    public string Name { get; set; } = "Новый шлюз";
    /// <summary>Базовый адрес без слеша: http://host:port</summary>
    public string Url { get; set; } = "";
    /// <summary>Адрес api_server (/v1/capabilities, /v1/runs), если он на другой
    /// порт, чем <see cref="Url"/>. Hermes держит их раздельно: разговор и
    /// исполнение идут по WebSocket в `hermes serve` (9122), а проверка шлюза и
    /// тестовая задача — по REST в api_server (8642). Один адрес на оба не
    /// работает: на 9122 /v1/capabilities отдаёт 404, на 8642 нет /api/ws.
    /// Пусто — использовать <see cref="Url"/> (прежнее поведение для одного порта).</summary>
    public string ApiUrl { get; set; } = "";
    /// <summary>Свой токен шлюза. Общий на все машины означает, что любой сервер
    /// может исполнить задачу от чужого имени — поэтому токен у каждого свой.</summary>
    public string Token { get; set; } = "";
    /// <summary>Какой профиль за этим шлюзом закреплён. Пусто — свободный.</summary>
    public string ProfileId { get; set; } = "";
    public string Kind { get; set; } = "bridge";     // bridge | hermes
    public string Note { get; set; } = "";

    // ---- Результат последней проверки ----
    public string Status { get; set; } = "не проверен";
    public string StatusNote { get; set; } = "";
    public string Model { get; set; } = "";
    public long LatencyMs { get; set; }
    public int Toolsets { get; set; }

    public int Slots { get; set; }
    public long CheckedAt { get; set; }

    public bool Reachable => Status is "доступен" or "отвечает";
    /// <summary>Адрес для REST-проверки: отдельный api_server или тот же, что и Url.</summary>
    [JsonIgnore]
    public string RestBase => (ApiUrl.Length > 0 ? ApiUrl : Url).TrimEnd('/');
    public string StatusDetail { get; set; } = "";
    /// <summary>Цвет точки в списке. Привязывается напрямую: статус — единственное,
    /// что оператор видит сразу, поэтому он не должен требовать чтения подписи.
    /// Помечен JsonIgnore: кисть — объект WPF с циклами ссылок, и в state.json
    /// она превращала сохранение в исключение, то есть состояние не писалось вовсе.</summary>
    [JsonIgnore]
    public Brush StatusBrush => Status switch
    {
        "доступен" => new SolidColorBrush(Color.FromRgb(0x4F, 0xB4, 0x77)),
        "недоступен" => new SolidColorBrush(Color.FromRgb(0xE0, 0x60, 0x5A)),
        _ => new SolidColorBrush(Color.FromRgb(0x6B, 0x72, 0x7D))
    };
    [JsonIgnore]
    public bool HasToken => Token.Length >= 8;
    [JsonIgnore]
    public string CheckedText => CheckedAt == 0
        ? "ни разу не проверялся"
        : DateTimeOffset.FromUnixTimeSeconds(CheckedAt).ToLocalTime().ToString("dd.MM HH:mm:ss");

    /// <summary>Без адреса или токена проверять бессмысленно — говорим почему.</summary>
    public string ReadyError =>
        Url.Length == 0 ? "не указан адрес" :
        HasToken ? "" : "токен короче 8 символов";
}

/// <summary>Живой результат прогона задачи через внешний шлюз.</summary>
public sealed class GatewayProbe
{
    public bool Ok { get; set; }
    public string Stage { get; set; } = "";
    public string Detail { get; set; } = "";
    public long Milliseconds { get; set; }
    public string Output { get; set; } = "";
    public int InputTokens { get; set; }
    public int OutputTokens { get; set; }
    public string Model { get; set; } = "";
}

/// <summary>Клиент внешнего шлюза: capabilities, живой прогон задачи, отмена.</summary>
public sealed class GatewayClient(Gateway gateway)
{
    // REST-нога всегда идёт на ApiUrl: на порту `hermes serve` (9122) эндпоинта
    // /v1/capabilities нет вовсе, он живёт в api_server (8642).
    private static string Base(Gateway gateway) => gateway.RestBase;

    private HttpClient NewClient() => new() { Timeout = TimeSpan.FromSeconds(60) };

    private void Authorize(HttpRequestMessage request)
    {
        if (gateway.HasToken) request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", gateway.Token);
    }

    /// <summary>Шаг 1: шлюз вообще отвечает и пускает по ключу.</summary>
    public async Task<GatewayProbe> CapabilitiesAsync(CancellationToken cancel)
    {
        var started = DateTimeOffset.Now.ToUnixTimeMilliseconds();
        var probe = new GatewayProbe { Stage = "capabilities" };
        try
        {
            using var http = NewClient();
            using var request = new HttpRequestMessage(HttpMethod.Get, Base(gateway) + "/v1/capabilities");
            Authorize(request);
            using var response = await http.SendAsync(request, cancel);
            probe.Milliseconds = DateTimeOffset.Now.ToUnixTimeMilliseconds() - started;
            if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
            {
                probe.Detail = "Ключ отклонён (401) — проверь токен этого шлюза.";
                return probe;
            }
            if (!response.IsSuccessStatusCode)
            {
                probe.Detail = $"HTTP {(int)response.StatusCode} от /v1/capabilities.";
                return probe;
            }
            var body = await response.Content.ReadAsStringAsync(cancel);
            using var doc = JsonDocument.Parse(body);
            probe.Model = doc.RootElement.TryGetProperty("model", out var model) ? model.GetString() ?? "" : "";
            probe.Ok = true;
            probe.Detail = "отвечает, модель " + (probe.Model.Length == 0 ? "?" : probe.Model);
            return probe;
        }
        catch (TaskCanceledException)
        {
            probe.Detail = "Таймаут — адрес не отвечает.";
            probe.Milliseconds = DateTimeOffset.Now.ToUnixTimeMilliseconds() - started;
            return probe;
        }
        catch (HttpRequestException error)
        {
            probe.Detail = "Недоступен: " + error.Message;
            probe.Milliseconds = DateTimeOffset.Now.ToUnixTimeMilliseconds() - started;
            return probe;
        }
    }

    /// <summary>Шаг 2: реальная задача доходит до агента и возвращает ответ.
    /// Проверка capabilities ничего не значит, пока агент не выполнил хоть что-то.</summary>
    public async Task<GatewayProbe> RunTaskAsync(string input, string sessionId, CancellationToken cancel)
    {
        var probe = new GatewayProbe { Stage = "задача" };
        var started = DateTimeOffset.Now.ToUnixTimeMilliseconds();
        try
        {
            using var http = NewClient();
            var payload = new Dictionary<string, object?>
            {
                ["model"] = "hermes-agent",
                ["input"] = input,
                ["session_id"] = sessionId
            };
            using var request = new HttpRequestMessage(HttpMethod.Post, Base(gateway) + "/v1/runs")
            {
                Content = new StringContent(JsonSerializer.Serialize(payload), System.Text.Encoding.UTF8, "application/json")
            };
            Authorize(request);
            using var response = await http.SendAsync(request, cancel);
            var body = await response.Content.ReadAsStringAsync(cancel);
            if (!response.IsSuccessStatusCode)
            {
                probe.Detail = $"HTTP {(int)response.StatusCode}: " + body[..Math.Min(body.Length, 200)];
                return probe;
            }
            using var created = JsonDocument.Parse(body);
            var runId = created.RootElement.GetProperty("run_id").GetString() ?? "";

            for (var attempt = 0; attempt < 60; attempt++)
            {
                cancel.ThrowIfCancellationRequested();
                await Task.Delay(2500, cancel);
                using var poll = new HttpRequestMessage(HttpMethod.Get, $"{Base(gateway)}/v1/runs/{runId}");
                Authorize(poll);
                using var polled = await http.SendAsync(poll, cancel);
                var statusBody = await polled.Content.ReadAsStringAsync(cancel);
                if (!polled.IsSuccessStatusCode) continue;
                using var state = JsonDocument.Parse(statusBody);
                var status = state.RootElement.TryGetProperty("status", out var s) ? s.GetString() ?? "" : "";
                if (status is not ("completed" or "failed" or "cancelled" or "interrupted")) continue;
                probe.Milliseconds = DateTimeOffset.Now.ToUnixTimeMilliseconds() - started;
                if (state.RootElement.TryGetProperty("output", out var output)) probe.Output = output.GetString() ?? "";
                if (state.RootElement.TryGetProperty("usage", out var usage))
                {
                    if (usage.TryGetProperty("input_tokens", out var inTok) && inTok.TryGetInt32(out var i)) probe.InputTokens = i;
                    if (usage.TryGetProperty("output_tokens", out var outTok) && outTok.TryGetInt32(out var o)) probe.OutputTokens = o;
                }
                if (state.RootElement.TryGetProperty("runtime", out var runtime)
                    && runtime.TryGetProperty("model", out var model)) probe.Model = model.GetString() ?? "";
                probe.Ok = status == "completed";
                probe.Detail = probe.Ok
                    ? "агент выполнил задачу"
                    : status == "failed" ? "агент сообщил об ошибке" : "запуск прерван: " + status;
                return probe;
            }
            probe.Milliseconds = DateTimeOffset.Now.ToUnixTimeMilliseconds() - started;
            probe.Detail = "Агент не ответил за 2,5 минуты.";
            return probe;
        }
        catch (TaskCanceledException)
        {
            probe.Detail = "Таймаут задачи.";
            return probe;
        }
        catch (HttpRequestException error)
        {
            probe.Detail = "Сбой связи: " + error.Message;
            return probe;
        }
    }

    /// <summary>Шаг 0: подсказка с адреса и порта — что чаще всего и нужно чинить.</summary>
    public static string Diagnose(string url)
    {
        if (url.Length == 0) return "Адрес пуст.";
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return "Адрес должен начинаться с http:// или https://";
        if (uri.Scheme is not ("http" or "https")) return "Схема только http или https.";
        if (uri.Host.Length == 0) return "В адресе нет хоста.";
        var port = uri.Port;
        return port == 80 || port == 443
            ? "Порт не указан явно. Для шлюза Hermes обычно 9119 (hermes serve)."
            : $"Порт {port}.";
    }

    /// <summary>Тот же адрес для WS-ноги. На api_server (8642) /api/ws нет, поэтому
    /// разговор идёт на порт `hermes serve`.</summary>
    public static string DiagnoseWs(string url)
    {
        if (url.Length == 0) return "Адрес пуст.";
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return "Адрес должен начинаться с http:// или https://";
        if (uri.Port == 8642)
            return "Порт 8642 — это старый api_server: он больше не поднимается, и /api/ws там не было. Для разговора нужен hermes serve (обычно 9119).";
        return $"Порт {uri.Port}.";
    }
}