using System.Text;
using System.Text.Json.Nodes;

namespace HermesChat;

/// <summary>
/// Мост «события TUI gateway» → «события ленты» (RunEvent). Существующая лента,
/// счётчики расхода и блок одобрения продолжают работать как раньше: меняется
/// только источник — вместо SSE /v1/runs/{id}/events кадры приходят по WS.
///
/// Имена приводятся к тем, что уже разбирает Apply(): message.delta,
/// tool.started / tool.completed, run.completed, reasoning.available.
///
/// Два отличия от api_server, которые пришлось учесть:
///  * `reasoning.delta` приходит потоком, а не готовым блоком, поэтому
///    рассуждение копится в reasoning и публикуется в Note по завершении —
///    иначе оно мерцало бы на каждом токене и дёргало ленту;
///  * `tool.generating` приходит ДО tool.start, когда модель ещё печатает сам
///    вызов инструмента, — это и есть признак «агент что-то делает».
/// </summary>
public sealed class TuiEventBridge
{
    private readonly TuiGateway _gateway;
    private readonly Action<RunEvent> _emit;
    private readonly StringBuilder _reasoning = new();
    private readonly StringBuilder _text = new();
    private string? _runningTool;
    private DateTime _toolSince = DateTime.UtcNow;

    public TuiEventBridge(TuiGateway gateway, Action<RunEvent> emit)
    {
        _gateway = gateway;
        _emit = emit;
        _gateway.OnEvent += OnEvent;
    }

    /// <summary>Отсоединиться от шлюза: иначе обработчик удерживал бы ленту в памяти.</summary>
    public void Detach() => _gateway.OnEvent -= OnEvent;

    private static string TextOf(JsonNode? payload, params string[] keys)
    {
        if (payload is not JsonObject obj) return "";
        foreach (var key in keys)
            if (obj[key] is { } value) return NodeText(value);
        return "";
    }

    private static string NodeText(JsonNode value, int depth = 0)
    {
        if (value is JsonValue scalar)
            return scalar.TryGetValue<string>(out var text) ? text : scalar.ToJsonString();
        if (depth >= 4) return value.ToJsonString();
        if (value is JsonObject obj)
        {
            foreach (var key in new[] { "text", "content", "preview", "command", "path", "file_path", "url", "query", "output", "result", "args", "input" })
                if (obj[key] is { } child)
                {
                    var text = NodeText(child, depth + 1);
                    if (text.Length > 0) return text;
                }
            return obj.ToJsonString();
        }
        if (value is JsonArray array)
            return string.Join("\n", array.Take(8).Select(item => item is null ? "" : NodeText(item, depth + 1)).Where(text => text.Length > 0));
        return value.ToJsonString();
    }

    private static JsonObject? Inner(JsonNode? parameters, string key) =>
        parameters is JsonObject p && p[key] is JsonObject inner ? inner : null;

    private static bool IsError(JsonNode? payload)
    {
        if (payload is not JsonObject obj) return false;
        var value = obj["error"] ?? obj["is_error"];
        if (value is JsonValue scalar)
        {
            if (scalar.TryGetValue<bool>(out var flag)) return flag;
            if (scalar.TryGetValue<string>(out var text)) return !string.IsNullOrWhiteSpace(text);
        }
        return false;
    }

    private void OnEvent(string type, JsonNode? parameters)
    {
        var payload = Inner(parameters, "payload");

        switch (type)
        {
            case "message.delta":
            {
                var delta = TextOf(payload, "text", "delta");
                if (delta.Length == 0) return;
                _text.Append(delta);
                _emit(new RunEvent { Event = "message.delta", Delta = delta });
                return;
            }

            case "message.interim":
            {
                if (!TuiInterimPayload.TryExtract(parameters, out var text, out var alreadyStreamed)) return;
                _emit(new RunEvent { Event = "message.interim", Text = text, AlreadyStreamed = alreadyStreamed });
                return;
            }

            case "reasoning.delta":
            case "thinking.delta":
            {
                // Складываем, а не эмитим: поток рассуждения на каждом токене
                // перерисовывал бы ленту сотни раз за один ответ.
                var delta = TextOf(payload, "text", "delta");
                if (delta.Length > 0) _reasoning.Append(delta);
                _emit(new RunEvent { Event = "reasoning.chunk" });
                return;
            }

            case "tool.generating":
            {
                var name = TextOf(payload, "name", "tool");
                if (name.Length == 0) return;
                _runningTool = name;
                _toolSince = DateTime.UtcNow;
                _emit(new RunEvent { Event = "tool.generating", Tool = name });
                return;
            }

            case "tool.start":
            {
                var name = TextOf(payload, "name", "tool");
                if (name.Length == 0) name = _runningTool ?? "";
                _runningTool = name;
                _toolSince = DateTime.UtcNow;
                _emit(new RunEvent
                {
                    Event = "tool.started",
                    Tool = name,
                    Preview = TextOf(payload, "preview", "input", "args"),
                });
                return;
            }

            case "tool.complete":
            {
                var name = TextOf(payload, "name", "tool");
                if (name.Length == 0) name = _runningTool ?? "";
                var seconds = Math.Round((DateTime.UtcNow - _toolSince).TotalSeconds, 1);
                _runningTool = null;
                _emit(new RunEvent
                {
                    Event = "tool.completed",
                    Tool = name,
                    Preview = TextOf(payload, "result", "preview", "output"),
                    Error = IsError(payload),
                    Duration = seconds,
                });
                return;
            }

            case "message.complete":
            {
                // Финальный текст — источник истины для длинных ответов: он приходит
                // целиком и не зависит от того, сколько дельт долетело.
                var complete = TextOf(payload, "text");
                var item = new RunEvent { Event = "run.completed" };
                if (complete.Length > 0) item.Output = complete;
                else item.Output = _text.ToString();

                if (_reasoning.Length > 0)
                {
                    item.Reasoning = _reasoning.ToString();
                    _reasoning.Clear();
                }
                _text.Clear();
                ApplyUsage(item, Inner(payload, "usage") ?? payload);
                _emit(item);
                return;
            }

            case "approval.cancelled":
            case "request.cancel":
            {
                // Шлюз сам снял вопрос (таймаут, прерывание, закрытие сессии) —
                // окно должно исчезнуть само, а не висеть до следующего клика.
                _emit(new RunEvent
                {
                    Event = "approval.resolved",
                    Choice = (parameters?["reason"]?.ToString() ?? "отменено"),
                });
                return;
            }

            case "session.usage":
            {
                if (!TuiUsagePayload.TryExtract(parameters, out var usage)) return;
                var item = new RunEvent { Event = "usage" };
                ApplyUsage(item, usage);
                _emit(item);
                return;
            }

            case "status.update":
            {
                _emit(new RunEvent
                {
                    Event = "status",
                    Text = TextOf(payload, "text"),
                });
                return;
            }
        }
    }

    /// <summary>Разбор usage в поля RunEvent, чтобы ApplyUsage их посчитал как раньше.</summary>
    private static void ApplyUsage(RunEvent item, JsonNode? usage)
    {
        if (usage is not JsonObject node) return;
        item.InputTokens = Int(node, "input_tokens", "prompt_tokens", "input", "in");
        item.OutputTokens = Int(node, "output_tokens", "completion_tokens", "output", "out");
        item.TotalTokens = Int(node, "total_tokens", "total");
        item.ReasoningTokens = Int(node, "reasoning_tokens", "reasoning");
        item.CacheReadTokens = Int(node, "cache_read_input_tokens", "cache_read_tokens", "cache_read");
        item.CacheWriteTokens = Int(node, "cache_creation_input_tokens", "cache_write_tokens", "cache_write");
        item.ContextUsedTokens = Int(node, "context_used");
        item.ContextMaxTokens = Int(node, "context_max");
        item.ContextPercent = Int(node, "context_percent");
        item.CacheHitPercent = Int(node, "cache_hit_pct");
        item.ContextSource = TextOf(node, "context_source");
        item.ContextEstimated = Bool(node, "context_estimated");
        item.CostUsd = Number(node, "cost_usd", "actual_cost_usd", "estimated_cost_usd");
        item.CostStatus = TextOf(node, "cost_status");
        item.AverageLatencySeconds = Number(node, "avg_latency_s");
        item.AverageTokensPerSecond = Number(node, "avg_tps");
        item.Provider = TextOf(node, "provider");
        item.RuntimeModel = TextOf(node, "model");
    }

    private static int Int(JsonObject node, params string[] keys)
    {
        foreach (var key in keys)
            if (node[key] is JsonValue value && value.TryGetValue<int>(out var number))
                return number;
        return 0;
    }

    private static double? Number(JsonObject node, params string[] keys)
    {
        foreach (var key in keys)
            if (node[key] is JsonValue value && value.TryGetValue<double>(out var number))
                return number;
        return null;
    }

    private static bool? Bool(JsonObject node, string key) =>
        node[key] is JsonValue value && value.TryGetValue<bool>(out var result) ? result : null;
}
