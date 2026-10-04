using System.Text.Json.Nodes;

namespace HermesChat;

/// <summary>Извлечение usage из event envelope TUI Gateway.</summary>
public static class TuiUsagePayload
{
    public static bool TryExtract(JsonNode? parameters, out JsonNode? usage)
    {
        var envelope = parameters as JsonObject;
        var payload = envelope?["payload"] as JsonObject ?? envelope;
        usage = payload?["usage"];
        return usage is JsonObject;
    }
}
