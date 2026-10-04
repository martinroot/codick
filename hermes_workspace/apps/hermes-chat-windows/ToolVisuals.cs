namespace HermesChat;

public sealed record ToolVisual(string Icon, string Title);

/// <summary>Человеко-читаемые подписи и пиктограммы событий инструментов в ленте.</summary>
public static class ToolVisuals
{
    private static readonly Dictionary<string, ToolVisual> Known = new(StringComparer.OrdinalIgnoreCase)
    {
        ["read_file"] = new("📖", "Читает файл"),
        ["write_file"] = new("📝", "Записывает файл"),
        ["patch"] = new("🛠️", "Правит файлы"),
        ["search_files"] = new("🔎", "Ищет по файлам"),
        ["terminal"] = new("⌨️", "Выполняет команду"),
        ["web_search"] = new("🌐", "Ищет в интернете"),
        ["web_extract"] = new("📄", "Читает веб-страницу"),
        ["browser"] = new("🌐", "Открывает страницу"),
        ["computer_use"] = new("🖱️", "Управляет окном"),
        ["image_gen"] = new("🎨", "Создаёт изображение"),
        ["delegate_task"] = new("🤝", "Передаёт подзадачу"),
        ["clarify"] = new("❓", "Уточняет задачу"),
        ["skills_list"] = new("🧰", "Смотрит доступные навыки"),
        ["skill_view"] = new("📚", "Читает навык"),
        ["skill_manage"] = new("🧠", "Обновляет навык"),
    };

    public static ToolVisual For(string? name)
    {
        var key = (name ?? "").Trim().ToLowerInvariant().Replace('-', '_').Replace(' ', '_');
        if (Known.TryGetValue(key, out var visual)) return visual;
        var readable = string.Join(' ', key.Split('_', StringSplitOptions.RemoveEmptyEntries)
            .Select(part => part.Length == 0 ? part : char.ToUpperInvariant(part[0]) + part[1..]));
        return new ToolVisual("⚙️", readable.Length > 0 ? readable : "Инструмент");
    }
}
