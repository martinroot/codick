using System.Windows;
using System.Windows.Controls;

namespace HermesChat;
public partial class ChatsTab
{
    public Func<string, bool>? RouteThread { get; set; }
    private string _storedSignature = "";
    public Func<ChatThread, string, Task>? HumanReplyCompleted { get; set; }
    public void RefreshStoredConversation()
    {
        if (_thread is null || !IsVisible) return;
        // Идущий ответ открытого диалога рисует Apply(): полная перерисовка
        // раз в секунду конкурировала бы с потоком токенов и дёргала ленту.
        if (CurrentRun is { Busy: true }) return;
        var last = _thread.Messages.LastOrDefault();
        var signature = $"{_thread.Id}:{_thread.Messages.Count}:{last?.Status}:{last?.Text.Length}:{last?.Streaming.Length}";
        if (signature == _storedSignature) return;
        _storedSignature = signature; Render(); UpdateStats();
    }
    public void ReleaseIdleSession(string threadId)
    {
        // Только когда запуска нет: идущий ответ держит своё соединение, и
        // освобождение оборвало бы стрим на полуслове.
        if (!_runs.IsBusy(threadId) && _runs[threadId] is { } idle) idle.StopTransport();
        _runs.End(threadId);
        StopApprovalWatch(threadId);
    }

    public string CurrentWorkspaceThreadId => _thread?.Id ?? "";
    public void OpenStoredThread(string id) { var thread = _store.Threads.FirstOrDefault(t => t.Id == id); if (thread is not null) Show(thread); }
    public WorkspaceCoordinator? Coordinator { get; set; }
    private int _projectPage;
    private bool _loadingGateway;
    private void RefreshProjectPages()
    {
        var projects = _store.Profiles.Where(p => p.IsBound).ToList();
        var pages = Math.Max(1, (projects.Count + 9) / 10);
        _projectPage = Math.Clamp(_projectPage, 0, pages - 1);
        var previous = _loadingAddressee; _loadingAddressee = true;
        try { ProfileList.ItemsSource = projects.Skip(_projectPage * 10).Take(10).ToList(); ProfileList.SelectedItem = CurrentProfile; }
        finally { _loadingAddressee = previous; }
        ProjectPageText.Text = $"{projects.Count} проектов · {_projectPage + 1}/{pages}";
    }
    private void OnProjectsPrev(object sender, RoutedEventArgs e) { _projectPage = Math.Max(0, _projectPage - 1); RefreshProjectPages(); }
    private void OnProjectsNext(object sender, RoutedEventArgs e) { _projectPage++; RefreshProjectPages(); }
    public void StartTraining(Profile profile, AgentTestCase test)
    {
        NewThread(profile.Id, null);
        _thread!.Title = "Тест · " + profile.Name;
        test.ThreadId = _thread.Id;
        Input.Text = test.Prompt + "\n\nКритерии проверки:\n" + test.Expected;
        WorkspaceTabs.SelectedItem = TabChat; _store.Save(); UpdateHeader();
    }
    private void OnImportTree(object sender, RoutedEventArgs e)
    {
        var dialog = new Microsoft.Win32.OpenFileDialog { Filter = "Дерево JSON|*.json" };
        if (dialog.ShowDialog() != true) return;
        try { WorkspaceMigration.ImportTree(System.IO.File.ReadAllText(dialog.FileName)); _store.RefreshProfiles(); FillProfiles(); RefreshThreadGroups(); RenderWorkspaceSide(); _store.Save(); }
        catch (Exception error) { MessageBox.Show(error.Message, "HermesWorkspace"); }
    }
    private void OnProposeIteration(object sender, RoutedEventArgs e)
    {
        try { if (Coordinator is null || CurrentProfile is null) return; Coordinator.Propose(CurrentProfile); }
        catch (Exception error) { MessageBox.Show(error.Message, "HermesWorkspace"); }
    }
    private void OnProjectGatewayChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_loadingGateway || CurrentProfile is not { IsBound: true } profile || ProjectGatewayBox.SelectedItem is not Gateway gateway) return;
        if (Coordinator?.IsLooping(profile.Id) == true || _store.Iterations.Any(j => j.ProfileId == profile.Id && j.Busy)) return;
        _store.ProjectGateways[profile.Id] = gateway.Id; _store.Save();
        RenderProjectProgress();
    }

    private void OnChatBindingChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_loadingGateway || CurrentProfile is not { IsBound: true } profile) return;
        if (Coordinator?.IsLooping(profile.Id) == true || _store.Iterations.Any(j => j.ProfileId == profile.Id && j.Busy)) return;
        if (!_store.ChatBindings.TryGetValue(profile.Id, out var binding))
            _store.ChatBindings[profile.Id] = binding = new WorkspaceChatBinding();
        if (ReferenceEquals(sender, OrchestratorChatBox)) binding.OrchestratorThreadId = (OrchestratorChatBox.SelectedItem as ChatThread)?.Id ?? "";
        if (ReferenceEquals(sender, ExecutorChatBox)) binding.ExecutorThreadId = (ExecutorChatBox.SelectedItem as ChatThread)?.Id ?? "";
        _store.Save();
    }

    private void OnOpenBoundChat(object sender, RoutedEventArgs e)
    {
        var binding = _store.ChatBindings.GetValueOrDefault(CurrentProfile?.Id ?? "");
        var id = (sender as Button)?.Tag?.ToString() == "executor" ? binding?.ExecutorThreadId : binding?.OrchestratorThreadId;
        if (!string.IsNullOrWhiteSpace(id)) OpenStoredThread(id);
    }

    /// <summary>START / STOP цикла оркестрации. Кнопка стоит здесь, а не только в
    /// Workspace: привязка шлюза к проекту — тоже здесь, и держать обе кнопки в
    /// разных вкладках значило заставлять владельца прыгать туда-обратно.
    /// Состояние подписано прямо на кнопке, иначе непонятно, что нажатие
    /// сделает: остановит или запустит.</summary>
    private void OnToggleLoop(object sender, RoutedEventArgs e)
    {
        var profile = CurrentProfile;
        if (profile is not { IsBound: true } || Coordinator is null) return;
        try
        {
            if (Coordinator.IsLooping(profile.Id)) Coordinator.StopLoop(profile.Id);
            else Coordinator.StartLoop(profile);
        }
        catch (Exception error) { MessageBox.Show(error.Message, "HermesWorkspace"); }
        RefreshLoopState();
    }

    public void RefreshLoopState()
    {
        if (LoopButton is null || LoopStateText is null || Coordinator is null) return;
        var profile = CurrentProfile;
        if (profile is null || !profile.IsBound) { LoopButton.IsEnabled = false; LoopStateText.Text = "Цикл: нет проекта"; return; }
        var looping = Coordinator.IsLooping(profile.Id);
        LoopButton.IsEnabled = true;
        LoopButton.Content = looping ? "STOP цикла" : "START цикла";
        LoopStateText.Text = "Цикл: " + Coordinator.LoopState(profile.Id);
    }
    private void RenderProjectProgress()
    {
        if (ProgressPanel is null || ProjectGatewayBox is null || State is null) return;
        var profile = CurrentProfile;
        _loadingGateway = true;
        ProjectGatewayBox.ItemsSource = _store.Gateways;
        ProjectGatewayBox.SelectedItem = profile is null ? null : _store.Gateways.FirstOrDefault(g => g.Id == _store.ProjectGateways.GetValueOrDefault(profile.Id));
        _loadingGateway = false;
        var binding = profile is null ? null : _store.ChatBindings.GetValueOrDefault(profile.Id);
        _loadingGateway = true;
        OrchestratorChatBox.ItemsSource = _store.Threads.Where(t => t.ProfileId == profile?.Id).ToList();
        OrchestratorChatBox.SelectedItem = _store.Threads.FirstOrDefault(t => t.Id == binding?.OrchestratorThreadId);
        var gatewayId = profile is null ? "" : _store.ProjectGateways.GetValueOrDefault(profile.Id, "");
        ExecutorChatBox.ItemsSource = _store.Threads.Where(t => t.GatewayId == gatewayId && t.Id != binding?.OrchestratorThreadId).ToList();
        ExecutorChatBox.SelectedItem = _store.Threads.FirstOrDefault(t => t.Id == binding?.ExecutorThreadId);
        _loadingGateway = false;
        var editable = profile is not null && Coordinator?.IsLooping(profile.Id) != true && !_store.Iterations.Any(j => j.ProfileId == profile.Id && j.Busy);
        ProjectGatewayBox.IsEnabled = OrchestratorChatBox.IsEnabled = ExecutorChatBox.IsEnabled = editable;
        RefreshLoopState();
        ProgressPanel.Children.Clear();
        var jobs = _store.Iterations.Where(j => j.ProfileId == profile?.Id).OrderByDescending(j => j.CreatedAt).ToList();
        ProgressPanel.Children.Add(new TextBlock { Text = "Прогресс проекта", FontSize = 24, Margin = new Thickness(0,0,0,16) });
        ProgressPanel.Children.Add(new TextBlock { Text = $"Принято итераций: {jobs.Count(j => j.Status == "done")} · всего: {jobs.Count}", Margin = new Thickness(0,0,0,12) });
        foreach (var job in jobs)
        {
            ProgressPanel.Children.Add(new TextBlock { Text = $"{job.StatusText} · {job.Title}", FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0,12,0,4) });
            ProgressPanel.Children.Add(new TextBlock { Text = job.Note + "\n" + job.Result, TextWrapping = TextWrapping.Wrap, Foreground = Find("Dim") });
        }
    }
    public async Task<string> RunWorkspaceAsync(string prompt, CancellationToken token)
    {
        var conversation = _thread ?? throw new InvalidOperationException("Не выбран диалог.");
        // Один запуск на диалог: ждём освобождения, а не падаем. Фоновые ответы
        // в ДРУГИХ чатах этому не мешают — они живут в своих запусках.
        while (_runs.IsBusy(conversation.Id)) await Task.Delay(200, token);
        var count = conversation.Messages.Count;
        token.ThrowIfCancellationRequested();
        Input.Text = prompt;
        using var registration = token.Register(() => Dispatcher.BeginInvoke(new Action(() => { if (ReferenceEquals(_thread, conversation)) CancelWorkspaceRun(); })));
        await SendWorkspaceCoreAsync(token, automated: true);
        token.ThrowIfCancellationRequested();
        var response = conversation.Messages.Skip(count).LastOrDefault(m => m.IsAgent);
        if (response is null || response.Status != "ok") throw new InvalidOperationException(response?.Note ?? "Шлюз не вернул результат.");
        return response.Text;
    }
    private void CancelWorkspaceRun()
    {
        var run = _runs.Stop(_thread?.Id ?? "");
        if (run is null) return;
        StopApprovalWatch(run.ThreadId);
        run.Message.WaitingApproval = run.Message.WaitingClarification = false;
        run.Message.ApprovalRequestId = run.Message.ClarifyRequestId = "";
        RefreshRequestBar();
        if (ReferenceEquals(_thread, run.Thread)) { SetBusy(); Render(); }
    }
    public void OpenWorkspaceSession(Profile profile, Gateway? gateway, string sessionId)
    {
        var thread = _store.Threads.FirstOrDefault(t => t.Id == sessionId);
        if (thread is null)
        {
            thread = new ChatThread { Id = sessionId, Title = profile.Name + (gateway is null ? " · оценка" : " · исполнение"), ProfileId = profile.Id, ProfileName = profile.Name, GatewayId = gateway?.Id ?? "", GatewayName = gateway?.Name ?? "" };
            _store.Threads.Insert(0, thread);
        }
        if (!_threads.Contains(thread)) _threads.Add(thread);
        Show(thread);
    }
}
