using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;

namespace PulsePilot;

public partial class MainWindow : Window
{
    private readonly StateStore _state = StateStore.Load();
    private ApiClient? _api;
    private Tree _tree = new();
    private readonly LlmClient _llm = new();
    private readonly AgentAdapter _adapter = new();
    private readonly ActivityTracker _act = new();
    private readonly DispatcherTimer _poll = new() { Interval = TimeSpan.FromSeconds(20) };
    private string _projectFilter = "", _selNode = "", _selProject = "", _jobId = "";
    private bool _polling, _mutating, _chatBusy, _alertOpen, _renderingNote;
    private readonly HashSet<string> _jobRequests = new();
    private static long Now => DateTimeOffset.Now.ToUnixTimeSeconds();
    private FleetJob? SelectedJob => _state.FleetJobs.FirstOrDefault(j => j.Id == _jobId);

    public MainWindow()
    {
        InitializeComponent();
        SlotsBox.ItemsSource = new[] { 3, 4, 7 };
        SlotsBox.SelectedItem = _state.Settings.ParallelSlots is 3 or 4 or 7 ? _state.Settings.ParallelSlots : 7;
        JobNote.TextChanged += (_, _) => { if (!_renderingNote && SelectedJob is { } job) { job.Note = JobNote.Text; _state.Save(); } };
        Loaded += async (_, _) =>
        {
            LogList.ItemsSource = _state.Log;
            foreach (var msg in _state.Chat) ChatUi.Add(ChatPanel, msg, ChatScroll);
            _act.Tick += () => ActivityText.Text = _act.HumanToday();
            _act.Enabled = _state.Settings.TrackActivity;
            if (_act.Enabled) _act.Start();
            await BootAsync();
        };
        _poll.Tick += async (_, _) => await PollAsync();
        Closing += (_, _) => { _poll.Stop(); _state.Save(); _act.Stop(); _act.SaveDay(); };
    }
    private async Task BootAsync()
    {
        LoadSnapshot();
        if (string.IsNullOrWhiteSpace(_state.Settings.ApiKey))
        {
            var settings = new SettingsWindow(_state) { Owner = this };
            if (settings.ShowDialog() != true) { StatusText.Text = "Снимок дерева · подключение не настроено"; _poll.Start(); return; }
        }
        _api = new ApiClient(_state.Settings.ApiUrl, _state.Settings.ApiKey);
        _poll.Interval = TimeSpan.FromSeconds(Math.Max(5, _state.Settings.PollSeconds));
        await RefreshAsync(); _poll.Start();
    }
    private void LoadSnapshot()
    {
        try
        {
            var path = Path.Combine(AppContext.BaseDirectory, "tree-snapshot.json");
            if (File.Exists(path)) _tree = JsonSerializer.Deserialize<Tree>(File.ReadAllText(path)) ?? new Tree();
            var briefs = Path.Combine(AppContext.BaseDirectory, "project-briefs.json");
            if (File.Exists(briefs))
                foreach (var pair in JsonSerializer.Deserialize<Dictionary<string, ProjectBrief>>(File.ReadAllText(briefs)) ?? new())
                    _state.ProjectBriefs.TryAdd(pair.Key, pair.Value);
            _state.Tree = _tree; MigrateLegacy(); Render();
            StatusText.Text = "Снимок дерева · статусы агентов ещё не проверены";
        }
        catch (Exception ex) { StatusText.Text = "Ошибка снимка: " + ex.Message; }
    }
    private void MigrateLegacy()
    {
        if (_state.LegacyFleetMigrated) return;
        var steps = _state.WaitingSteps.Values.ToList();
        if (_state.CurrentStep is { Phase: "active" or "review" } step) steps.Add(step);
        foreach (var old in steps.GroupBy(s => s.NodeId).Select(g => g.First()))
            if (!_state.FleetJobs.Any(j => j.NodeId == old.NodeId))
                _state.FleetJobs.Add(new FleetJob { NodeId = old.NodeId, ProjectId = old.ProjectId, Title = _tree.NodeById(old.NodeId)?.Title ?? old.NodeId,
                    Prompt = old.Prompt, Note = old.ResultDraft, Locker = _state.Lockers.GetValueOrDefault(old.NodeId) ?? "",
                    Resource = "project:" + old.ProjectId, Status = "unknown", Summary = "Перенесено из прежней версии. Проверь агент в локере." });
        _state.CurrentStep = null; _state.WaitingSteps.Clear();
        _state.LegacyFleetMigrated = true; _state.Save();
    }
    private async Task RefreshAsync()
    {
        if (_api == null) return;
        try
        {
            var incoming = await _api.GetTreeAsync();
            var changed = incoming.Version != _tree.Version || incoming.Steps != _tree.Steps;
            _tree = incoming; _state.Tree = _tree;
            if (changed) Render(); else RenderFleet();
            StatusText.Text = $"Дерево синхронизировано · {DateTime.Now:HH:mm:ss}";
        }
        catch (Exception ex) { StatusText.Text = "Дерево не обновлено: " + ex.Message; }
    }
    private async Task PollAsync()
    {
        if (_polling) return; _polling = true;
        try
        {
            var checks = _state.FleetJobs.Where(j => j.Source == "api" && j.RemoteId.Length > 0 && (FleetRules.Busy(j) || j.Status == "failed"))
                .ToList().Select(CheckJob).ToList();
            checks.Add(RefreshAsync());
            checks.Add(PollLiveness());
            await Task.WhenAll(checks);
            RenderFleet(); MaybeAlert();
        }
        finally { _polling = false; }
    }
    /// <summary>Проверяем локеры только у ручных запусков, у Bridge это уже делает опрос агента.</summary>
    private async Task PollLiveness()
    {
        var stale = _state.Settings.AgentStaleMinutes * 60;
        foreach (var job in _state.FleetJobs.Where(j => j.Source == "manual" && (FleetRules.Busy(j) || j.Status is "prepared" or "review")
            && Now >= j.LivenessAt + stale && _jobRequests.Add(j.Id)).ToList())
        {
            try
            {
                var probe = Liveness.Parse(job.Locker);
                var wasOk = job.LivenessOk;
                job.LivenessAt = Now;
                if (!probe.Verifiable) { job.LivenessNote = probe.Describe(); continue; }
                var result = await Liveness.RunAsync(probe);
                job.LivenessOk = result.Ok; job.LivenessNote = result.Note;
                if (!result.Ok && wasOk)
                {
                    job.Summary = "Проверка локера не прошла: " + result.Note;
                    _state.AddLog("liveness", job.Title + ": " + result.Note);
                }
                _state.Save();
            }
            finally { _jobRequests.Remove(job.Id); }
        }
    }
    private void Render()
    {
        Tree.Items.Clear();
        foreach (var p in _tree.Projects.Where(p => _projectFilter.Length == 0 || p.Id == _projectFilter).OrderBy(p => p.SortOrder))
        {
            var parent = new TreeViewItem { Header = p.Title, Tag = "p:" + p.Id, IsExpanded = _projectFilter.Length > 0 };
            foreach (var lane in new[] { "todo", "wiki" })
            {
                var group = new TreeViewItem { Header = lane == "todo" ? "TODO · действия" : "Wiki · контекст и ограничения", IsExpanded = lane == "todo" && _projectFilter.Length > 0 };
                foreach (var n in p.Nodes.Where(n => n.Lane == lane).OrderBy(n => n.Done).ThenBy(n => n.SortOrder))
                    group.Items.Add(new TreeViewItem { Header = new TextBlock { Text = (n.Done == 1 ? "✓ " : "") + n.Title, TextWrapping = TextWrapping.Wrap, MaxWidth = 820,
                        Foreground = (Brush)FindResource(n.Done == 1 || lane == "wiki" ? "FgDim" : "Fg") }, Tag = "n:" + n.Id, ToolTip = n.Body });
                parent.Items.Add(group);
            }
            Tree.Items.Add(parent);
        }
        ModelText.Text = "Советник: " + _state.Settings.LlmModel + " · видит проекты, ограничения и статусы запусков";
        VerText.Text = $"v{_tree.Version} · {_tree.Projects.Count} направлений";
        RenderFleet();
    }
    private void TreeSelectionChanged(object sender, RoutedPropertyChangedEventArgs<object> e)
    {
        if (e.NewValue is not TreeViewItem { Tag: string tag }) return;
        _selNode = tag.StartsWith("n:") ? tag[2..] : "";
        _selProject = tag.StartsWith("p:") ? tag[2..] : _tree.ProjectOfNode(_selNode)?.Id ?? "";
    }
    private async void BtnRefresh(object s, RoutedEventArgs e) { await RefreshAsync(); await PollAgentOnly(); }
    private async Task PollAgentOnly() { await Task.WhenAll(_state.FleetJobs.Where(j => j.Source == "api" && j.RemoteId.Length > 0 && FleetRules.Busy(j)).ToList().Select(CheckJob)); RenderFleet(); }
    private void BtnAllProjects(object s, RoutedEventArgs e) { _projectFilter = ""; Render(); }
    private void SlotsChanged(object s, SelectionChangedEventArgs e) { if (SlotsBox.SelectedItem is int count) { _state.Settings.ParallelSlots = count; _state.Save(); if (IsLoaded) RenderFleet(); } }
    private void BtnWork(object s, RoutedEventArgs e) { _state.WorkUntil = _state.WorkUntil > Now ? 0 : Now + 1800; _state.Save(); RenderFleet(); }
    private void BtnSettings(object s, RoutedEventArgs e)
    {
        if (new SettingsWindow(_state) { Owner = this }.ShowDialog() != true) return;
        _api = new ApiClient(_state.Settings.ApiUrl, _state.Settings.ApiKey);
        _poll.Interval = TimeSpan.FromSeconds(Math.Max(5, _state.Settings.PollSeconds));
        _act.Enabled = _state.Settings.TrackActivity; if (_act.Enabled) _act.Start(); else _act.Stop();
        _ = RefreshAsync();
    }
    private void BtnAgentSettings(object s, RoutedEventArgs e)
    {
        var dialog = new AgentSettingsWindow(_state) { Owner = this };
        if (dialog.ShowDialog() == true) RenderFleet();
    }
    private async Task Mutate(string action, Dictionary<string, object?> data)
    {
        if (_api == null) { FleetHint.Text = "Подключи API дерева в настройках."; return; }
        if (_mutating) return; _mutating = true;
        try { await _api.PostAsync(action, data); await RefreshAsync(); }
        catch (Exception ex) { FleetHint.Text = "Не сохранено: " + ex.Message; }
        finally { _mutating = false; }
    }
    private async void BtnAddProject(object s, RoutedEventArgs e)
    {
        var dialog = new TextInputWindow("Направление", "Название", "") { Owner = this };
        if (dialog.ShowDialog() == true && dialog.Value.Trim().Length > 0) await Mutate("add_project", new() { ["title"] = dialog.Value.Trim() });
    }
    private async void BtnAddNode(object s, RoutedEventArgs e)
    {
        if (_selProject.Length == 0) { FleetHint.Text = "Выбери направление в дереве."; return; }
        var dialog = new TextInputWindow("TODO", "Конкретное действие", "") { Owner = this };
        if (dialog.ShowDialog() == true && dialog.Value.Trim().Length > 0) await Mutate("add_node", new() { ["project_id"] = _selProject, ["title"] = dialog.Value.Trim(), ["lane"] = "todo" });
    }
    private async void BtnEdit(object s, RoutedEventArgs e)
    {
        var node = _tree.NodeById(_selNode); if (node == null) return;
        var dialog = new TextInputWindow("Изменить TODO", "Название", node.Title) { Owner = this };
        if (dialog.ShowDialog() == true && dialog.Value.Trim().Length > 0) await Mutate("edit_node", new() { ["id"] = node.Id, ["title"] = dialog.Value.Trim() });
    }
    private async void BtnToggle(object s, RoutedEventArgs e) { if (_selNode.Length > 0) await Mutate("toggle", new() { ["id"] = _selNode }); }
    private void BtnShowNode(object s, RoutedEventArgs e)
    {
        var node = _tree.NodeById(_selNode); if (node == null) return;
        var dialog = new TextInputWindow("Текст узла", node.Title, node.Body) { Owner = this }; dialog.ShowDialog();
    }
    private void BtnMoreChat(object sender, RoutedEventArgs e) { if (sender is Button { ContextMenu: { } menu } b) { menu.PlacementTarget = b; menu.IsOpen = true; } }
    private void ChatInputKeyDown(object s, KeyEventArgs e) { if (e.Key == Key.Enter && Keyboard.Modifiers.HasFlag(ModifierKeys.Control)) { e.Handled = true; BtnChatSend(s, e); } }
    private async void BtnChatSend(object s, RoutedEventArgs e)
    {
        var text = ChatInput.Text.Trim(); if (_chatBusy || text.Length == 0) return;
        _chatBusy = true; ChatSend.IsEnabled = false; ChatStatus.Text = "Разбираю…";
        try
        {
            _state.AddChat("user", text); ChatUi.Add(ChatPanel, _state.Chat[^1], ChatScroll); ChatInput.Clear();
            var prompt = "Ты — диспетчер 3–7 параллельных проектов. Один человек принимает решения, агенты исполняют одновременно. " +
                "Не требуй завершить один проект перед переключением. TODO — работа, Wiki — контекст. Держи денежные цели, реальные факты и ворота масштаба отдельно. " +
                "Опирайся на заданные ограничения проекта; не выдумывай статусы и интеграции. Предлагай один следующий управляющий шаг, до 8 коротких строк. " +
                "Дерево:\n" + Planner.BuildContext(_tree, _state, "", _act) + "\nРеальные карточки запуска:\n" +
                string.Join("\n", _state.FleetJobs.Select(j => $"{j.Title}: {FleetRules.StatusName(j)}; {j.Summary}; вопрос {j.Question}"));
            var messages = new List<(string, string)> { ("system", prompt) };
            messages.AddRange(_state.Chat.TakeLast(8).Select(m => (m.Role, m.Text)));
            var answer = await _llm.AskAsync(_state.Settings, messages);
            _state.AddChat("assistant", answer); ChatUi.Add(ChatPanel, _state.Chat[^1], ChatScroll); ChatStatus.Text = "";
        }
        catch (Exception ex) { ChatStatus.Text = "Модель не ответила: " + ex.Message; }
        finally { _chatBusy = false; ChatSend.IsEnabled = true; }
    }
}
