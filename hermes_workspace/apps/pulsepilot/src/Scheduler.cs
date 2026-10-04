namespace PulsePilot;

/// <summary>
/// Приоритет подкидывания. Чем выше — тем ближе к верху.
/// Главный принцип: свежее внимание уходит вниз, забытое всплывает наверх.
/// </summary>
public static class Scheduler
{
    public sealed class Scored
    {
        public Node Node { get; init; } = null!;
        public Project Project { get; init; } = null!;
        public double Score { get; init; }
        public string Reason { get; init; } = "";
        public string IdleText { get; init; } = "";
        public long IdleSeconds { get; init; }
    }

    private const double DonePenalty = 1000;      // закрытое уходит на дно
    private const double FocusPenalty = 400;       // активный фокус не подкидываем повторно
    private const double StaleAfterMinutes = 25;   // после этого считаем «давно не брал»
    private const double WarmupMinutes = 6;        // свежий выбор не штрафуется сразу
    // «Голод» растёт логарифмически: и час простоя, и три дня дают разный вес,
    // но без потолка, поэтому порядок между старыми задачами не деградирует в случайный.
    private const double StarvationScale = 250;
    private const double FreshnessPenalty = 200;
    private const double PinBoost = 900;         // ⚑ человека важнее любого автомата
    private const double BlockedPenalty = 120;    // заблокированное чуть ниже, но не на дне

    public static List<Scored> Rank(Tree tree, StateStore state, string? currentFocusNodeId, bool openOnly = true)
    {
        var now = DateTimeOffset.Now.ToUnixTimeSeconds();
        var list = new List<Scored>();

        foreach (var p in tree.Projects)
        {
            foreach (var n in p.Nodes)
            {
                if (openOnly && n.Done == 1) continue;
                list.Add(Score(n, p, state, currentFocusNodeId, now));
            }
        }

        // Закреплённое человеком идёт абсолютно первым: ⚑ важнее любой автоматики.
        return list
            .OrderByDescending(s => state.IsPinned(s.Node.Id))
            .ThenByDescending(s => s.Score)
            .ToList();
    }

    /// <summary>Лучшее направление по тем же правилам, но по его лучшей открытой задаче.</summary>
    public static Scored? BestForProject(Project p, StateStore state, string? currentFocusNodeId)
    {
        var open = p.Nodes.Where(n => n.Done == 0).ToList();
        if (open.Count == 0) return null;
        var now = DateTimeOffset.Now.ToUnixTimeSeconds();
        return open
            .Select(n => Score(n, p, state, currentFocusNodeId, now))
            .OrderByDescending(s => s.Score)
            .First();
    }

    private static Scored Score(Node n, Project p, StateStore state, string? currentFocusNodeId, long now)
    {
        var last = state.GetLastTaken(n.Id);
        var idle = last == 0 ? 24 * 3600 : Math.Max(0, now - last);
        var idleMin = idle / 60.0;

        // 1. Голод: чем дольше не брали, тем выше.
        var starvation = StarvationScale * Math.Log(1 + idleMin / 30.0);

        // 2. Свежее внимание — вниз: плавное затухание, первые минуты почти не штрафуем.
        var freshnessPenalty = idleMin < WarmupMinutes
            ? FreshnessPenalty * (1 - idleMin / WarmupMinutes)
            : 0;

        // 3. Честная очередь по направлению: перекос «много брал / мало сделал» толкает вверх.
        var take = state.GetTakeCount(p.Id);
        var done = state.GetDoneCount(p.Id);
        var imbalance = Math.Clamp((take - done) * 12.0, 0, 150);

        // 4. Узел, который мы прямо сейчас держим в фокусе, повторно не подкидываем.
        var focusPenalty = currentFocusNodeId != null && currentFocusNodeId == n.Id ? FocusPenalty : 0;

        // 5. Небольшой бонус за наличие текста: описанная задача берётся охотнее.
        var describedBonus = string.IsNullOrWhiteSpace(n.Body) ? 0 : 8;

        // 6. Закреплено человеком — идёт в самое начало, поверх автоматики.
        var pinBoost = state.IsPinned(n.Id) ? PinBoost : 0;

        // 7. Заблокировано открытым блокером — показываем ниже, но не на дне:
        //    блокер может оказаться быстрее, чем кажется.
        var blocked = state.LiveBlockers(n.Id, state.Tree) is { Count: > 0 } ? BlockedPenalty : 0;

        var score = starvation + imbalance + describedBonus + pinBoost
                    - freshnessPenalty - focusPenalty - blocked
                    - (n.Done == 1 ? DonePenalty : 0);

        return new Scored
        {
            Node = n,
            Project = p,
            Score = score,
            IdleSeconds = idle,
            IdleText = IdleText(idleMin),
            Reason = Reason(state, n, p, idleMin, imbalance)
        };
    }

    private static string Reason(StateStore state, Node n, Project p, double idleMin, double imbalance)
    {
        if (state.GetLastTaken(n.Id) == 0) return "ещё не брал";
        if (idleMin < StaleAfterMinutes) return "только что был";
        // Перекос по направлению — только как усиление уже остывшей задачи, иначе подпись врёт.
        if (imbalance >= 36) return "подостыл + много брал, мало закрыл";
        if (idleMin >= StaleAfterMinutes * 4) return "давно не брал";
        return "подостыл";
    }

    public static string IdleText(double minutes)
    {
        if (minutes >= 60 * 24) return $"{(int)(minutes / (60 * 24))} дн";
        if (minutes >= 60) return $"{(int)(minutes / 60)} ч";
        if (minutes >= 1) return $"{(int)minutes} мин";
        return "только что";
    }
}
