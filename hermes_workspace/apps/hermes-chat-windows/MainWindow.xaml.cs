using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace HermesChat;

/// <summary>
/// Оболочка приложения: разделы поверх одного общего состояния.
/// Чаты, профили оркестраторов, внешние шлюзы и разговоры шлюза читают и
/// пишут один store, поэтому диалог может быть привязан к профилю, шлюз —
/// к профилю же, а разговор — к существующей сессии шлюза.
/// </summary>
public partial class MainWindow : Window
{
    private readonly Store _store = new();
    private readonly System.Windows.Threading.DispatcherTimer _activityTimer = new() { Interval = TimeSpan.FromSeconds(1) };
    private string _approvalSignature = "";
    private WorkspaceCoordinator Coordinator = null!;
    private readonly Dictionary<string, ChatsTab> _workers = new();
    private string _current = "";

    public MainWindow()
    {
        InitializeComponent();
        _store.Load();
        WorkspaceMigration.Import(_store);
        _store.RefreshProfiles();

        Chats.State = _store;
        Profiles.State = _store;
        Gateways.State = _store;
        Sessions.State = _store;
        Profiles.RequestThread += OpenThreadWithProfile;
        Profiles.RequestConversation += OpenConversation;
        Profiles.RequestTest += (profile,test) => { Show("chats"); Chats.StartTraining(profile,test); };
        // Шлюз в оболочке и диалог в списке — одна сущность с двух сторон.
        Gateways.RequestThreadWithGateway += OpenThreadWithGateway;
        // Переезд в шлюз: подхватываем сессию и открываем её диалог.
        Sessions.RequestThread += AdoptSessionAsync;

        Coordinator = new WorkspaceCoordinator(_store, ExecuteIterationAsync);
        Coordinator.ValidateRoutes = profile => new WorkspaceChatRelay(_store).Resolve(profile, null);
        Chats.Coordinator = Coordinator;
        Chats.HumanReplyCompleted = OnHumanReplyAsync;
        Chats.RouteThread = id => RouteBoundThread(id, "");
        Overview.Init(_store, Coordinator, id => { Show("chats"); Chats.OpenWithProfile(id); }, OpenWorker, OpenConversation);
        Coordinator.Changed += RefreshWorkspace;
        Chats.Init();
        Profiles.Load();
        Gateways.Load();
        Show("chats");
        _activityTimer.Tick += (_,_) =>
        {
            Chats.RefreshStoredConversation();
            foreach (var runner in _workers.Values.Where(w => w.Visibility == Visibility.Visible)) runner.RefreshStoredConversation();
            var signature = string.Join("|", _store.Threads.SelectMany(t => t.Messages).Where(m => m.WaitingApproval || m.WaitingClarification).Select(m => m.Id));
            if (signature != _approvalSignature) { _approvalSignature = signature; RefreshWorkspace(); }
        };
        _activityTimer.Start();
        RefreshWorkspace();
    }

    private void OnTabClick(object sender, RoutedEventArgs e)
    {
        if (sender is Button button && button.Tag is string tag) Show(tag);
    }

    private void Show(string tag)
    {
        HiddenRunners.Visibility = Visibility.Collapsed;
        _current = tag;
        Overview.Visibility = tag == "workspace" ? Visibility.Visible : Visibility.Collapsed;
        Mark(TabWorkspace, tag == "workspace");
        if (tag == "workspace") Overview.Refresh();
        Chats.Visibility = tag == "chats" ? Visibility.Visible : Visibility.Collapsed;
        Profiles.Visibility = tag == "profiles" ? Visibility.Visible : Visibility.Collapsed;
        Gateways.Visibility = tag == "gateways" ? Visibility.Visible : Visibility.Collapsed;
        Sessions.Visibility = tag == "sessions" ? Visibility.Visible : Visibility.Collapsed;
        // Активная вкладка подсвечивается, остальные гаснут — иначе при четырёх
        // одинаковых кнопках непонятно, какой раздел открыт.
        Mark(TabChats, tag == "chats");
        Mark(TabProfiles, tag == "profiles");
        Mark(TabGateways, tag == "gateways");
        Mark(TabSessions, tag == "sessions");
        // Вкладки читают состояние при показе: список мог измениться, пока их не было видно.
        if (tag == "profiles") Profiles.Load();
        if (tag == "gateways") Gateways.Load();
        if (tag == "sessions")
        {
            Sessions.FillGateways();
            Sessions.Resume();
            _ = Sessions.LoadAsync();
        }
        Chats.RefreshThreadGroups();
    }

    private static void Mark(Button button, bool active) =>
        button.Background = (Brush)Application.Current.FindResource(active ? "PanelHi" : "Panel");

    /// <summary>Перейти в диалог с внешним агентом и показать список диалогов:
    /// там он лежит в группе «Внешние шлюзы», рядом с остальными чатами.</summary>
    private void OpenThreadWithGateway(string gatewayId)
    {
        Show("chats");
        Chats.OpenWithGateway(gatewayId);
    }

    /// <summary>Открыть диалог с выбранным профилем — из вкладки профилей.</summary>
    private void OpenThreadWithProfile(string profileId)
    {
        Show("chats");
        Chats.OpenWithProfile(profileId);
    }

    /// <summary>
    /// Подхватить разговор шлюза: его история становится диалогом, а отправка
    /// продолжает ту же сессию. Это «переехать в шлюз»: консольный разговор
    /// виден в приложении целиком и остаётся единым, а не копией с обрезанным
    /// началом.
    /// </summary>
    private async Task AdoptSessionAsync(RemoteSession session)
        {
            try
            {
                // Сессия принадлежит конкретной машине: id одинаков на разных
                // шлюзах, поэтому в диалог едет вместе с ней и адрес.
                var gatewayId = Sessions.GatewayId;
                await Chats.OpenRemoteSessionAsync(session, gatewayId.Length > 0 ? gatewayId : null,
                    CancellationToken.None);
                Show("chats");
            }
        catch (Exception error)
        {
            CrashLog.Write("Переезд в сессию: " + error);
            MessageBox.Show("Не удалось подхватить разговор: " + error.Message,
                "HermesChat", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private async Task<string> ExecuteIterationAsync(Profile profile, Gateway? gateway, string prompt, CancellationToken token)
    {
        if (!Dispatcher.CheckAccess())
            return await Dispatcher.InvokeAsync(() => ExecuteIterationAsync(profile, gateway, prompt, token)).Task.Unwrap();
        token.ThrowIfCancellationRequested();
        var thread = new WorkspaceChatRelay(_store).Resolve(profile, gateway);
        var worker = RunnerFor(thread);
        worker.OpenStoredThread(thread.Id);
        return await worker.RunWorkspaceAsync(prompt, token);
    }

    private ChatsTab RunnerFor(ChatThread thread)
    {
        if (_workers.TryGetValue(thread.Id, out var existing)) return existing;
        Chats.ReleaseIdleSession(thread.Id);
        foreach (var previous in _workers.Values) previous.ReleaseIdleSession(thread.Id);
        var worker = new ChatsTab { State = _store, Coordinator = Coordinator, HumanReplyCompleted = OnHumanReplyAsync };
        HiddenRunners.Children.Add(worker); worker.Init(); worker.Visibility = Visibility.Collapsed;
        _workers[thread.Id] = worker;
        worker.RouteThread = id => RouteBoundThread(id, thread.Id);
        return worker;
    }

    private bool RouteBoundThread(string id, string ownedId)
    {
        if (id == ownedId) return false;
        if (!_workers.ContainsKey(id) && !_store.ChatBindings.Values.Any(b => b.OrchestratorThreadId == id || b.ExecutorThreadId == id)) return false;
        OpenConversation(id); return true;
    }

    private async Task OnHumanReplyAsync(ChatThread thread, string answer)
    {
        var profile = _store.Profiles.FirstOrDefault(p =>
            _store.ChatBindings.GetValueOrDefault(p.Id)?.OrchestratorThreadId == thread.Id);
        if (profile is null) return;
        try { await Coordinator.ApplyConversationAsync(profile, answer); }
        catch (Exception error) { MessageBox.Show(error.Message, "Оркестратор · правки не применены"); }
    }

    private void OpenWorker(WorkspaceIteration job)
    {
        var binding = _store.ChatBindings.GetValueOrDefault(job.ProfileId);
        var id = job.Status is "reviewing" or "owner" ? binding?.OrchestratorThreadId : binding?.ExecutorThreadId;
        if (!string.IsNullOrWhiteSpace(id)) OpenConversation(id);
    }

    private void OpenConversation(string threadId)
    {
        var worker = _workers.Values.FirstOrDefault(w => w.CurrentWorkspaceThreadId == threadId);
        if (worker is null && _store.ChatBindings.Values.Any(b => b.OrchestratorThreadId == threadId || b.ExecutorThreadId == threadId))
        {
            var thread = _store.Threads.FirstOrDefault(t => t.Id == threadId);
            if (thread is not null) { worker = RunnerFor(thread); worker.OpenStoredThread(threadId); }
        }
        if (worker is null) { Show("chats"); Chats.OpenStoredThread(threadId); return; }
        Show("run"); HiddenRunners.Visibility = Visibility.Visible;
        foreach (var item in _workers.Values) item.Visibility = ReferenceEquals(worker, item) ? Visibility.Visible : Visibility.Collapsed;
    }
    private void RefreshWorkspace()
    {
        if (!Dispatcher.CheckAccess()) { Dispatcher.BeginInvoke(new Action(RefreshWorkspace)); return; }
        Overview.Refresh(); Chats.RefreshThreadGroups(); Chats.RefreshLoopState();
        Chats.RefreshStoredConversation();
        foreach (var runner in _workers.Values) runner.RefreshStoredConversation();
        var pending = _store.Iterations.Where(i => i.Status == "approval").ToList();
        var waiting = _store.Threads.Where(t => t.Messages.Any(m => m.WaitingApproval || m.WaitingClarification)).ToList();
        ApprovalToast.Visibility = pending.Count + waiting.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        ApprovalText.Text = waiting.Count > 0 ? $"Агент ждёт ответа: {waiting.Last().Title}\nОткрой выполнение в Workspace." : pending.Count == 0 ? "" : $"Ожидают решения: {pending.Count}\n{pending.Last().Title}\n{pending.Last().Note}";
    }
    private void OnOpenApprovals(object sender, RoutedEventArgs e) { Show("workspace"); ApprovalToast.Visibility = Visibility.Collapsed; }
    private void OnDismissToast(object sender, RoutedEventArgs e) => ApprovalToast.Visibility = Visibility.Collapsed;

    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        _activityTimer.Stop();
        Coordinator.Shutdown();
        _store.Save();
        base.OnClosing(e);
    }
}