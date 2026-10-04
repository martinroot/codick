namespace HermesChat;

/// <summary>Записи в списке моделей. Id уходит в /v1/runs как model.</summary>
public sealed class ModelChoice
{
    public string Id { get; set; } = "";
    public string Label { get; set; } = "";
    public string Note { get; set; } = "";
    public bool IsCustom => Id.Length > 0 && !ModelCatalog.Known(Id);
    /// <summary>Список и редактируемое поле показывают Label, в котором первым идёт Id:
    /// иначе «Claude Sonnet 4» уйдёт в шлюз как model и не сработает.</summary>
    public string Display => Id.Length > 0 ? Id + (Label.Length > 0 ? " — " + Label : "") : Label;
    public override string ToString() => Display;
}

public static class ModelCatalog
{
    /// <summary>/v1/models отдаёт только hermes-agent, но произвольный model в /v1/runs
    /// принимается и маршрутизируется как raw_request (проверено на anthropic/claude-sonnet-4).
    /// Поэтому список предложений наш, а шлюз остаётся источником истины по факту ответа:
    /// реально ответившая модель приходит в runtime.model и показывается рядом.</summary>
    public static readonly ModelChoice[] Defaults =
    {
        new() { Id = "hermes-agent",              Label = "Hermes (как настроен в шлюзе)" },
        new() { Id = "stealth/space-bunny-alpha", Label = "Space Bunny Alpha — быстро, дёшево" },
        new() { Id = "anthropic/claude-sonnet-4",  Label = "Claude Sonnet 4 — сильное рассуждение" },
        new() { Id = "openai/gpt-4.1",             Label = "GPT-4.1" },
        new() { Id = "google/gemini-2.5-pro",      Label = "Gemini 2.5 Pro" },
        new() { Id = "deepseek/deepseek-v4-flash", Label = "DeepSeek V4 Flash" }
    };

    public static bool Known(string id) => Defaults.Any(m => m.Id == id);

    /// <summary>Заголовок списка — чтобы строка «свой маршрут» не выглядела как модель.</summary>
    public const string CustomLabel = "Свой маршрут шлюза…";
}

public sealed class SkillInfo
{
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
    public string Category { get; set; } = "";
}

/// <summary>Вложение: скриншот из буфера, перетащенный файл или выбранный через диалог.</summary>
public sealed class Attachment
{
    public string Name { get; set; } = "";
    /// <summary>Абсолютный путь — агент читает файл с диска своей машины (шлюз локальный).</summary>
    public string Path { get; set; } = "";
    public long Size { get; set; }
    public bool IsImage { get; set; }
    /// <summary>Снимок экрана, снятый с буфера: показываем рядом с именем, чтобы видеть, что отправлено.</summary>
    public string? PreviewBase64 { get; set; }

    public string SizeText => Size switch
    {
        < 1024 => $"{Size} Б",
        < 1024 * 1024 => $"{Size / 1024.0:0.#} КБ",
        _ => $"{Size / (1024.0 * 1024.0):0.#} МБ"
    };
}
