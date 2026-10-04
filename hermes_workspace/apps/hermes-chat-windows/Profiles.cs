using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace HermesChat;

/// <summary>
/// Профильный агент направления. У каждого профиля свой «мозг» (Prompt), свои навыки,
/// своя модель и своя память (SessionKey). Диалог работает в контексте ровно одного профиля.
/// </summary>
public sealed class Profile
{
    public string Id { get; set; } = "profile-" + Guid.NewGuid().ToString("N")[..8];
    public string Name { get; set; } = "Новый профиль";
    public string ProjectId { get; set; } = "";
    public string ProjectTitle { get; set; } = "";
    /// <summary>Специализация: кто он и в чём его зона. Уходит в instructions шлюза.</summary>
    public string Prompt { get; set; } = "";
    /// <summary>Навыки, прикреплённые к профилю. Перечисляются в каждом запросе.</summary>
    public List<string> Skills { get; set; } = new();
    public List<string> AssetIds { get; set; } = new();
    public List<string> Toolsets { get; set; } = new();
    public List<AgentTestCase> TestCases { get; set; } = new();
    public string Model { get; set; } = "";
    /// <summary>Память профиля. Свой — значит профили не путают контекст между собой.</summary>
    public string SessionKey { get; set; } = "";
    public string Color { get; set; } = "#5B9CFF";
    public long CreatedAt { get; set; } = DateTimeOffset.Now.ToUnixTimeSeconds();
    public long LastUsedAt { get; set; }

    [JsonIgnore]
    public bool IsBound => ProjectId.Length > 0;
    /// <summary>Вторая строка в списке оркестраторов: очередь направления и,
    /// если разговор уже был, число сообщений в нём. Считается из снимка
    /// дерева, а не хранится, — очередь меняется сама, и копия в профиле
    /// быстро протухла бы. Название направления не дублируется: профиль
    /// часто назван так же, как проект.</summary>
    public string QueueLine
    {
        get
        {
            if (ProjectId.Length == 0) return "универсальный агент";
            var queue = TreeBriefs.TodoCount(ProjectId);
            if (queue == 0) return "очередь пуста или снимок не найден";
            var title = TreeBriefs.TitleOf(ProjectId);
            return queue + " TODO" + (title.Length > 0 && title != Name ? " · " + title : "");
        }
    }
    /// <summary>Сколько сообщений в диалоге этого профиля. Ноль — значит
    /// разговора ещё не было, и строка показывает очередь направления.
    /// Заполняется из чатов при каждой пересборке списков.</summary>
    [JsonIgnore]
    public int ThreadMessages { get; set; }
    /// <summary>Вторая строка профиля в сайдбаре.</summary>
    [JsonIgnore]
    public string SideLine => ThreadMessages > 0
        ? QueueLine + " · сообщений: " + ThreadMessages
        : QueueLine;
    /// <summary>Кастомный шаблон ComboBox показывает объект как есть, поэтому текст
    /// элемента списка задаётся здесь, а не через DisplayMemberPath.</summary>
    public override string ToString() => Name;
}

public static class ProfileDefaults
{
    /// <summary>Палитра точек профилей. Берётся по кругу, чтобы соседние
    /// направления в списке не сливались в один цвет.</summary>
    private static readonly string[] Palette =
        { "#5B9CFF", "#4FB477", "#E0A33E", "#E0605A", "#9E8CE8", "#63C7C4", "#E89A5B", "#5AC8E5" };

    /// <summary>Цвет по кругу палитры — чтобы соседние строки не сливались в один цвет.</summary>
    public static string PaletteColor(int index) => Palette[index % Palette.Length];

    /// <summary>
    /// Профиль одного направления дерева. Специализация из Specialty, если она
    /// есть; иначе — общая, честно называющая, что очередь направления и есть
    /// зона работы. Направление без рукописной записи не пропускается: у него
    /// всё равно есть очередь TODO, а значит есть и агент.
    /// </summary>
    public static Profile ForDirection(TreeBrief brief, string color)
    {
        var known = Specialty.FirstOrDefault(s => s.ProjectId == brief.ProjectId);
        return Make(
            known?.Name ?? brief.Title,
            brief.ProjectId,
            color,
            known?.Prompt ?? ("Ты ведёшь направление «" + brief.Title + "». "
                               + "Бери следующий TODO из своей очереди и доводи его до проверяемого результата."),
            known?.Rule ?? "Порядок и состояние важнее скорости. Число, которое нельзя проверить, не называй.");
    }

    /// <summary>Полный набор профилей по снимку. Синхронизация состояния идёт
    /// через SyncProfiles, этот метод — для первого запуска и тестов.</summary>
    public static List<Profile> Seed()
    {
        var list = new List<Profile>();
        foreach (var brief in TreeBriefs.All()) list.Add(ForDirection(brief, PaletteColor(list.Count)));
        return list;
    }

    /// <summary>Рукописная специализация по id направления. Направление без
    /// записи получает общий текст выше — это нормально, а не ошибка.</summary>
    private sealed record Direction(string ProjectId, string Name, string Prompt, string Rule);

    private static readonly Direction[] Specialty =
    {
        new("9", "CPA-трекер (rtb-velvetflux, 169)",
            "Ты ведёшь CPA-трекер: сверка реального расхода с трекерным, жёсткие лимиты, когортные отчёты.",
            "Расход и выплаты считаются по данным Kadam, а не по cpc трекера. Прежде чем предлагать TODO, назови цифру, на которой он строится."),
        new("6", "Fabra / Юкасса — модерация, РК Директ",
            "Ты ведёшь Fabra: каталог услуг, модерация объявлений, РК Директ.",
            "Платёжный цикл и порядок в каталоге. Сначала сверяй факт по платежу и заказу, потом предлагай действие."),
        new("2", "Адалт-сайты и домены",
            "Ты ведёшь линию доменов: доходность, регистраторы, масштабирование.",
            "Доходность считается на домен в день. Не предлагай масштаб, пока не подтверждена доходность нового домена."),
        new("3", "Игра — Директ-закуп",
            "Ты ведёшь Директ-закуп игр: кампании, метрики, выбор донорской игры.",
            "Канал с нулём в центре денег не масштабируется: сначала метрика, потом бюджет."),
        new("4", "Парсер игр + конвейер заливки",
            "Ты ведёшь конвейер игр: парсер, сборку, заливку, QA.",
            "Конвейер: intake → сборка → QA → публикация. Сборка без проверки не считается выполненной."),
        new("8", "Spy AI",
            "Ты ведёшь Spy AI: полнота выборки, оценка монет, фильтры.",
            "Сначала полнота и воспроизводимость выборки, потом любые выводы о качестве."),
        new("5", "JobLock + dolphin + акки сервисов",
            "Ты ведёшь JobLock: аккаунты, прокси-матрицу, сплат-тесты.",
            "Сплат-тесты с автопроверкой по состоянию. Шаг, который нельзя проверить, не выполнен."),
        new("1", "CoDick — форк Hermes (Bootstrap-панель)",
            "Ты ведёшь CoDick: форк Hermes и Bootstrap-панель.",
            "Разработка. Возвращай проверяемый результат и указывай, какой тест это подтверждает."),
        new("10", "BI-GATE — Task Manager для Windows",
            "Ты ведёшь BI-GATE: контракт данных между Windows и деревом.",
            "Пока контракт источника истины не зафиксирован, нижние слои писать рано."),
        new("11", "РАБОТА — время владельца",
            "Ты ведёшь учёт времени владельца по проектам.",
            "Факт часов, а не оценка. Каждый проект в дереве должен получить фактическое время.")
    };

    private static Profile Make(string name, string projectId, string color, string prompt, string rule) => new()
    {
        Name = name,
        ProjectId = projectId,
        ProjectTitle = name,
        Color = color,
        SessionKey = "agent:profile:" + projectId + ":win",
        Prompt = prompt + "\n\nПравила работы:\n" + rule
                 + "\n- Бери один TODO за раз, не расширяй объём."
                 + "\n- Нужен доступ или решение владельца — спроси одним вопросом и остановись."
                 + "\n- Верни проверяемый результат: что сделано, чем проверено, что дальше."
    };
}

/// <summary>
/// Незакрытые TODO направления из снимка дерева. Профиль получает свою очередь
/// и поэтому может сам решать, какой узел брать следующим.
/// </summary>
public sealed class TreeBrief
{
    public string ProjectId { get; set; } = "";
    public string Title { get; set; } = "";
    public List<TodoItem> Todo { get; set; } = new();
    public List<TodoItem> Nodes { get; set; } = new();

    public sealed class TodoItem
    {
        public string Id { get; set; } = "";
        public string Title { get; set; } = "";
        public string Body { get; set; } = "";
        public string Lane { get; set; } = "todo";
        public bool Done { get; set; }
    }
}

/// <summary>Одна правка дерева, которую оркестратор возвращает после тика.</summary>
public sealed class TreeEdit
{
    /// <summary>done | add | rewrite | lane</summary>
    public string Op { get; set; } = "";
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public string Body { get; set; } = "";
    public string Lane { get; set; } = "todo";
}

public static class TreeBriefs
{
    private static readonly Dictionary<string, TreeBrief> ById = new();
    private static bool _loaded;

    /// <summary>Загружает снимок один раз. Отсутствие файла не считается ошибкой:
    /// профиль просто получит пустую очередь и скажет об этом.</summary>
    public static void Reload() { _loaded = false; ById.Clear(); SourceFile = "не найден"; Load(); }

    public static void Load()
    {
        if (_loaded) return;
        _loaded = true;
        foreach (var path in SnapshotPaths())
        {
            if (!File.Exists(path)) continue;
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(path));
                var source = doc.RootElement;
                if (source.TryGetProperty("tree", out var nested) && nested.ValueKind == JsonValueKind.Object) source = nested;
                if (!source.TryGetProperty("projects", out var projects)) continue;
                foreach (var project in projects.EnumerateArray())
                {
                    var brief = new TreeBrief
                    {
                        ProjectId = project.TryGetProperty("id", out var id) ? Text(id) : "",
                        Title = project.TryGetProperty("title", out var title) ? title.GetString() ?? "" : ""
                    };
                    if (project.TryGetProperty("nodes", out var nodes))
                    {
                        foreach (var node in nodes.EnumerateArray())
                        {
                            var lane = node.TryGetProperty("lane", out var value) ? value.GetString() ?? "" : "";
                            var item = new TreeBrief.TodoItem
                            {
                                Id = node.TryGetProperty("id", out var nodeId) ? Text(nodeId) : "",
                                Title = node.TryGetProperty("title", out var nodeTitle) ? nodeTitle.GetString() ?? "" : "",
                                Body = node.TryGetProperty("body", out var nodeBody) ? nodeBody.GetString() ?? "" : "",
                                Lane = lane,
                                Done = node.TryGetProperty("done", out var done) && (done.ToString() == "1" || done.ValueKind == JsonValueKind.True)
                            };
                            brief.Nodes.Add(item);
                            if (lane.Equals("todo", StringComparison.OrdinalIgnoreCase) && !item.Done) brief.Todo.Add(item);
                        }
                    }
                    if (brief.ProjectId.Length == 0) continue;
                    ById[brief.ProjectId] = brief;
                    SourceFile = path;
                }
                return;
            }
            catch (Exception) { /* битый снимок — пробуем следующий путь */ }
        }
    }

    /// <summary>Дерево отдаёт id строкой, а не числом; принимаем оба вида.</summary>
    private static string Text(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.Number => element.GetInt64().ToString(),
        JsonValueKind.String => element.GetString() ?? "",
        _ => ""
    };

    public static List<TreeBrief.TodoItem> TodoOf(string projectId)
    {
        Load();
        return projectId is not null && ById.TryGetValue(projectId, out var brief) ? brief.Todo : new List<TreeBrief.TodoItem>();
    }

    /// <summary>Все направления снимка, по порядку файла. Из них рождаются
    /// профили, поэтому список должен быть полным и повторяемым.
    /// Сортируем по id, но не всегда числами: дерево отдаёт их строками,
    /// и нечисловой id не должен ронять запуск.</summary>
    public static List<TreeBrief> All()
    {
        Load();
        return ById.Values
            .OrderBy(b => int.TryParse(b.ProjectId, out var id) ? id : int.MaxValue)
            .ThenBy(b => b.ProjectId, StringComparer.Ordinal)
            .ToList();
    }

    public static string TitleOf(string projectId)
    {
        Load();
        return projectId is not null && ById.TryGetValue(projectId, out var brief) ? brief.Title : "";
    }

    public static int TodoCount(string projectId) => TodoOf(projectId).Count;

    /// <summary>
    /// Применить правки оркестратора к снимку дерева и перезагрузить его.
    /// Запись идёт в тот же файл, что читает Load (тот, что реально нашёлся),
    /// с копией .backup. Правки, которые нельзя применить (пустая операция,
    /// неизвестный op, add без id), отбрасываются молча и попадают в отчёт:
    /// молчащая потеря правки хуже явного списка непринятых.
    /// </summary>
    public static (int applied, List<string> rejected) Apply(string projectId, IEnumerable<TreeEdit> edits)
    {
        Load();
        var list = edits.ToList();
        var rejected = new List<string>();
        if (list.Count == 0) return (0, rejected);
        if (!ById.ContainsKey(projectId)) return (0, new List<string> { "направление " + projectId + " не найдено в снимке" });
        var path = SourceFile == "не найден" ? null : SourceFile;
        if (path is null || !File.Exists(path)) return (0, new List<string> { "файл снимка не найден" });

        JsonObject root;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            root = JsonNode.Parse(doc.RootElement.GetRawText()) as JsonObject ?? new JsonObject();
        }
        catch (JsonException error) { return (0, new List<string> { "снимок не читается: " + error.Message }); }

        var documentRoot = root;
        if (root["tree"] is JsonObject nested && nested["projects"] is not null) root = nested;
        var projects = root["projects"] as JsonArray;
        if (projects is null) return (0, new List<string> { "в снимке нет массива projects" });
        var project = projects.FirstOrDefault(node =>
            node?["id"]?.ToString() is string id && id == projectId) as JsonObject;
        if (project is null) return (0, new List<string> { "проект " + projectId + " не найден в файле" });
        var nodes = project["nodes"] as JsonArray;
        if (nodes is null) { nodes = new JsonArray(); project["nodes"] = nodes; }

        var applied = 0;
        foreach (var edit in list)
        {
            var op = (edit.Op ?? "").Trim().ToLowerInvariant();
            var id = (edit.Id ?? "").Trim();
            if (op.Length == 0) { rejected.Add("правка без op"); continue; }
            if (op != "add" && id.Length == 0) { rejected.Add(op + ": без id"); continue; }
            var node = op == "add"
                ? null
                : nodes.FirstOrDefault(n => n?["id"]?.ToString() == id) as JsonObject;
            if (op != "add" && node is null) { rejected.Add(op + ": узел " + id + " не найден"); continue; }

            switch (op)
            {
                case "done":
                    node!["done"] = true;
                    // Выполненный узел не должен висеть в очереди: иначе оркестратор
                    // возьмёт его снова следующим тиком.
                    node["lane"] = "done";
                    applied++;
                    break;
                case "add":
                    if (id.Length == 0 || string.IsNullOrWhiteSpace(edit.Title)) { rejected.Add("add: нужны id и title"); break; }
                    if (nodes.Any(n => n?["id"]?.ToString() == id)) { rejected.Add("add: узел " + id + " уже есть"); break; }
                    nodes.Add(new JsonObject
                    {
                        ["id"] = id,
                        ["title"] = edit.Title ?? "",
                        ["body"] = edit.Body ?? "",
                        ["lane"] = (edit.Lane ?? "todo").Length == 0 ? "todo" : edit.Lane,
                        ["done"] = false,
                    });
                    applied++;
                    break;
                case "rewrite":
                    if (edit.Title is { Length: > 0 }) node!["title"] = edit.Title;
                    if (edit.Body is { Length: > 0 }) node!["body"] = edit.Body;
                    applied++;
                    break;
                case "lane":
                    node!["lane"] = (edit.Lane ?? "").Length == 0 ? "todo" : edit.Lane;
                    if ((edit.Lane ?? "").Equals("todo", StringComparison.OrdinalIgnoreCase)) node["done"] = false;
                    applied++;
                    break;
                default:
                    rejected.Add("неизвестная операция: " + op);
                    break;
            }
        }

        if (rejected.Count > 0) return (0, rejected);
        if (applied > 0)
        {
            try
            {
                File.Copy(path, path + ".backup", true);
                var options = new JsonSerializerOptions { WriteIndented = true };
                File.WriteAllText(path + ".tmp", documentRoot.ToJsonString(options));
                File.Move(path + ".tmp", path, true);
                Reload();
            }
            catch (Exception error) { return (0, new List<string> { "запись снимка не удалась: " + error.Message }); }
        }
        return (applied, rejected);
    }

    public static string SourceFile { get; private set; } = "не найден";

    /// <summary>
    /// Ищем снимок от самой вероятной точки к наименее вероятной: рядом с exe (при публикации
    /// он копируется туда csproj'ом), затем вверх по дереву папок — из bin/ и dist/ разная глубина.
    /// Раньше проверялись только два пути, и из bin/ снимок не находился вовсе.
    /// </summary>
    private static IEnumerable<string> SnapshotPaths()
    {
        yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "HermesWorkspace", "tree-snapshot.json");
        var exeDir = AppContext.BaseDirectory;
        yield return Path.Combine(exeDir, "tree-snapshot.json");

        var dir = new DirectoryInfo(exeDir);
        for (var depth = 0; depth < 7 && dir is not null; depth++, dir = dir.Parent)
        {
            var direct = Path.Combine(dir.FullName, "tree-snapshot.json");
            if (File.Exists(direct)) { yield return direct; yield break; }
            var sibling = Path.Combine(dir.FullName, "pulsepilot", "tree-snapshot.json");
            if (File.Exists(sibling)) { yield return sibling; yield break; }
        }

        yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "HermesChat", "tree-snapshot.json");
        yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "HermesChat", "tree-snapshot.json");
    }
}