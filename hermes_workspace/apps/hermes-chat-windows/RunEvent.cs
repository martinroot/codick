using System.Text.Json.Serialization;

namespace HermesChat;

/// <summary>Событие из потока запуска: SSE /v1/runs/{id}/events и мост TUI-шлюза
/// приводят оба к этому типу, поэтому лента и Apply() одинаково понимают оба
/// источника. Вынесено из HermesClient, чтобы транспорт и модель события не
/// тянули друг друга в тестовую сборку.</summary>
public sealed class RunEvent
{
    public string Event { get; set; } = "";
    public string RunId { get; set; } = "";
    public long Seq { get; set; }
    public string Delta { get; set; } = "";
    public string Text { get; set; } = "";
    public string Output { get; set; } = "";
    public string Tool { get; set; } = "";
    public string Preview { get; set; } = "";
    public bool Error { get; set; }
    public double Duration { get; set; }
    public bool AlreadyStreamed { get; set; }
    public int InputTokens { get; set; }
    public int OutputTokens { get; set; }
    public int CacheReadTokens { get; set; }
    public int CacheWriteTokens { get; set; }
    public int TotalTokens { get; set; }
    public int ReasoningTokens { get; set; }
    [JsonPropertyName("context_used")]
    public int ContextUsedTokens { get; set; }
    [JsonPropertyName("context_max")]
    public int ContextMaxTokens { get; set; }
    [JsonPropertyName("context_percent")]
    public int ContextPercent { get; set; }
    [JsonPropertyName("cache_hit_pct")]
    public int CacheHitPercent { get; set; }
    [JsonPropertyName("context_source")]
    public string ContextSource { get; set; } = "";
    [JsonPropertyName("context_estimated")]
    public bool? ContextEstimated { get; set; }
    [JsonPropertyName("cost_usd")]
    public double? CostUsd { get; set; }
    [JsonPropertyName("cost_status")]
    public string CostStatus { get; set; } = "";
    [JsonPropertyName("avg_latency_s")]
    public double? AverageLatencySeconds { get; set; }
    [JsonPropertyName("avg_tps")]
    public double? AverageTokensPerSecond { get; set; }
    public string Provider { get; set; } = "";
    /// <summary>Модель, которая реально ответила. Совпадает с запрошенной не всегда:
    /// провайдер умеет переключаться на резервную.</summary>
    public string RuntimeModel { get; set; } = "";
    public string RouteSource { get; set; } = "";
    public double CreatedAt { get; set; }
    public double UpdatedAt { get; set; }
    public long DurationMs => UpdatedAt > CreatedAt ? (long)((UpdatedAt - CreatedAt) * 1000) : 0;
    public string Status { get; set; } = "";
    public string Message { get; set; } = "";
    // ---- Одобрение инструмента ----
    public string RequestId { get; set; } = "";
    public string Command { get; set; } = "";
    public string ToolName { get; set; } = "";
    public List<string> Choices { get; set; } = new();
    public bool SmartDenied { get; set; }
    public string Reason { get; set; } = "";
    public string Choice { get; set; } = "";
    /// <summary>Поток рассуждений, накопленный из reasoning.delta.</summary>
    public string Reasoning { get; set; } = "";
}