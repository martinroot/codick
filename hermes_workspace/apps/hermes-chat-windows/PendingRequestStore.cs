namespace HermesChat;

/// <summary>
/// Реестр открытых запросов шлюза (approval / clarify) для одного окна.
///
/// Ключевая вещь, ради которой реестр выделен: ответ нельзя искать по ЖИВОМУ
/// ЗАПУСКУ. Разрешение живёт в очереди tools/approval на шлюзе и приходит
/// отдельным server→client запросом — в том числе когда ответ агента уже
/// дописался и запуска не осталось. Поиск по запуску в таком случае давал null,
/// кнопка молча ничего не делала, и блок висел на экране до перезапуска.
/// Реестр хранит сокет запроса рядом с его сообщением и живёт своей жизнью.
///
/// Без generic и без WPF: состояние запросов проверяется обычными тестами.
/// </summary>
public sealed class PendingRequestStore<TMessage, TTransport> where TMessage : class
{
    public sealed record Entry(string Id, string Kind, TTransport? Transport, TMessage Message);

    private readonly Dictionary<string, Entry> _entries = new();

    /// <summary>Вид + id: одинаковые строки id у разных шлюзов не затирают друг друга.</summary>
    private static string Key(string kind, string id) => kind + ":" + id;

    public int Count => _entries.Count;

    public IEnumerable<Entry> Entries => _entries.Values;

    /// <summary>Запрос по виду и id кадра.</summary>
    public Entry? Find(string kind, string id) =>
        _entries.GetValueOrDefault(Key(kind, id));

    /// <summary>Запрос по сообщению и виду. Именно этим ищет кнопка: в разметке
    /// доступен id сообщения, а не id кадра шлюза.</summary>
    public Entry? FindByMessage(string kind, string messageId, Func<TMessage, string> idOf)
    {
        foreach (var entry in _entries.Values)
            if (entry.Kind == kind && string.Equals(idOf(entry.Message), messageId, StringComparison.Ordinal))
                return entry;
        return null;
    }

    public void Remember(Entry entry) => _entries[Key(entry.Kind, entry.Id)] = entry;

    /// <summary>Забрать и снять: повторный клик по той же кнопке уже ничего
    /// не отправит — запрос закрыт один раз.</summary>
    public Entry? Take(string kind, string id) =>
        _entries.Remove(Key(kind, id), out var entry) ? entry : null;

    /// <summary>Снять запись, не отвечая: шлюз сам разберётся по таймауту.</summary>
    public Entry? Forget(string kind, string id) => Take(kind, id);

    /// <summary>Забыть всё: закрытие вкладки или окна. Неотвеченные кадры шлюз
    /// снимет по своему таймауту, держать их в памяти незачем.</summary>
    public void Clear() => _entries.Clear();
}