using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Text.Json.Serialization;

namespace HermesChat;

/// <summary>Одно сообщение в ленте чата. Роль: user | agent | system | tool.</summary>
public sealed class ChatMessage
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    /// <summary>Durable message id from the gateway, when this bubble was imported from history.</summary>
    public string RemoteId { get; set; } = "";
    public Dictionary<string,int> AssetVersions { get; set; } = new();
    public string Role { get; set; } = "user";
    public string Text { get; set; } = "";
    /// <summary>Живой текст, пока агент пишет. Финализируется в Text по run.completed.</summary>
    public string Streaming { get; set; } = "";
    public string RunId { get; set; } = "";
    public string Status { get; set; } = "";        // ok | running | failed | stopped | partial
    public string Note { get; set; } = "";
    /// <summary>Размышление агента целиком (из reasoning.delta).</summary>
    public string Reasoning { get; set; } = "";          // причина обрыва/ошибки
    public long CreatedAt { get; set; } = DateTimeOffset.Now.ToUnixTimeSeconds();
    // ---- Учёт. Заполняется из run.completed / GET /v1/runs: usage + runtime. ----
    public int InputTokens { get; set; }
    public int OutputTokens { get; set; }
    public int CacheReadTokens { get; set; }
    public int CacheWriteTokens { get; set; }
    public int TotalTokens { get; set; }
    public int ReasoningTokens { get; set; }
    public int ContextUsedTokens { get; set; }
    public int ContextMaxTokens { get; set; }
    public int ContextPercent { get; set; }
    public int CacheHitPercent { get; set; }
    public string ContextSource { get; set; } = "";
    public bool? ContextEstimated { get; set; }
    public double? CostUsd { get; set; }
    public string CostStatus { get; set; } = "";
    public double? AverageLatencySeconds { get; set; }
    public double? AverageTokensPerSecond { get; set; }
    /// <summary>Модель, которая реально ответила (runtime.model), а не та, что запрошена.</summary>
    public string Model { get; set; } = "";
    public string Provider { get; set; } = "";
    public string RouteSource { get; set; } = "";
    /// <summary>Длительность запуска в миллисекундах — по created_at и updated_at шлюза.</summary>
    public long DurationMs { get; set; }
    public int ToolCount { get; set; }
    /// <summary>Ожидает решения человека. Пока стоит, запуску нужен ответ — иначе он висит вечно.</summary>
    public bool WaitingApproval { get; set; }
    public string ApprovalCommand { get; set; } = "";
    public string ApprovalTool { get; set; } = "";
    public string ApprovalRequestId { get; set; } = "";
    public List<string> ApprovalChoices { get; set; } = new();
    /// <summary>Открытый batch-clarify запрос шлюза: пользователь может ответить прямо в ленте.</summary>
    public bool WaitingClarification { get; set; }
    public string ClarifyRequestId { get; set; } = "";
    public List<ClarifyQuestionData> ClarifyQuestions { get; set; } = new();
    /// <summary>Промежуточные комментарии агента перед/рядом с вызовами инструментов.</summary>
    public List<string> InterimSegments { get; set; } = new();
    /// <summary>Подсказки, отправленные в идущий запуск — видно, что ты вмешивался.</summary>
    public List<string> Steers { get; set; } = new();
    /// <summary>Контекст = входные токены последнего запуска: это то, что реально ушло модели.</summary>
    [JsonIgnore]
    public int ContextTokens => InputTokens;
    public List<Attachment> Attachments { get; set; } = new();
    /// <summary>Хронология вызовов инструментов — как в ТГ, а не одна строка «последний инструмент».</summary>
    public List<ToolStep> Tools { get; set; } = new();

    [JsonIgnore]
    public bool IsAgent => Role == "agent";
    /// <summary>Сообщение пришло из шлюза, а не отправлено из приложения. Такие
    /// не хранятся в state.json: их история лежит в шлюзе и читается оттуда.</summary>
    public bool Remote { get; set; }
    [JsonIgnore]
    public bool IsRunning => Status == "running";
    /// <summary>Что показать в ленте: во время стрима — накопленный текст, иначе финальный.</summary>
    [JsonIgnore]
    public string Body => Streaming.Length > 0 ? Streaming : Text;
}

/// <summary>Один вызов инструмента в ходе ответа агента.</summary>
public sealed class ToolStep
{
    public string Tool { get; set; } = "";
    public string Preview { get; set; } = "";
    public string Result { get; set; } = "";
    public double Seconds { get; set; }
    public bool Error { get; set; }
    public bool Running { get; set; }
    /// <summary>generating — модель собирает вызов; running — инструмент уже запущен.</summary>
    public string Phase { get; set; } = "";
    public long At { get; set; } = DateTimeOffset.Now.ToUnixTimeMilliseconds();
}

public sealed class ChatThread : INotifyPropertyChanged
{
    private string _title = "Новый диалог";
    public event PropertyChangedEventHandler? PropertyChanged;

    public string Id { get; set; } = "hermeschat-" + Guid.NewGuid().ToString("N")[..12];
    /// <summary>Переименовывается после первого сообщения — список обязан увидеть это,
    /// поэтому свойство с уведомлением, а не авто-свойство.</summary>
    public string Title
    {
        get => _title;
        set
        {
            if (_title == value) return;
            _title = value;
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(Title)));
        }
    }
    public string SessionKey { get; set; } = "";
    public List<ChatMessage> Messages { get; set; } = new();
    /// <summary>Модель этого диалога. Пусто — модель по умолчанию из настроек.</summary>
    public string Model { get; set; } = "";
    /// <summary>Навыки, прикреплённые к диалогу: агент видит их как обязательные к применению.</summary>
    public List<string> Skills { get; set; } = new();
    /// <summary>Профиль направления. Пусто — разговор без профиля, как раньше.</summary>
    public string ProfileId { get; set; } = "";
    /// <summary>Модель, действующая на момент ответа: профиль важнее диалога.</summary>
    public string ProfileName { get; set; } = "";
    /// <summary>Внешний шлюз, если диалог ведётся с агентом на другой машине.
    /// Пусто — диалог идёт на локальный шлюз из настроек.</summary>
    public string GatewayId { get; set; } = "";
    public string GatewayName { get; set; } = "";
    /// <summary>Сессия шлюза, в которой реально живёт этот разговор.
    /// Пусто — диалог ещё не привязан, и его id служит session_id.
    /// Заполняется, когда подхватывается чужой разговор (например, наш
    /// консольный): с этого момента отправка идёт в ту же сессию и
    /// продолжает её историю, а не начинает новую.</summary>
    public string RemoteSessionId { get; set; } = "";
    /// <summary>Сколько сообщений уже подтянуто из шлюза для этого диалога.
    /// Показывается в списке, чтобы было видно, что история не пустая.</summary>
    public int RemoteMessages { get; set; }
    public long UpdatedAt { get; set; } = DateTimeOffset.Now.ToUnixTimeSeconds();
    public long CreatedAt { get; set; } = DateTimeOffset.Now.ToUnixTimeSeconds();
    public int PendingAgentMessages { get; set; }

    [JsonIgnore]
    public bool HasUnfinished => PendingAgentMessages > 0;

    // ---- Представление в списке слева ----

    /// <summary>Группа списка. Считается на лету: адресат диалога меняется
    /// (создали шлюз, привязали диалог), и группа обязана меняться вместе с ним,
    /// а не храниться отдельным полем, которое разъедется с реальностью.</summary>
    [JsonIgnore]
    public string GroupKey => GatewayId.Length > 0 ? "g" + GatewayId
        : ProfileId.Length > 0 ? "p" + ProfileId : "chats";

    [JsonIgnore]
    public string GroupName => GatewayId.Length > 0 ? "ВНЕШНИЕ ШЛЮЗЫ"
        : ProfileId.Length > 0 ? "ОРКЕСТРАТОРЫ" : "ЧАТЫ";

    /// <summary>Вторая строка в списке: кто на том конце провода.
    /// Подхваченная сессия помечена отдельно — она ведётся с консоли или
    /// с другого клиента, и без метки нельзя понять, откуда взялся диалог.</summary>
    [JsonIgnore]
    public string Place => GatewayId.Length > 0 ? GatewayName
        : RemoteSessionId.Length > 0 ? "сессия шлюза · " + RemoteSessionId
        : ProfileId.Length > 0 ? ProfileName
        : "локальный шлюз";
}

/// <summary>Сессия шлюза: разговор, который ведётся через api_server.
/// Именно она хранит настоящую историю — state.json это только список диалогов.
/// Источник: cli (наш консольный разговор) или приложение.</summary>
public sealed class RemoteSession
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    /// <summary>cli | app | unknown. Сессии консоли и приложения различаются
    /// только происхождением, но продолжить можно любую.</summary>
    public string Source { get; set; } = "";
    public string Model { get; set; } = "";
    public int MessageCount { get; set; }
    public int ToolCallCount { get; set; }
    public double StartedAt { get; set; }
    /// <summary>Когда разговор шел последний раз. Без него список выглядит
    /// мёртвым: сообщения набежали, а цифра и время стоят.</summary>
    public double LastActive { get; set; }
    /// <summary>Первая строка последнего сообщения — по ней сессия опознаётся
    /// в списке, не открывая её целиком.</summary>
    public string Preview { get; set; } = "";
    /// <summary>«сейчас» / «5 мин назад» / «вчера». Человеку это понятнее,
    /// чем абсолютная метка, когда он смотрит, где идёт работа.</summary>
    public string ActiveText
    {
        get
        {
            if (LastActive <= 0) return "";
            var minutes = (DateTimeOffset.Now.ToUnixTimeSeconds() - (long)LastActive) / 60;
            return minutes switch
            {
                < 1 => "сейчас",
                < 60 => $"{minutes} мин назад",
                < 60 * 24 => $"{minutes / 60} ч назад",
                _ => DateTimeOffset.FromUnixTimeSeconds((long)LastActive).ToLocalTime().ToString("dd.MM")
            };
        }
    }

    public string StartedText => StartedAt <= 0
        ? ""
        : DateTimeOffset.FromUnixTimeSeconds((long)StartedAt).ToLocalTime().ToString("dd.MM HH:mm");

    public string Badge => Source switch
    {
        "cli" => "консоль",
        "app" => "приложение",
        _ => ""
    };
}

/// <summary>Одно сообщение сессии шлюза. Роль: user | assistant | tool | system.</summary>
public sealed class RemoteMessage
{
    public string Id { get; set; } = "";
    public string Role { get; set; } = "";
    /// <summary>Текст. У вызова инструмента пусто — содержание в Result.</summary>
    public string Content { get; set; } = "";
    public string ToolName { get; set; } = "";
    public string ToolCallId { get; set; } = "";
    /// <summary>Что вызвал агент: имя инструмента и аргументы. У пользователя пусто.</summary>
    public string ToolCall { get; set; } = "";
    /// <summary>Результат вызова инструмента.</summary>
    public string Result { get; set; } = "";
    public double Timestamp { get; set; }

    public bool IsAgent => Role == "assistant";
    public bool IsUser => Role == "user";
    public bool IsTool => Role == "tool";
    /// <summary>Показывать ли строку вообще: пустой вызов без результата
    /// пользователю ничего не говорит, а строки тысячи.</summary>
    public bool Visible => Content.Length > 0 || Result.Length > 0 || ToolCall.Length > 0;

    public string TimeText => Timestamp <= 0
        ? ""
        : DateTimeOffset.FromUnixTimeMilliseconds((long)(Timestamp * 1000)).ToLocalTime().ToString("HH:mm");
}

public sealed class ChatSettings
{
    public string BaseUrl { get; set; } = "http://127.0.0.1:8642";
    public string ApiKey { get; set; } = "";
    public string DefaultSessionKey { get; set; } = "agent:hermeschat:win:dm:marti";
    public string Model { get; set; } = "hermes-agent";
    public bool ShowReasoning { get; set; } = true;
    public bool ShowTools { get; set; } = true;
    public int FontSize { get; set; } = 14;

    [JsonIgnore]
    public string NormalizedBase => BaseUrl.TrimEnd('/');
    [JsonIgnore]
    public bool Ready => ApiKey.Length >= 8 && Uri.TryCreate(NormalizedBase, UriKind.Absolute, out var u)
                          && u.Scheme is "http" or "https";
}