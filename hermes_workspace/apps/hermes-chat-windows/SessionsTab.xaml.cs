using System.Windows;
using System.Windows.Controls;

namespace HermesChat;

/// <summary>
/// Вкладка «Разговоры шлюза»: сессии api_server выбранного шлюза. Отличие от
/// вкладки шлюзов принципиальное: там адреса и токины машин, здесь — разговоры,
/// которые уже были. Подхват сессии показывает её историю в диалоге и
/// переключает отправку на эту же сессию: это и есть «переехать в шлюз».
/// Реестр шлюзов общий для всех вкладок, поэтому список сессий и разговор
/// с внешним агентом всегда относятся к одной и той же машине.
/// </summary>
public partial class SessionsTab : UserControl
{
    public Store State { get; set; } = null!;
    private readonly List<RemoteSession> _sessions = new();
    private CancellationTokenSource? _work;
    private RemoteSession? _current;
    private string _gatewayId = "";
    private readonly System.Windows.Threading.DispatcherTimer _tick = new()
    { Interval = TimeSpan.FromSeconds(12) };

    public SessionsTab()
    {
        InitializeComponent();
        // Список сессий сам по себе показывал мёртвые цифры: разговоры шли, а
        // счётчик стоял до нажатия «Обновить». Тикер перечитывает список, пока
        // вкладка видима, и замирает, когда её закрыли, — фон не крутится зря.
        _tick.Tick += async (_, _) =>
        {
            if (!IsVisible || _loading) return;
            await LoadAsync(quiet: true);
        };
        IsVisibleChanged += (_, _) => _tick.Stop();
    }

    /// <summary>Тикер живёт только пока вкладка на экране.</summary>
    public void Resume()
    {
        _tick.Stop();
        _tick.Start();
    }

    private bool _loading;

    /// <summary>Шлюз выбранного разговора. Пусто — локальный из настроек.</summary>
    public string GatewayId
    {
        get => _gatewayId;
        set
        {
            if (_gatewayId == value) return;
            _gatewayId = value;
            _sessions.Clear();
            SessionList.ItemsSource = null;
        }
    }

    /// <summary>Список сессий. Читается при каждом открытии вкладки и при смене
    /// шлюза: разговоры идут прямо сейчас, и кэш из прошлого открытия врал бы.
    /// Клиент строится на лету — у каждого шлюза свой адрес и свой токен.</summary>
    public async Task LoadAsync(bool quiet = false)
    {
        if (_loading) return;
        var client = BuildClient();
        if (client is null)
        {
            NoteText.Text = "У выбранного шлюза не заполнены адрес или токен — заполни их во вкладке «Внешние шлюзы».";
            return;
        }
        _loading = true;
        try
        {
            var token = new CancellationTokenSource();
            var previous = Interlocked.Exchange(ref _work, token);
            if (previous is not null) { try { previous.Cancel(); previous.Dispose(); } catch (ObjectDisposedException) { } }
            if (!quiet)
            {
                NoteText.Text = "Читаю сессии у шлюза «" + GatewayName() + "»…";
                SessionList.ItemsSource = null;
            }
            var fresh = new List<RemoteSession>();
            try { fresh.AddRange(await client.ReadSessionsAsync(token.Token)); }
            catch (OperationCanceledException) { return; }
            // Перечитываем список на месте: выбранная сессия и открытая справа
            // история остаются, а цифры и «когда шёл разговор» обновляются сами.
            var keep = _current?.Id;
            _sessions.Clear();
            _sessions.AddRange(fresh.OrderByDescending(s => s.LastActive > 0 ? s.LastActive : s.StartedAt));
            SessionList.Items.Refresh();
            if (keep is not null)
            {
                var again = _sessions.FirstOrDefault(s => s.Id == keep);
                if (again is not null) SessionList.SelectedItem = again;
            }
            NoteText.Text = _sessions.Count == 0
                ? $"Шлюз «{GatewayName()}» не вернул ни одной сессии."
                : $"Сессий у «{GatewayName()}»: {_sessions.Count} · список обновляется сам. "
                  + "Подхват сессии — это «переехать в шлюз»: история подтягивается, а отправка продолжает её.";
            if (!quiet && _sessions.Count > 0) SessionList.SelectedIndex = 0;
        }
        catch (Exception error)
        {
            if (!quiet)   // тихий отказ обновления не должен пугать надписью
            {
                NoteText.Text = "Не удалось прочитать сессии «" + GatewayName() + "»: " + error.Message;
                CrashLog.Write("Сессии шлюза: " + error);
            }
        }
        finally { _loading = false; }
    }

    private void OnReload(object sender, RoutedEventArgs e) => _ = LoadAsync();

    private void OnGatewayChanged(object sender, SelectionChangedEventArgs e)
    {
        if (GatewayBox.SelectedItem is not Gateway gateway) return;
        GatewayId = gateway.Id;
        _ = LoadAsync();
    }

    /// <summary>Предпросмотр: начало сессии до переезда, чтобы не переносить
    /// вслепую разговор на сотни сообщений.</summary>
    private async void OnSelect(object sender, SelectionChangedEventArgs e)
    {
        if (SessionList.SelectedItem is not RemoteSession session) return;
        var client = BuildClient();
        if (client is null) return;
        _current = session;
        DetailTitle.Text = session.Title.Length > 0 ? session.Title : session.Id;
        DetailMeta.Text = $"сессия {session.Id} · {session.Badge} · {session.MessageCount} сообщений"
                         + $" · инструментов {session.ToolCallCount} · модель {session.Model} · начата {session.StartedText}"
                         + $" · шлюз «{GatewayName()}»";
        DetailText.Text = "Читаю историю…";
        try
        {
            var history = await client.ReadSessionMessagesAsync(session.Id, CancellationToken.None);
            var lines = history.Where(m => m.Visible).Take(60)
                .Select(m => m.IsUser
                    ? "ТЫ: " + Clip(m.Content, 400)
                    : m.IsTool
                        ? "  ⚙ " + m.ToolCall + " → " + Clip(m.Result, 200)
                        : "HERMES: " + Clip(m.Content, 400));
            DetailText.Text = history.Count == 0
                ? "Сессия пустая."
                : (history.Count > 60 ? "Показаны первые 60 из " + history.Count + ":\n\n" : "") + string.Join("\n\n", lines);
        }
        catch (Exception error)
        {
            DetailText.Text = "Не удалось прочитать историю: " + error.Message;
        }
    }

    private async void OnOpen(object sender, RoutedEventArgs e)
    {
        if (_current is null) return;
        OpenBtn.IsEnabled = false;
        NoteText.Text = "Переношу разговор в приложение…";
        try
        {
            if (RequestThread is not null) await RequestThread(_current);
            NoteText.Text = "Разговор перенесён — он открыт во вкладке «Чаты». Отправка продолжает эту сессию шлюза.";
        }
        catch (Exception error)
        {
            NoteText.Text = "Не удалось перенести: " + error.Message;
            CrashLog.Write("Переезд в сессию: " + error);
        }
        finally { OpenBtn.IsEnabled = true; }
    }

    /// <summary>Оболочка переводит диалог в сессию шлюза и открывает вкладку чатов.</summary>
    public event Func<RemoteSession, Task>? RequestThread;

    /// <summary>Клиент шлюза. Пусто — локальный из настроек. Готовый клиент без
    /// адреса или токена означал бы запрос в никуда и ошибку, которую человек
    /// видит как «шлюз молчит», поэтому возвращаем null и говорим почему.</summary>
    private HermesClient? BuildClient()
    {
        if (_gatewayId.Length == 0) return new HermesClient(State.Settings);
        var gateway = State.Gateways.FirstOrDefault(g => g.Id == _gatewayId);
        if (gateway is null || gateway.Url.Length == 0 || gateway.Token.Length < 8) return null;
        // HermesClient говорит по REST (/v1/runs, /v1/capabilities) — это api_server,
        // который на другом порту, чем WS-адрес `hermes serve`.
        return new HermesClient(State.Settings, gateway.RestBase, gateway.Token);
    }

    private string GatewayName() => _gatewayId.Length == 0
        ? "этот ноут"
        : State.Gateways.FirstOrDefault(g => g.Id == _gatewayId)?.Name ?? _gatewayId;

    /// <summary>Набор шлюзов для выпадающего списка. Локальный всегда первый:
    /// без него нечего читать, пока в реестр не внесены машины.</summary>
    public void FillGateways()
    {
        var current = GatewayBox.SelectedItem as Gateway;
        GatewayBox.Items.Clear();
        GatewayBox.Items.Add(new Gateway { Id = "", Name = "Этот ноут (api_server)" });
        foreach (var gateway in State.Gateways) GatewayBox.Items.Add(gateway);
        if (current is not null)
            GatewayBox.SelectedItem = GatewayBox.Items.OfType<Gateway>()
                .FirstOrDefault(g => g.Id == current.Id);
        if (GatewayBox.SelectedItem is null) GatewayBox.SelectedIndex = 0;
    }

    private new static string Clip(string value, int size)
    {
        var flat = value.Replace("\r", " ").Replace("\n", " ");
        return flat.Length <= size ? flat : flat[..size] + "…";
    }
}