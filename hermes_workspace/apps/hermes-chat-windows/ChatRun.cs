namespace HermesChat;

/// <summary>
/// Один живой ответ одного диалога: своё WS-соединение шлюза, своя отмена,
/// своё сообщение и свои счётчики.
///
/// Раньше всё это лежало полями вкладки, и это была главная причина, по
/// которой стриминг «сбрасывался» при переключении чата: второе сообщение
/// перезаписывало поля первого, а EnsureTuiAsync закрывал его соединение.
/// Теперь запуски независимы: чатов может быть сколько угодно, и каждый
/// дописывает свой ответ сам.
///
/// Таймер проверки окна разрешения намеренно НЕ здесь: DispatcherTimer тянет
/// WPF, а состояние запуска проверяется обычными тестами без окна.
/// </summary>
public sealed class ChatRun
{
    public ChatRun(string threadId, ChatThread thread, ChatMessage message)
    {
        ThreadId = threadId;
        Thread = thread;
        Message = message;
    }

    public string ThreadId { get; }
    public ChatThread Thread { get; }
    public ChatMessage Message { get; }

    /// <summary>Активен ли запуск: пока он не null, идёт ответ агента.</summary>
    public CancellationTokenSource? Cts;

    public TuiCompletionSignal? Completion;

    /// <summary>WS-соединение этого диалога и мост событий к его сообщению.</summary>
    public TuiGateway? Gateway;
    public TuiEventBridge? Bridge;
    public string Address = "";

    /// <summary>Сколько событий потока пришло — счётчик видно в строке метрик.</summary>
    public int StreamEvents;

    /// <summary>id запроса шлюза, ждущего разрешения (approval).</summary>
    public string? ApprovalRequestId;

    public bool Busy => Cts is not null;

    /// <summary>Освободить транспорт, не трогая сообщение: сессия на шлюзе
    /// переоткроется по stored_session_id при следующей отправке.</summary>
    public void StopTransport()
    {
        Bridge?.Detach();
        Bridge = null;
        Gateway?.Dispose();
        Gateway = null;
        Address = "";
    }

    /// <summary>Остановить запуск и закрыть транспорт. Вызывается при STOP,
    /// снятии вкладки и закрытии окна.</summary>
    public void Stop()
    {
        var cts = Interlocked.Exchange(ref Cts, null);
        if (cts is not null)
        {
            cts.Cancel();
            try { cts.Dispose(); } catch (ObjectDisposedException) { }
        }
        Completion?.Cancel();
        Completion = null;
        StopTransport();
    }
}

/// <summary>
/// Реестр живых запусков этого окна: по одному активному ответу на диалог,
/// и диалоги не мешают друг другу.
///
/// Ключ — id диалога, поэтому фоновый ответ дописывает своё сообщение, не
/// трогая открытый чат: переключение чата меняет только то, что нарисовано.
/// </summary>
public sealed class RunRegistry
{
    private readonly Dictionary<string, ChatRun> _runs = new();

    public IReadOnlyCollection<ChatRun> Runs => _runs.Values;

    public ChatRun? this[string threadId] => _runs.GetValueOrDefault(threadId);

    /// <summary>Есть ли хоть один активный ответ — от этого зависит кнопка STOP.</summary>
    public bool AnyBusy
    {
        get { foreach (var run in _runs.Values) if (run.Busy) return true; return false; }
    }

    /// <summary>Сколько ответов идёт, кроме указанного диалога: их видно в шапке,
    /// иначе про фоновый чат не узнать вообще нигде.</summary>
    public int BackgroundCount(string except) =>
        _runs.Values.Count(run => run.Busy && !string.Equals(run.ThreadId, except, StringComparison.Ordinal));

    public bool IsBusy(string threadId) => this[threadId]?.Busy == true;

    /// <summary>Зарегистрировать запуск. Возвращает false, если диалог уже
    /// отвечает: второй ответ в тот же диалог затирал бы первый.</summary>
    public bool TryBegin(string threadId, ChatThread thread, ChatMessage message, out ChatRun? run)
    {
        if (IsBusy(threadId)) { run = null; return false; }
        run = new ChatRun(threadId, thread, message);
        _runs[threadId] = run;
        return true;
    }

    /// <summary>Запуск по его сообщению: кнопки разрешений и вопросов несут id
    /// сообщения, а ответ уходит в сокет ИМЕННО этого диалога, а не текущего.</summary>
    public ChatRun? ByMessage(string messageId)
    {
        foreach (var run in _runs.Values)
            if (string.Equals(run.Message.Id, messageId, StringComparison.Ordinal)) return run;
        return null;
    }

    /// <summary>Снять регистрацию после завершения ответа. Соединение при этом
    /// остаётся: следующее сообщение продолжит ту же сессию шлюза.</summary>
    public ChatRun? End(string threadId)
    {
        if (!_runs.TryGetValue(threadId, out var run)) return null;
        _runs.Remove(threadId);
        return run;
    }

    /// <summary>Остановить один диалог и снять регистрацию. Соседние запуски не
    /// трогаются: STOP относится к открытому чату.</summary>
    public ChatRun? Stop(string threadId)
    {
        var run = End(threadId);
        run?.Stop();
        return run;
    }

    /// <summary>Остановить всё: закрытие вкладки или окна. Иначе фоновый ответ
    /// продолжал бы писать в ленту невидимого диалога.</summary>
    public List<ChatRun> StopAll()
    {
        var stopped = _runs.Values.ToList();
        _runs.Clear();
        foreach (var run in stopped) run.Stop();
        return stopped;
    }
}