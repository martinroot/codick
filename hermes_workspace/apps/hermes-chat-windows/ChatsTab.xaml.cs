using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Windows.Data;
using System.IO;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;

namespace HermesChat;

public partial class ChatsTab : UserControl
{
    /// <summary>Состояние общее для всех вкладок: один файл, одна правда.
    /// Свой Store здесь означал бы, что чаты и профили сохраняются互相но и затирают друг друга.</summary>
    public Store State { get; set; } = null!;
    private Store _store => State;
    /// <summary>Локальный шлюз: он же источник навыков и проверки связи.
    /// Не readonly: после закрытия окна настроек адрес и ключ меняются, и клиент
    /// должен быть пересоздан, иначе правка настроек молча не подействует.</summary>
    private HermesClient _local = null!;
    /// <summary>Локальный шлюз наружу: вкладке разговоров он нужен как источник
    /// сессий. Наружу именно поле, а не копия: после правки настроек клиент
    /// пересоздаётся, и внешний должен увидеть тот же адрес и ключ.</summary>
    public HermesClient LocalClient => _local;
    /// <summary>Клиент, через который идёт текущий диалог. У диалога с внешним
    /// шлюзом это другой адрес и другой токен — иначе сообщение ушло бы на
    /// localhost, и «переехать туда» было бы негде.</summary>
    /// <summary>Клиент текущего диалога. Именно поле, а не вычисляемое свойство:
    /// свойство создавало новый HermesClient на КАЖДОЕ обращение, а внутри него —
    /// новый HttpClient на каждый запрос. Ни один не освобождался, сокеты копились
    /// в TIME_WAIT, и при длинном ответе (поток держится минутами) новое соединение
    /// уходило в ожидание — приложение «думало» после того, как шлюз уже принял
    /// сообщение. Теперь клиент один на диалог и пересоздаётся при смене адресата.</summary>
    private HermesClient _activeClient = null!;
    private string _activeKey = "";

    public HermesClient _client => ActiveClient();
    public HermesClient Client => ActiveClient();

    /// <summary>Клиент для текущего диалога, пересоздаваемый только при смене
    /// шлюза или профиля — то есть когда реально меняется адрес или токен.</summary>
    private HermesClient ActiveClient()
    {
        var gateway = _thread is null ? null : GatewayOf(_thread);
        var key = (gateway?.Id ?? "") + "|" + (_thread?.Id ?? "");
        if (_activeClient is null || _activeKey != key)
        {
            _activeClient = ClientFor(_thread);
            _activeKey = key;
        }
        return _activeClient;
    }

    private ChatThread? _thread;

    // ── Живые запуски: по одному на ДИАЛОГ, а не на вкладку ───────────────
    // Раньше запуск, его WS-соединение и живое сообщение были полями вкладки,
    // и второе сообщение затирало первое: переключил чат — стриминг первого
    // обрывался, а лента рисовала чужое состояние. Теперь у каждого диалога
    // свой ChatRun в реестре: своё соединение, своя отмена, своё сообщение.
    private readonly RunRegistry _runs = new();

    /// <summary>Запуск открытого диалога — тот, чьи события сейчас в ленте.</summary>
    private ChatRun? CurrentRun => _thread is null ? null : _runs[_thread.Id];

    /// <summary>Запуск по сообщению: кнопки разрешений и вопросов несут id
    /// сообщения, а не диалога, — по нему и находится запущенный поток.</summary>
    private ChatRun? RunOfMessage(string messageId) => _runs.ByMessage(messageId);

    /// <summary>Диалоги с идущим ответом — для заголовка и кнопки STOP.</summary>
    private bool AnyBusy => _runs.AnyBusy;

    private readonly List<Attachment> _pending = new();
    private List<SkillInfo> _skills = new();
    private bool _loadingModel;
    private bool _loadingProfile;
    private readonly ObservableCollection<ChatThread> _threads = new();
    private bool _suppressListEvent;
    /// <summary>Открытие уже идёт: сброс выбора в списке адресатов не должен
    /// второй раз уводить в диалог и зацикливать перерисовку.</summary>
    private bool _loadingAddressee;

    public ChatsTab()
    {
        // Разметка обязана быть загружена до Init(): без этого все именованные
        // элементы (ModelBox, ChatList) остаются null и Init падает.
        InitializeComponent();
    }

    /// <summary>Старт вкладки. Вызывается оболочкой после присвоения State,
    /// поэтому загрузка состояния тут не нужна: файл уже прочитан один раз.</summary>
    public void Init()
    {
        if (_store.Settings.ApiKey.Length == 0) AutoFillKeyFromHermesEnv();
        _local = new HermesClient(_store.Settings);
        // Наблюдаемая коллекция: иначе ListBox не покажет добавленный диалог —
        // ItemsSource переустановка на ту же ссылку List<T> не обновляет.
        _loadingModel = true;
        foreach (var choice in ModelCatalog.Defaults) ModelBox.Items.Add(choice);
        ModelBox.SelectedIndex = 0;
        _loadingModel = false;
        _skills = _local.ReadSkills();
        FillProfiles();
        SkillsBtn.ToolTip = _skills.Count == 0
            ? "Навыки не найдены в каталоге Hermes"
            : $"{_skills.Count} навыков доступно";
        foreach (var thread in _store.Threads) _threads.Add(thread);
        RefreshThreadGroups();
        // При запуске не открываем случайную свободную переписку из архива,
        // если уже есть профильный или шлюзовый диалог.
        var first = _threads.Where(t => !IsUniversal(t)).OrderByDescending(t => t.UpdatedAt).FirstOrDefault()
                    ?? _threads.OrderByDescending(t => t.UpdatedAt).FirstOrDefault();
        if (first is not null) Show(first);
        PreviewKeyDown += OnWindowPaste;
        Unloaded += (_, _) => Shutdown();
    }

    /// <summary>Ключ берём из .env Hermes, чтобы приложение работало сразу после установки.</summary>
    private void AutoFillKeyFromHermesEnv()
    {
        try
        {
            var env = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "hermes", ".env");
            if (!File.Exists(env)) return;
            var match = Regex.Match(File.ReadAllText(env), @"^API_SERVER_KEY=(.+)$", RegexOptions.Multiline);
            if (match.Success) _store.Settings.ApiKey = match.Groups[1].Value.Trim();
        }
        catch (Exception error) { CrashLog.Write("Автоподстановка ключа: " + error.Message); }
    }

    /// <summary>Закрытие вкладки останавливает ВСЕ её запуски: не только открытый
    /// диалог. Иначе ответ, идущий в фоновом чате, продолжал бы писать в ленту
    /// невидимого диалога и держать соединение.</summary>
    private void Shutdown()
    {
        foreach (var run in _runs.StopAll())
        {
            run.Message.Status = run.Message.Status == "running" ? "stopped" : run.Message.Status;
            run.Message.WaitingApproval = run.Message.WaitingClarification = false;
            run.Message.ApprovalRequestId = run.Message.ClarifyRequestId = "";
        }
        ForgetAllRequests();
        _store.Save();
        RefreshRequestBar();
    }

    /// <summary>Ресурс темы по имени. Имена строковые, потому что заливки
    /// назначаются в коде, а не в разметке.</summary>
    private Brush Find(string key) => (Brush)FindResource(key);

    // ---------- диалоги ----------

    /// <summary>Только один список чатов: разговоры с универсальным агентом.
    /// Чаты с профилем или внешним шлюзом живут в своих секциях как у профиля
    /// и у шлюза, а не отдельной строкой, — иначе один и тот же адресат
    /// показывался бы дважды.</summary>
    private ICollectionView AttachThreadView()
    {
        ChatList.ItemsSource = null;
        var source = new ObservableCollection<ChatThread>(_threads.Where(IsUniversal));
        var view = CollectionViewSource.GetDefaultView(source);
        view.SortDescriptions.Clear();
        view.SortDescriptions.Add(new SortDescription(nameof(ChatThread.UpdatedAt), ListSortDirection.Descending));
        ChatList.ItemsSource = view;
        return view;
    }

    private static bool IsUniversal(ChatThread thread) =>
        thread.GatewayId.Length == 0 && thread.ProfileId.Length == 0;

    /// <summary>Пересобрать списки: состав диалогов или профилей изменился.</summary>
    public void RefreshThreadGroups()
    {
        foreach (var item in _store.Threads) if (!_threads.Contains(item)) _threads.Add(item);
        _suppressListEvent = true;
        try
        {
            AttachThreadView();
            if (_thread is not null && IsUniversal(_thread))
            {
                ChatArchiveExpander.IsExpanded = true;
                ChatList.SelectedItem = _thread;
            }
            else ChatList.SelectedItem = null;
        }
        finally { _suppressListEvent = false; }
        var freeChats = _threads.Count(IsUniversal);
        ChatArchiveHeader.Text = $"АРХИВ СВОБОДНЫХ ЧАТОВ · {freeChats}";
        ChatArchiveExpander.Visibility = freeChats > 0 ? Visibility.Visible : Visibility.Collapsed;
        // Счётчики сообщений у профилей: строка должна показывать, что за
        // профилем уже есть разговор, иначе клик выглядит как переход в пустоту.
        // Max на пустой последовательности бросает исключение и роняет окно
        // целиком, поэтому пустой набор даёт ноль явно.
        foreach (var profile in _store.Profiles)
            profile.ThreadMessages = _threads
                .Where(t => t.ProfileId == profile.Id && t.GatewayId.Length == 0)
                .Select(t => t.Messages.Count)
                .DefaultIfEmpty(0)
                .Max();
        // Списки адресатов — те же объекты, что в состоянии, но их набор мог
        // измениться на соседней вкладке, поэтому ItemsSource переустанавливается.
        RefreshProjectPages();
        FreeProfileList.ItemsSource = _store.Profiles.Where(p => !p.IsBound).ToList();
        GatewayList.ItemsSource = _store.Gateways;
        ProfileList.Items.Refresh();
        // Пустая секция молчит — а она должна объяснять, куда идти.
        ProfileHint.Visibility = _store.Profiles.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        GatewayHint.Visibility = _store.Gateways.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>Клик по профилю: открыть его диалог с историей. Один клик, а не
    /// двойной: строка профиля и есть ссылка на разговор, и ждать второго клика
    /// нельзя — человек сразу видит, что ничего не произошло.
    /// Если диалога ещё нет, он заводится, но в списке чатов не появляется:
    /// он принадлежит профилю, а не разделу универсальных.</summary>
    private void OnProfilePicked(object sender, SelectionChangedEventArgs e)
    {
        if (_loadingAddressee) return;
        if (sender is not ListBox list || list.SelectedItem is not Profile profile) return;
        if (_thread is not null && _thread.ProfileId == profile.Id && _thread.GatewayId.Length == 0) return;
        _loadingAddressee = true;
        try { OpenWithProfile(profile.Id); }
        finally { _loadingAddressee = false; }
    }

    /// <summary>Клик по внешнему шлюзу: то же, что и профиль, но с проверкой
    /// готовности адреса — незаполненный шлюз открывать бессмысленно.</summary>
    private void OnGatewayPicked(object sender, SelectionChangedEventArgs e)
    {
        if (_loadingAddressee) return;
        if (sender is not ListBox list || list.SelectedItem is not Gateway gateway) return;
        if (_thread is not null && _thread.GatewayId == gateway.Id) return;
        if (gateway.ReadyError.Length > 0)
        {
            MessageBox.Show("У шлюза «" + gateway.Name + "» " + gateway.ReadyError
                            + ". Заполни адрес и токен во вкладке «Внешние шлюзы».", "HermesChat");
            _loadingAddressee = true;
            try { list.SelectedItem = null; }
            finally { _loadingAddressee = false; }
            return;
        }
        _loadingAddressee = true;
        try { OpenWithGateway(gateway.Id); }
        finally { _loadingAddressee = false; }
    }

    /// <summary>Выбор диалога в списке чатов.</summary>
    private void OnThreadSelected(object sender, SelectionChangedEventArgs e)
    {
        if (_suppressListEvent) return;
        if (sender is not ListBox list || list.SelectedItem is not ChatThread thread) return;
        _thread = thread;
        thread.UpdatedAt = DateTimeOffset.Now.ToUnixTimeSeconds();
        _store.Save();
        LoadThreadProfile();
        LoadThreadModel();
        SetBusy();
        UpdateHeader();
        Render();
        UpdateStats();
        RefreshRequestBar();
    }

    private void Select(ChatThread thread)
    {
        _suppressListEvent = true;
        try { ChatList.SelectedItem = thread; }
        finally { _suppressListEvent = false; }
    }

    /// <summary>Кнопка «+» у секции чатов: новый разговор с универсальным агентом.
    /// У профилей и шлюзов отдельной кнопки нет: они и есть адресат, клик по
    /// строке открывает его диалог.</summary>
    private void OnNewInSection(object sender, RoutedEventArgs e) => NewThread(null, null);

    /// <summary>Создать диалог и показать его. Адресат пустой — универсальный агент.</summary>
    private void NewThread(string? profileId, string? gatewayId)
    {
        var thread = new ChatThread { Title = "Новый диалог " + DateTime.Now.ToString("HH:mm") };
        if (profileId is { Length: > 0 })
        {
            thread.ProfileId = profileId;
            thread.ProfileName = _store.Profiles.FirstOrDefault(p => p.Id == profileId)?.Name ?? "";
        }
        if (gatewayId is { Length: > 0 })
        {
            var gateway = _store.Gateways.FirstOrDefault(g => g.Id == gatewayId);
            if (gateway is null) return;
            thread.GatewayId = gateway.Id;
            thread.GatewayName = gateway.Name;
            thread.ProfileId = gateway.ProfileId;
            thread.ProfileName = _store.Profiles.FirstOrDefault(p => p.Id == gateway.ProfileId)?.Name ?? "";
        }
        _store.Threads.Insert(0, thread);
        _threads.Insert(0, thread);
        RefreshThreadGroups();
        ChatArchiveExpander.IsExpanded = true;
        Select(thread);
        _thread = thread;
        LoadThreadProfile();
        LoadThreadModel();
        SetBusy();
        UpdateHeader();
        Render();
        UpdateStats();
        RefreshRequestBar();
        Input.Focus();
    }

    private void OnNewThread(object sender, RoutedEventArgs e) => NewThread(null, null);

    // ---------- лента ----------

    /// <summary>Сколько сообщений лента рисует за раз. Подхваченная сессия шлюза —
        /// это сотни сообщений и тысячи строк инструментов; построить их все сразу
        /// означает заморозить окно (UIA перестаёт отвечать, приложение выглядит
        /// повешенным). Держим хвост и говорим, сколько сверху не показано.</summary>
        private const int FeedLimit = 120;

        private void Render()
        {
            _liveBubble = null;
            Feed.Children.Clear();
            if (_thread is null) return;
            var live = CurrentRun?.Message;
            if (_thread.Messages.Count == 0)
            {
                Feed.Children.Add(new TextBlock
                {
                    Text = "Спроси агента о чём угодно. Он видит твою машину: файлы, команды, веб.",
                    Foreground = Find("Dim"),
                    TextWrapping = TextWrapping.Wrap,
                    Margin = new Thickness(0, 24, 0, 0)
                });
                return;
            }
            var skip = _thread.Messages.Count - FeedLimit;
            if (skip > 0)
                Feed.Children.Add(new TextBlock
                {
                    Text = $"… сверху {skip} сообщений не показано — это подхваченный разговор шлюза.",
                    Foreground = Find("Dim"),
                    TextWrapping = TextWrapping.Wrap,
                    Margin = new Thickness(0, 0, 0, 10)
                });
            foreach (var message in _thread.Messages.Skip(skip))
                    {
                        var bubble = BuildBubble(message);
                        Feed.Children.Add(bubble);
                        // Активный ответ — последний нарисованный пузырь: на него потом
                        // ссылается поток по токенам. Ссылка, а не индекс: лента рисует
                        // хвост, и индекс сообщения в неё не верен.
                        if (ReferenceEquals(message, live)) _liveBubble = bubble;
                    }
                    if (live is not null && _liveBubble is null)
                        _liveBubble = Feed.Children.OfType<Border>().LastOrDefault();
                    ScrollToEnd();
                }

    private Border BuildBubble(ChatMessage message)
    {
        var panel = new StackPanel { Margin = new Thickness(0, 6, 0, 6) };
        var meta = new TextBlock
        {
            Tag = "message-meta",
            Text = RoleName(message)
                 + (message.Status == "running" ? " · " + StatusLine(message)
                    : message.Status == "ok" && message.Model.Length > 0 ? " · " + message.Model : ""),
            FontSize = 11,
            Foreground = Find(message.Status switch { "running" => "Warn", "failed" => "Bad", "partial" => "Warn", "stopped" => "Dim", _ => "Dim" }),
            Margin = new Thickness(2, 0, 0, 4)
        };
        panel.Children.Add(meta);

        var summary = message.IsAgent && message.Status == "ok" && _store.ChatBindings.Values.Any(b => b.OrchestratorThreadId == _thread?.Id)
            ? WorkspaceDecision.DisplayText(message.Body) : null;
        var body = MarkdownRenderer.Render(summary ?? (message.Body.Length > 0 ? message.Body : "…"),
            _store.Settings.FontSize, message.IsAgent ? Find("Fg") : Find("Accent"),
            Find("Dim"), Find("Bg"), Find("Line"), Find("Accent"), Find("Panel"));
        var bubble = new Border
        {
            Tag = "message-body",
            Background = message.IsAgent ? Find("Panel") : Find("Bg"),
            BorderBrush = message.IsAgent ? Find("Line") : Find("Accent"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(12, 9, 12, 9),
            Child = body,
            HorizontalAlignment = message.IsAgent ? HorizontalAlignment.Stretch : HorizontalAlignment.Right,
            MaxWidth = 760
        };
        if (!message.IsAgent) panel.Children.Add(bubble);

        if (message.Attachments.Count > 0)
        {
            var strip = new WrapPanel { Margin = new Thickness(0, 8, 0, 0) };
            foreach (var file in message.Attachments)
                strip.Children.Add(BuildAttachmentChip(file));
            panel.Children.Add(strip);
        }

        // Активные запросы (разрешение, вопросы) рисуются НЕ здесь, а в панели
        // над полем ввода: внутри ленты они уезжали наверх вместе с длинным
        // ответом. В ленте остаётся только история — уже отвеченные вопросы.
        if (message.WaitingApproval && !IsShownInRequestBar(message))
            panel.Children.Add(BuildApprovalBlock(message));
        if (message.ClarifyQuestions.Count > 0 && !IsShownInRequestBar(message))
            panel.Children.Add(BuildClarifyBlock(message));

        if (message.Steers.Count > 0)
            foreach (var steer in message.Steers)
                panel.Children.Add(new TextBlock
                {
                    Text = "твоя подсказка: " + steer,
                    FontSize = 11,
                    Foreground = Find("Accent"),
                    TextWrapping = TextWrapping.Wrap,
                    Margin = new Thickness(2, 4, 0, 0)
                });

        if (message.IsAgent) panel.Children.Add(bubble);
        if (summary is not null)
            panel.Children.Add(new Expander { Header = "Полный ответ / правки TODO", Foreground = Find("Dim"),
                Content = new TextBox { Text = message.Body, IsReadOnly = true, TextWrapping = TextWrapping.Wrap, MaxHeight = 250, VerticalScrollBarVisibility = ScrollBarVisibility.Auto } });
        RefreshInterimRows(panel, message);
        RefreshToolRows(panel, message);

        if (message.Note.Length > 0)
            panel.Children.Add(new TextBlock
            {
                Text = message.Note,
                FontSize = 11,
                Foreground = Find("Warn"),
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(2, 4, 0, 0)
            });
        if (message.InputTokens > 0 || message.OutputTokens > 0)
            panel.Children.Add(new TextBlock
            {
                Text = UsageLine(message),
                FontSize = 10,
                Foreground = Find("Dim"),
                TextWrapping = TextWrapping.Wrap,
                ToolTip = message.RouteSource.Length > 0 ? "маршрут: " + message.RouteSource : "",
                Margin = new Thickness(2, 5, 0, 0)
            });
        return new Border { Child = panel, HorizontalAlignment = HorizontalAlignment.Stretch };
    }

    /// <summary>Живая строка состояния: видно, что агент делает, а не только «пишет».</summary>
    private static string StatusLine(ChatMessage message)
    {
        if (message.WaitingApproval) return "ждёт твоего решения";
        if (message.Tools.LastOrDefault() is { Running: true } step)
        {
            var visual = ToolVisuals.For(step.Tool);
            return step.Phase == "generating"
                ? $"{visual.Icon} {visual.Title}: формирует вызов…"
                : $"{visual.Icon} {visual.Title}: выполняется…";
        }
        if (message.Streaming.Length > 0) return "пишет…";
        return "думает…";
    }

    /// <summary>Блок одобрения: без него запуск висит в waiting_for_approval молча.</summary>
    private FrameworkElement BuildApprovalBlock(ChatMessage message)
    {
        var box = new StackPanel();
        box.Children.Add(new TextBlock
        {
            Text = "Агент просит разрешить: " + message.ApprovalTool,
            FontSize = 12,
            Foreground = Find("Warn"),
            Margin = new Thickness(0, 0, 0, 4)
        });
        if (message.ApprovalCommand.Length > 0)
            box.Children.Add(new Border
            {
                Background = Find("Bg"),
                BorderBrush = Find("Warn"),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(4),
                Padding = new Thickness(8, 6, 8, 6),
                Margin = new Thickness(0, 0, 0, 8),
                Child = new TextBlock
                {
                    Text = message.ApprovalCommand,
                    FontFamily = new FontFamily("Consolas"),
                    FontSize = 12,
                    Foreground = Find("Fg"),
                    TextWrapping = TextWrapping.Wrap
                }
            });

        var row = new WrapPanel();
        foreach (var choice in message.ApprovalChoices)
        {
            var label = choice switch
            {
                "once" => "Разрешить",
                "session" => "Разрешить до конца сессии",
                "always" => "Разрешить всегда",
                "deny" => "Запретить",
                _ => choice
            };
            var button = new Button
            {
                Content = label,
                Style = (Style)FindResource(choice == "deny" ? "Btn" : "PrimaryBtn"),
                Margin = new Thickness(0, 0, 8, 0),
                Tag = message.Id + "|" + choice
            };
            button.Click += OnApproveClick;
            row.Children.Add(button);
        }
        // Закрыть без ответа. Без неё блок, который шлюз уже снял, было бы
        // нечем убрать — и он висел бы на экране до перезапуска.
        var dismiss = new Button
        {
            Content = "Закрыть",
            Style = (Style)FindResource("Btn"),
            Margin = new Thickness(0, 0, 0, 0),
            Tag = message.Id,
            ToolTip = "Убрать окно и отказать агенту"
        };
        dismiss.Click += OnRequestDismiss;
        row.Children.Add(dismiss);
        box.Children.Add(row);
        return new Border
        {
            Background = Find("Panel"),
            BorderBrush = Find("Warn"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(6),
            Padding = new Thickness(12, 10, 12, 10),
            Margin = new Thickness(0, 6, 0, 0),
            Child = box
        };
    }

    private sealed record ClarifyOptionTag(string MessageId, string QuestionId, string Value);
    private sealed record ClarifyTextTag(string MessageId, string QuestionId);

    /// <summary>Диалог, которому принадлежит сообщение.</summary>
    private ChatThread? FindThread(ChatMessage message) =>
        _store.Threads.FirstOrDefault(thread => thread.Messages.Contains(message));

    /// <summary>Открытые запросы шлюза по ВСЕМ диалогам этого окна: разрешения
    /// и вопросы. Панель над полем ввода обязана показывать их все — иначе
    /// вопрос из фонового чата нельзя было бы закрыть, не переключаясь на него.
    /// Порядок: сначала текущий диалог, потом остальные по времени сообщения.</summary>
    private List<ChatMessage> OpenRequests() => _store.Threads
        .SelectMany(thread => thread.Messages)
        .Where(IsOpenRequest)
        .OrderByDescending(message => IsCurrentThread(message))
        .ThenByDescending(message => message.CreatedAt)
        .ToList();

    /// <summary>Ждёт ли сообщение ответа прямо сейчас. Флага достаточно: id запроса
    /// шлюза может быть пустым, и требование непустого id просто прятало бы блок
    /// от пользователя — вместе с возможностью его закрыть.</summary>
    private static bool IsOpenRequest(ChatMessage message) =>
        message.WaitingApproval || message.WaitingClarification;

    private bool IsCurrentThread(ChatMessage message) =>
        _thread is not null && FindThread(message) is { } owner
        && string.Equals(owner.Id, _thread.Id, StringComparison.Ordinal);

    /// <summary>Открытые запросы шлюза этого окна. Реестр переживает сам запуск:
    /// разрешение приходит из очереди tools/approval и часто уже после того, как
    /// ответ дописался. Отсюда и ответ на «кнопка не работает, висит вечно» —
    /// раньше адресат ответа искался среди живых запусков и не находился.</summary>
    private readonly PendingRequestStore<ChatMessage, TuiGateway> _pendingRequests = new();

    private void RememberRequest(string kind, string id, TuiGateway? gateway, ChatMessage message) =>
        _pendingRequests.Remember(new PendingRequestStore<ChatMessage, TuiGateway>.Entry(id, kind, gateway, message));

    private PendingRequestStore<ChatMessage, TuiGateway>.Entry? TakeRequest(string kind, string id) =>
        _pendingRequests.Take(kind, id);

    /// <summary>Снять все запросы окна. Неотвеченный кадр шлюз снимет сам по
    /// таймауту, но держать его в памяти и перерисовывать панель незачем.</summary>
    private void ForgetAllRequests() => _pendingRequests.Clear();

    private static bool IsShownInRequestBar(ChatMessage message) => IsOpenRequest(message);

    /// <summary>Пересобрать панель запросов. Вызывается на каждое событие
    /// запуска: блок появляется сразу, а не после того, как длинный ответ
    /// долистается до конца.</summary>
    private string _requestSignature = "";

    private void RefreshRequestBar()
    {
        var pending = OpenRequests();
        // Пересобираем панель только когда изменился её состав: Apply() зовёт
        // этот метод на каждом токене, и полная пересборка на каждом событии
        // съедала бы интерфейс на длинном ответе.
        var signature = string.Join("|", pending.Select(message =>
            message.Id + ":" + (message.WaitingApproval ? message.ApprovalRequestId : message.ClarifyRequestId)));
        if (signature == _requestSignature) return;
        _requestSignature = signature;
        RequestPanel.Children.Clear();
        foreach (var message in pending)
        {
            var thread = FindThread(message);
            // Заголовок с именем диалога: вопрос из фонового чата иначе выглядит
            // как вопрос текущего.
            if (thread is not null && !ReferenceEquals(thread, _thread))
                RequestPanel.Children.Add(new TextBlock
                {
                    Text = "Диалог: " + thread.Title,
                    FontSize = 11,
                    Foreground = Find("Dim"),
                    Margin = new Thickness(0, 0, 0, 4)
                });
            RequestPanel.Children.Add(message.WaitingApproval
                ? BuildApprovalBlock(message)
                : BuildClarifyBlock(message));
        }
        RequestBar.Visibility = pending.Count == 0 ? Visibility.Collapsed : Visibility.Visible;
    }

    private FrameworkElement BuildClarifyBlock(ChatMessage message)
    {
        var active = message.WaitingClarification;
        var box = new StackPanel();
        box.Children.Add(new TextBlock
        {
            Text = active ? "Ответь на вопросы агента" : "Уточнение",
            FontWeight = FontWeights.SemiBold,
            Foreground = Find(active ? "Warn" : "Dim"),
            Margin = new Thickness(0, 0, 0, 8)
        });

        foreach (var question in message.ClarifyQuestions)
        {
            var card = new StackPanel { Margin = new Thickness(0, 0, 0, 10) };
            card.Children.Add(new TextBlock
            {
                Text = question.Question,
                FontWeight = FontWeights.SemiBold,
                Foreground = Find("Fg"),
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 0, 0, 5)
            });
            if (question.Choices.Count > 0)
            {
                var options = new WrapPanel { Margin = new Thickness(0, 0, 0, 5) };
                foreach (var choice in question.Choices)
                {
                    var tag = new ClarifyOptionTag(message.Id, question.Qid, choice);
                    if (question.MultiSelect)
                    {
                        var check = new CheckBox
                        {
                            Content = choice,
                            IsChecked = question.SelectedChoices.Contains(choice, StringComparer.Ordinal),
                            IsEnabled = active,
                            Tag = tag,
                            Foreground = Find("Fg"),
                            Margin = new Thickness(0, 2, 14, 2)
                        };
                        check.Checked += OnClarifyOptionChanged;
                        check.Unchecked += OnClarifyOptionChanged;
                        options.Children.Add(check);
                    }
                    else
                    {
                        var radio = new RadioButton
                        {
                            Content = choice,
                            GroupName = "clarify_" + message.Id + "_" + question.Qid,
                            IsChecked = question.SelectedChoice == choice,
                            IsEnabled = active,
                            Tag = tag,
                            Foreground = Find("Fg"),
                            Margin = new Thickness(0, 2, 14, 2)
                        };
                        radio.Checked += OnClarifyOptionChanged;
                        options.Children.Add(radio);
                    }
                }
                card.Children.Add(options);
            }

            var answer = new TextBox
            {
                Tag = new ClarifyTextTag(message.Id, question.Qid),
                Text = question.FreeText,
                AcceptsReturn = true,
                TextWrapping = TextWrapping.Wrap,
                MinHeight = 34,
                MaxHeight = 100,
                IsEnabled = active,
                ToolTip = question.Choices.Count > 0 ? "Свой вариант (необязательно)" : "Твой ответ",
                Margin = new Thickness(0, 2, 0, 0)
            };
            answer.TextChanged += OnClarifyTextChanged;
            card.Children.Add(answer);

            if (!active)
            {
                var recorded = ClarifyAnswer(question) ?? question.Answer ?? "(пропущено)";
                card.Children.Add(new TextBlock
                {
                    Text = "Ответ: " + recorded,
                    Foreground = Find("Accent"),
                    TextWrapping = TextWrapping.Wrap,
                    Margin = new Thickness(2, 4, 0, 0)
                });
            }
            box.Children.Add(card);
        }

        if (active)
        {
            var actions = new WrapPanel();
            var submit = new Button
            {
                Content = "Отправить ответы",
                Style = (Style)FindResource("PrimaryBtn"),
                Tag = message.Id,
                Margin = new Thickness(0, 2, 8, 0)
            };
            submit.Click += OnClarifySubmit;
            actions.Children.Add(submit);
            var cancel = new Button
            {
                Content = "Пропустить вопросы",
                Style = (Style)FindResource("Btn"),
                Tag = message.Id,
                Margin = new Thickness(0, 2, 0, 0)
            };
            cancel.Click += OnClarifyCancel;
            actions.Children.Add(cancel);
            var close = new Button
            {
                Content = "Закрыть",
                Style = (Style)FindResource("Btn"),
                Tag = message.Id,
                Margin = new Thickness(0, 2, 0, 0),
                ToolTip = "Убрать окно и отказать агенту"
            };
            close.Click += OnRequestDismiss;
            actions.Children.Add(close);
            box.Children.Add(actions);
        }

        return new Border
        {
            Background = Find("Panel"),
            BorderBrush = Find(active ? "Accent" : "Line"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(6),
            Padding = new Thickness(12, 10, 12, 10),
            Margin = new Thickness(0, 6, 0, 0),
            Child = box
        };
    }

    private ChatMessage? ClarifyMessage(string messageId) =>
        _threads.SelectMany(thread => thread.Messages).FirstOrDefault(message => message.Id == messageId);

    private void OnClarifyOptionChanged(object sender, RoutedEventArgs e)
    {
        if (sender is not FrameworkElement { Tag: ClarifyOptionTag tag }) return;
        var question = ClarifyMessage(tag.MessageId)?.ClarifyQuestions.FirstOrDefault(item => item.Qid == tag.QuestionId);
        if (question is null) return;
        if (sender is CheckBox check)
        {
            if (check.IsChecked == true && !question.SelectedChoices.Contains(tag.Value, StringComparer.Ordinal))
                question.SelectedChoices.Add(tag.Value);
            else if (check.IsChecked != true)
                question.SelectedChoices.RemoveAll(value => value == tag.Value);
        }
        else if (sender is RadioButton { IsChecked: true }) question.SelectedChoice = tag.Value;
    }

    private void OnClarifyTextChanged(object sender, TextChangedEventArgs e)
    {
        if (sender is not TextBox { Tag: ClarifyTextTag tag }) return;
        var question = ClarifyMessage(tag.MessageId)?.ClarifyQuestions.FirstOrDefault(item => item.Qid == tag.QuestionId);
        if (question is not null) question.FreeText = ((TextBox)sender).Text;
    }

    private static string? ClarifyAnswer(ClarifyQuestionData question)
    {
        var freeText = question.FreeText.Trim();
        if (question.MultiSelect)
        {
            var parts = question.SelectedChoices.Concat(freeText.Length > 0 ? new[] { freeText } : Array.Empty<string>())
                .Where(value => value.Length > 0).Distinct(StringComparer.Ordinal).ToList();
            return parts.Count == 0 ? null : string.Join(", ", parts);
        }
        if (freeText.Length > 0) return freeText;
        return question.SelectedChoice.Length > 0 ? question.SelectedChoice : null;
    }

    private async void OnClarifySubmit(object sender, RoutedEventArgs e)
    {
        if (sender is not FrameworkElement { Tag: string messageId }) return;
        var message = FindMessage(messageId);
        if (message is null || !message.WaitingClarification) return;
        // Ответ уходит по сокету того диалога, который спросил, — и по тому же
        // кадру, а не «по текущему чату»: фоновый вопрос иначе остался бы висеть.
        var pending = _pendingRequests.FindByMessage("clarify", messageId, m => m.Id)
            ?? new PendingRequestStore<ChatMessage, TuiGateway>.Entry(
                message.ClarifyRequestId, "clarify", CurrentRun?.Gateway, message);
        if (pending.Transport is null)
        {
            message.Note = "Соединение с шлюзом закрыто — ответить на вопрос некуда.";
            RefreshRequestBar();
            Render();
            return;
        }
        TakeRequest("clarify", pending.Id);
        var requestId = message.ClarifyRequestId.Length > 0 ? message.ClarifyRequestId : pending.Id;
        try
        {
            foreach (var question in message.ClarifyQuestions)
            {
                var answer = ClarifyAnswer(question);
                question.Answer = answer;
                var result = await pending.Transport.LockClarifyAnswerAsync(requestId, question.Qid,
                    answer, CancellationToken.None);
                if ((string?)result?["status"] == "expired")
                    throw new InvalidOperationException("Шлюз уже закрыл окно вопросов.");
            }
            message.WaitingClarification = false;
            message.ClarifyRequestId = "";
            message.Note = "Ответы на вопросы отправлены.";
        }
        catch (Exception error)
        {
            message.Note = "Ответ не принят: " + error.Message;
            CrashLog.Write("Clarify answer: " + error);
        }
        _store.Save();
        RefreshRequestBar();
        Render();
        UpdateStats();
    }

    private async void OnClarifyCancel(object sender, RoutedEventArgs e)
    {
        if (sender is not FrameworkElement { Tag: string messageId }) return;
        var message = FindMessage(messageId);
        if (message is null || !message.WaitingClarification) return;
        var pending = _pendingRequests.FindByMessage("clarify", messageId, m => m.Id);
        if (pending is not null)
        {
            TakeRequest("clarify", pending.Id);
            await AnswerPendingAsync(pending, new JsonObject());   // без answers = пропустить всё
        }
        message.WaitingClarification = false;
        message.ClarifyRequestId = "";
        message.Note = "Уточнение пропущено.";
        _store.Save();
        RefreshRequestBar();
        Render();
    }

    /// <summary>Пока висит окно одобрения, статус запуска опрашивается: шлюз ждёт
    /// ответа ограниченное время и по истечении идёт дальше сам. Без этой
    /// проверки кнопки оставались бы на экране уже после того, как они
    /// перестали работать, и клик по ним давал 409.
    ///
    /// Таймеры живут здесь, а не в ChatRun: DispatcherTimer тянет WPF, и
    /// состояние запуска тогда нельзя было бы проверить тестом. Ключ — id
    /// запуска, поэтому опрос одного диалога не трогает соседние.</summary>
    private readonly Dictionary<string, DispatcherTimer> _approvalWatches = new();

    private void WatchApproval(ChatRun run)
    {
        if (_approvalWatches.ContainsKey(run.ThreadId)) return;
        var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(4) };
        timer.Tick += async (_, _) =>
        {
            var message = run.Message;
            if (!message.WaitingApproval || message.RunId.Length == 0)
            {
                StopApprovalWatch(run.ThreadId);
                return;
            }
            try
            {
                var state = await ClientFor(run.Thread).StatusAsync(message.RunId, CancellationToken.None);
                if (state.Status is "completed" or "failed" or "cancelled" or "interrupted")
                {
                    message.WaitingApproval = false;
                    message.ApprovalRequestId = "";
                    message.Note = "Окно разрешения закрыто: агент ушёл дальше сам, не дождавшись.";
                    StopApprovalWatch(run.ThreadId);
                    RefreshRequestBar();
                    if (ReferenceEquals(_thread, run.Thread)) Render();
                }
            }
            catch (Exception) { /* сеть моргнула — попробуем на следующем тике */ }
        };
        timer.Start();
        _approvalWatches[run.ThreadId] = timer;
    }

    private void StopApprovalWatch(string threadId)
    {
        if (!_approvalWatches.Remove(threadId, out var timer)) return;
        timer.Stop();
    }

    private static List<(string role, string content)> RecoveryHistory(ChatThread thread, ChatMessage? live)
    {
        var messages = thread.Messages;
        var end = live is null ? messages.Count : messages.IndexOf(live);
        if (end < 0) end = messages.Count;
        var history = new List<(string role, string content)>();
        for (var i = 0; i < end; i++)
        {
            var user = messages[i];
            if (user.Role != "user") continue;
            if (i + 1 >= end || messages[i + 1].Role != "agent" || messages[i + 1].Status != "ok") break;
            if (!string.IsNullOrWhiteSpace(user.Text)) history.Add(("user", user.Text));
            var assistant = messages[++i];
            if (!string.IsNullOrWhiteSpace(assistant.Text)) history.Add(("assistant", assistant.Text));
        }
        return history.TakeLast(40).ToList();
    }

    /// <summary>Подключение к сессии конкретного ЗАПУСКА. Соединение принадлежит
    /// запуску, а не вкладке: переключение чата больше не трогает транспорт
    /// фонового диалога, и его стриминг не прерывается. Переподключение внутри
    /// одного запуска (обрыв WS) восстанавливает именно его stored session id.</summary>
    private async Task<TuiGateway> EnsureTuiAsync(ChatRun run, CancellationToken ct)
    {
        var thread = run.Thread;
        var address = TuiBaseOf(thread);
        var addressKey = address.ToString();
        if (run.Gateway is { Connected: true } && run.Bridge is not null && run.Address == addressKey)
            return run.Gateway;

        run.StopTransport();

        // Внешний шлюз обслуживает ТУННЕЛЬ или удалённую машину — локально
        // поднимать serve нельзя (порт может быть уже занят туннелем).
        await ServeProcess.EnsureAsync(address, ct, allowLocalSpawn: GatewayOf(thread) is null);
        var gateway = new TuiGateway(address);
        await gateway.ConnectAsync(ct);
        var bridge = new TuiEventBridge(gateway, item => Dispatcher.BeginInvoke(new Action(() =>
        {
            try { Apply(run, item); }
            catch (Exception error) { CrashLog.Write("Событие шлюза: " + error); }
            finally { run.Completion?.UiApplied(item.Event); }
        })));
        run.Gateway = gateway;
        run.Bridge = bridge;
        run.Address = addressKey;
        // Запросы шлюза адресуются ЗАПУСКУ, а не «текущему чату»: без этого
        // вопрос, пришедший в фоновый диалог, уезжал в ленту другого чата.
        gateway.OnServerRequest += (id, method, parameters) => OnServerRequest(run, id, method, parameters);
        gateway.OnDisconnected += () => Dispatcher.BeginInvoke(new Action(() =>
        {
            if (!ReferenceEquals(run.Gateway, gateway)) return;
            if (run.Message.Status == "running")
            {
                run.Message.Status = "failed";
                run.Message.Note = "Соединение со шлюзом закрыто без финального ответа. Проверь сервер перед повтором.";
            }
            run.Completion?.Cancel();
        }));

        var title = thread.Title.Length > 0 ? thread.Title : "HermesChat";
        if (title.StartsWith("Новый диалог", StringComparison.Ordinal)) title = "HermesChat";
        var stored = thread.RemoteSessionId;
        if (stored.Length > 0)
        {
            try
            {
                await gateway.ResumeSessionAsync(stored, ct);
                thread.RemoteSessionId = gateway.StoredSessionId;
            }
            catch (TuiRpcException error) when (error.Code == 4007)
            {
                // Старые версии сохраняли runtime id; восстанавливаем локальную историю
                // именно этого диалога, не того, который мог быть выбран во время await.
                var live = run.Message;
                await gateway.CreateSessionAsync(title, ct, RecoveryHistory(thread, live));
                thread.RemoteSessionId = gateway.StoredSessionId;
                live.Note = "Старая сессия шлюза устарела; восстановил историю в новой сессии.";
            }
        }
        else
        {
            await gateway.CreateSessionAsync(title, ct);
            thread.RemoteSessionId = gateway.StoredSessionId;
        }
        _store.Save();
        if (ReferenceEquals(_thread, thread)) UpdateHeader();
        return gateway;
    }

    /// <summary>Адрес шлюза для WS: локальный api_server отображаем на hermes serve, удалённый — на его адрес.</summary>
    private Uri TuiBaseOf(ChatThread? thread)
    {
        var gateway = GatewayOf(thread);
        if (gateway is null || IsLocalApiServerGateway(gateway))
            return new Uri("http://127.0.0.1:9119");

        // Внешний шлюз: `hermes serve` поднят на своей машине, локально запускать
        // нечего. Для ТУННЕЛЯ (адрес 127.0.0.1:<проброшенный порт>) это не так:
        // процесс уже работает, и попытка поднять второй на том же порту упрётся
        // в занятый порт и отдаст невнятное «не поднялся».
        var url = gateway.Url;
        if (!url.StartsWith("http", StringComparison.OrdinalIgnoreCase)) url = "http://" + url;
        return new Uri(url.TrimEnd('/'));
    }

    private bool IsLocalApiServerGateway(Gateway gateway)
    {
        if (!gateway.Kind.Equals("hermes", StringComparison.OrdinalIgnoreCase)
            || !Uri.TryCreate(gateway.Url, UriKind.Absolute, out var target)
            || !Uri.TryCreate(_store.Settings.NormalizedBase, UriKind.Absolute, out var api))
            return false;
        return target.IsLoopback && api.IsLoopback
            && target.Scheme.Equals(api.Scheme, StringComparison.OrdinalIgnoreCase)
            && target.Port == api.Port;
    }

    /// <summary>Server-to-client requests, including approvals and batch clarification questions.</summary>
    private void OnServerRequest(ChatRun run, string id, string method, JsonNode? parameters)
    {
        Dispatcher.BeginInvoke(new Action(() =>
        {
            var payload = parameters?["payload"] as JsonObject ?? parameters as JsonObject;
            var live = run.Message;
            if (method == "clarify")
            {
                var questions = ClarifyRequestParser.Parse(parameters);
                if (questions.Count == 0)
                {
                    _ = AnswerFrameAsync(id, "clarify", run.Gateway, new JsonObject()); // cancel-all
                    return;
                }
                live.ClarifyRequestId = id;
                live.ClarifyQuestions = questions;
                live.WaitingClarification = true;
                live.Note = "Нужно ответить на вопросы агента.";
                RememberRequest("clarify", id, run.Gateway, live);
                _store.Save();
                RefreshRequestBar();
                if (ReferenceEquals(_thread, run.Thread)) UpdateHeader();
                return;
            }
            if (method != "approval")
            {
                _ = AnswerFrameAsync(id, method, run.Gateway, new JsonObject { ["decline"] = "not_shown" });
                return;
            }

            var choices = new List<string>();
            if (payload?["choices"] is JsonArray list)
                foreach (var choice in list)
                {
                    var name = choice?.ToString() ?? "";
                    if (name.Length > 0) choices.Add(name);
                }
            if (choices.Count == 0) choices.AddRange(new[] { "once", "deny" });

            // id для ответа — ВНЕШНИЙ (id кадра server→client), а request_id из
            // payload — внутренний id записи в очереди tools/approval. Отвечать
            // нужно первым: по нему шлюз закрывает именно этот кадр.
            run.ApprovalRequestId = id;
            live.WaitingApproval = true;
            live.ApprovalCommand = (payload?["command"]?.ToString() ?? "").Length > 0
                ? payload!["command"]!.ToString()
                : (payload?["tool"]?.ToString() ?? "");
            live.ApprovalTool = payload?["tool_name"]?.ToString() ?? payload?["tool"]?.ToString() ?? "";
            live.ApprovalRequestId = payload?["request_id"]?.ToString() ?? id;
            live.ApprovalChoices = choices;
            live.Note = "Нужно твоё решение: " + Trim(live.ApprovalCommand, 160);
            RememberRequest("approval", id, run.Gateway, live);
            WatchApproval(run);
            RefreshRequestBar();
        }));
    }

    /// <summary>Ответ на открытый запрос шлюза. Соединение берётся из РЕЕСТРА
    /// запросов, а не из запуска: разрешение может пережить сам запуск, и ответ
    /// по «текущему» сокету ушёл бы в чужой диалог или никуда.</summary>
    private async Task AnswerPendingAsync(PendingRequestStore<ChatMessage, TuiGateway>.Entry request, JsonObject result)
    {
        await AnswerFrameAsync(request.Id, request.Kind, request.Transport, result);
    }

    /// <summary>Ответ на кадр server→client по конкретному сокету. Сокет берётся
    /// из реестра запроса, а не у вкладки: у «текущего» диалога он может быть
    /// чужим или уже закрытым.</summary>
    private static async Task AnswerFrameAsync(string id, string kind, TuiGateway? gateway, JsonObject result)
    {
        try
        {
            if (gateway is not null) await gateway.AnswerAsync(id, result);
            else CrashLog.Write("Ответ шлюзу: соединение запроса уже закрыто (" + kind + ").");
        }
        catch (Exception error)
        {
            CrashLog.Write("Ответ шлюзу: " + error);
        }
    }

    /// <summary>Кнопка разрешения. Ищет запрос по id СООБЩЕНИЯ в реестре запросов и
    /// отвечает по нему. Раньше здесь был поиск запуска: если ответа ещё не было
    /// (очередь шлюза) или запуск уже завершился, поиск давал null — и клик
    /// молча ничего не делал, блок висел вечно.</summary>
    private async void OnApproveClick(object sender, RoutedEventArgs e)
    {
        if (sender is not FrameworkElement { Tag: string tag }) return;
        var parts = tag.Split('|');
        if (parts.Length < 2) return;
        var messageId = parts[0];
        var choice = parts[1];

        var pending = _pendingRequests.FindByMessage("approval", messageId, m => m.Id);
        if (pending is null)
        {
            // Запрос уже закрыт шлюзом (request.cancel) или ответ был дан.
            // Блок убираем, а не оставляем висеть навсегда.
            var stale = FindMessage(messageId);
            if (stale is not null)
            {
                stale.WaitingApproval = false;
                stale.ApprovalRequestId = "";
                stale.Note = "Окно разрешения уже закрыто: шлюз снял вопрос.";
                _store.Save();
            }
            RefreshRequestBar();
            Render();
            return;
        }

        TakeRequest("approval", pending.Id);
        var live = pending.Message;
        live.WaitingApproval = false;
        live.ApprovalRequestId = "";
        await AnswerPendingAsync(pending, new JsonObject
        {
            ["choice"] = choice,
            ["all"] = choice is "session" or "always",
        });
        live.Note = "Ответ отправлен: " + choice;
        _store.Save();
        RefreshRequestBar();
        Render();
        UpdateStats();
    }

    /// <summary>Закрыть запрос без ответа. Шлюз получит отказ и освободит очередь
    /// агента: иначе блок, который нельзя закрыть, держал запуск до таймаута.</summary>
    private async void OnRequestDismiss(object sender, RoutedEventArgs e)
    {
        if (sender is not FrameworkElement { Tag: string messageId }) return;
        var pending = _pendingRequests.FindByMessage("approval", messageId, m => m.Id)
                      ?? _pendingRequests.FindByMessage("clarify", messageId, m => m.Id);
        if (pending is not null)
        {
            TakeRequest(pending.Kind, pending.Id);
            // Отказ, а не пустой ответ: пустой clarify означает «пропустить всё»,
            // а approval без choice шлюз читает как deny — это ровно то, что нужно.
            await AnswerPendingAsync(pending, new JsonObject
            {
                ["choice"] = "deny",
                ["decline"] = "dismissed",
            });
        }
        var message = FindMessage(messageId);
        if (message is not null)
        {
            message.WaitingApproval = message.WaitingClarification = false;
            message.ApprovalRequestId = message.ClarifyRequestId = "";
            message.Note = "Запрос закрыт без ответа.";
            _store.Save();
        }
        RefreshRequestBar();
        Render();
    }

    private ChatMessage? FindMessage(string messageId) =>
        _store.Threads.SelectMany(thread => thread.Messages)
            .FirstOrDefault(message => string.Equals(message.Id, messageId, StringComparison.Ordinal));

                /// <summary>Подсказка в идущий запуск. Пустое поле означает обычную отправку.</summary>
                private async void OnSteerSend(object sender, RoutedEventArgs e)
                {
                    var run = CurrentRun;
                    var text = SteerInput.Text.Trim();
                    if (run is null || text.Length == 0 || run.Message.RunId.Length == 0) return;
                    var live = run.Message;
                    try
                    {
                        await ClientFor(run.Thread).SteerAsync(live.RunId, text);
                        live.Steers.Add(text);
                        SteerInput.Clear();
                        live.Note = "Подсказка отправлена агенту";
                        Render();
        }
        catch (Exception error)
        {
            CrashLog.Write("Steer: " + error);
            MessageBox.Show("Подсказку не приняли: " + error.Message, "HermesChat",
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private FrameworkElement BuildToolRow(ToolStep step)
    {
        var visual = ToolVisuals.For(step.Tool);
        var generating = step.Running && step.Phase == "generating";
        var stateBrush = step.Error ? Find("Bad") : generating ? Find("Warn")
            : step.Running ? Find("Accent") : Find("Good");
        var stateText = step.Error ? "✕  ошибка"
            : generating ? "●  формирует вызов…"
            : step.Running ? "●  выполняется…"
            : step.Seconds > 0 ? $"✓  готово · {step.Seconds:0.#} с" : "✓  готово";

        var icon = new Border
        {
            Width = 32,
            Height = 32,
            CornerRadius = new CornerRadius(8),
            Background = Find("Bg"),
            BorderBrush = Find("Line"),
            BorderThickness = new Thickness(1),
            Margin = new Thickness(0, 0, 9, 0),
            Child = new TextBlock
            {
                Text = visual.Icon,
                FontSize = 17,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            }
        };
        var status = new TextBlock
        {
            Text = stateText,
            Foreground = stateBrush,
            FontSize = 10.5,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(8, 0, 0, 0)
        };
        var title = new TextBlock
        {
            Text = visual.Title,
            FontSize = 12,
            FontWeight = FontWeights.SemiBold,
            Foreground = Find("Fg"),
            VerticalAlignment = VerticalAlignment.Center,
            TextTrimming = TextTrimming.CharacterEllipsis,
            ToolTip = step.Tool
        };
        var line = new DockPanel { LastChildFill = true };
        DockPanel.SetDock(status, Dock.Right);
        line.Children.Add(status);
        DockPanel.SetDock(icon, Dock.Left);
        line.Children.Add(icon);
        line.Children.Add(title);

        var content = new StackPanel();
        content.Children.Add(line);
        var detail = step.Running ? step.Preview : step.Result.Length > 0 ? step.Result : step.Preview;
        if (detail.Length > 0)
            content.Children.Add(new TextBlock
            {
                Text = Trim(detail, 220),
                FontSize = 10.5,
                Foreground = Find("Dim"),
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(41, 4, 0, 0)
            });
        return new Border
        {
            Tag = step,
            Background = Find("Panel"),
            BorderBrush = step.Running || step.Error ? stateBrush : Find("Line"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(8, 6, 8, 6),
            Margin = new Thickness(2, 2, 2, 2),
            Child = content
        };
    }

    private void RefreshInterimRows(Panel rows, ChatMessage message)
    {
        var oldRows = rows.Children.OfType<Border>()
            .Where(child => child.Tag as string == "interim-segment").ToList();
        foreach (var child in oldRows) rows.Children.Remove(child);
        if (message.InterimSegments.Count == 0) return;

        var toolHeader = rows.Children.OfType<TextBlock>()
            .FirstOrDefault(child => child.Tag as string == "tools-header");
        var body = rows.Children.OfType<Border>()
            .FirstOrDefault(child => child.Tag as string == "message-body");
        FrameworkElement? anchor = (FrameworkElement?)toolHeader ?? body;
        var index = anchor is null ? rows.Children.Count : rows.Children.IndexOf(anchor);
        foreach (var segment in message.InterimSegments)
        {
            var view = MarkdownRenderer.Render(segment, _store.Settings.FontSize, Find("Fg"),
                Find("Dim"), Find("Bg"), Find("Line"), Find("Accent"), Find("Panel"));
            rows.Children.Insert(index++, new Border
            {
                Tag = "interim-segment",
                Background = Find("Bg"),
                BorderBrush = Find("Line"),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(6),
                Padding = new Thickness(8, 6, 8, 6),
                Margin = new Thickness(2, 3, 2, 5),
                Child = view
            });
        }
    }

    /// <summary>Пересобирает блок процесса перед телом ответа, чтобы финальный текст
    /// оставался последним элементом ассистентского пузыря.</summary>
    private void RefreshToolRows(Panel rows, ChatMessage message)
    {
        var oldHeader = rows.Children.OfType<TextBlock>()
            .FirstOrDefault(child => child.Tag as string == "tools-header");
        if (oldHeader is not null) rows.Children.Remove(oldHeader);
        var oldRows = rows.Children.OfType<Border>()
            .Where(child => child.Tag is ToolStep).ToList();
        foreach (var child in oldRows) rows.Children.Remove(child);

        if (!_store.Settings.ShowTools || message.Tools.Count == 0) return;
        LiveBubbleAccess.InsertBeforeBody(rows, new TextBlock
        {
            Tag = "tools-header",
            Text = "Работа агента",
            FontSize = 11,
            Foreground = Find("Dim"),
            Margin = new Thickness(2, 10, 0, 3)
        });
        foreach (var step in message.Tools)
            LiveBubbleAccess.InsertBeforeBody(rows, BuildToolRow(step));
    }

    private FrameworkElement BuildAttachmentChip(Attachment file)
    {
        var inner = new StackPanel { Orientation = Orientation.Horizontal };
        if (file.PreviewBase64 is { Length: > 0 })
        {
            try
            {
                var image = new System.Windows.Media.Imaging.BitmapImage();
                image.BeginInit();
                image.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad;
                image.StreamSource = new MemoryStream(Convert.FromBase64String(file.PreviewBase64));
                image.DecodePixelHeight = 64;
                image.EndInit();
                image.Freeze();
                inner.Children.Add(new Image
                {
                    Source = image,
                    Height = 44,
                    Margin = new Thickness(0, 0, 8, 0),
                    ToolTip = file.Path
                });
            }
            catch (Exception) { /* превью не получилось — покажем только имя */ }
        }
        inner.Children.Add(new TextBlock
        {
            Text = file.Name + "  " + file.SizeText,
            VerticalAlignment = VerticalAlignment.Center,
            FontSize = 12,
            Foreground = Find("Fg"),
            ToolTip = file.Path
        });
        return new Border
        {
            Background = Find("Bg"),
            BorderBrush = Find("Line"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(6),
            Padding = new Thickness(8, 6, 8, 6),
            Margin = new Thickness(0, 0, 8, 0),
            Child = inner
        };
    }

    private static string RoleName(ChatMessage message) => message.Role switch
    { "user" => "Ты", "agent" => "Hermes", _ => message.Role };

    /// <summary>Пузырь активного ответа. Раньше он искался по индексу сообщения в
        /// ленте, а это индекс во всём диалоге: у подхваченной сессии сообщений
        /// сотни, лента рисует хвост, и обращение вылетало за границы на КАЖДЫЙ
        /// токен. Обработчик глотал исключение, лента молчала до конца, и ответ
        /// появлялся сразу готовым — выглядело как «стрима нет».</summary>
        /// <summary>Пузырь активного ответа. Раньше он искался по индексу сообщения в
    /// ленте, а это индекс во всём диалоге: у подхваченной сессии сообщений
    /// сотни, лента рисует хвост, и обращение вылетало за границы на КАЖДЫЙ
    /// токен. Обработчик глотал исключение, лента молчала до конца, и ответ
    /// появлялся сразу готовым — выглядело как «стрима нет».</summary>
    private Border? _liveBubble;
    private long _lastPaint;
    private long _lastFollow;
    private int _streamEvents;

    /// <summary>
    /// Поток текста. Ключевой момент: <c>TextBlock.Text</c> на длинном ответе
    /// ломает раскладку всего дерева ленты, а лента — это сотни пузырей с
    /// переносом строк. Ставить его на каждый дельт значит верстать весь чат
    /// сотни раз за ответ: UI перестаёт отвечать, и выглядит это как «прога
    /// подвисла, пока модель думает». Поэтому текст перерисовывается не чаще
    /// раза в ~60 мс — глаз не видит разницы, а верстка случается в разы
    /// реже. Прокрутка и статистика — ещё реже, раз в ~400 мс.
    /// </summary>
    private void PatchLive(ChatRun run)
    {
        // Рисуем только свой диалог. События фоновых запусков идут в модель,
        // но перерисовку ленты чужого чата не трогают — иначе открытый чат
        // дёргался бы на каждый токен соседнего.
        var live = run.Message;
        if (!ReferenceEquals(run.Thread, _thread) || _liveBubble is null) return;
        var now = Environment.TickCount64;
        var paintDue = now - _lastPaint >= 60;
        if (paintDue)
        {
            _lastPaint = now;
            try
            {
                if (LiveBubbleAccess.TryGetContent(_liveBubble, out var stack, out var meta, out var body))
                {
                    body.Child = MarkdownRenderer.Render(live.Body.Length > 0 ? live.Body : "…",
                        _store.Settings.FontSize, Find("Fg"), Find("Dim"), Find("Bg"),
                        Find("Line"), Find("Accent"), Find("Panel"));
                    meta.Text = "Hermes · " + StatusLine(live);
                    RefreshInterimRows(stack, live);
                    RefreshToolRows(stack, live);
                }
                else CrashLog.Write("Поток в ленте: не найдена структура активного пузыря.");
            }
            catch (Exception error)
            {
                // Один сбой отрисовки не должен ронять весь ответ: лента обновится
                // финальным Render, а причина останется в логе.
                CrashLog.Write("Поток в ленте: " + error);
            }
        }
        if (now - _lastFollow < 400) return;
        _lastFollow = now;
        UpdateStats();
        ScrollToEnd();
    }

    /// <summary>Прокрутка в конец ленты. Планировщик вызывается на каждый токен,
    /// поэтому задача не плодится: пока предыдущая ещё в очереди, новая не
    /// ставится. Иначе за длинный ответ очередь Dispatcher растёт быстрее,
    /// чем выполняется, и окно перестаёт отвечать.</summary>
    private bool _scrollQueued;

    private void ScrollToEnd()
    {
        if (_scrollQueued) return;
        _scrollQueued = true;
        Dispatcher.BeginInvoke(new Action(() =>
        {
            _scrollQueued = false;
            try
            {
                // ScrollToEnd на ленте в сотни пузырей тянет за собой полную
                // перевёрстку всего дерева. Если человек сам ушёл читать вверх,
                // догонять хвост не нужно — это и есть главный источник «зависает».
                var atBottom = FeedScroll.ScrollableHeight <= 0
                               || FeedScroll.VerticalOffset >= FeedScroll.ScrollableHeight - FeedScroll.ViewportHeight - 60;
                if (atBottom) FeedScroll.ScrollToEnd();
            }
            catch (Exception) { /* лента ещё не измерена */ }
        }), DispatcherPriority.Background);
    }

    // ---------- отправка ----------

    private void OnInputKey(object sender, KeyEventArgs e)
    {
        // Main keyboard Enter is Key.Return; Key.Enter is the numeric keypad variant.
        if (e.Key is not (Key.Enter or Key.Return)) return;
        if ((Keyboard.Modifiers & (ModifierKeys.Shift | ModifierKeys.Control)) != 0) return;
        e.Handled = true;
        OnSend(sender, e);
    }

    private async void OnSend(object sender, RoutedEventArgs e)
    {
        var thread = _thread;
        var count = thread?.Messages.Count ?? 0;
        await SendWorkspaceCoreAsync();
        var reply = thread?.Messages.Skip(count).LastOrDefault(m => m.IsAgent && m.Status == "ok");
        if (thread is not null && reply is not null && HumanReplyCompleted is not null)
            await HumanReplyCompleted(thread, reply.Text);
    }

    private async Task SendWorkspaceCoreAsync(CancellationToken cancellation = default, bool automated = false)
    {
        var text = Input.Text.Trim();
        if ((text.Length == 0 && _pending.Count == 0) || _thread is null) return;
        var conversation = _thread;
        // Один активный ответ на ДИАЛОГ, а не на окно: другой чат можно
        // отправить одновременно, его ответ пойдёт своим потоком.
        if (_runs.IsBusy(conversation.Id))
        { MessageBox.Show("В этом диалоге уже идёт ответ. Дождитесь завершения или нажмите STOP.", "Чат занят"); return; }
        // Проверяем адрес И ЭТОГО диалога: у внешнего шлюза свой адрес и свой токен,
        // и проверка локальных настроек заблокировала бы разговор с ним.
        if (!ReadyFor(conversation))
        {
            MessageBox.Show(conversation.GatewayId.Length > 0
                ? "У этого шлюза не заполнены адрес или токен. Открой «Внешние шлюзы» и заполни."
                : "Сначала укажи адрес и ключ шлюза в настройках.", "HermesChat");
            return;
        }

        if (_store.ChatRuns.Contains(conversation.Id))
        { MessageBox.Show("В этом чате уже идёт ответ. Дождитесь завершения или нажмите STOP.", "Чат занят"); return; }
        cancellation.ThrowIfCancellationRequested();
        Input.Clear();
        var attachments = _pending.ToList();
        _pending.Clear();
        ShowAttachments();
        // Обычная переписка: на шлюз уходит ровно то, что владелец напечатал.
        // Никаких «Контекст профиля», инструкций специализации и пакетов
        // ассетов — они превращали диалог в отчёт о себе и мешали просто писать.
        // Прикреплённые файлы оставляем: агент без путей их не прочитает.
        string payload;
        try
        {
            payload = ComposeInput(text, attachments, skills: []);
        }
        catch (Exception error) { Input.Text = text; MessageBox.Show(error.Message, "Пакет агента"); return; }
        _store.ChatRuns.Add(conversation.Id);
        var user = new ChatMessage { Role = "user", Text = text, Attachments = attachments };
        var agent = new ChatMessage { Role = "agent", Status = "running", AssetVersions = _store.Assets.Where(a => (ProfileOf(conversation)?.AssetIds ?? new()).Contains(a.Id)).ToDictionary(a => a.Id, a => a.Version) };
        conversation.Messages.Add(user);
        conversation.Messages.Add(agent);
        if (conversation.Title.StartsWith("Новый диалог", StringComparison.Ordinal))
        {
            var basis = text.Length > 0 ? text : attachments[0].Name;
            conversation.Title = basis.Length > 60 ? basis[..60] + "…" : basis;
        }
        RefreshThreadGroups();
        // Запуск регистрируется ДО отправки: события шлюза начнут приходить сразу
        // после prompt.submit и должны находить своё состояние. Реестр
        // заодно не даст начать второй ответ в этом же диалоге.
        _runs.TryBegin(conversation.Id, conversation, agent, out var run);
        if (run is null) return;
        if (ReferenceEquals(_thread, conversation)) UpdateHeader();
        Render();
        SetBusy(true);

        var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        run.Cts = cts;
        try
        {
            // TUI gateway: сессия и разговор живут на шлюзе, ответ приходит
            // событиями по WS. Соединение принадлежит запуску, поэтому чаты
            // работают параллельно, а не вытесняют друг друга.
            var gateway = await EnsureTuiAsync(run, cts.Token);
            var completion = new TuiCompletionSignal();
            run.Completion = completion;
            try
            {
                using var done = cts.Token.Register(completion.Cancel);
                await gateway.SubmitAsync(payload, cts.Token);
                // Ждём не только прихода message.complete, но и применения run.completed к модели/UI.
                await completion.Task;
            }
            finally
            {
                if (ReferenceEquals(run.Completion, completion)) run.Completion = null;
            }
        }
        catch (OperationCanceledException) when (cts.IsCancellationRequested)
        {
            agent.Status = "stopped";
            agent.WaitingApproval = agent.WaitingClarification = false;
            agent.ApprovalRequestId = agent.ClarifyRequestId = "";
            agent.Note = "Отправка остановлена. Проверь сервер: запущенные процессы могут продолжаться.";
        }
        catch (Exception error)
        {
            agent.Status = "failed";
            agent.Note = error is HermesException ? error.Message : "Ошибка: " + error.Message;
            CrashLog.Write("Отправка: " + error);
        }
        finally
        {
            _store.ChatRuns.Remove(conversation.Id);
            if (agent.Streaming.Length > 0 && agent.Text.Length == 0) agent.Text = agent.Streaming;
            agent.Streaming = "";
            if (agent.Status == "running") { agent.Status = "partial"; agent.Note = "Поток событий закрылся без ответа."; }
            if (ReferenceEquals(run.Cts, cts)) run.Cts = null;
            try { cts.Dispose(); } catch (ObjectDisposedException) { }
            // Запуск закрыт, но соединение оставляем: следующее сообщение в этом
            // диалоге продолжит ту же сессию шлюза без нового handshake.
            _runs.End(conversation.Id);
            StopApprovalWatch(conversation.Id);
            if (ReferenceEquals(_thread, conversation)) _liveBubble = null;
            // Счётчик и история обновляются у того диалога, который отправил запрос,
            // даже если пользователь успел перейти в другой чат.
            if (conversation.ProfileId.Length > 0)
            {
                var profile = _store.Profiles.FirstOrDefault(p => p.Id == conversation.ProfileId);
                if (profile is not null) profile.ThreadMessages = conversation.Messages.Count;
            }
            conversation.UpdatedAt = DateTimeOffset.Now.ToUnixTimeSeconds();
            _store.Save();
            SetBusy(false);
            RefreshThreadGroups();
            RefreshRequestBar();
            if (ReferenceEquals(_thread, conversation))
            {
                UpdateHeader();
                Render();
                UpdateStats();
            }
            if (ReferenceEquals(_thread, conversation)) Input.Focus();
        }
    }

    /// <summary>Применяет событие потока к сообщению СВОЕГО запуска.</summary>
    private void Apply(ChatRun run, RunEvent item)
    {
        var _live = run.Message;
        // Счётчик событий потока виден в интерфейсе: по нему сразу видно, идут ли
        // дельты от шлюза или приложение их не получает. Без него «нет стрима» и
        // «модель думает» выглядят одинаково.
        run.StreamEvents++;
        _streamEvents = run.StreamEvents;
        switch (item.Event)
        {
            case "tool.generating" when _store.Settings.ShowTools:
            {
                var step = _live.Tools.LastOrDefault(s => s.Tool == item.Tool && s.Running);
                if (step is null)
                {
                    step = new ToolStep { Tool = item.Tool, Running = true, Phase = "generating" };
                    _live.Tools.Add(step);
                }
                else step.Phase = "generating";
                _live.Note = "";
                break;
            }
            case "tool.started" when _store.Settings.ShowTools:
            {
                // tool.start обновляет карточку tool.generating; не создаём вторую строку.
                var step = _live.Tools.LastOrDefault(s => s.Tool == item.Tool && s.Running && s.Phase == "generating")
                    ?? _live.Tools.LastOrDefault(s => s.Running && s.Phase == "generating");
                if (step is null)
                {
                    step = new ToolStep { Tool = item.Tool };
                    _live.Tools.Add(step);
                }
                step.Tool = item.Tool;
                step.Preview = Trim(item.Preview, 300);
                step.Running = true;
                step.Error = false;
                step.Phase = "running";
                _live.Note = "";
                break;
            }
            case "tool.completed" when _store.Settings.ShowTools:
            {
                // Ищем незакрытый вызов того же инструмента: события не гарантируют парность по имени.
                var step = _live.Tools.LastOrDefault(s => s.Tool == item.Tool && s.Running)
                    ?? _live.Tools.LastOrDefault(s => s.Running);
                if (step is null)
                {
                    step = new ToolStep { Tool = item.Tool };
                    _live.Tools.Add(step);
                }
                step.Tool = item.Tool.Length > 0 ? item.Tool : step.Tool;
                step.Running = false;
                step.Error = item.Error;
                step.Phase = item.Error ? "failed" : "completed";
                step.Seconds = item.Duration;
                step.Result = Trim(item.Preview, 400);
                _live.Note = "";
                break;
            }
            case "message.delta":
                _live.Streaming += item.Delta;
                break;
            case "message.interim" when !item.AlreadyStreamed && item.Text.Length > 0:
                _live.InterimSegments.Add(item.Text);
                break;
            case "approval.request":
                // Запуск стоит и ждёт решения. Без явного блока с кнопками он молчал бы
                // вечно, и пользователь не понимал бы, почему «агент завис».
                _live.WaitingApproval = true;
                WatchApproval(run);
                _live.ApprovalCommand = item.Command.Length > 0 ? item.Command : item.Preview;
                _live.ApprovalTool = item.ToolName.Length > 0 ? item.ToolName : item.Tool;
                _live.ApprovalRequestId = item.RequestId;
                _live.ApprovalChoices = item.Choices.Count > 0
                    ? new List<string>(item.Choices)
                    : new List<string> { "once", "deny" };
                _live.Note = "Нужно твоё решение: " + Trim(_live.ApprovalCommand, 160);
                break;
            case "approval.resolved":
            case "approval.decided":
            {
                var clarified = _live.WaitingClarification;
                _live.WaitingApproval = false;
                _live.WaitingClarification = false;
                _live.ClarifyRequestId = "";
                _live.ApprovalRequestId = "";
                _live.Note = clarified
                    ? "Уточнение снято шлюзом."
                    : "Решение принято: " + Trim(item.Choice.Length > 0 ? item.Choice : "подтверждено", 80);
                break;
            }
            case "reasoning.available" when _store.Settings.ShowReasoning:
                _live.Note = "Размышление: " + Trim(item.Text, 140);
                break;
            case "run.completed":
                ApplyUsage(_live, item);
                _live.Text = item.Output;
                if (item.Reasoning.Length > 0) _live.Reasoning = item.Reasoning;
                _live.Status = "ok";
                _live.ToolCount = _live.Tools.Count;
                _live.Note = "";
                break;
            case "usage":
                // Расход приходит отдельным событием session.usage ещё до финала.
                ApplyUsage(_live, item);
                UpdateStats();
                break;
            case "tool.generating":
                _live.Note = "Готовит вызов: " + Trim(item.Tool, 80);
                break;
            case "reasoning.chunk":
                // Поток рассуждения не трогаем: он целиком покажется в run.completed.
                break;
            case "status" when item.Text.Length > 0 && item.Text.Length < 160:
                _live.Note = Trim(item.Text, 140);
                break;
            case "run.failed":
                _live.Status = "failed";
                _live.Note = Trim(item.Message.Length > 0 ? item.Message : "Агент сообщил об ошибке.", 300);
                break;
            case "run.cancelled":
                _live.Status = "stopped";
                _live.Note = "Остановлено.";
                break;
            case "run.interrupted":
                _live.Status = "partial";
                _live.Note = "Gateway прервал запуск.";
                break;
        }
        // Один вызов на любое событие: условие «run.* или не run.*» давало
        // ровно то же самое и только путало при чтении.
        RefreshRequestBar();
        PatchLive(run);
    }

    /// <summary>Переносит usage/runtime из события или из ответа опроса в сообщение.</summary>
    private static void ApplyUsage(ChatMessage message, RunEvent item)
    {
        message.InputTokens = item.InputTokens;
        message.OutputTokens = item.OutputTokens;
        message.TotalTokens = item.TotalTokens > 0 ? item.TotalTokens : item.InputTokens + item.OutputTokens;
        message.ReasoningTokens = item.ReasoningTokens;
        message.CacheReadTokens = item.CacheReadTokens;
        message.CacheWriteTokens = item.CacheWriteTokens;
        message.ContextUsedTokens = item.ContextUsedTokens;
        message.ContextMaxTokens = item.ContextMaxTokens;
        message.ContextPercent = item.ContextPercent;
        message.CacheHitPercent = item.CacheHitPercent;
        message.ContextSource = item.ContextSource;
        message.ContextEstimated = item.ContextEstimated;
        if (item.CostUsd is double cost) message.CostUsd = cost;
        if (item.CostStatus.Length > 0) message.CostStatus = item.CostStatus;
        if (item.AverageLatencySeconds is double latency) message.AverageLatencySeconds = latency;
        if (item.AverageTokensPerSecond is double tps) message.AverageTokensPerSecond = tps;
        if (item.RuntimeModel.Length > 0) message.Model = item.RuntimeModel;
        if (item.Provider.Length > 0) message.Provider = item.Provider;
        if (item.RouteSource.Length > 0) message.RouteSource = item.RouteSource;
        if (item.DurationMs > 0) message.DurationMs = item.DurationMs;
    }

    /// <summary>Метрики одного ответа: токены, контекст, кэш и только известная стоимость.</summary>
    private static string UsageLine(ChatMessage message) => ChatDiagnostics.UsageLine(
        message.InputTokens, message.OutputTokens, message.ContextUsedTokens, message.ContextMaxTokens,
        message.ContextPercent, message.CacheReadTokens, message.CacheWriteTokens, message.CacheHitPercent,
        message.CostUsd, message.CostStatus, message.Provider, message.Model)
        + (message.ToolCount > 0 ? $" · инструментов {message.ToolCount}" : "")
        + (message.DurationMs > 0 ? $" · {message.DurationMs / 1000.0:0.#} с" : "")
        + (message.ReasoningTokens > 0 ? $" · reasoning {message.ReasoningTokens:N0}" : "");

    /// <summary>Итог по диалогу — то, что в консоли видно как расход сессии.</summary>
    private void UpdateStats()
    {
        if (_thread is null) { StatsText.Text = ""; StatsText.ToolTip = null; return; }
        var turns = _thread.Messages.Where(m => m.IsAgent && m.Status == "ok").ToList();
        var currentRun = CurrentRun;
        if (currentRun?.Message is { IsAgent: true, Status: "running" } live && !turns.Contains(live))
            turns.Add(live);
        // Счётчик событий — от открытого диалога: пока ты смотришь другой чат,
        // строка метрик показывает его, а не фонового соседа.
        _streamEvents = currentRun?.StreamEvents ?? _streamEvents;
        if (turns.Count == 0)
        {
            StatsText.Text = $"Поток: {_streamEvents} событий · метрики появятся после ответа.";
            StatsText.ToolTip = DiagnosticIdsText();
            return;
        }
        var last = turns[^1];
        var completedTurns = turns.Count(m => m.Status == "ok");
        var activeTurn = currentRun?.Message is { IsAgent: true, Status: "running" };
        // Фоновые ответы видны в шапке: иначе про чат, который ещё думает,
        // нельзя было бы узнать вообще нигде.
        var background = _runs.BackgroundCount(_thread.Id);
        var input = turns.Sum(m => m.InputTokens);
        var output = turns.Sum(m => m.OutputTokens);
        var total = turns.Sum(m => m.TotalTokens > 0 ? m.TotalTokens : m.InputTokens + m.OutputTokens);
        var cacheRead = turns.Sum(m => m.CacheReadTokens);
        var cacheWrite = turns.Sum(m => m.CacheWriteTokens);
        var tools = turns.Sum(m => m.ToolCount);
        var priced = turns.Where(m => m.CostUsd.HasValue).ToList();
        var cost = priced.Count == 0 ? "стоимость —"
            : $"стоимость ${priced.Sum(m => m.CostUsd!.Value).ToString("0.000000", System.Globalization.CultureInfo.InvariantCulture)} USD"
              + (priced.Count < turns.Count ? " (частично)" : "");
        StatsText.Text =
            $"Ходы {completedTurns}{(activeTurn ? " + 1 сейчас" : "")} · поток {_streamEvents} · токены вход {input:N0} / выход {output:N0} / всего {total:N0}"
            + $" · кэш {cacheRead:N0} чтение / {cacheWrite:N0} запись · инструменты {tools} · {cost}"
            + (background > 0 ? $"\nВ фоне ещё отвечают: {background}" : "")
            + "\nПоследний ответ: " + UsageLine(last);
        StatsText.ToolTip = DiagnosticIdsText() + Environment.NewLine + Environment.NewLine
            + string.Join(Environment.NewLine, turns.Select(m =>
                $"{Time(m.CreatedAt)} · msg={(m.RemoteId.Length > 0 ? m.RemoteId : m.Id)} · {UsageLine(m)}"));
    }

    private static string Time(long unix) =>
        DateTimeOffset.FromUnixTimeSeconds(unix).ToLocalTime().ToString("HH:mm:ss");

    /// <summary>Добирает финальный статус опросом, если поток закрылся без терминального события.</summary>
    private async Task SettleAsync(ChatRun run, string runId, CancellationToken cancel)
    {
        var agent = run.Message;
        if (runId.Length == 0) return;
        for (var attempt = 0; attempt < 30; attempt++)
        {
            if (cancel.IsCancellationRequested || agent.Status is "ok" or "failed" or "stopped" or "partial") return;
            RunEvent state;
            try { state = await ClientFor(run.Thread).StatusAsync(runId, cancel); }
            catch (Exception) { return; }
            if (state.Status is "completed" or "failed" or "cancelled" or "interrupted")
            {
                Apply(run, state);
                if (state.Status == "completed") { ApplyUsage(agent, state); agent.Status = "ok"; agent.Text = state.Output; agent.ToolCount = agent.Tools.Count; }
                else if (state.Status == "failed") { agent.Status = "failed"; agent.Note = Trim(state.Message, 300); }
                else if (state.Status == "cancelled") { agent.Status = "stopped"; agent.Note = "Остановлено."; }
                else { agent.Status = "partial"; agent.Note = "Запуск прерван на стороне шлюза."; }
                return;
            }
            await Task.Delay(1200, cancel);
        }
    }

    /// <summary>STOP: останавливает ответ ТОЛЬКО открытого диалога. Фоновые чаты
    /// продолжают отвечать — иначе кнопка «стоп» глушила бы чужую работу.
    /// Цикл оркестрации при этом останавливается: он управляет диалогом целиком.</summary>
    private void OnStop(object sender, RoutedEventArgs e)
    {
        var run = CurrentRun;
        if (run is not { Busy: true })
        {
            MessageBox.Show("В открытом диалоге сейчас никто не отвечает.", "HermesChat",
                MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        var bound = _store.ChatBindings.FirstOrDefault(pair => pair.Value.OrchestratorThreadId == _thread?.Id || pair.Value.ExecutorThreadId == _thread?.Id);
        if (bound.Key is not null) Coordinator?.StopLoop(bound.Key);
        CancelWorkspaceRun();
    }

    /// <summary>Состояние кнопок — от активных запусков этого окна: STOP виден,
    /// когда отвечает хоть один диалог, но останавливает открытый.</summary>
    private void SetBusy(bool? _ = null)
    {
        var busy = CurrentRun is { Busy: true };
        SendBtn.IsEnabled = !busy;
        SendBtn.Content = busy ? "Агент работает" : "Отправить";
        StopBtn.Visibility = AnyBusy ? Visibility.Visible : Visibility.Collapsed;
        SteerBar.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
        if (busy)
        {
            StopBtn.IsEnabled = true;
            if (!SteerInput.IsFocused) SteerInput.Focus();
        }
        else SteerInput.Clear();
    }

    private static string Trim(string value, int size) =>
        value.Length <= size ? value : value[..size] + "…";

    // ---------- модель диалога ----------

    /// <summary>Показывает модель диалога. Неизвестный идентификатор не подменяется молча:
    /// он остаётся в поле, помеченный как свой маршрут, — иначе пользователь не видит,
    /// что реально отправит в шлюз.</summary>
    private void LoadThreadModel()
    {
        if (_thread is null) return;
        _loadingModel = true;
        var wanted = _thread.Model.Length > 0 ? _thread.Model : _store.Settings.Model;
        var index = IndexOfModel(wanted);
        if (index < 0)
        {
            ModelBox.Items.Insert(0, new ModelChoice { Id = wanted, Label = wanted, Note = "свой маршрут" });
            index = 0;
        }
        ModelBox.SelectedItem = ModelBox.Items[index];
        ModelBox.Text = wanted;               // в поле ввода — чистый id, он и уходит в шлюз
        _loadingModel = false;
        UpdateHeader();
    }

    /// <summary>Профили в списке плюс явный пункт «без профиля»: универсальный агент —
    /// не ошибка, а осознанный выбор, поэтому он должен быть видимой опцией.</summary>
    private void FillProfiles()
    {
        _loadingProfile = true;
        ProfileBox.Items.Clear();
        ProfileBox.Items.Add(new Profile { Id = "", Name = "Универсальный (без профиля)" });
        foreach (var profile in _store.Profiles)
            ProfileBox.Items.Add(new Profile { Id = profile.Id, Name = profile.Name });
        _loadingProfile = false;
    }

    /// <summary>
    /// Табы рабочего пространства адресата. Содержимое «Дерева» и «Очереди»
    /// зависит от профиля текущего диалога, поэтому оно пересобирается при
    /// каждой смене адресата, а не один раз при загрузке окна.
    /// </summary>
    private void OnWorkspaceTab(object sender, SelectionChangedEventArgs e)
    {
        if (!ReferenceEquals(e.Source, WorkspaceTabs) || State is null || Input is null) return;
        if (Composer is not null) Composer.Visibility = WorkspaceTabs.SelectedItem == TabChat ? Visibility.Visible : Visibility.Collapsed;
        if (WorkspaceTabs.SelectedItem is TabItem tab && tab == TabChat)
        {
            // Возврат в чат возвращает фокус в поле ввода: иначе после взгляда
            // на дерево пришлось бы кликать в поле руками, чтобы продолжить.
            Input.Focus();
            return;
        }
        RenderWorkspaceSide();
    }

    /// <summary>Профиль, за которым открыт текущий диалог. Пусто — универсальный агент.</summary>
    private Profile? CurrentProfile =>
        _thread is null ? null : _store.Profiles.FirstOrDefault(p => p.Id == _thread.ProfileId);

    /// <summary>
    /// Наполняет боковые вкладки состоянием направления. Дерево показывает
    /// очередь TODO этого направления, очередь — то же списком с готовым
    /// действием. Оба читают один снимок, поэтому разойтись не могут.
    /// </summary>
    private void RenderWorkspaceSide()
    {
        RenderProjectProgress();
        var profile = CurrentProfile;
        if (profile is null || profile.ProjectId.Length == 0)
        {
            var text = "Диалог без профиля: направления за ним нет, поэтому дерево и очередь пусты."
                       + " Выбери профиль оркестратора слева — и здесь появится его состояние.";
            TreeHint.Text = text;
            QueueHint.Text = text;
            TreeView.Items.Clear();
            QueuePanel.Children.Clear();
            return;
        }

        var todos = TreeBriefs.TodoOf(profile.ProjectId);
        var title = TreeBriefs.TitleOf(profile.ProjectId);
        TreeHint.Text = todos.Count == 0
            ? $"Направление «{title}»: незакрытых TODO в снимке нет ({TreeBriefs.SourceFile})."
            : $"Направление «{title}»: {todos.Count} незакрытых TODO из снимка {TreeBriefs.SourceFile}. "
              + "Запуск следующего поручения требует аппрува в Workspace.";
        QueueHint.Text = todos.Count == 0 ? "Очередь пуста." : "Двойной клик отправляет узел агенту в чат.";

        TreeView.Items.Clear();
        QueuePanel.Children.Clear();
        var direction = TreeBriefs.All().FirstOrDefault(b => b.ProjectId == profile.ProjectId);
        var root = new TreeViewItem { Header = title, IsExpanded = true };
        foreach (var group in (direction?.Nodes ?? todos).GroupBy(n => n.Lane))
        {
            var label = group.Key switch { "todo" => "Задачи", "wiki" => "Контекст и правила", "goal" => "Цели", _ => group.Key };
            var branch = new TreeViewItem { Header = label + " · " + group.Count(), IsExpanded = group.Key == "todo" };
            foreach (var node in group)
            {
                var child = new TreeViewItem { Header = (node.Done ? "✓ " : "") + node.Title, ToolTip = node.Body, Tag = node.Id };
                if (node.Body.Length > 0) child.Items.Add(new TextBlock { Text = node.Body, TextWrapping = TextWrapping.Wrap, MaxWidth = 700, Foreground = Find("Dim") });
                branch.Items.Add(child);
            }
            root.Items.Add(branch);
        }
        TreeView.Items.Add(root);
        foreach (var todo in todos)
        {

            var row = new Border
            {
                Background = Find("Panel"),
                BorderBrush = Find("Line"),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(6),
                Padding = new Thickness(10, 7, 10, 7),
                Margin = new Thickness(0, 0, 0, 6),
                Tag = todo.Id,
                Child = new StackPanel()
            };
            var panel = (StackPanel)row.Child;
            panel.Children.Add(new TextBlock
            {
                Text = todo.Title.Length > 0 ? todo.Title : todo.Id,
                TextWrapping = TextWrapping.Wrap,
                Foreground = Find("Fg"),
                FontWeight = FontWeights.SemiBold
            });
            panel.Children.Add(new TextBlock
            {
                Text = "#" + todo.Id,
                FontSize = 10.5,
                Foreground = Find("Dim"),
                Margin = new Thickness(0, 3, 0, 0)
            });
            if (todo.Body.Length > 0)
                panel.Children.Add(new TextBlock
                {
                    Text = todo.Body,
                    TextWrapping = TextWrapping.Wrap,
                    Foreground = Find("Dim"),
                    FontSize = 11.5,
                    Margin = new Thickness(0, 4, 0, 0)
                });
            // Двойной клик отправляет узел в чат: это мост между «смотрю дерево»
            // и «говорю с агентом» без переключения вкладки. Border — это
            // FrameworkElement, а не Control, поэтому у него нет готового
            // MouseDoubleClick: ловим вверх мыши и считаем клики сами.
            row.MouseLeftButtonUp += (_, args) =>
            {
                if (args.ClickCount != 2) return;
                args.Handled = true;
                SendNodeToChat(todo);
            };
            row.Cursor = Cursors.Hand;
            QueuePanel.Children.Add(row);
        }
    }

    /// <summary>
    /// Ставит узел в чат как готовое поручение. Отдельного канала «поручение»
    /// у диалога нет, а набирать его руками каждый раз — ровно та рутина,
    /// ради которой дерево и открыто рядом с чатом.
    /// </summary>
    private void SendNodeToChat(TreeBrief.TodoItem todo)
    {
        var title = todo.Title.Length > 0 ? todo.Title : todo.Id;
        var text = "Возьми TODO #" + todo.Id + " — " + title
                   + (todo.Body.Length > 0 ? "\n\n" + todo.Body : "");
        Input.Text = text;
        WorkspaceTabs.SelectedItem = TabChat;
        Input.Focus();
        Input.CaretIndex = text.Length;
    }

    private void LoadThreadProfile()
    {
        _loadingProfile = true;
        var index = 0;
        for (var i = 0; i < ProfileBox.Items.Count; i++)
            if (ProfileBox.Items[i] is Profile choice && choice.Id == _thread?.ProfileId) { index = i; break; }
        ProfileBox.SelectedIndex = index;
        _loadingProfile = false;
    }

    private void OnProfileChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_loadingProfile || _thread is null || ProfileBox.SelectedItem is not Profile choice) return;
        _thread.ProfileId = choice.Id;
        _thread.ProfileName = choice.Id.Length > 0
            ? _store.Profiles.FirstOrDefault(p => p.Id == choice.Id)?.Name ?? ""
            : "";
        if (choice.Id.Length > 0)
        {
            var profile = _store.Profiles.FirstOrDefault(p => p.Id == choice.Id);
            if (profile is not null)
            {
                profile.LastUsedAt = DateTimeOffset.Now.ToUnixTimeSeconds();
                // Навыки профиля переходят в диалог: иначе они были бы мёртвым текстом в настройках.
                foreach (var skill in profile.Skills.Where(s => !_thread.Skills.Contains(s)))
                    _thread.Skills.Add(skill);
            }
        }
        _store.Save();
        UpdateHeader();
    }

    /// <summary>session_id для отправки. Подхваченный диалог пишет в сессию
        /// шлюза, из которой взят, — иначе разговор разорвался бы на два: то, что
        /// ты пишешь в приложении, ушло бы в пустую сессию мимо консольной.</summary>
        private static string SessionKeyOf(ChatThread thread) =>
            thread.RemoteSessionId.Length > 0 ? thread.RemoteSessionId : thread.Id;

        /// <summary>
        /// Подхватить разговор шлюза: его история показывается в диалоге, и с этого
        /// момента отправка продолжает ту же сессию. Это «переехасть в шлюз» —
        /// консольный разговор виден в приложении и остаётся единым.
        /// В state.json сама история не копируется: она живёт в шлюзе, копия бы
        /// протухла, а state.json разрастался бы на сотни сообщений за переезд.
        /// </summary>
        public async Task OpenRemoteSessionAsync(RemoteSession session, string? gatewayId, CancellationToken cancel)
        {
            var client = ClientForGateway(gatewayId);
            var gatewayKey = gatewayId ?? "";
            var gateway = gatewayKey.Length > 0
                ? _store.Gateways.FirstOrDefault(g => g.Id == gatewayKey)
                : null;
            // По одному активному диалогу на шлюз: выбор сессии из каталога
            // явно перепривязывает его, а не создаёт ещё одну скрытую строку.
            var thread = gatewayKey.Length > 0
                ? _threads.Where(t => t.GatewayId == gatewayKey).OrderByDescending(t => t.UpdatedAt).FirstOrDefault()
                : _threads.FirstOrDefault(t => t.RemoteSessionId == session.Id && t.GatewayId.Length == 0);
            var oldSessionId = thread?.RemoteSessionId ?? "";
            var sameSession = oldSessionId == session.Id;
            var local = thread?.Messages.Where(m => !m.Remote).ToList() ?? new List<ChatMessage>();

            if (thread is null)
            {
                thread = new ChatThread
                {
                    GatewayId = gatewayKey,
                    GatewayName = gateway?.Name ?? "",
                    ProfileId = gateway?.ProfileId ?? "",
                    ProfileName = _store.Profiles.FirstOrDefault(p => p.Id == gateway?.ProfileId)?.Name ?? "",
                    Title = session.Title.Length > 0 ? session.Title : session.Id
                };
                _store.Threads.Insert(0, thread);
                _threads.Insert(0, thread);
            }
            else if (!sameSession && local.Count > 0)
            {
                // Не смешиваем локальные пузыри предыдущей сессии с новой историей.
                // Сохраняем их в архиве без маршрута отправки, старые серверные
                // сообщения остаются доступны через каталог сессий шлюза.
                var oldLabel = oldSessionId.Length > 0 ? oldSessionId : "сессия не создана";
                var archived = new ChatThread
                {
                    Title = $"{thread.Title} · прежняя сессия {oldLabel}",
                    Model = thread.Model,
                    Messages = local,
                    CreatedAt = thread.CreatedAt,
                    UpdatedAt = thread.UpdatedAt
                };
                _store.Threads.Insert(0, archived);
                _threads.Insert(0, archived);
            }

            thread.Title = session.Title.Length > 0 ? session.Title : session.Id;
            thread.RemoteSessionId = session.Id;
            if (!sameSession) thread.Messages.Clear();
            thread.RemoteMessages = session.MessageCount;
            if (session.Model.Length > 0) thread.Model = session.Model;
            thread.GatewayId = gatewayKey;
            thread.GatewayName = gateway?.Name ?? thread.GatewayName;
            if (gateway is not null)
            {
                thread.ProfileId = gateway.ProfileId;
                thread.ProfileName = _store.Profiles.FirstOrDefault(p => p.Id == gateway.ProfileId)?.Name ?? "";
            }
            thread.UpdatedAt = DateTimeOffset.Now.ToUnixTimeSeconds();
            _store.Save();
            RefreshThreadGroups();
            Show(thread);
            var history = await client.ReadSessionMessagesAsync(session.Id, cancel);
            // За время сетевого запроса пользователь мог выбрать другую сессию.
            // Старый ответ не должен перерисовать новый чат.
            if (thread.RemoteSessionId != session.Id) return;
            if (history.Count == 0)
            {
                MessageBox.Show("Шлюз не отдал историю сессии — диалог открыт без неё.", "HermesChat");
                return;
            }
            thread.Messages.Clear();
            foreach (var message in history.Where(m => m.Visible)) thread.Messages.Add(ToChatMessage(message));
            if (sameSession)
                foreach (var message in local.Where(m => !thread.Messages.Any(x => x.Id == m.Id)))
                    thread.Messages.Add(message);
            thread.RemoteMessages = history.Count(m => m.Visible);
            thread.PendingAgentMessages = 0;
            _store.Save();
            if (!ReferenceEquals(_thread, thread)) return;   // пользователь уже переключился
            UpdateHeader();
            Render();
            UpdateStats();
            ScrollToEnd();
        }

        /// <summary>Сообщение сессии шлюза → сообщение диалога: роли и текст те же,
        /// метки времени подтягиваются, чтобы лента читалась как хронология.</summary>
        private static ChatMessage ToChatMessage(RemoteMessage message) => new()
        {
            RemoteId = message.Id,
            Role = message.IsUser ? "user" : "agent",
            Text = message.Content.Length > 0 ? message.Content : message.Result,
            Status = message.IsAgent ? "ok" : "",
            Note = message.IsTool ? "вызов: " + message.ToolCall : "",
            Remote = true,
            CreatedAt = message.Timestamp > 0 ? (long)message.Timestamp : DateTimeOffset.Now.ToUnixTimeSeconds(),
            Tools = message.ToolCall.Length > 0
                ? new List<ToolStep> { new() { Tool = message.ToolCall, Result = Trim(message.Result, 600) } }
                : new List<ToolStep>()
        };

        /// <summary>Клиент указанного шлюза. Пусто — локальный из настроек.</summary>
        private HermesClient ClientForGateway(string? gatewayId)
        {
            if (gatewayId is not { Length: > 0 }) return _local;
            var gateway = _store.Gateways.FirstOrDefault(g => g.Id == gatewayId);
            if (gateway is null || gateway.Url.Length == 0) return _local;
            return new HermesClient(_store.Settings, gateway.RestBase, gateway.Token);
        }

        /// <summary>Открывает или создаёт диалог с профилем оркестратора вместе с его историей,
    /// заводя диалог при первом обращении. Берётся самый свежий диалог этого
    /// профиля, а не первый в списке: иначе после нескольких разговоров
    /// клик открывал бы самый старый. Один диалог на профиль — у него своя
    /// память (SessionKey), и второй разговор продолжил бы тот же контекст.</summary>
    public void OpenWithProfile(string profileId)
    {
        if (profileId.Length == 0) return;
        var existing = _threads
            .Where(t => t.ProfileId == profileId && t.GatewayId.Length == 0)
            .OrderByDescending(t => t.UpdatedAt)
            .FirstOrDefault();
        if (existing is null)
        {
            var profile = _store.Profiles.FirstOrDefault(p => p.Id == profileId);
            existing = new ChatThread
            {
                ProfileId = profileId,
                ProfileName = profile?.Name ?? "Профиль",
                Title = profile is not null && profile.ProjectId.Length > 0
                    ? profile.ProjectTitle
                    : profile?.Name ?? "Диалог профиля"
            };
            _store.Threads.Insert(0, existing);
            _threads.Insert(0, existing);
            _store.Save();
        }
        // Метка времени двигается при открытии: иначе «последний диалог» навсегда
        // остался бы самым старым и клик путался бы между двумя разговорами.
        // Порядок самого _threads не трогаем: диалог профиля в списке чатов не показывается.
        existing.UpdatedAt = DateTimeOffset.Now.ToUnixTimeSeconds();
        _store.Save();
        Show(existing);
    }

    /// <summary>Открывает или создаёт диалог с внешним агентом. Один диалог на шлюз:
    /// второй разговор с той же машиной продолжил бы чужой контекст.</summary>
    public void OpenWithGateway(string gatewayId)
    {
        var gateway = _store.Gateways.FirstOrDefault(g => g.Id == gatewayId);
        if (gateway is null) return;
        var existing = _threads.Where(t => t.GatewayId == gatewayId)
            .OrderByDescending(t => t.UpdatedAt).FirstOrDefault();
        if (existing is null)
        {
            existing = new ChatThread
            {
                GatewayId = gateway.Id,
                GatewayName = gateway.Name,
                Title = gateway.Name,
                ProfileId = gateway.ProfileId,
                ProfileName = _store.Profiles.FirstOrDefault(p => p.Id == gateway.ProfileId)?.Name ?? ""
            };
            _store.Threads.Insert(0, existing);
            _threads.Insert(0, existing);
        }
        existing.GatewayName = gateway.Name;
        _store.Save();
        Show(existing);
    }

    /// <summary>Показать диалог с его историей. Диалог лежит не в списке чатов
    /// (универсальных), а за профилем или шлюзом, поэтому состояние переносится
    /// напрямую: перерисовка ленты здесь обязательна, иначе справа остаётся
    /// предыдущий диалог и кажется, что клик не сработал.</summary>
    private void Show(ChatThread thread)
    {
        if (RouteThread?.Invoke(thread.Id) == true) return;
        _thread = thread;
        thread.UpdatedAt = DateTimeOffset.Now.ToUnixTimeSeconds();
        _store.Save();
        // Универсальные диалоги живут в сворачиваемом архиве; профильные и
        // шлюзовые — в своих списках, поэтому не оставляем чужую подсветку.
        _suppressListEvent = true;
        try
        {
            if (IsUniversal(thread))
            {
                ChatArchiveExpander.IsExpanded = true;
                ChatList.SelectedItem = thread;
            }
            else
            {
                ChatList.SelectedItem = null;
                ChatArchiveExpander.IsExpanded = false;
            }
        }
        finally { _suppressListEvent = false; }
        LoadThreadProfile();
        LoadThreadModel();
        SetBusy();               // STOP/отправка — по запуску ЭТОГО диалога
        UpdateHeader();
        Render();
        UpdateStats();
        RefreshRequestBar();
        ScrollToEnd();
        Input.Focus();
    }

    private int IndexOfModel(string id)
    {
        for (var i = 0; i < ModelBox.Items.Count; i++)
            if (ModelBox.Items[i] is ModelChoice choice && choice.Id == id) return i;
        return -1;
    }

    private void OnModelChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_loadingModel || _thread is null) return;
        if (ModelBox.SelectedItem is not ModelChoice choice || choice.Id.Length == 0) return;
        ApplyModel(choice.Id);
    }

    /// <summary>Пользователь вписал модель руками. Пустая строка — вернуть модель по умолчанию.</summary>
    private void OnModelTyped(object sender, RoutedEventArgs e)
    {
        if (_loadingModel || _thread is null) return;
        var typed = ModelBox.Text.Trim();
        if (typed.Length == 0) { LoadThreadModel(); return; }
        ApplyModel(typed);
    }

    private void ApplyModel(string id)
    {
        if (_thread is null) return;
        var index = IndexOfModel(id);
        if (index < 0)
        {
            // Неизвестный id добавляем в список, чтобы он не потерялся при переключении диалогов.
            ModelBox.Items.Insert(0, new ModelChoice { Id = id, Label = id, Note = "свой маршрут" });
            _loadingModel = true;
            ModelBox.SelectedItem = ModelBox.Items[0];
            _loadingModel = false;
        }
        _thread.Model = id;
        _store.Save();
        UpdateHeader();
    }

    private void UpdateHeader()
    {
        var requested = _thread is null ? _store.Settings.Model : ResolveModel(_thread);
        var profile = _thread is null ? null : ProfileOf(_thread);
        var gateway = GatewayOf(_thread);
        var todo = profile?.IsBound == true ? TreeBriefs.TodoCount(profile.ProjectId) : 0;
        var skills = _thread?.Skills.Count ?? 0;
        var historyTitle = _thread?.Title ?? "Диалог";
        var title = historyTitle;
        if (profile is not null && title == profile.Name) title = "";
        HeaderText.Text = (title.Length > 0 ? title + "  ·  " : "")
            + (profile is not null ? profile.Name + "  ·  " : "")
            + (gateway is not null ? "→ " + gateway.Name + "  ·  " : "")
            + requested
            + (todo > 0 ? $"  ·  TODO в очереди: {todo}" : "")
            + (skills > 0 ? $"  ·  навыков: {skills}" : "");
        var served = _thread?.Messages.LastOrDefault(m => m.IsAgent && m.Model.Length > 0);
        if (served is not null && served.Model.Length > 0 && served.Model != requested)
            HeaderText.Text += $"  →  ответила {served.Model}";
        HeaderText.ToolTip = HeaderText.Text;

        var profileName = profile?.Name ?? (_thread?.ProfileName.Length > 0 ? _thread.ProfileName : "Универсальный");
        var history = _thread?.Messages.LastOrDefault();
        var messageId = history is null ? "" : history.RemoteId.Length > 0 ? history.RemoteId : history.Id;
        IdentityText.Text = ChatDiagnostics.IdentityLine(
            profileName, historyTitle, gateway?.Name ?? "Локальный шлюз", _thread?.Id ?? "",
            _thread?.RemoteSessionId ?? "", messageId);
        IdentityText.ToolTip = DiagnosticIdsText();
        CopyIdsBtn.IsEnabled = _thread is not null;
        CopyIdsBtn.Content = "⧉ ID";

        // Боковые вкладки принадлежат адресату, а не окну: при смене профиля
        // их содержимое обязано смениться вместе с ним, иначе «Дерево» покажет
        // чужое направление. Пересборка дешёвая — источник один снимок в памяти.
        RenderWorkspaceSide();
    }

    private string DiagnosticIdsText()
    {
        if (_thread is null) return "";
        var profile = ProfileOf(_thread);
        var gateway = GatewayOf(_thread);
        var latest = _thread.Messages.LastOrDefault();
        var served = _thread.Messages.LastOrDefault(message => message.IsAgent && message.Model.Length > 0);
        return string.Join(Environment.NewLine, new[]
        {
            "profile=" + (profile?.Name ?? (_thread.ProfileName.Length > 0 ? _thread.ProfileName : "universal")),
            "profile_id=" + _thread.ProfileId,
            "history=" + _thread.Title,
            "gateway=" + (gateway?.Name ?? "local"),
            "chat_id=" + _thread.Id,
            "session_id=" + (_thread.RemoteSessionId.Length > 0 ? _thread.RemoteSessionId : "(not created)"),
            "message_id=" + (latest?.Id ?? "(none)"),
            "remote_message_id=" + (latest?.RemoteId ?? ""),
            "message_status=" + (latest?.Status ?? ""),
        }) + Environment.NewLine + ChatDiagnostics.ModelIdentityLine(
            ResolveModel(_thread), served?.Model ?? "");
    }

    private void OnCopyIds(object sender, RoutedEventArgs e)
    {
        if (_thread is null) return;
        try
        {
            Clipboard.SetText(DiagnosticIdsText());
            CopyIdsBtn.Content = "✓ Скопировано";
        }
        catch (Exception error)
        {
            CrashLog.Write("Копирование ID: " + error.Message);
            MessageBox.Show("Не удалось скопировать IDs: " + error.Message, "HermesChat");
        }
    }

    // ---------- навыки ----------

    private void OnSkills(object sender, RoutedEventArgs e)
    {
        if (_thread is null) return;
        if (_skills.Count == 0)
        {
            MessageBox.Show("В каталоге Hermes не найдено ни одного SKILL.md. Проверь %LOCALAPPDATA%\\hermes\\skills.",
                "HermesChat", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        var window = new SkillsWindow(_skills, _thread.Skills) { Owner = Application.Current.MainWindow };
        window.ShowDialog();
        _store.Save();
        UpdateHeader();
    }

    // ---------- вложения ----------

    private void ShowAttachments()
    {
        AttachBar.ItemsSource = _pending;
        AttachBar.Visibility = _pending.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private void AddAttachment(Attachment attachment)
    {
        if (_pending.Count >= 10)
        {
            MessageBox.Show("Больше десяти вложений в одно сообщение не берём — агент запутается.",
                "HermesChat", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }
        _pending.Add(attachment);
        ShowAttachments();
    }

    private void OnPasteImage(object sender, RoutedEventArgs e) => TryPaste();

    private void TryPaste()
    {
        try { AddAttachment(Attachments.FromClipboard()); }
        catch (Exception error) { MessageBox.Show(error.Message, "HermesChat", MessageBoxButton.OK, MessageBoxImage.Information); }
    }

    private void OnPickFile(object sender, RoutedEventArgs e)
    {
        var dialog = new Microsoft.Win32.OpenFileDialog { Multiselect = true, Title = "Выбери файлы для агента" };
        if (dialog.ShowDialog(Application.Current.MainWindow) != true) return;
        foreach (var file in dialog.FileNames)
        {
            try { AddAttachment(Attachments.FromPath(file)); }
            catch (Exception error) { CrashLog.Write("Вложение: " + error.Message); MessageBox.Show(error.Message, "HermesChat"); }
        }
    }

    private void OnRemoveAttachment(object sender, RoutedEventArgs e)
    {
        if (sender is FrameworkElement { Tag: Attachment attachment })
        {
            _pending.Remove(attachment);
            ShowAttachments();
        }
    }

    private void OnDragOver(object sender, DragEventArgs e)
    {
        e.Effects = e.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None;
        DropHint.Visibility = e.Effects == DragDropEffects.Copy ? Visibility.Visible : Visibility.Collapsed;
        e.Handled = true;
    }

    private void OnDrop(object sender, DragEventArgs e)
    {
        DropHint.Visibility = Visibility.Collapsed;
        if (!e.Data.GetDataPresent(DataFormats.FileDrop) || e.Data.GetData(DataFormats.FileDrop) is not string[] files) return;
        foreach (var file in files)
        {
            try { AddAttachment(Attachments.FromPath(file)); }
            catch (Exception error) { CrashLog.Write("Drag&drop: " + error.Message); MessageBox.Show(error.Message, "HermesChat"); }
        }
    }

    /// <summary>Ctrl+V — скриншот из буфера. Не перехватываем обычную вставку текста.</summary>
    private void OnWindowPaste(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.V || (Keyboard.Modifiers & ModifierKeys.Control) == 0) return;
        if (!Clipboard.ContainsImage()) return;
        e.Handled = true;
        TryPaste();
    }

    

    /// <summary>Ключ памяти профиля. У профиля он свой — иначе направления путают контекст.</summary>
    private string ProfileSessionKey(ChatThread thread)
    {
        if (thread.ProfileId.Length == 0) return "";
        var profile = _store.Profiles.FirstOrDefault(p => p.Id == thread.ProfileId);
        return profile?.SessionKey ?? "";
    }

    /// <summary>Клиент для диалога: локальный шлюз либо адрес внешнего агента.
    /// Создаётся на каждый вызов — дёшево, зато адрес и токен не могут «залипнуть»
    /// от прошлого выбранного диалога.</summary>
    /// <summary>Готов ли этот диалог к отправке: свои адрес и токен, а не чужие.</summary>
    private bool ReadyFor(ChatThread? thread)
    {
        if (thread is not null && thread.GatewayId.Length > 0)
        {
            var gateway = _store.Gateways.FirstOrDefault(g => g.Id == thread.GatewayId);
            if (gateway is null) return false;
            return Uri.TryCreate(gateway.Url, UriKind.Absolute, out var uri)
                   && uri.Scheme is "http" or "https" && gateway.Token.Length >= 8;
        }
        return _store.Settings.Ready;
    }

    private HermesClient ClientFor(ChatThread? thread)
    {
        if (thread is null || thread.GatewayId.Length == 0) return _local;
        var gateway = _store.Gateways.FirstOrDefault(g => g.Id == thread.GatewayId);
        if (gateway is null || gateway.Url.Length == 0) return _local;
        return new HermesClient(_store.Settings, gateway.Url, gateway.Token);
    }

    /// <summary>Шлюз, с которым ведётся диалог. Пусто — локальный.</summary>
    private Gateway? GatewayOf(ChatThread? thread) =>
        thread is null || thread.GatewayId.Length == 0 ? null
            : _store.Gateways.FirstOrDefault(g => g.Id == thread.GatewayId);

    private Profile? ProfileOf(ChatThread thread) =>
        thread.ProfileId.Length > 0 ? _store.Profiles.FirstOrDefault(p => p.Id == thread.ProfileId) : null;

    /// <summary>Модель диалога: профиль важнее диалога, диалог важнее настроек.</summary>
    private string ResolveModel(ChatThread thread)
    {
        if (thread.ProfileId.Length > 0)
        {
            var profile = _store.Profiles.FirstOrDefault(p => p.Id == thread.ProfileId);
            if (profile is not null && profile.Model.Length > 0) return profile.Model;
        }
        return thread.Model.Length > 0 ? thread.Model : _store.Settings.Model;
    }

    /// <summary>Путь в тексте запроса: агент читает файл сам, это и есть «отправка файла».</summary>
    private static string ComposeInput(string text, IReadOnlyList<Attachment> attachments, IReadOnlyList<string> skills)
    {
        var parts = new List<string>();
        if (skills.Count > 0) parts.Add("Обязательные навыки этого диалога: " + string.Join(", ", skills) + ". Примени их.");
        if (text.Length > 0) parts.Add(text);
        if (attachments.Count > 0)
        {
            parts.Add("Прикреплённые файлы (прочитай их по путям):");
            foreach (var file in attachments)
                parts.Add($"- {file.Name} ({file.SizeText}) → {file.Path}");
            parts.Add("Прежде чем отвечать, посмотри каждый файл.");
        }
        return string.Join("\n\n", parts);
    }

    private void OnSettings(object sender, RoutedEventArgs e)
    {
        var window = new SettingsWindow(_store);
        window.ShowDialog();
        // Адрес и ключ могли поменяться — клиент пересоздаётся, иначе правка
        // настроек молча не подействует.
        _local = new HermesClient(_store.Settings);
        Render();
    }
}