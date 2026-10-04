using System.Diagnostics;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace PulsePilot;

public partial class MainWindow
{
    private TextBlock Text(string value, double size = 13, string color = "Fg") => new()
    { Text = value, TextWrapping = TextWrapping.Wrap, FontSize = size, Foreground = (Brush)FindResource(color), Margin = new Thickness(0, 0, 0, 8) };
    private static string At(long unix, string format) => DateTimeOffset.FromUnixTimeSeconds(unix).ToLocalTime().ToString(format);
    private Button ActionButton(string label, Action action, bool primary = false)
    {
        var button = new Button { Content = label, Margin = new Thickness(0, 0, 8, 8), Padding = new Thickness(12, 8, 12, 8) };
        if (primary) button.Style = (Style)FindResource("PrimaryBtn");
        button.Click += (_, _) => action(); return button;
    }
    private void RenderFleet()
    {
        var busy = _state.FleetJobs.Count(FleetRules.Busy);
        var alerts = _state.FleetJobs.Where(j => FleetRules.Attention(j, Now, _state.Settings.AgentStaleMinutes * 60)).ToList();
        var money = _state.FleetJobs.Count(j => j.BlockReason is "money" or "access");
        var dead = _state.FleetJobs.Count(j => j.LivenessAt > 0 && !j.LivenessOk);
        var work = _state.WorkUntil > Now;
        FleetSummary.Text = $"{busy}/{_state.Settings.ParallelSlots} проектов в исполнении · {alerts.Count} требуют внимания · " +
            (_state.Settings.AgentBaseUrl.Length > 0 ? "Agent Bridge настроен" : "Ручные локеры · автозапуск ещё не настроен") +
            (work ? $" · рабочий блок ещё {(_state.WorkUntil - Now + 59) / 60} мин" : "") +
            (money > 0 ? $" · упираются в деньги/доступ: {money}" : "") +
            (dead > 0 ? $" · локер не отвечает: {dead}" : "");
        WorkButton.Content = work ? "Вернулся · разобрать очередь" : "Ушёл на работу · 30 мин";
        DirectionStrip.Children.Clear(); FleetCards.Children.Clear(); AttentionList.Children.Clear();
        foreach (var project in _tree.Projects.OrderBy(p => p.SortOrder))
        {
            var jobs = _state.FleetJobs.Where(j => j.ProjectId == project.Id).ToList();
            var last = jobs.LastOrDefault(j => j.Status != "done" && j.Status != "cancelled") ?? jobs.LastOrDefault();
            var side = new Button { Content = new TextBlock { Text = project.Title + "\n" + (last == null ? "Нет запущенного агента" : FleetRules.StatusName(last)), TextWrapping = TextWrapping.Wrap, FontSize = 12 },
                HorizontalContentAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 0, 0, 8), Padding = new Thickness(10),
                BorderBrush = (Brush)FindResource(_projectFilter == project.Id ? "Accent" : "Line") };
            side.Click += (_, _) => { _projectFilter = project.Id; _selProject = project.Id; Render(); };
            DirectionStrip.Children.Add(side);
        }
        var projects = _tree.Projects.Where(p => _projectFilter.Length == 0 || p.Id == _projectFilter)
            .OrderByDescending(p => _state.FleetJobs.Any(j => j.ProjectId == p.Id && FleetRules.Attention(j, Now, _state.Settings.AgentStaleMinutes * 60)))
            .ThenByDescending(p => _state.FleetJobs.Any(j => j.ProjectId == p.Id && FleetRules.Busy(j))).ThenBy(p => p.SortOrder);
        foreach (var project in projects)
        {
            var brief = _state.ProjectBriefs.GetValueOrDefault(project.Id) ?? new ProjectBrief { Goal = project.Note, Gate = "Уточнить проверяемое условие масштаба" };
            var job = _state.FleetJobs.LastOrDefault(j => j.ProjectId == project.Id && j.Status is not ("done" or "cancelled"))
                ?? _state.FleetJobs.LastOrDefault(j => j.ProjectId == project.Id);
            var suggestion = FleetRules.Suggest(project, _state);
            var stack = new StackPanel();
            stack.Children.Add(Text(project.Title, 18));
            stack.Children.Add(Text("ЦЕЛЬ · " + (brief.Goal.Length > 0 ? brief.Goal : "Задать цель"), 12, "Accent2"));
            stack.Children.Add(Text("ФАКТ · снимок 30.09 · " + (brief.Fact.Length > 0 ? brief.Fact : "Нет подтверждённой метрики"), 12, "FgDim"));
            stack.Children.Add(Text("МАСШТАБ · " + brief.Gate, 12, "FgDim"));
            var badge = job == null ? "Нет запущенного агента" : FleetRules.StatusName(job);
            stack.Children.Add(Text(badge, 13, job != null && FleetRules.Attention(job, Now, _state.Settings.AgentStaleMinutes * 60) ? "Warn" : "Accent"));
            stack.Children.Add(Text(job?.Title ?? suggestion?.Title ?? "Выбери конкретный TODO в дереве", 14));
            if (job != null)
            {
                stack.Children.Add(Text(job.Summary, 12, "FgDim"));
                stack.Children.Add(Text(job.CheckedAt == 0 ? "Статус не проверялся" : $"Проверка {DateTimeOffset.FromUnixTimeSeconds(job.CheckedAt).ToLocalTime():HH:mm:ss} · {(job.Source == "api" ? "Bridge" : "оператор")}", 11, "FgDim"));
                if (job.Status == "prepared" && _state.Settings.AgentBaseUrl.Length == 0)
                    stack.Children.Add(Text("Bridge не подключён. Кнопка ниже только копирует текст — агент не запускается и прогресс не отслеживается. После передачи отметь «Ещё ▾ → Я передал, жду результата».", 12, "Warn"));
                if (FleetRules.Neglected(job, Now, _state.Settings.AgentStaleMinutes * 60))
                    stack.Children.Add(Text("Поручение подготовлено, но не передано. Оно попало в очередь решений.", 12, "Warn"));
            }
            var buttons = new WrapPanel();
            var manual = _state.Settings.AgentBaseUrl.Length == 0;
            if (job?.Status == "prepared") buttons.Children.Add(ActionButton(manual ? "Скопировать поручение" : "Передать агенту", () => _ = StartJob(job), true));
            if (job?.Status == "prepared" && manual)
                buttons.Children.Add(ActionButton("Я передал, жду результата →", () => { SelectJob(job.Id); Manual("running"); }));
            if (job == null || (job.Status is "done" or "cancelled"))
                buttons.Children.Add(ActionButton("Подготовить TODO агенту", () => Prepare(project, suggestion), true));
            if (job != null) buttons.Children.Add(ActionButton("Открыть запуск →", () => SelectJob(job.Id)));
            buttons.Children.Add(ActionButton("Цель / факт", () =>
            {
                if (new ProjectBriefWindow(project, brief) { Owner = this }.ShowDialog() == true)
                { _state.ProjectBriefs[project.Id] = brief; _state.Save(); RenderFleet(); }
            }));
            buttons.Children.Add(ActionButton("TODO и Wiki", () => { _projectFilter = project.Id; _selProject = project.Id; Render(); WorkspaceTabs.SelectedIndex = 1; }));
            if (job == null || job.Status is "done" or "cancelled")
                buttons.Children.Add(ActionButton("ИИ — другая задача", () => AskAiPick(project), false));
            stack.Children.Add(buttons);
            FleetCards.Children.Add(new Border { Style = (Style)FindResource("Card"), Padding = new Thickness(18), Margin = new Thickness(0, 0, 12, 12), Child = stack });
        }
        if (alerts.Count == 0) AttentionList.Children.Add(Text("Никто не ждёт твоего решения. Можно запускать другие направления или заниматься работой.", 13, "FgDim"));
        foreach (var job in alerts.OrderBy(j => j.CheckedAt))
        {
            var reason = FleetRules.Neglected(job, Now, _state.Settings.AgentStaleMinutes * 60)
                ? "Поручение подготовлено, но не передано агенту"
                : job.LivenessAt > 0 && !job.LivenessOk
                    ? "Локер не отвечает: " + job.LivenessNote + ". Назови причину простоя."
                    : job.BlockReason.Length > 0
                        ? BlockReasons.Label(job.BlockReason) + " · " + job.Summary
                        : job.Question.Length > 0 ? job.Question : job.Summary;
            var label = (_tree.ById(job.ProjectId)?.Title ?? job.ProjectId) + "\n" + FleetRules.StatusName(job) + "\n" + reason;
            var button = new Button { Content = new TextBlock { Text = label, TextWrapping = TextWrapping.Wrap, MaxWidth = 260 },
                Padding = new Thickness(12), Margin = new Thickness(0, 0, 0, 10), HorizontalContentAlignment = HorizontalAlignment.Left };
            button.Click += (_, _) => SelectJob(job.Id); AttentionList.Children.Add(button);
        }
        RenderInspector(); LogList.Items.Refresh();
    }
    private void SelectJob(string id) { _jobId = id; WorkspaceTabs.SelectedIndex = 0; RenderInspector(); }
    private void RenderInspector()
    {
        var job = SelectedJob; InspectorCard.Visibility = job == null ? Visibility.Collapsed : Visibility.Visible;
        if (job == null) return;
        var probe = Liveness.Parse(job.Locker);
        var live = job.LivenessAt == 0
            ? "живость не проверялась"
            : job.LivenessOk ? "живость: живой" : "живость: НЕ ОТВЕЧАЕТ";
        var liveAge = job.LivenessAt == 0 ? "" : " (проверка " + At(job.LivenessAt, "HH:mm:ss") + ")";
        var since = job.BlockSince > 0 ? " · с " + At(job.BlockSince, "dd.MM HH:mm") : "";
        var reason = job.BlockReason.Length > 0
            ? "\n\nПричина простоя: " + BlockReasons.Label(job.BlockReason) + since
            : FleetRules.UnreasonedSilence(job, Now, _state.Settings.AgentStaleMinutes * 60)
                ? "\n\nМолчит без названной причины — укажи, что помешало." : "";
        JobTitle.Text = job.Title; JobStatus.Text = FleetRules.StatusName(job);
        JobDetail.Text = job.Summary + (job.Result.Length > 0 ? "\n\nРезультат:\n" + job.Result : "") +
            "\n\nЛокер: " + (job.Locker.Length > 0 ? job.Locker : "не задан") + "\nПроверка: " + probe.Describe() + " · " + live + liveAge +
            (job.LivenessNote.Length > 0 ? " — " + job.LivenessNote : "") + reason;
        JobQuestion.Text = job.Question;
        _renderingNote = true; if (JobNote.Text != job.Note) JobNote.Text = job.Note; _renderingNote = false;
        SendInputButton.IsEnabled = job.Source == "api" && job.Status == "waiting_input" && !_jobRequests.Contains(job.Id);
        AcceptJobButton.IsEnabled = job.Status == "review" && !_jobRequests.Contains(job.Id);
    }
    private void BtnPrepareSelected(object s, RoutedEventArgs e) { var p = _tree.ProjectOfNode(_selNode); if (p != null) Prepare(p, _tree.NodeById(_selNode)); }
    /// <summary>
    /// ИИ предлагает другую задачу направления. Модель видит только реальные узлы дерева,
    /// а её ответ фильтруется по дереву — выдуманный id в поручение не попадёт.
    /// </summary>
    private void AskAiPick(Project project)
    {
        var brief = _state.ProjectBriefs.GetValueOrDefault(project.Id) ?? new ProjectBrief { Goal = project.Note };
        var candidates = AiPick.Candidates(project, _state, _tree);
        var window = new AiTaskWindow(project, brief, candidates.Count) { Owner = this };
        if (candidates.Count == 0)
        {
            window.SetError("В этом направлении нет исполнимых TODO: всё закрыто, заблокировано или помечено как отложенное.");
            window.ShowDialog();
            return;
        }
        // Окно немодальное: пока модель думает, приложением можно пользоваться и закрыть это окно.
        window.Chosen += (nodeId, why) =>
        {
            var node = _tree.NodeById(nodeId);
            if (node == null) { FleetHint.Text = "Выбранный узел исчез из дерева."; RenderFleet(); return; }
            _state.AddLog("aipick", project.Title + ": ИИ предложил [" + node.Id + "] " + node.Title +
                (why.Length > 0 ? " — " + why : ""));
            Prepare(project, node);
        };
        window.Retry = () => _ = AskAiPickOnce(window, project, brief, candidates);
        window.Show();
        _ = AskAiPickOnce(window, project, brief, candidates);
    }
    /// <summary>
    /// Выбор задачи идёт отдельной быстрой моделью: reasoning-модели (deepseek-v4-flash) съедают
    /// весь max_tokens на внутреннее рассуждение и возвращают пустой ответ — проверено на живых данных.
    /// Если основная модель не дала разбираемого выбора, пробуем запасную, и только потом показываем сырой ответ.
    /// </summary>
    private async Task AskAiPickOnce(AiTaskWindow window, Project project, ProjectBrief brief, List<Node> candidates)
    {
        if (window.IsBusy || window.IsDisposed) return;
        var cts = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        window.TrackRequest(cts);
        window.SetBusy("Думаю над выбором… обычно 5–15 секунд. Окно можно свернуть, работа продолжится.");
        var allowed = candidates.Select(n => n.Id).ToHashSet();
        var request = AiPick.BuildRequest(project, brief, candidates, _state.FleetJobs, window.Guidance);
        var messages = new[] { ("system", AiPick.SystemPrompt), ("user", request) };
        var models = new[] { _state.Settings.LlmPickModel, _state.Settings.LlmPickFallbackModel }
            .Where(m => !string.IsNullOrWhiteSpace(m)).Distinct().ToList();
        var lastNote = "";
        try
        {
            foreach (var model in models)
            {
                var pick = new AppSettings
                {
                    LlmBaseUrl = _state.Settings.LlmBaseUrl, LlmKey = _state.Settings.LlmKey, LlmModel = model,
                    LlmTemperature = 0.2, LlmMaxTokens = 800
                };
                string answer;
                try { answer = await _llm.AskAsync(pick, messages, cts.Token); }
                catch (Exception ex) { lastNote = model + ": " + ex.Message; continue; }
                var picks = AiPick.Parse(answer, allowed, out _, out var why);
                if (picks.Count > 0)
                {
                    if (model != models[0]) window.Note("Выбрала запасная модель " + model + ". Первую ответ не разобрала: " + lastNote);
                    window.Show(why, picks, project.Nodes.ToDictionary(n => n.Id));
                    return;
                }
                lastNote = model + " вернул ответ без выбора";
                window.SetRaw(answer);
            }
        }
        catch (OperationCanceledException) { window.SetError("Модель не уложилась в 90 секунд. Уточни словами или спроси заново."); return; }
        catch (Exception ex) { window.SetError("Модель не ответила: " + ex.Message); return; }
        finally { window.ForgetRequest(); cts.Dispose(); }
        window.SetError("Ни одна модель не предложила задачу из списка кандидатов. " + lastNote + ". Разбор ответа — в окне.");
    }
    private void Prepare(Project project, Node? node)
    {
        if (node == null || !FleetRules.Actionable(node)) { FleetHint.Text = "Выбери исполнимый TODO. Wiki, цель, риск и отложенные работы остаются контекстом."; return; }
        if (_state.LiveBlockers(node.Id, _tree).Count > 0) { FleetHint.Text = "Сначала закрой открытые зависимости этого TODO."; return; }
        var existing = _state.FleetJobs.LastOrDefault(j => j.ProjectId == project.Id && (FleetRules.Busy(j) || j.Status is "prepared" or "review"));
        if (existing != null) { SelectJob(existing.Id); FleetHint.Text = "Поручение направления уже сохранено. Оно не теряется при переключении."; return; }
        var brief = _state.ProjectBriefs.GetValueOrDefault(project.Id) ?? new ProjectBrief { Goal = project.Note };
        var job = new FleetJob { NodeId = node.Id, ProjectId = project.Id, Title = node.Title, Prompt = FleetRules.MakePrompt(project, node, brief),
            Resource = "project:" + project.Id, Locker = _state.Lockers.GetValueOrDefault(node.Id) ?? "" };
        var setup = new JobSetupWindow(job) { Owner = this };
        if (setup.ShowDialog() != true) return;
        _state.FleetJobs.Add(job); _state.Lockers[node.Id] = job.Locker; _state.Save();
        SelectJob(job.Id); RenderFleet();
    }
    private async Task StartJob(FleetJob job)
    {
        if (job.Status != "prepared" || _jobRequests.Contains(job.Id)) return;
        if (!FleetRules.CanStart(job, _state.FleetJobs, _state.Settings.ParallelSlots)) { FleetHint.Text = "Лимит параллельных проектов или ресурс занят. Работающие агенты продолжают выполнение."; return; }
        if (_state.Settings.AgentBaseUrl.Length == 0)
        {
            try { Clipboard.SetText(job.Prompt); FleetHint.Text = "Поручение скопировано (Bridge не подключён — процесс не запущен). Вставь его агенту, затем нажми «Я передал, жду результата», чтобы включить отслеживание и напоминание."; }
            catch { FleetHint.Text = "Буфер обмена занят."; }
            _state.AddLog("dispatch", "Поручение скопировано вручную: " + job.Title);
            RenderFleet();
            return;
        }
        if (_tree.NodeById(job.NodeId) is not { Done: 0 } || _state.LiveBlockers(job.NodeId, _tree).Count > 0)
        { FleetHint.Text = "TODO закрыт или заблокирован — запуск отменён."; return; }
        _jobRequests.Add(job.Id); job.Source = "api"; job.Endpoint = _state.Settings.AgentBaseUrl; job.RemoteId = job.Id;
        job.Status = "submitting";
        if (!_state.Save())
        {
            job.Status = "prepared"; job.Source = "manual"; job.RemoteId = ""; _jobRequests.Remove(job.Id);
            FleetHint.Text = "Запуск не отправлен: не удалось сохранить идентификатор. " + _state.LastSaveError;
            RenderFleet(); return;
        }
        RenderFleet();
        try
        {
            var response = await _adapter.Call(job.Endpoint, _state.Settings.AgentKey, "/runs", new { client_job_id = job.Id, project_id = job.ProjectId,
                node_id = job.NodeId, resource = job.Resource, prompt = job.Prompt });
            if (!response.TryGetProperty("id", out var id) || id.GetString() != job.Id) throw new InvalidOperationException("Адаптер не подтвердил client_job_id.");
            FleetRules.ApplyRemote(job, response, Now);
            _state.AddLog("dispatch", "Передано агенту: " + job.Title);
        }
        catch (AgentAdapterException ex) when (ex.StatusCode is 400 or 401 or 403 or 404 or 409)
        { job.Status = "prepared"; job.RemoteId = ""; job.Source = "manual"; job.Summary = "Bridge отклонил запуск: " + ex.Message + ". Проверь настройки, лимит и общий ресурс."; }
        catch (Exception ex) { job.Status = "unknown"; job.Summary = "Исход отправки не подтверждён: " + ex.Message + ". Проверяй тот же запуск; повторной отправки автоматически нет."; }
        finally { _jobRequests.Remove(job.Id); _state.Save(); RenderFleet(); }
    }
    private async Task CheckJob(FleetJob job)
    {
        if (job.Source != "api" || job.RemoteId.Length == 0 || !_jobRequests.Add(job.Id)) return;
        try
        {
            var data = await _adapter.Call(job.Endpoint, _state.Settings.AgentKey, "/runs/" + Uri.EscapeDataString(job.RemoteId));
            var previous = job.Status; FleetRules.ApplyRemote(job, data, Now);
            if (previous != job.Status) _state.AddLog("agent", job.Title + ": " + FleetRules.StatusName(job));
        }
        catch (Exception ex) { if (FleetRules.Busy(job)) job.Status = "unknown"; job.Summary = "Не удалось проверить агент: " + ex.Message; }
        finally { _jobRequests.Remove(job.Id); _state.Save(); }
    }
    private async void BtnCheckJob(object s, RoutedEventArgs e)
    {
        if (SelectedJob is not { } job) return;
        if (job.Source == "manual") { FleetHint.Text = "Открой локер, проверь факт и обнови отметку через «Ещё». Автоматической связи с этим локером нет."; return; }
        await CheckJob(job); RenderFleet();
    }
    private async void BtnSendInput(object s, RoutedEventArgs e)
    {
        var job = SelectedJob; if (job == null || job.Source != "api" || job.Status != "waiting_input" || job.Note.Trim().Length == 0 || !_jobRequests.Add(job.Id)) return;
        try
        {
            var data = await _adapter.Call(job.Endpoint, _state.Settings.AgentKey, "/runs/" + Uri.EscapeDataString(job.RemoteId) + "/input",
                new { answer = job.Note, expected_version = job.Version, input_id = job.Id + ":" + job.Version });
            FleetRules.ApplyRemote(job, data, Now); job.Note = ""; _state.AddLog("input", "Ответ агенту: " + job.Title);
        }
        catch (Exception ex) { FleetHint.Text = "Ответ не подтверждён: " + ex.Message + ". Проверь статус перед повтором."; }
        finally { _jobRequests.Remove(job.Id); _state.Save(); RenderFleet(); }
    }
    private void BtnAcceptJob(object s, RoutedEventArgs e)
    {
        if (SelectedJob is not { Status: "review" } job || _jobRequests.Contains(job.Id)) return;
        if (job.Note.Trim().Length == 0) { FleetHint.Text = "Запиши, что проверено. Отчёт агента сам по себе ещё не приёмка."; JobNote.Focus(); return; }
        job.Status = "done"; _state.AddLog("accepted", job.Title + " — " + job.Note); _state.AddWhatDoing(job.NodeId, job.Note); _state.Save(); RenderFleet();
        FleetHint.Text = "Результат принят. TODO в серверном дереве закрой отдельно, если задача выполнена полностью.";
    }
    private void Manual(string status)
    {
        if (SelectedJob is not { } job || job.Source != "manual" || _jobRequests.Contains(job.Id)) return;
        if (status == "running" && !FleetRules.CanStart(job, _state.FleetJobs, _state.Settings.ParallelSlots)) { FleetHint.Text = "Лимит или ресурс занят."; return; }
        if (job.Status is "done" or "cancelled") return;
        var wasPrepared = job.Status == "prepared";
        job.Status = status; job.CheckedAt = Now; job.NextCheckAt = Now + _state.Settings.AgentStaleMinutes * 60;
        // Отметка оператора снимает прошлую причину: она относилась к предыдущему состоянию.
        if (job.BlockReason.Length > 0) { job.BlockReason = ""; job.BlockSince = 0; }
        job.Summary = wasPrepared
            ? "Передано вручную. Напомню о карточке через " + _state.Settings.AgentStaleMinutes + " мин, если не отметишь результат."
            : "Отметка оператора после проверки локера."; _state.AddLog("manual", job.Title + ": " + FleetRules.StatusName(job)); _state.Save(); RenderFleet();
    }
    private void BtnManualRunning(object s, RoutedEventArgs e) => Manual("running");
    private void BtnManualInput(object s, RoutedEventArgs e) => Manual("waiting_input");
    private void BtnManualResult(object s, RoutedEventArgs e) => Manual("review");
    private void BtnManualStopped(object s, RoutedEventArgs e) => Manual("cancelled");
    private async void BtnCancelJob(object s, RoutedEventArgs e)
    {
        if (SelectedJob is not { } job || job.Status is "done" or "cancelled" || !_jobRequests.Add(job.Id)) return;
        try
        {
            if (job.Source == "api") { var data = await _adapter.Call(job.Endpoint, _state.Settings.AgentKey, "/runs/" + Uri.EscapeDataString(job.RemoteId) + "/cancel", new { }); FleetRules.ApplyRemote(job, data, Now); }
            else { job.Status = "unknown"; job.Summary = "Останови агент в локере, затем подтверди остановку. Приложение не управляет ручным процессом."; }
        }
        catch (Exception ex) { job.Status = "unknown"; job.Summary = "Остановка не подтверждена: " + ex.Message; }
        finally { _jobRequests.Remove(job.Id); _state.Save(); RenderFleet(); }
    }
    private async void BtnResolveUnknown(object s, RoutedEventArgs e)
    {
        if (SelectedJob is not { Status: "unknown" } job || !_jobRequests.Add(job.Id)) return;
        try
        {
            if (job.Note.Trim().Length == 0) { FleetHint.Text = "Запиши, как проверено, что агент остановлен. Неизвестный исход нельзя снять без факта."; return; }
            if (job.Source == "api")
            {
                var data = await _adapter.Call(job.Endpoint, _state.Settings.AgentKey, "/runs/" + Uri.EscapeDataString(job.RemoteId) + "/resolve",
                    new { status = "cancelled", evidence = job.Note, expected_version = job.Version });
                FleetRules.ApplyRemote(job, data, Now);
            }
            else job.Status = "cancelled";
            _state.AddLog("resolution", job.Title + " — остановка подтверждена оператором: " + job.Note);
        }
        catch (Exception ex) { FleetHint.Text = "Не удалось подтвердить: " + ex.Message; }
        finally { _jobRequests.Remove(job.Id); _state.Save(); RenderFleet(); }
    }
    private void BtnSnoozeJob(object s, RoutedEventArgs e) { if (SelectedJob is { } j) { j.AlertAfter = Now + 300; _state.Save(); FleetHint.Text = "Повторный экран через 5 минут; запись остаётся в очереди."; } }
    private async void BtnCheckLiveness(object s, RoutedEventArgs e)
    {
        if (SelectedJob is not { } job || !_jobRequests.Add(job.Id)) return;
        try
        {
            var probe = Liveness.Parse(job.Locker);
            if (!probe.Verifiable) { FleetHint.Text = "Проверить нечем: " + probe.Describe() + ". Укажи tmux:имя, proc:имя или http(s)-адрес — тогда система сама увидит, жив ли запуск."; return; }
            FleetHint.Text = "Проверяю " + probe.Describe() + "…";
            var result = await Liveness.RunAsync(probe);
            job.LivenessAt = Now; job.LivenessOk = result.Ok; job.LivenessNote = result.Note;
            if (!result.Ok) { job.BlockReason = "crashed"; job.BlockSince = Now; }
            _state.AddLog("liveness", job.Title + ": " + (result.Ok ? "живой — " : "не отвечает — ") + result.Note);
            _state.Save();
            FleetHint.Text = result.Ok ? "Живой: " + result.Note : "Не отвечает: " + result.Note;
        }
        catch (Exception ex) { FleetHint.Text = "Проверка не удалась: " + ex.Message; }
        finally { _jobRequests.Remove(job.Id); RenderFleet(); }
    }
    private void BtnBlockReason(object s, RoutedEventArgs e)
    {
        if (SelectedJob is not { } job) return;
        var probe = Liveness.Parse(job.Locker);
        var dialog = new BlockReasonWindow(job, probe, job.LivenessAt > 0 && job.LivenessOk) { Owner = this };
        if (dialog.ShowDialog() != true) return;
        job.BlockReason = dialog.ReasonKey; job.BlockSince = Now;
        job.Summary = BlockReasons.Label(dialog.ReasonKey) + ": " + dialog.Fact;
        _state.AddLog("block", job.Title + " — " + BlockReasons.Label(dialog.ReasonKey) + ": " + dialog.Fact);
        _state.Save(); RenderFleet();
    }
    private void BtnClearBlockReason(object s, RoutedEventArgs e)
    {
        if (SelectedJob is not { } job) return;
        job.BlockReason = ""; job.BlockSince = 0; _state.Save(); RenderFleet();
        FleetHint.Text = "Причина снята. Карточка снова попадёт в очередь, когда молчание превысит интервал.";
    }
    private void BtnCopyJob(object s, RoutedEventArgs e) { if (SelectedJob is { } j) { try { Clipboard.SetText(j.Prompt); FleetHint.Text = "Поручение скопировано."; } catch { FleetHint.Text = "Буфер обмена занят."; } } }
    private void BtnOpenLocker(object s, RoutedEventArgs e)
    {
        if (SelectedJob is not { } j) return;
        try
        {
            if (Uri.TryCreate(j.Locker, UriKind.Absolute, out var uri) && uri.Scheme is "https" or "http") Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
            else if (j.Locker.Length > 0) { Clipboard.SetText(j.Locker); FleetHint.Text = "Название локера скопировано."; }
            else FleetHint.Text = "Локер не задан. Поручение доступно в этой карточке.";
        }
        catch (Exception ex) { FleetHint.Text = ex.Message; }
    }
    private void MaybeAlert()
    {
        if (_alertOpen || _state.WorkUntil > Now) return;
        var due = _state.FleetJobs.Where(j => FleetRules.Attention(j, Now, _state.Settings.AgentStaleMinutes * 60) && j.AlertAfter <= Now).ToList();
        if (due.Count == 0 || !_state.Settings.AskWhatDoing) return;
        _alertOpen = true;
        foreach (var j in due) j.AlertAfter = Now + 300;
        _state.Save();
        try
        {
            if (_state.Settings.SoundEnabled) Sound.PlayFocusUp();
            var window = new Window { Title = "PulsePilot — очередь решений", Owner = this, WindowStyle = WindowStyle.None,
                WindowState = WindowState.Maximized, Topmost = true, Background = (Brush)FindResource("Bg") };
            var stack = new StackPanel { Margin = new Thickness(32), MaxWidth = 740 };
            stack.Children.Add(Text($"{due.Count} событий требуют твоего решения", 30));
            stack.Children.Add(Text("Остальные агенты продолжают работать. Выбери событие для разбора.", 16, "FgDim"));
            foreach (var job in due.Take(7)) stack.Children.Add(ActionButton((_tree.ById(job.ProjectId)?.Title ?? "") + " · " + FleetRules.StatusName(job), () => { SelectJob(job.Id); window.Close(); }));
            stack.Children.Add(ActionButton("Вернуться к работе · напомнить через 5 мин", () => window.Close()));
            window.KeyDown += (_, e) => { if (e.Key == System.Windows.Input.Key.Escape) window.Close(); };
            window.Content = new ScrollViewer { Content = stack, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            window.ShowDialog();
        }
        finally { _alertOpen = false; }
    }
}
