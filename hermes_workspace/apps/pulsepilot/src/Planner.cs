namespace PulsePilot;

public sealed class PlanResult
{
    /// <summary>node_id -> id узлов-блокеров, как поняла модель.</summary>
    public Dictionary<string, List<string>> Blockers { get; } = new();
    /// <summary>Короткие куски плана по направлениям.</summary>
    public Dictionary<string, string> PerProject { get; } = new();
    public string Summary { get; set; } = "";
    public string Order { get; set; } = "";
    public string[] Warnings { get; set; } = Array.Empty<string>();
}

/// <summary>
/// Слой «умного планирования»: модель разбирает дерево на блокеры, раскладывает цикл на шаги
/// и ругает по логу отклонов. Ответ — в приложение, не в серверную схему.
/// </summary>
public static class Planner
{
    public const string AnalysePrompt = """
        Ты — планировщик одного человека, который работает короткими 5-минутными циклами.
        У него есть дерево направлений и задач, и он обязан поочерёдно двигать каждое
        направление вперёд. Закрытие задачи само по себе не увеличивает счётчик микроитераций.

        Твоя задача — разобрать дерево и вернуть план. Отвечай СТРОГО в этом формате,
        каждая строка начинается с ключевого слова, ничего лишнего не пиши:

        ИТОГ: одно предложение — в чём главная проблема прямо сейчас.
        БЛОКЕР: <id> зависит от <id> — <почему, 5-8 слов>
        ШАГ: <id> — <что конкретно сделать за 5 минут>
        ПЛАН <id направления>: <что делать с этим направлением в ближайший час>
        РИСК: <что может застрять, одно предложение>

        Правила:
        - БЛОКЕР ставь только если из текста задачи прямо видно, что она зависит от другой.
          Не выдумывай зависимости. Не ставь БЛОКЕР на самую первую задачу.
        - ШАГ должен влезать в 5 минут и начинаться с глагола.
        - Учитывай, что приложение само поднимает забытые задачи вверх, а свежие вниз.
        - Обязательно скажи, где перекос: где человек много брал, а мало закрывал.
        - Раздел «Реальная активность сегодня» — это замер, а не слова. Если там видно,
          что время ушло не в работу по задачам, скажи это прямо и предложи, что делать.
        - Не больше 6 БЛОКЕР, 5 ШАГ, 3 РИСК.
        """;

    public const string MotivationPrompt = """
        Ты — жёсткий, но смешной внутренний тренер. Человек только что провалил цикл или
        откладывал работу. Твоя задача — выдать ОДНО сообщение, которое его заденет.

        Правила:
        - ОДНО предложение, максимум 25 слов. Без мотивационных штампов типа «успей!», «верь в себя!».
        - Ударь в конкретику из его же данных: сколько раз он пропустил подряд, какое
          направление забрасывает, сколько минут он фактически откладывал.
        - Если в данных есть раздел «Реальная активность сегодня» — это самый сильный
          аргумент, используй его в первую очередь: сколько минут реально в фокусе,
          сколько из них ввод, сколько простоя, и какие приложения забрали время.
          Называй приложения прямо: он узнает себя.
        - Если в фокусе было много времени, а закрытых задач ноль — бей по этому разрыву.
        - Можно слегка ехидно и по-человечески, это его внутренний переписку, не оскорбление.
        - Иногда вместо ругани дай резкий конкретный план: что делать в следующие 5 минут.
        - Никаких эмодзи, никаких заглавных букв целиком, никаких восклицательных знаков подряд.
        """;

    /// <summary>Готовит контекст: дерево, версии, блокеры, лог отклонений, реальная активность.</summary>
    public static string BuildContext(Tree tree, StateStore state, string focusNodeId, ActivityTracker? act = null)
    {
        var sb = new System.Text.StringBuilder();
        var ranked = Scheduler.Rank(tree, state, focusNodeId);

        sb.AppendLine("## Направления");
        foreach (var p in tree.Projects)
        {
            var open = p.Nodes.Count(n => n.Done == 0);
            var best = ranked.FirstOrDefault(s => s.Project.Id == p.Id);
            sb.AppendLine($"- [{p.Id}] «{p.Title}»: версия {p.Ver}, микроитераций {state.MicroCount(p.Id)}, " +
                          $"открыто {open}, брали {state.GetTakeCount(p.Id)}, закрыли {state.GetDoneCount(p.Id)}" +
                          (best == null ? "" : $", подкидывает «{best.Node.Title}» ({best.Reason})"));
        }

        sb.AppendLine();
        sb.AppendLine("## Задачи (только открытые, с версиями и простоями)");
        foreach (var s in ranked)
        {
            var live = state.LiveBlockers(s.Node.Id, tree);
            var blockerTxt = live.Count == 0
                ? ""
                : $" БЛОКИРУЕТСЯ: {string.Join(", ", live.Select(id => $"[{id}] " + (tree.NodeById(id)?.Title ?? "?")))}";
            var pin = state.IsPinned(s.Node.Id) ? " ЗАКРЕПЛЕНО" : "";
            sb.AppendLine($"- [{s.Node.Id}] v{s.Node.Ver} простой {s.IdleText} приоритет {s.Score:F0} «{s.Node.Title}»{pin}{blockerTxt}");
            if (!string.IsNullOrWhiteSpace(s.Node.Body))
            {
                var body = s.Node.Body.Replace("\n", " ").Trim();
                if (body.Length > 260) body = body[..260] + "…";
                sb.AppendLine($"    {body}");
            }
        }

        if (state.Drafts.Count > 0)
        {
            sb.AppendLine();
            sb.AppendLine("## Черновики (человек накидал, ещё не отправил в дерево)");
            foreach (var d in state.Drafts.Take(10))
                sb.AppendLine($"- [{d.Ts}] {tree.ById(d.ProjectId)?.Title ?? "?"}: {d.Text}");
        }

        if (act != null && act.Today.Samples > 0)
        {
            sb.AppendLine();
            sb.AppendLine("## Реальная активность сегодня (не слова, а замер)");
            sb.AppendLine(act.HumanToday());
            var top = act.TopApps(6);
            if (top.Count > 0)
                sb.AppendLine("где шёл процесс: " + string.Join(", ", top.Select(t => $"{t.App} — {t.Minutes} мин")));

            // Сколько времени ушло на работу над задачами, а сколько мимо.
            var work = WorkSeconds(act, state, tree);
            if (work > 0)
            {
                sb.AppendLine($"время в приложениях, связанных с задачами: {work / 60} мин " +
                              $"из {act.Today.FocusSeconds / 60} мин в фокусе");
            }
            if (act.Today.IdleSeconds > 300)
                sb.AppendLine($"простой без ввода: {act.Today.IdleSeconds / 60} мин — возможно, ты отошёл");
        }

        if (state.WhatI.Count > 0)
        {
            sb.AppendLine();
            sb.AppendLine("## Что человек отписал делать (свежие сверху)");
            foreach (var w in state.WhatI.Take(10))
            {
                var n = tree.NodeById(w.NodeId);
                sb.AppendLine($"- {w.Ts} «{n?.Title ?? w.NodeId}»: {w.Text}");
            }
        }

        var skips = state.Log.Count(l => l.Kind is "skip" or "postpone");
        if (skips > 0)
        {
            sb.AppendLine();
            sb.AppendLine("## Лог отклонений");
            sb.AppendLine($"всего пропусков и отсрочек: {skips}");
            var streak = 0;
            foreach (var e in state.Log)
            {
                if (e.Kind is "skip" or "postpone") streak++;
                else if (streak > 0) break;
            }
            sb.AppendLine($"подряд последних: {streak}");
            foreach (var e in state.Log.Where(l => l.Kind is "skip" or "postpone").Take(8))
                sb.AppendLine($"- {e.Ts} {e.Text}");
        }

        if (!string.IsNullOrWhiteSpace(state.LastPlanSummary))
        {
            sb.AppendLine();
            sb.AppendLine("## Прошлый план");
            sb.AppendLine(state.LastPlanSummary);
        }

        if (state.CurrentStep is { } step)
        {
            sb.AppendLine($"Текущий микро-шаг [{step.NodeId}] / {step.Phase}: {step.Action}");
            sb.AppendLine("Критерий результата: " + step.Check);
        }
        foreach (var waitingStep in state.WaitingSteps.Values)
            sb.AppendLine($"Ожидается проверка агента [{waitingStep.NodeId}]: {waitingStep.Check}");
        return sb.ToString();
    }

    /// <summary>Сколько минут замер ушёл на приложения, похожие на рабочие (по словам задач).</summary>
    private static int WorkSeconds(ActivityTracker act, StateStore state, Tree tree)
    {
        var words = tree.Projects
            .SelectMany(p => p.Nodes.Select(n => n.Title + " " + n.Body))
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .ToList();
        if (words.Count == 0) return 0;

        var total = 0;
        foreach (var slice in act.Today.Slices)
        {
            var hay = (slice.App + " " + slice.Title).ToLowerInvariant();
            var hits = words.Count(w =>
            {
                var tokens = w.ToLowerInvariant()
                    .Split(new[] { ' ', ',', '.', ':', ';', '(', ')', '\n', '\t' }, StringSplitOptions.RemoveEmptyEntries)
                    .Where(t => t.Length >= 5)
                    .Distinct()
                    .Take(6);
                return tokens.Any(t => hay.Contains(t, StringComparison.Ordinal));
            });
            if (hits > 0) total += slice.Seconds;
        }
        return total;
    }

    /// <summary>Разбирает машинно-читаемые строки ответа модели. Мусор игнорирует, не падает.</summary>
    public static PlanResult Parse(string answer)
    {
        var res = new PlanResult();
        var order = new List<string>();
        var warnings = new List<string>();

        foreach (var raw in answer.Split('\n'))
        {
            var line = raw.Trim().TrimStart('#', '*', '-', ' ');
            if (line.Length == 0) continue;

            if (line.StartsWith("ИТОГ:", StringComparison.OrdinalIgnoreCase))
            {
                res.Summary += line[4..].Trim() + " ";
                continue;
            }

            if (line.StartsWith("БЛОКЕР:", StringComparison.OrdinalIgnoreCase))
            {
                var ids = ExtractIds(line);
                if (ids.Count >= 2)
                {
                    if (!res.Blockers.TryGetValue(ids[0], out var list))
                        res.Blockers[ids[0]] = list = new List<string>();
                    if (!list.Contains(ids[1])) list.Add(ids[1]);
                }
                continue;
            }

            if (line.StartsWith("ШАГ:", StringComparison.OrdinalIgnoreCase))
            {
                var id = ExtractIds(line).FirstOrDefault();
                if (id != null) order.Add(id);
                continue;
            }

            // «ПЛАН 1:» или «ПЛАН [1]:» — модель пишет и так, и так.
            if (line.StartsWith("ПЛАН", StringComparison.OrdinalIgnoreCase))
            {
                var id = ExtractIds(line).FirstOrDefault() ?? ExtractBareNumber(line);
                var colon = line.IndexOf(':');
                if (id != null && colon > 0) res.PerProject[id] = line[(colon + 1)..].Trim();
                continue;
            }

            if (line.StartsWith("РИСК:", StringComparison.OrdinalIgnoreCase))
                warnings.Add(line[5..].Trim());
        }

        res.Order = string.Join(", ", order);
        res.Warnings = warnings.Take(3).ToArray();
        res.Summary = res.Summary.Trim();
        return res;
    }

    /// <summary>Число между словом и двоеточием, если скобок нет: «ПЛАН 1: текст» -> 1.</summary>
    private static string? ExtractBareNumber(string line)
    {
        var colon = line.IndexOf(':');
        if (colon < 0) return null;
        // Отбрасываем ведущее слово («ПЛАН») и пробелы, берём цифры до двоеточия.
        var head = line[..colon];
        var digits = new string(head.SkipWhile(c => !char.IsDigit(c)).TakeWhile(char.IsDigit).ToArray());
        return digits.Length > 0 ? digits : null;
    }

    /// <summary>Вытаскивает числовые id в квадратных скобках: [7] -> 7.</summary>
    private static List<string> ExtractIds(string line)
    {
        var ids = new List<string>();
        for (var i = 0; i + 2 < line.Length; i++)
        {
            if (line[i] != '[') continue;
            var j = line.IndexOf(']', i);
            if (j < 0) break;
            var inner = line[(i + 1)..j];
            if (inner.Length > 0 && inner.All(char.IsDigit)) ids.Add(inner);
            i = j;
        }
        return ids;
    }
}
