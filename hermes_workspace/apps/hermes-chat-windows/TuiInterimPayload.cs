using System.Text.Json.Nodes;

namespace HermesChat;

public static class TuiInterimPayload
{
    public static bool TryExtract(JsonNode? parameters, out string text, out bool alreadyStreamed)
    {
        var envelope = parameters as JsonObject;
        var payload = envelope?["payload"] as JsonObject ?? envelope;
        text = payload?["text"]?.ToString() ?? "";
        alreadyStreamed = payload?["already_streamed"] is JsonValue value
            && value.TryGetValue<bool>(out var flag) && flag;
        return text.Length > 0;
    }
}
