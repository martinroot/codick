using System.Text.Json;

namespace PulsePilot;

public sealed class ProjectBrief
{
    public string Goal { get; set; } = "";
    public string Fact { get; set; } = "";
    public string Gate { get; set; } = "";
    public string SuggestedNode { get; set; } = "";
}
public sealed class FleetJob
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string NodeId { get; set; } = "";
    public string ProjectId { get; set; } = "";
    public string Title { get; set; } = "";
    public string Prompt { get; set; } = "";
    public string Locker { get; set; } = "";
    public string Resource { get; set; } = "";
    public string Source { get; set; } = "manual";
    public string Status { get; set; } = "prepared";
    public string RemoteId { get; set; } = "";
    public string Endpoint { get; set; } = "";
    public string Summary { get; set; } = "Поручение подготовлено. Агент ещё не запущен.";
    public string Question { get; set; } = "";
    public string Result { get; set; } = "";
    public string Note { get; set; } = "";
    public long CreatedAt { get; set; } = DateTimeOffset.Now.ToUnixTimeSeconds();
    public long CheckedAt { get; set; }
    public long NextCheckAt { get; set; }
    public long ProgressAt { get; set; }
    public long Version { get; set; }
    public long AlertAfter { get; set; }
    // ---- Живость запуска: последняя проверка локера и её результат ----
    public long LivenessAt { get; set; }
    public bool LivenessOk { get; set; }
    public string LivenessNote { get; set; } = "";
    /// <summary>Причина простоя из закрытого списка BlockReasons. Пусто — причина ещё не названа.</summary>
    public string BlockReason { get; set; } = "";
    public long BlockSince { get; set; }
}
public static class FleetRules
{
    public static bool Busy(FleetJob j) => j.Status is "submitting" or "queued" or "running" or "waiting_input" or "blocked" or "unknown" or "cancelling";
    /// <summary>Забытый запуск: карточка «готова к передаче», которой не воспользовались дольше двух интервалов staleness.</summary>
    public static bool Neglected(FleetJob j, long now, int staleSeconds) => j.Status == "prepared"
        && j.CreatedAt > 0 && now >= j.CreatedAt + staleSeconds * 2;
    /// <summary>Простой без названной причины: как минимум один staleness-интервал тишины и пустой BlockReason.</summary>
    public static bool UnreasonedSilence(FleetJob j, long now, int staleSeconds) =>
        Busy(j) && j.Status != "waiting_input" && j.BlockReason.Length == 0 && j.CheckedAt > 0
        && now >= j.CheckedAt + staleSeconds;
    public static bool Attention(FleetJob j, long now, int staleSeconds) => j.Status is "waiting_input" or "blocked" or "failed" or "unknown" or "review"
        || (j.Source == "api" && j.Status == "running" && j.ProgressAt > 0 && now - j.ProgressAt >= staleSeconds)
        || Neglected(j, now, staleSeconds)
        || UnreasonedSilence(j, now, staleSeconds)
        || (j.LivenessAt > 0 && !j.LivenessOk && (Busy(j) || j.Status is "prepared" or "review"))
        || (Busy(j) && now >= (j.NextCheckAt > 0 ? j.NextCheckAt : j.CheckedAt + staleSeconds));
    public static string StatusName(FleetJob j) => j.Status switch {
        "prepared" => "Готово к передаче", "submitting" => "Отправляется", "queued" => "В очереди агента",
        "running" => j.Source == "manual" ? "В работе · отметка оператора" : "Агент выполняет",
        "waiting_input" => "Агент ждёт ответа", "blocked" => "Нужен разбор блокера", "review" => "Результат на проверке",
        "failed" => "Ошибка выполнения", "unknown" => "Статус не подтверждён", "cancelling" => "Остановка запрошена",
        "cancelled" => "Остановлено", "done" => "Результат принят", _ => "Неизвестный статус" };
    public static bool Actionable(Node n) => n.Done == 0 && n.Lane.Equals("todo", StringComparison.OrdinalIgnoreCase)
        && !n.Body.Contains("@deferred", StringComparison.OrdinalIgnoreCase)
        && !n.Title.Contains("do not start", StringComparison.OrdinalIgnoreCase)
        && !new[] { "ЦЕЛЬ ", "МЕТРИКА", "РИСК ", "РИСКИ", "ГОТОВНОСТЬ К МАСШТАБИРОВАНИЮ", "✔ ЧК", "🔒" }.Any(x => n.Title.StartsWith(x, StringComparison.OrdinalIgnoreCase));
    public static bool CanStart(FleetJob job, IEnumerable<FleetJob> all, int slots) =>
        !all.Any(j => j.Id != job.Id && (Busy(j) || j.Status == "review") && (j.ProjectId == job.ProjectId || j.Resource == job.Resource))
        && all.Count(j => j.Id != job.Id && Busy(j)) < Math.Clamp(slots, 1, 7);
    public static Node? Suggest(Project p, StateStore state)
    {
        var preferred = state.ProjectBriefs.GetValueOrDefault(p.Id)?.SuggestedNode;
        var ready = p.Nodes.Where(n => Actionable(n) && state.LiveBlockers(n.Id, state.Tree).Count == 0);
        return ready.FirstOrDefault(n => n.Id == preferred)
            ?? ready.OrderByDescending(n => state.IsPinned(n.Id)).ThenBy(n => n.SortOrder).FirstOrDefault();
    }
    public static string MakePrompt(Project p, Node n, ProjectBrief brief) =>
        $"Направление: {p.Title}\nЦель: {brief.Goal}\nФакт по снимку: {brief.Fact}\nУсловие масштаба: {brief.Gate}\n\n" +
        $"Исполнить только TODO [{n.Id}]: {n.Title}\n{n.Body}\n\n" +
        "Контекст и ограничения проекта:\n" + string.Join("\n\n", p.Nodes.Where(x => x.Lane == "wiki").Select(x => x.Title + "\n" + x.Body)).Truncate(16000) +
        "\n\nВерни проверяемый результат, выполненные проверки, ссылку/артефакт и следующий TODO. " +
        "Wiki, цель и метрики — контекст, а не самостоятельные поручения. Не расширяй объём и не запускай другие проекты. " +
        "Сообщи блокер или waiting_input с одним вопросом, если требуется решение оператора. " +
        "Сохраняй ограничения расходов, модерации и параллелизма из контекста. Новая модель управления владельца: " +
        "3–7 независимых проектов могут исполняться параллельно; один focus означает выбранную карточку для внимания человека.";
    private static string Truncate(this string value, int size) => value.Length <= size ? value : value[..size] + "\n[Контекст сокращён — полный текст в дереве.]";
    public static void ApplyRemote(FleetJob job, JsonElement data, long now)
    {
        string Read(string key) => data.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        var status = Read("status");
        if (status is not ("queued" or "running" or "waiting_input" or "blocked" or "completed" or "failed" or "cancelled" or "unknown"))
            throw new InvalidOperationException("Адаптер вернул неизвестный статус.");
        if (!data.TryGetProperty("version", out var version) || !version.TryGetInt64(out var number))
            throw new InvalidOperationException("Адаптер не вернул числовую version.");
        if (number < job.Version) return;
        job.Version = number; job.Status = status == "completed" ? "review" : status;
        job.Summary = Read("summary"); job.Question = Read("question"); job.Result = Read("result");
        job.CheckedAt = now; job.NextCheckAt = now + 300;
        if (data.TryGetProperty("progress_at", out var progress) && progress.TryGetInt64(out var progressAt)) job.ProgressAt = progressAt;
    }
}
