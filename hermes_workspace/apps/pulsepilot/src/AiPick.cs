using System.Text.Json;

namespace PulsePilot;

/// <summary>
/// Выбор задачи по подсказке оператора. Модель предлагает кандидатов из РЕАЛЬНОГО дерева,
/// парсер отбрасывает всё, чего в дереве нет или что не исполнимо, — выдумать узел нельзя.
/// </summary>
public static class AiPick
{
    public sealed record Candidate(string NodeId, string Why);

    public const string SystemPrompt = """
        Ты — планировщик одного направления. Твоя единственная задача: выбрать ОДИН следующий TODO,
        который имеет смысл отдать исполнителю прямо сейчас, и объяснить это в одну строку.
        Правила:
        - выбирай только из списка кандидатов, он полный. Никогда не придумывай новые id и задачи;
        - не выбирай wiki, цели, метрики, риски и отложенные работы — это контекст, а не работа;
        - учитывай, что уже висит, что заблокировано, и слова оператора о приоритете;
        - если оператор просит конкретное, а такого кандидата нет — так и напиши в ПОЧЕМУ.
        Формат ответа — только три строки, без markdown и без нумерации:
        ВЫБОР: <id>
        ПОЧЕМУ: <одна строка>
        АЛЬТЕРНАТИВА: <id или пусто>
        """;

    public static string BuildRequest(Project project, ProjectBrief brief, IEnumerable<Node> candidates,
        IEnumerable<FleetJob> jobs, string guidance, int limit = 40)
    {
        var sb = new System.Text.StringBuilder();
        sb.AppendLine("Направление: " + project.Title);
        if (project.Note.Length > 0) sb.AppendLine("Что это: " + project.Note);
        sb.AppendLine("Цель: " + (brief.Goal.Length > 0 ? brief.Goal : "не задана"));
        sb.AppendLine("Условие масштаба: " + (brief.Gate.Length > 0 ? brief.Gate : "не задано"));
        sb.AppendLine();

        var live = jobs.Where(j => j.ProjectId == project.Id && j.Status is not ("done" or "cancelled")).ToList();
        sb.AppendLine("УЖЕ В РАБОТЕ (не предлагай дубликат):");
        if (live.Count == 0) sb.AppendLine("  — ничего");
        foreach (var j in live)
            sb.AppendLine("  - [" + j.NodeId + "] " + j.Title + " — " + FleetRules.StatusName(j) +
                (j.BlockReason.Length > 0 ? " · причина простоя: " + BlockReasons.Label(j.BlockReason) : ""));
        sb.AppendLine();

        sb.AppendLine("КАНДИДАТЫ (только эти, id обязателен). Блокеры уже отфильтрованы, список исполнимый:");
        var count = 0;
        foreach (var n in candidates)
        {
            if (count++ >= limit) { sb.AppendLine("  … ещё есть, но список обрезан"); break; }
            sb.AppendLine($"- [{n.Id}] {n.Title}" + (n.Body.Length > 0 ? "  // " + n.Body.Replace("\n", " ").Cut(160) : "  // (пояснения нет — сформулируй сам, чего добиваться)"));
        }
        sb.AppendLine();
        sb.AppendLine("СЛОВА ОПЕРАТОРА: " + (guidance.Trim().Length > 0 ? guidance.Trim() : "(не заданы)"));
        return sb.ToString();
    }

    /// <summary>Разбирает ответ. Возвращает только те узлы, которые есть в дереве и исполнимы.</summary>
    public static List<Candidate> Parse(string answer, IReadOnlyCollection<string> allowed, out string chosen, out string why)
    {
        chosen = ""; why = "";
        var found = new List<Candidate>();
        foreach (var raw in answer.Split('\n'))
        {
            var line = raw.Trim().TrimStart('*', ' ', '-');
            string tag = "", rest = "";
            foreach (var pair in new[] { ("ВЫБОР:", "choice"), ("ПОЧЕМУ:", "why"), ("АЛЬТЕРНАТИВА:", "alt") })
            {
                if (line.StartsWith(pair.Item1, StringComparison.OrdinalIgnoreCase))
                { tag = pair.Item2; rest = line[pair.Item1.Length..].Trim(); break; }
            }
            if (tag.Length == 0) continue;
            if (tag == "why") { if (why.Length == 0) why = rest.Trim('*', ' '); continue; }
            var id = System.Text.RegularExpressions.Regex.Match(rest, @"\d+").Value;
            if (id.Length == 0 || !allowed.Contains(id)) continue;
            if (tag == "alt") { if (found.Count < 2) found.Add(new Candidate(id, "альтернатива от модели")); continue; }
            if (tag == "choice" && found.Count == 0) { chosen = id; found.Add(new Candidate(id, "")); }
        }
        if (found.Count == 0 && chosen.Length > 0) found.Add(new Candidate(chosen, why));
        return found;
    }

    /// <summary>Кандидаты, которые вообще можно предложить: исполнимые, без живых блокеров.</summary>
    public static List<Node> Candidates(Project project, StateStore state, Tree tree) =>
        project.Nodes.Where(n => FleetRules.Actionable(n) && state.LiveBlockers(n.Id, tree).Count == 0)
            .OrderBy(n => state.IsPinned(n.Id) ? 0 : 1).ThenBy(n => n.SortOrder).ToList();
}

public static class AiText
{
    public static string Cut(this string value, int size) =>
        value.Length <= size ? value : value[..size] + "…";
}
