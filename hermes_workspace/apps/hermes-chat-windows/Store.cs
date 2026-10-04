using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace HermesChat;

/// <summary>Диалоги и настройки на диске: %APPDATA%\HermesChat\state.json. Запись атомарная.</summary>
public sealed class Store
{
    private static readonly JsonSerializerOptions Opts = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public string Path { get; }
    public ChatSettings Settings { get; set; } = new();
    public List<ChatThread> Threads { get; set; } = new();
    /// <summary>Профильные агенты направлений. Универсальный агент — тоже профиль, пустой.</summary>
    public List<AgentAsset> Assets { get; set; } = new();
    public List<Profile> Profiles { get; set; } = new();
    /// <summary>Снимок дерева: откуда профили берут очередь TODO.</summary>
    public bool PulseImported { get; set; }
    public List<WorkspaceIteration> Iterations { get; set; } = new();
    [JsonIgnore] public HashSet<string> ChatRuns { get; } = new();
    public Dictionary<string, WorkspaceChatBinding> ChatBindings { get; set; } = new();
    public Dictionary<string, string> ProjectGateways { get; set; } = new();
    public string TreeSnapshot { get; set; } = "";
    /// <summary>Внешние шлюзы — агенты на других машинах.</summary>
    public List<Gateway> Gateways { get; set; } = new();

    public Store()
    {
        var folder = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        Path = System.IO.Path.Combine(folder, "HermesWorkspace", "state.json");
    }

    public void Load()
    {
        if (!File.Exists(Path))
        {
            var legacy = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "HermesChat", "state.json");
            if (File.Exists(legacy)) { Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!); File.Copy(legacy, Path); }
            else { EnsureSeed(); return; }
        }
        try
        {
            var doc = JsonSerializer.Deserialize<Store>(File.ReadAllText(Path), Opts);
            if (doc is null) { EnsureSeed(); return; }
            PulseImported = doc.PulseImported;
            Iterations = doc.Iterations ?? new();
            ProjectGateways = doc.ProjectGateways ?? new();
            ChatBindings = doc.ChatBindings ?? new();
            foreach (var item in Iterations.Where(i => i.Status is "running" or "reviewing"))
            { item.Status = "interrupted"; item.Note = "Запуск прерван закрытием приложения. Проверь сервер перед повтором."; }
            Settings = doc.Settings ?? new ChatSettings();
            Threads = doc.Threads ?? new List<ChatThread>();
            Assets = doc.Assets ?? new();
            Profiles = doc.Profiles ?? new List<Profile>();
            TreeSnapshot = doc.TreeSnapshot ?? "";
            Gateways = doc.Gateways ?? new List<Gateway>();
            foreach (var thread in Threads)
            {
                // Незавершённый агент после перезапуска не «продолжает молча» — он помечен и виден.
                foreach (var message in thread.Messages.Where(m => m.Status == "running"))
                {
                    message.Status = "partial";
                    message.Note = "Приложение закрыто во время ответа. Итог не получен — отправь запрос заново.";
                }
                thread.PendingAgentMessages = thread.Messages.Count(m => m.Status is "running");
            }
            Normalize();
            SyncProfiles();
            // Локальный api_server — не «внешний агент», но и не пустота: именно
            // он держит сессии, включая наш консольный разговор. Поэтому он
            // прописывается в реестр по умолчанию и служит источником сессий.
            // Внешние машины добавляются рядом и отличимы адресом.
            if (Gateways.All(g => g.Url.TrimEnd('/') != Settings.NormalizedBase))
                Gateways.Insert(0, new Gateway
                {
                    Name = "Этот ноут (api_server)",
                    Url = Settings.NormalizedBase,
                    Token = Settings.ApiKey,
                    Kind = "hermes",
                    Note = "Локальный api_server Hermes. Здесь живут сессии разговоров."
                });
            if (Threads.Count == 0) EnsureSeed();
        }
        catch (Exception)
        {
            // Повреждённый state не должен ронять приложение: отводим битый файл в сторону.
            try { File.Move(Path, Path + ".broken", true); } catch (Exception) { }
            Settings = new ChatSettings();
            Threads = new List<ChatThread>();
            Gateways = new List<Gateway>();
            SyncProfiles();
            EnsureSeed();
        }
    }

    /// <summary>
    /// Профили = направления дерева. Каждому направлению снимка соответствует
    /// один профиль, и новые направления добавляются сами: иначе оркестратор
    /// пришлось бы заводить руками, а список в сайдбаре расходился бы с деревом.
    /// Ручные правки (специализация, модель, навыки) не затираются: добавляются
    /// только недостающие, id направления служит ключом.
    /// </summary>
    private void SyncProfiles()
    {
        TreeBriefs.Load();
        var known = Profiles.Select(p => p.ProjectId).Where(id => id.Length > 0).ToHashSet();
        foreach (var brief in TreeBriefs.All())
            if (!known.Contains(brief.ProjectId))
                Profiles.Add(ProfileDefaults.ForDirection(brief, ProfileDefaults.PaletteColor(Profiles.Count)));
        // Снимок недоступен и профилей нет — сообщаем правдой, а не пустотой.
        if (Profiles.Count == 0 && TreeBriefs.SourceFile == "не найден")
            Profiles.Add(new Profile
            {
                Name = "Универсальный агент",
                Prompt = "Снимок дерева не найден — своей очереди TODO у тебя нет. Скажи об этом прямо."
            });
    }

    /// <summary>Старые state.json не знают новых полей и пишут в них null.
    /// Без этого _thread.Model.Length роняет окно при выборе диалога —
    /// и падение выглядит как «модели кривые».</summary>
    private void Normalize()
    {
        Settings.BaseUrl ??= "http://127.0.0.1:8642";
        Settings.ApiKey ??= "";
        Settings.DefaultSessionKey ??= "";
        Settings.Model = string.IsNullOrWhiteSpace(Settings.Model) ? "hermes-agent" : Settings.Model;
                foreach (var profile in Profiles)
                {
                    profile.Id = string.IsNullOrWhiteSpace(profile.Id) ? "profile-" + Guid.NewGuid().ToString("N")[..8] : profile.Id;
                    profile.Name = string.IsNullOrWhiteSpace(profile.Name) ? "Без имени" : profile.Name;
                    profile.AssetIds ??= new(); profile.Toolsets ??= new(); profile.TestCases ??= new();
                    profile.Prompt = profile.Prompt ?? "";
                    profile.ProjectId = profile.ProjectId ?? "";
                    profile.ProjectTitle = profile.ProjectTitle ?? "";
                    profile.Model = profile.Model ?? "";
                    profile.SessionKey = profile.SessionKey ?? "";
                    profile.Color = string.IsNullOrWhiteSpace(profile.Color) ? "#5B9CFF" : profile.Color;
                    profile.Skills ??= new List<string>();
                }
                // Диалог может ссылаться на удалённый профиль — тогда он просто универсальный.
                var known = Profiles.Select(item => item.Id).ToHashSet();
                foreach (var thread in Threads)
                    if (thread.ProfileId.Length > 0 && !known.Contains(thread.ProfileId))
                    {
                        thread.ProfileId = "";
                        thread.ProfileName = "";
                    }
                // Шлюз мог быть удалён. Молчаливый откат на локальный адрес отправил бы
                // разговор не тому, и это выглядело бы как «всё сломалось».
                var gatewayIds = Gateways.Select(g => g.Id).ToHashSet();
                foreach (var thread in Threads)
                    if (thread.GatewayId.Length > 0 && !gatewayIds.Contains(thread.GatewayId))
                    {
                        thread.GatewayId = "";
                        thread.GatewayName = "";
                    }
                foreach (var thread in Threads)
        {
            thread.Id = string.IsNullOrWhiteSpace(thread.Id) ? NewThreadId() : thread.Id;
            thread.Title = string.IsNullOrWhiteSpace(thread.Title) ? "Без названия" : thread.Title;
            thread.Model = thread.Model ?? "";
            thread.ProfileId = thread.ProfileId ?? "";
            thread.ProfileName = thread.ProfileName ?? "";
            thread.GatewayId = thread.GatewayId ?? "";
            thread.GatewayName = thread.GatewayName ?? "";
            thread.SessionKey ??= "";
            thread.WorkingDir ??= "";
            thread.RemoteSessionId ??= "";
            thread.Skills ??= new List<string>();
            thread.Messages ??= new List<ChatMessage>();
            foreach (var message in thread.Messages)
            {
                message.Id = string.IsNullOrWhiteSpace(message.Id) ? Guid.NewGuid().ToString("N") : message.Id;
                message.RemoteId = message.RemoteId ?? "";
                message.Role = string.IsNullOrWhiteSpace(message.Role) ? "user" : message.Role;
                message.Text ??= "";
                message.Streaming = "";
                message.Status ??= "";
                message.Note = message.Note ?? "";
                message.RunId = message.RunId ?? "";
                message.Model = message.Model ?? "";
                message.Provider = message.Provider ?? "";
                message.RouteSource = message.RouteSource ?? "";
                message.ContextSource = message.ContextSource ?? "";
                message.CostStatus = message.CostStatus ?? "";
                message.Attachments ??= new List<Attachment>();
                message.Tools ??= new List<ToolStep>();
                message.ApprovalChoices ??= new List<string>();
                message.Steers ??= new List<string>();
                message.ApprovalCommand = message.ApprovalCommand ?? "";

                message.ApprovalTool = message.ApprovalTool ?? "";
                message.ApprovalRequestId = message.ApprovalRequestId ?? "";
                message.ClarifyRequestId = message.ClarifyRequestId ?? "";
                message.ClarifyQuestions ??= new List<ClarifyQuestionData>();
                message.InterimSegments = (message.InterimSegments ?? new List<string>())
                    .Where(segment => !string.IsNullOrWhiteSpace(segment)).ToList();
                foreach (var question in message.ClarifyQuestions)
                {
                    question.Qid ??= "";
                    question.Question ??= "";
                    question.SelectedChoice ??= "";
                    question.FreeText ??= "";
                    question.Choices ??= new List<string>();
                    question.SelectedChoices ??= new List<string>();
                }
                foreach (var file in message.Attachments) { file.Name ??= "file"; file.Path = file.Path ?? ""; }
                foreach (var step in message.Tools) { step.Tool ??= "tool"; step.Preview = step.Preview ?? ""; step.Result = step.Result ?? ""; step.Phase = step.Phase ?? ""; }
            }
        }
    }

    private static string NewThreadId() => "hermeschat-" + Guid.NewGuid().ToString("N")[..12];

    private void EnsureSeed()
    {
        Threads.Add(new ChatThread { Title = "Новый диалог" });
    }

    /// <summary>Раз в запуск подтягиваем снимок дерева и подставляем профилям их очереди.</summary>
    public void RefreshProfiles()
    {
        TreeBriefs.Load();
        foreach (var profile in Profiles)
        {
            if (profile.ProjectId.Length == 0) continue;
            var title = TreeBriefs.TitleOf(profile.ProjectId);
            if (title.Length > 0) profile.ProjectTitle = title;
            if (profile.SessionKey.Length == 0) profile.SessionKey = "agent:profile:" + profile.ProjectId + ":win";
            if (profile.Model.Length == 0) profile.Model = Settings.Model;
            profile.Skills.RemoveAll(string.IsNullOrWhiteSpace);
        }
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
            var temp = Path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(this, Opts));
            File.Move(temp, Path, true);
        }
        catch (Exception error)
        {
            CrashLog.Write("Не удалось сохранить состояние: " + error.Message);
        }
    }
}

public static class CrashLog
{
    private static readonly string File = System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "HermesWorkspace", "error.log");

    public static void Write(string message)
    {
        try
        {
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(File)!);
            System.IO.File.AppendAllText(File, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {message}{Environment.NewLine}");
        }
        catch (Exception) { /* логирование не должно само падать */ }
    }
}