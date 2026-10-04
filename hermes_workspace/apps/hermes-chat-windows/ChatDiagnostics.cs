using System.Globalization;

namespace HermesChat;

/// <summary>Короткая идентификация переписки и расхода для шапки HermesChat.</summary>
public static class ChatDiagnostics
{
    public static string ShortId(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return "—";
        var id = value.Trim();
        return id.Length <= 16 ? id : id[..10] + "…" + id[^4..];
    }

    public static string IdentityLine(
        string profile,
        string history,
        string gateway,
        string chatId,
        string sessionId,
        string messageId)
        => $"Профиль: {Value(profile)} · История: {Value(history)} · Шлюз: {Value(gateway)}"
           + $" · Чат: {ShortId(chatId)} · Сессия: {ShortId(sessionId)} · Сообщение: {ShortId(messageId)}";

    public static string ModelIdentityLine(string selectedModel, string servedModel)
    {
        var selection = selectedModel == "hermes-agent"
            ? "hermes-agent (gateway default)"
            : Value(selectedModel);
        return "selected_model=" + selection + Environment.NewLine
            + "served_model=" + Value(servedModel);
    }

    public static string UsageLine(
        int input,
        int output,
        int contextUsed,
        int contextMax,
        int contextPercent,
        int cacheRead,
        int cacheWrite,
        int cacheHitPct,
        double? costUsd,
        string costStatus,
        string provider,
        string model)
    {
        var context = contextUsed > 0 ? contextUsed : input;
        var parts = new List<string>
        {
            $"вход {input:N0}",
            $"выход {output:N0}",
            $"контекст {context:N0}" + (contextMax > 0 ? $"/{contextMax:N0}" : "")
                + (contextPercent > 0 ? $" ({contextPercent}%)" : ""),
            $"кэш {cacheRead:N0} чтение / {cacheWrite:N0} запись"
        };
        if (cacheHitPct > 0) parts.Add($"попадание в кэш {cacheHitPct}%");
        if (costUsd is double cost)
        {
            var status = string.IsNullOrWhiteSpace(costStatus) ? "" : " · " + costStatus;
            parts.Add("стоимость $" + cost.ToString("0.000000", CultureInfo.InvariantCulture) + status);
        }
        else parts.Add("стоимость —");
        if (provider.Length > 0 || model.Length > 0)
            parts.Add((provider.Length > 0 ? provider + "/" : "") + model);
        return string.Join(" · ", parts);
    }

    private static string Value(string value) =>
        string.IsNullOrWhiteSpace(value) ? "—" : value.Trim();
}
