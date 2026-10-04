using System.IO;
using System.Text.Json;

namespace PulsePilot;

public class AppSettings
{
    public string ApiUrl { get; set; } = "https://velvetflux.click/pilot1026/api.php";
    public string ApiKey { get; set; } = "";
    // ---- Устаревшие поля прежней пошаговой версии. Значения хранятся в state.json ради совместимости,
    // но больше нигде не читаются: цикл с FocusPopup/NagWindow удалён в пользу очереди решений диспетчера.
    public int IntervalMinutes { get; set; } = 5;
    public bool SoundEnabled { get; set; } = true;
    [Obsolete("Цикл с отложенными шагами удалён. Используй AgentStaleMinutes и очередь решений.")]
    public bool AutoStartTimer { get; set; } = true;
    [Obsolete("Отложение полноэкранного окна шагом удалено. Используй «Нapомнить через 5 минут» в карточке.")]
    public int MaxPostpone { get; set; } = 2;
    public int PollSeconds { get; set; } = 20;
    public bool AskWhatDoing { get; set; } = true;
    public bool TrackActivity { get; set; } = true;

    // ---- Встроенная модель для планирования в чате ----
    public string AgentBaseUrl { get; set; } = "";
    public string AgentKey { get; set; } = "";
    public int ParallelSlots { get; set; } = 7;
    public int AgentStaleMinutes { get; set; } = 5;
    public string LlmBaseUrl { get; set; } = "https://openrouter.ai/api/v1";
    public string LlmKey { get; set; } = "";
    public string LlmModel { get; set; } = "deepseek/deepseek-v4-flash";
    /// <summary>
    /// Модель для выбора задачи — отдельная от советника и принципиально ДРУГАЯ.
    /// deepseek-v4-flash и другие reasoning-модели тратят весь max_tokens на внутреннее рассуждение
    /// и возвращают пустой ответ: проверено на 1200 и 4000 токенах. Выбор задачи — простая задача,
    /// ей нужна быстрая не-reasoning модель.
    /// </summary>
    public string LlmPickModel { get; set; } = "meta-llama/llama-3.3-70b-instruct";
    /// <summary>Запасная модель, если основная не ответила или ответила пустым.</summary>
    public string LlmPickFallbackModel { get; set; } = "openai/gpt-4o-mini";
    public double LlmTemperature { get; set; } = 0.4;
    public int LlmMaxTokens { get; set; } = 1200;
}

public class ChatMessage
{
    public string Role { get; set; } = "user";   // user | assistant | system
    public string Text { get; set; } = "";
    public string Ts { get; set; } = "";
}

public class WhatDoing
{
    public string Ts { get; set; } = "";
    public string NodeId { get; set; } = "";
    public string Text { get; set; } = "";
}

public class Draft
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N")[..8];
    public string Text { get; set; } = "";
    public string ProjectId { get; set; } = "";
    public string Ts { get; set; } = "";

    /// <summary>Название направления для показа — заполняется при рендере, в json не пишется.</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public string ProjectTitle { get; set; } = "";
}

public class LogEntry
{
    public string Ts { get; set; } = "";
    public string Kind { get; set; } = "";
    public string Text { get; set; } = "";
}

public class StateStore
{
    public AppSettings Settings { get; set; } = new();
    /// <summary>0..10 — прогресс направления, +0.1 за итерацию.</summary>
    public Dictionary<string, int> Progress { get; set; } = new();
    public List<LogEntry> Log { get; set; } = new();
    public string? LastNodeId { get; set; }
    /// <summary>node_id -> когда последний раз брали в фокус (Unix seconds, 0 = ни разу).</summary>
    public Dictionary<string, long> LastTaken { get; set; } = new();
    /// <summary>Сколько раз закрывали задачу этого направления — для честной очереди.</summary>
    public Dictionary<string, int> DoneCount { get; set; } = new();
    /// <summary>Сколько раз брали задачи этого направления — противоположный счётчик.</summary>
    public Dictionary<string, int> TakeCount { get; set; } = new();
    public List<ChatMessage> Chat { get; set; } = new();

    /// <summary>node_id -> id узлов, которые его блокируют (выяснено моделью).</summary>
    public Dictionary<string, List<string>> Blockers { get; set; } = new();
    /// <summary>Задачи, которые человек отметил как «бери в первую очередь».</summary>
    public Dictionary<string, int> Pin { get; set; } = new();
    /// <summary>Что модель насчитала при последнем разборе: время, сводка.</summary>
    public string LastPlanSummary { get; set; } = "";
    public long LastPlanAt { get; set; }
    /// <summary>Что человек делал в прошлом цикле (словами) — модель видит это в контексте.</summary>
    public List<WhatDoing> WhatI { get; set; } = new();
    /// <summary>Черновики задач: набросал мысль — она ждёт, пока подтвердишь и отправишь в дерево.</summary>
    public List<Draft> Drafts { get; set; } = new();

    public List<FleetJob> FleetJobs { get; set; } = new();
    public Dictionary<string, ProjectBrief> ProjectBriefs { get; set; } = new();
    public long WorkUntil { get; set; }
    public bool LegacyFleetMigrated { get; set; }
    public Dictionary<string, int> MicroIterations { get; set; } = new();
    public Dictionary<string, long> LastProjectTouch { get; set; } = new();
    public Dictionary<string, string> Lockers { get; set; } = new();
    public Dictionary<string, MicroStep> WaitingSteps { get; set; } = new();
    public MicroStep? CurrentStep { get; set; }
    public HashSet<string> RecordedSteps { get; set; } = new();
    public int MicroCount(string projectId) => MicroIterations.GetValueOrDefault(projectId);
    public bool RecordMicro(MicroStep step, string result)
    {
        if (string.IsNullOrWhiteSpace(result) || !RecordedSteps.Add(step.Id)) return false;
        MicroIterations[step.ProjectId] = MicroCount(step.ProjectId) + 1;
        LastProjectTouch[step.ProjectId] = DateTimeOffset.Now.ToUnixTimeSeconds();
        AddLog("micro", $"Итерация #{MicroCount(step.ProjectId)}: {Tree.ById(step.ProjectId)?.Title ?? step.ProjectId} — {result.Trim()}");
        CurrentStep = null;
        AddWhatDoing(step.NodeId, result.Trim());
        return true;
    }

    internal static string? TestDataDirectory;
    private static string Dir => TestDataDirectory ?? Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PulsePilot");
    public static string Path_ => Path.Combine(Dir, "state.json");

    private static readonly JsonSerializerOptions Opts = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true
    };

    public static StateStore Load()
    {
        try
        {
            if (File.Exists(Path_))
            {
                var s = JsonSerializer.Deserialize<StateStore>(File.ReadAllText(Path_), Opts) ?? new StateStore();
                if (string.IsNullOrWhiteSpace(s.Settings.LlmKey)) s.Settings.LlmKey = KeyFromHermesEnv() ?? "";
                return s;
            }
        }
        catch { }
        var fresh = new StateStore();
        fresh.Settings.LlmKey = KeyFromHermesEnv() ?? "";
        return fresh;
    }

    [System.Text.Json.Serialization.JsonIgnore]
    public string LastSaveError { get; private set; } = "";

    public bool Save()
    {
        try
        {
            Directory.CreateDirectory(Dir);
            var tmp = Path_ + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(this, Opts));
            File.Move(tmp, Path_, true);
            LastSaveError = "";
            return true;
        }
        catch (Exception ex) { LastSaveError = ex.Message; return false; }
    }

    public int GetProgress(string projectId) => Progress.TryGetValue(projectId, out var v) ? v : 0;

    public int BumpProgress(string projectId)
    {
        var v = Math.Min(10, GetProgress(projectId) + 1);
        Progress[projectId] = v;
        Save();
        return v;
    }

    /// <summary>Подхватывает ключ OpenRouter из окружения Hermes, чтобы не вводить его руками.</summary>
    private static string? KeyFromHermesEnv()
    {
        try
        {
            var env = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "hermes", ".env");
            if (!File.Exists(env)) return null;
            foreach (var line in File.ReadAllLines(env))
            {
                if (line.StartsWith("OPENROUTER_API_KEY=", StringComparison.OrdinalIgnoreCase))
                {
                    var v = line[(line.IndexOf('=') + 1)..].Trim().Trim('"').Trim('\'');
                    if (v.Length > 20) return v;
                }
            }
        }
        catch { }
        return null;
    }

    public long GetLastTaken(string nodeId) => LastTaken.TryGetValue(nodeId, out var t) ? t : 0;

    public int GetDoneCount(string projectId) => DoneCount.TryGetValue(projectId, out var c) ? c : 0;
    public int GetTakeCount(string projectId) => TakeCount.TryGetValue(projectId, out var c) ? c : 0;

    public void MarkTaken(string nodeId, string projectId)
    {
        var now = DateTimeOffset.Now.ToUnixTimeSeconds();
        LastTaken[nodeId] = now;
        TakeCount[projectId] = GetTakeCount(projectId) + 1;
        Save();
    }

    public void MarkDone(string nodeId, string projectId)
    {
        LastTaken[nodeId] = DateTimeOffset.Now.ToUnixTimeSeconds();
        DoneCount[projectId] = GetDoneCount(projectId) + 1;
        Save();
    }

    public void SetBlockers(string nodeId, List<string> blockerIds)
    {
        if (blockerIds.Count == 0) Blockers.Remove(nodeId);
        else Blockers[nodeId] = blockerIds;
        Save();
    }

    /// <summary>Блокирует ли ещё что-то этот узел: открытые блокеры считаются живыми.</summary>
    public List<string> LiveBlockers(string nodeId, Tree tree)
    {
        if (!Blockers.TryGetValue(nodeId, out var ids)) return new List<string>();
        return ids.Where(id => tree.NodeById(id) is { Done: 0 }).ToList();
    }

    /// <summary>Текущее дерево — нужно, чтобы понимать, живы ли блокеры.</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public Tree Tree { get; set; } = new();

    public bool IsPinned(string nodeId) => Pin.ContainsKey(nodeId);
    public void TogglePin(string nodeId)
    {
        if (!Pin.Remove(nodeId)) Pin[nodeId] = 1;
        Save();
    }

    public void AddDraft(string text, string projectId)
    {
        Drafts.Add(new Draft
        {
            Text = text,
            ProjectId = projectId,
            Ts = DateTime.Now.ToString("HH:mm")
        });
        if (Drafts.Count > 50) Drafts.RemoveRange(0, Drafts.Count - 50);
        Save();
    }

    public void RemoveDraft(string id)
    {
        Drafts.RemoveAll(d => d.Id == id);
        Save();
    }

    public void AddWhatDoing(string nodeId, string text)
    {
        WhatI.Insert(0, new WhatDoing
        {
            Ts = DateTime.Now.ToString("dd.MM HH:mm"),
            NodeId = nodeId,
            Text = text
        });
        if (WhatI.Count > 30) WhatI.RemoveRange(30, WhatI.Count - 30);
        Save();
    }

    public void AddChat(string role, string text)
    {
        Chat.Add(new ChatMessage
        {
            Role = role,
            Text = text,
            Ts = DateTime.Now.ToString("HH:mm")
        });
        if (Chat.Count > 40) Chat.RemoveRange(0, Chat.Count - 40);
        Save();
    }

    public void AddLog(string kind, string text)
    {
        Log.Insert(0, new LogEntry
        {
            Ts = DateTime.Now.ToString("HH:mm:ss"),
            Kind = kind,
            Text = text
        });
        if (Log.Count > 300) Log.RemoveRange(300, Log.Count - 300);
    }
}
