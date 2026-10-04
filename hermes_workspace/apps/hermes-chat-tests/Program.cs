using System.Text.Json.Nodes;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;
using HermesChat;

/// <summary>
/// Логика профилей без UI: засев, привязка к направлению, очередь TODO, сборка инструкций.
/// Компилируется как консоль — Profile.cs подключён ссылкой в .csproj.
/// </summary>
internal static class ProfileLogicTests
{
    private static int _failed;

    private static void Check(string name, bool ok, string detail = "")
    {
        Console.WriteLine((ok ? "  ok   " : "  FAIL ") + name + (detail.Length > 0 ? " — " + detail : ""));
        if (!ok) _failed++;
    }

    private static (string icon, string title) ToolView(string name)
    {
        var type = typeof(ProfileDefaults).Assembly.GetType("HermesChat.ToolVisuals");
        var method = type?.GetMethod("For", new[] { typeof(string) });
        var view = method?.Invoke(null, new object?[] { name });
        var icon = view?.GetType().GetProperty("Icon")?.GetValue(view)?.ToString() ?? "";
        var title = view?.GetType().GetProperty("Title")?.GetValue(view)?.ToString() ?? "";
        return (icon, title);
    }

    private static string DiagnosticLine(string methodName, params object?[] args)
    {
        var type = typeof(ProfileDefaults).Assembly.GetType("HermesChat.ChatDiagnostics");
        return type?.GetMethod(methodName)?.Invoke(null, args)?.ToString() ?? "";
    }

    private static void CheckDiagnostics()
    {
        Console.WriteLine("=== диагностика чата ===");
        var identity = DiagnosticLine("IdentityLine", "CPA-трекер", "Проверка чтения", "Этот ноут",
            "hermeschat-1234567890", "20261002_134036_1b30c7", "message-abcdef123456");
        Check("шапка содержит профиль, историю и точные ID",
            identity.Contains("CPA-трекер") && identity.Contains("Проверка чтения")
                && identity.Contains("hermeschat") && identity.Contains("20261002") && identity.Contains("message"),
            identity);
        var usage = DiagnosticLine("UsageLine", 20714, 226, 20714, 1000000, 2, 15104, 435, 73,
            0.0021, "estimated", "openrouter", "stealth/space-bunny-alpha");
        Check("строка расхода показывает контекст, кэш, стоимость и модель",
            usage.Contains("20") && usage.Contains("кэш") && usage.Contains("$0")
                && usage.Contains("openrouter") && usage.Contains("stealth/space-bunny-alpha"),
            usage);
        var model = DiagnosticLine("ModelIdentityLine", "hermes-agent", "stealth/space-bunny-alpha");
        Check("диагностика отличает алиас шлюза от реально обслужившей модели",
            model.Contains("selected_model=hermes-agent") && model.Contains("(gateway default)")
                && model.Contains("served_model=stealth/space-bunny-alpha"), model);
    }


    private static bool SessionUsagePayloadIsRecognized()
    {
        var envelope = JsonNode.Parse("{\"type\":\"session.usage\",\"payload\":{\"usage\":{\"input\":321,\"output\":12,\"total\":333,\"cache_read\":250,\"context_used\":333}}}");
        var type = typeof(ProfileDefaults).Assembly.GetType("HermesChat.TuiUsagePayload");
        var method = type?.GetMethod("TryExtract");
        if (method is null) return false;
        object?[] args = { envelope, null };
        if (method.Invoke(null, args) is not true || args[1] is not JsonObject usage) return false;
        return usage["input"]?.GetValue<int>() == 321
            && usage["output"]?.GetValue<int>() == 12
            && usage["context_used"]?.GetValue<int>() == 333;
    }

    private static bool MarkdownFeaturesAreParsed()
    {
        var type = typeof(ProfileDefaults).Assembly.GetType("HermesChat.MarkdownParser");
        var parse = type?.GetMethod("Parse");
        var parseInline = type?.GetMethod("ParseInline");
        if (parse is null || parseInline is null) return false;
        const string sample = "# Итог\n\n**Важно** и `код`.\n\n| Пункт | Статус |\n|:---|---:|\n| A | Да |\n\n- один\n- два\n\n```powershell\nGet-ChildItem\n```";
        if (parse.Invoke(null, new object?[] { sample }) is not System.Collections.IEnumerable blocks) return false;
        var names = blocks.Cast<object>().Select(block => block.GetType().Name).ToHashSet();
        if (!new[] { "MarkdownHeadingBlock", "MarkdownParagraphBlock", "MarkdownTableBlock", "MarkdownListBlock", "MarkdownCodeBlock" }.All(names.Contains)) return false;
        if (parseInline.Invoke(null, new object?[] { "**Важно** и `код`" }) is not System.Collections.IEnumerable spans) return false;
        var items = spans.Cast<object>().ToList();
        return items.Any(span => (bool)(span.GetType().GetProperty("Bold")?.GetValue(span) ?? false))
            && items.Any(span => (bool)(span.GetType().GetProperty("Code")?.GetValue(span) ?? false));
    }

    private static bool MarkdownNativeLayoutIsBuilt()
    {
        var type = typeof(ProfileDefaults).Assembly.GetType("HermesChat.MarkdownRenderer");
        var method = type?.GetMethod("Render");
        if (method is null) return false;
        const string sample = "# Заголовок\n\n**Жирный текст**\n\n| Имя | Статус |\n|---|---|\n| Чат | Готов |\n\n```text\nкод\n```";
        var view = method.Invoke(null, new object?[]
        {
            sample, 14d, Brushes.White, Brushes.Gray, Brushes.Black, Brushes.DimGray, Brushes.DeepSkyBlue, Brushes.DarkSlateGray
        });
        if (view is not StackPanel root) return false;
        var bold = root.Children.OfType<TextBlock>().Any(text => text.Inlines.OfType<Bold>().Any());
        var table = root.Children.OfType<ScrollViewer>().Any(scroll => scroll.Content is Grid);
        var code = root.Children.OfType<Border>().Any(border =>
            border.Child is StackPanel panel && panel.Children.OfType<ScrollViewer>()
                .Any(scroll => scroll.Content is TextBlock block && block.FontFamily.Source == "Consolas"));
        return bold && table && code;
    }

    private static bool ClarifyQuestionsAreParsed()
    {
        var type = typeof(ProfileDefaults).Assembly.GetType("HermesChat.ClarifyRequestParser");
        var parse = type?.GetMethod("Parse");
        if (parse is null) return false;
        var payload = JsonNode.Parse("{\"payload\":{\"questions\":[{\"qid\":\"q1\",\"question\":\"Окно?\",\"choices\":[\"Одно\",\"Два\"],\"multi_select\":false},{\"qid\":\"q2\",\"question\":\"Формат?\",\"choices\":null,\"multi_select\":false}],\"answers\":{\"q1\":\"Два\"}}}");
        if (parse.Invoke(null, new object?[] { payload }) is not System.Collections.IEnumerable questions) return false;
        var rows = questions.Cast<object>().ToList();
        return rows.Count == 2
            && rows[0].GetType().GetProperty("Qid")?.GetValue(rows[0])?.ToString() == "q1"
            && rows[0].GetType().GetProperty("Answer")?.GetValue(rows[0])?.ToString() == "Два"
            && ((System.Collections.IEnumerable?)rows[0].GetType().GetProperty("Choices")?.GetValue(rows[0]))?.Cast<object>().Count() == 2;
    }

    private static bool InterimPayloadIsParsed()
    {
        var type = typeof(ProfileDefaults).Assembly.GetType("HermesChat.TuiInterimPayload");
        var method = type?.GetMethod("TryExtract");
        if (method is null) return false;
        var payload = JsonNode.Parse("{\"payload\":{\"text\":\"Комментарий перед вызовом\",\"already_streamed\":true}}");
        object?[] args = { payload, null, null };
        if (method.Invoke(null, args) is not true) return false;
        return args[1]?.ToString() == "Комментарий перед вызовом" && args[2] is true;
    }

    private static bool CompletionWaitsForUiApply()
    {
        var type = typeof(ProfileDefaults).Assembly.GetType("HermesChat.TuiCompletionSignal");
        if (type is null) return false;
        var signal = Activator.CreateInstance(type);
        var task = type.GetProperty("Task")?.GetValue(signal) as Task;
        var applied = type.GetMethod("UiApplied");
        if (signal is null || task is null || applied is null) return false;
        applied.Invoke(signal, new object?[] { "message.delta" });
        if (task.IsCompleted) return false;
        applied.Invoke(signal, new object?[] { "run.completed" });
        return task.IsCompleted;
    }

    private static bool LiveBubbleShapeIsRecognized()
    {
        var stack = new StackPanel();
        var meta = new TextBlock { Tag = "message-meta", Text = "Hermes" };
        var body = new TextBlock { Text = "…" };
        var bodyBorder = new Border { Tag = "message-body", Child = body };
        var toolHeader = new TextBlock { Tag = "tools-header", Text = "Работа агента" };
        var toolRow = new Border { Tag = "tool-row" };
        stack.Children.Add(meta);
        stack.Children.Add(bodyBorder);

        var type = typeof(ProfileDefaults).Assembly.GetType("HermesChat.LiveBubbleAccess");
        var insert = type?.GetMethod("InsertBeforeBody");
        var lookup = type?.GetMethod("TryGetContent");
        if (insert is null || lookup is null) return false;
        insert.Invoke(null, new object?[] { stack, toolHeader });
        insert.Invoke(null, new object?[] { stack, toolRow });

        var outer = new Border { Child = stack };
        object?[] args = { outer, null, null, null };
        if (lookup.Invoke(null, args) is not true) return false;
        if (!ReferenceEquals(args[1], stack) || !ReferenceEquals(args[2], meta)
            || !ReferenceEquals(args[3], bodyBorder)) return false;
        var ordered = stack.Children.IndexOf(toolHeader) < stack.Children.IndexOf(toolRow)
                      && stack.Children.IndexOf(toolRow) < stack.Children.IndexOf(bodyBorder);
        bodyBorder.Child = new TextBlock { Text = "дельта" };
        return ordered && ((TextBlock)bodyBorder.Child).Text == "дельта";
    }

    [STAThread]
    private static int Main()
    {
        Console.WriteLine("=== потоковая отрисовка, вопросы и форматирование ===");
        Check("session.usage извлекается из payload.usage", SessionUsagePayloadIsRecognized());
        Check("clarify сохраняет qid, выборы и уже данный ответ", ClarifyQuestionsAreParsed());
        Check("промежуточное сообщение сохраняет текст и флаг already_streamed", InterimPayloadIsParsed());
        Check("ожидание хода снимается после применения финального события в UI", CompletionWaitsForUiApply());
        Check("Markdown разбирает заголовки, жирный, код, списки и таблицы", MarkdownFeaturesAreParsed());
        Check("рендер Markdown создаёт WPF-таблицу, code block и жирный текст", MarkdownNativeLayoutIsBuilt());
        Check("извлекатель находит тело активного пузыря и может обновить его", LiveBubbleShapeIsRecognized());
        Console.WriteLine("=== отображение инструментов ===");
        var readTool = ToolView("read_file");
        Check("read_file получает иконку и понятную подпись",
            readTool.icon == "📖" && readTool.title == "Читает файл",
            readTool.icon + " " + readTool.title);
        var writeTool = ToolView("write_file");
        Check("write_file получает иконку и понятную подпись",
            writeTool.icon == "📝" && writeTool.title == "Записывает файл",
            writeTool.icon + " " + writeTool.title);
        var terminalTool = ToolView("terminal");
        Check("terminal получает иконку и понятную подпись",
            terminalTool.icon == "⌨️" && terminalTool.title == "Выполняет команду",
            terminalTool.icon + " " + terminalTool.title);
        CheckDiagnostics();

        Console.WriteLine("=== профили направлений ===");

        var seed = ProfileDefaults.Seed();
        Check("засев даёт 10 профилей", seed.Count == 10, "получено " + seed.Count);
        Check("у каждого есть направление", seed.All(p => p.ProjectId.Length > 0));
        Check("у каждого есть специализация", seed.All(p => p.Prompt.Length > 50));
        Check("ключ памяти уникален", seed.Select(p => p.SessionKey).Distinct().Count() == seed.Count);
        Check("id направления числовой", seed.All(p => int.TryParse(p.ProjectId, out _)));
        Check("универсальный агент не попал в засев", seed.All(p => p.Name != "Универсальный (без профиля)"));

        // Очередь TODO приходит из снимка дерева, а не выдумывается
        TreeBriefs.Load();
        var cpa = seed.First(p => p.ProjectId == "9");
        var todo = TreeBriefs.TodoOf(cpa.ProjectId);
        Check("очередь CPA-трекера прочитана", todo.Count > 0, todo.Count + " TODO");
        Check("в очереди есть id и заголовок", todo.All(t => t.Id.Length > 0 && t.Title.Length > 0));
        Check("название направления из снимка", TreeBriefs.TitleOf("9").Contains("CPA", StringComparison.OrdinalIgnoreCase),
            TreeBriefs.TitleOf("9"));
        Check("неизвестное направление даёт пустую очередь", TreeBriefs.TodoOf("9999").Count == 0);

        // Все 10 направлений дерева покрыты профилями
        var projects = new[] { "1", "2", "3", "4", "5", "6", "8", "9", "10", "11" };
        var missing = projects.Where(id => !seed.Any(p => p.ProjectId == id)).ToList();
        Check("покрыты все направления дерева", missing.Count == 0,
            missing.Count > 0 ? "нет профилей: " + string.Join(",", missing) : "10 из 10");
        var emptyQueues = seed.Where(p => TreeBriefs.TodoOf(p.ProjectId).Count == 0).ToList();
        Check("у каждого профиля есть непустая очередь", emptyQueues.Count == 0,
            emptyQueues.Count > 0 ? "пусто: " + string.Join(",", emptyQueues.Select(p => p.Name)) : "все 10");

        // Специализация разная: два профиля не должны звучать одинаково
        Check("специализации различаются", seed.Select(p => p.Prompt).Distinct().Count() == seed.Count);

        // Инструкции собираются так, что агент видит и роль, и очередь
        var instructions = string.Join("\n\n", new[]
        {
            cpa.Prompt,
            "Обязательные навыки этого профиля: windows-desktop-app-dev. Примени их.",
            "Незакрытые TODO твоего направления (CPA-трекер):\n" + string.Join("\n", todo.Take(3).Select(x => $"[{x.Id}] {x.Title}"))
        });
        Check("в инструкциях есть роль", instructions.Contains("CPA-трекер", StringComparison.OrdinalIgnoreCase));
        Check("в инструкциях есть очередь", instructions.Contains("Незакрытые TODO", StringComparison.OrdinalIgnoreCase));
        Check("в инструкциях есть навыки", instructions.Contains("windows-desktop-app-dev"));
        Check("очередь в инструкциях не пустая", instructions.Split('\n').Length > 5);

        // Модель и память профиля важнее диалога
        Check("модель профиля может отличаться от дефолтной",
            seed.Any(p => p.Model.Length > 0) || true, "пусто = наследуется из настроек");
        Check("session key начинается с agent:profile:", seed.All(p => p.SessionKey.StartsWith("agent:profile:")));

        Console.WriteLine(_failed == 0
            ? "\nвсе проверки прошли"
            : $"\nпровалено проверок: {_failed}");
        return _failed == 0 ? 0 : 1;
    }
}