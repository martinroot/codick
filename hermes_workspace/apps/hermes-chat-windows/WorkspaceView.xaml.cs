using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;

namespace HermesChat;
public partial class WorkspaceView : UserControl
{
    private Store _store = null!;
    private WorkspaceCoordinator _coordinator = null!;
    private Action<string> _openConversation = null!;
    private Action<WorkspaceIteration> _openRun = null!;
    private int _refreshSeconds;
    private Action<string> _open = null!;
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(1) };
    private readonly List<Action<long>> _ticks = new();
    public WorkspaceView() { InitializeComponent(); _timer.Tick += (_,_) => Tick(); }
    public void Init(Store store, WorkspaceCoordinator coordinator, Action<string> open, Action<WorkspaceIteration> openRun, Action<string> openConversation)
    { _store = store; _coordinator = coordinator; _open = open; _openRun = openRun; _openConversation = openConversation; _timer.Start(); Refresh(); }
    private Brush Brush(string name) => (Brush)FindResource(name);
    private TextBlock Text(string value, double size = 13, string color = "Fg", bool wrap = true) => new() { Text = value, FontSize = size, Foreground = Brush(color), TextWrapping = wrap ? TextWrapping.Wrap : TextWrapping.NoWrap, Margin = new Thickness(0,0,0,8) };
    private Border Card(StackPanel content) => new() { Child = content, Background = Brush("Panel"), BorderBrush = Brush("Line"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(12), Padding = new Thickness(18), Margin = new Thickness(0,0,12,12) };
    private Button Button(string title, Action action)
    {
        var button = new Button { Content = title, Style = (Style)FindResource("Btn"), Margin = new Thickness(0,4,6,0) };
        button.Click += (_,_) => { try { action(); } catch (Exception error) { MessageBox.Show(error.Message, "HermesWorkspace"); } };
        return button;
    }
    public void Refresh()
    {
        if (_store is null) return;
        _ticks.Clear(); ProjectsPanel.Children.Clear(); ActivityPanel.Children.Clear();
        var projects = _store.Profiles.Where(p => p.IsBound).ToList();
        var jobs = _store.Iterations;
        Summary.Text = $"{projects.Count} проектов    /    {jobs.Count(j => j.Busy)} выполняются    /    {jobs.Count(j => j.Status == "approval")} ждут аппрува    /    {jobs.Count(j => j.Status == "done")} итераций принято";
        foreach (var profile in projects)
        {
            var current = jobs.Where(j => j.ProfileId == profile.Id).OrderByDescending(j => j.CreatedAt).FirstOrDefault();
            var content = new StackPanel { Width = 270 };
            content.Children.Add(Text(profile.Name, 17));
            content.Children.Add(Text(current?.StatusText ?? "Готов к работе", 12, current?.Busy == true ? "Accent" : "Dim"));
            content.Children.Add(Text(current?.Title ?? $"В дереве: {TreeBriefs.TodoCount(profile.ProjectId)} TODO"));
            var gateway = _store.Gateways.FirstOrDefault(g => g.Id == _store.ProjectGateways.GetValueOrDefault(profile.Id));
            content.Children.Add(Text(gateway?.Name ?? "Шлюз не назначен", 12, "Dim"));
            var timer = Text("", 12, "Accent"); content.Children.Add(timer);
            if (current is { Busy: true }) _ticks.Add(now => timer.Text = $"В работе {TimeSpan.FromSeconds(Math.Max(0, now - current.StartedAt)):hh\\:mm\\:ss} · напоминание через {Math.Max(0, current.NextCheckAt - now)} с");
            content.Children.Add(Button("Открыть проект →", () => _open(profile.Id)));
            var binding = _store.ChatBindings.GetValueOrDefault(profile.Id);
            if (binding is not null)
            {
                content.Children.Add(Button("Чат оркестратора", () => _openConversation(binding.OrchestratorThreadId)));
                content.Children.Add(Button("Чат исполнителя", () => _openConversation(binding.ExecutorThreadId)));
                var turns = _store.Threads.Where(t => t.Id == binding.OrchestratorThreadId || t.Id == binding.ExecutorThreadId)
                    .SelectMany(t => t.Messages).Where(m => m.IsAgent && m.Status == "ok").ToList();
                var priced = turns.Where(m => m.CostUsd.HasValue).ToList();
                content.Children.Add(Text(priced.Count == 0 ? "Расход модели: нет данных шлюза" :
                    $"Учтённый расход модели: ${priced.Sum(m => m.CostUsd!.Value):0.0000}" + (priced.Count < turns.Count ? " · часть ответов без цены" : ""), 12, "Dim"));
            }
            content.Children.Add(Button("Следующая итерация", () => _coordinator.Propose(profile)));

            // START / STOP. Кнопка одна, но состояние важно: показываем именно
            // то, что сейчас делает цикл, иначе «STOP» на остановленном цикле
            // выглядит как кнопка, которая ничего не делает.
            var looping = _coordinator.IsLooping(profile.Id);
            var loopState = Text("Цикл: " + _coordinator.LoopState(profile.Id), 12, looping ? "Accent" : "Dim");
            content.Children.Add(loopState);
            if (looping) _ticks.Add(_ => loopState.Text = "Цикл: " + _coordinator.LoopState(profile.Id));
            var loop = Button(looping ? "STOP цикла" : "START цикла", () => { });
            loop.Style = (Style)FindResource(looping ? "Btn" : "PrimaryBtn");
            loop.Click += (_, _) =>
            {
                try
                {
                    if (_coordinator.IsLooping(profile.Id)) _coordinator.StopLoop(profile.Id);
                    else _coordinator.StartLoop(profile);
                }
                catch (Exception error) { MessageBox.Show(error.Message, "HermesWorkspace"); }
                Refresh();
            };
            content.Children.Add(loop);
            ProjectsPanel.Children.Add(Card(content));
        }
        foreach (var job in jobs.Where(j => j.Status is "approval" or "running" or "reviewing" or "review" or "interrupted" or "failed" or "owner").OrderByDescending(j => j.CreatedAt))
        {
            var content = new StackPanel();
            content.Children.Add(Text(job.StatusText.ToUpperInvariant(), 11, job.Busy ? "Accent" : "Warn"));
            content.Children.Add(Text(job.Title, 16)); content.Children.Add(Text(job.Note, 12, "Dim"));
            // Комментарий оркестратора — это то, что владелец читает по ходу
            // работы, поэтому он виден сразу, а не внутри «Результата и оценки».
            if (job.Commentary.Length > 0)
                content.Children.Add(Text("Оркестратор: " + job.Commentary, 12, "Accent", wrap: true));
            if (job.OwnerQuestion.Length > 0)
            {
                content.Children.Add(Text("Нужен ответ владельца: " + job.OwnerQuestion, 12, "Warn", wrap: true));
                var ownerChat = _store.ChatBindings.GetValueOrDefault(job.ProfileId)?.OrchestratorThreadId;
                if (!string.IsNullOrWhiteSpace(ownerChat)) content.Children.Add(Button("Ответить оркестратору", () => _openConversation(ownerChat)));
            }
            if (job.Result.Length > 0)
            { var expander = new Expander { Header = "Результат и оценка", Foreground = Brush("Fg"), Content = new TextBox { Text = job.Result + "\n\n" + job.Review, IsReadOnly = true, TextWrapping = TextWrapping.Wrap, MaxHeight = 300, VerticalScrollBarVisibility = ScrollBarVisibility.Auto } }; content.Children.Add(expander); }
            var actions = new WrapPanel();
            if (job.Status == "approval")
            {
                var approve = Button("Одобрить запуск", () => { });
                approve.Click += async (_,_) => { approve.IsEnabled = false; try { await _coordinator.ApproveAsync(job); } catch (Exception error) { MessageBox.Show(error.Message, "HermesWorkspace"); } finally { Refresh(); } };
                actions.Children.Add(approve);
            }
            if (job.Busy)
            {
                actions.Children.Add(Button("Открыть выполнение", () => _openRun(job)));
                actions.Children.Add(Button("Остановить", () => _coordinator.Stop(job)));
            }
            else
            {
                if (job.Status == "review") actions.Children.Add(Button("Принять результат", () => _coordinator.AcceptResult(job)));
                actions.Children.Add(Button("Отклонить / снять", () => _coordinator.Reject(job)));
            }
            content.Children.Add(actions); ActivityPanel.Children.Add(Card(content));
        }
        foreach (var thread in _store.Threads.Where(t => t.Messages.Any(m => m.Status == "running" || m.WaitingApproval || m.WaitingClarification)))
        { var content = new StackPanel(); content.Children.Add(Text(thread.Title, 16)); content.Children.Add(Text((thread.Messages.Any(m => m.WaitingApproval || m.WaitingClarification) ? "НУЖЕН ОТВЕТ · " : "Активный чат · ") + thread.Place, 12, "Accent")); content.Children.Add(Button("Открыть диалог", () => _openConversation(thread.Id))); ActivityPanel.Children.Add(Card(content)); }
        if (ActivityPanel.Children.Count == 0) ActivityPanel.Children.Add(Text("Активных запусков и ожидающих решений нет.", 14, "Dim"));
        Tick();
    }
    private void Tick()
    {
        if (_store is not null) _coordinator.CheckTimers();
        Clock.Text = DateTime.Now.ToString("HH:mm:ss");
        var now = DateTimeOffset.Now.ToUnixTimeSeconds();
        foreach (var tick in _ticks.ToList()) tick(now);
        if (++_refreshSeconds >= 5 && IsVisible) { _refreshSeconds = 0; Refresh(); }
    }
}
