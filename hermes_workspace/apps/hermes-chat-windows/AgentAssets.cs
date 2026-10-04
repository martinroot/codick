using System.IO;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace HermesChat;
public sealed class AgentAsset
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Kind { get; set; } = "skill";
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
    public string Content { get; set; } = "";
    public string Runtime { get; set; } = "python";
    public List<string> RequiredEnv { get; set; } = new();
    public Dictionary<string, string> Files { get; set; } = new();
    public int Version { get; set; } = 1;
    public List<AssetRevision> History { get; set; } = new();
    public string StatusLine => (Kind == "skill" ? "Скилл" : Runtime + " · инструмент") + " · v" + Version;
}
public sealed class AssetRevision
{
    public int Version { get; set; }
    public long At { get; set; } = DateTimeOffset.Now.ToUnixTimeSeconds();
    public string Content { get; set; } = "";
    public string Description { get; set; } = "";
    public Dictionary<string,string> Files { get; set; } = new();
}
public sealed class AgentTestCase
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Prompt { get; set; } = "";
    public string Expected { get; set; } = "";
    public string Result { get; set; } = "";
    public string Status { get; set; } = "draft";
    public string AssetId { get; set; } = "";
    public string ThreadId { get; set; } = "";
    public Dictionary<string,int> AssetVersions { get; set; } = new();
    public long At { get; set; }
}
public sealed class AgentBundle
{
    public int Schema { get; set; } = 1;
    public Profile Profile { get; set; } = new();
    public List<AgentAsset> Assets { get; set; } = new();
    public List<AgentTestCase> Tests { get; set; } = new();
    public List<string> EnvNames { get; set; } = new();
}
public static class AgentPackages
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };
    public static void ImportEnv(string path, string profileId)
    {
        using var zip = ZipFile.OpenRead(path); var file = zip.GetEntry(".env"); if (file is null) return;
        using var reader = new StreamReader(file.Open());
        foreach (var line in reader.ReadToEnd().Split('\n')) { var index = line.IndexOf('='); if (index > 0 && !line.StartsWith('#')) SaveEnv(profileId,line[..index],line[(index+1)..].TrimEnd('\r')); }
    }
    public static string EnvPath(string profileId) => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "HermesWorkspace", "agents", SafeName(profileId), ".env");
    public static string SafeName(string value)
    { var slug = Regex.Replace(value.ToLowerInvariant(), "[^a-z0-9_-]", "-").Trim('-'); return slug.Length > 0 ? slug[..Math.Min(slug.Length,64)] : "agent"; }
    public static string SafeEntry(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Contains('\\') || value.StartsWith('/') || value.Contains(':')
            || value.Split('/').Any(p => p is ".." or "." or "")) throw new InvalidDataException("Недопустимый путь в пакете: " + value);
        return value;
    }
    public static Dictionary<string,string> ReadEnv(string id)
    {
        var result = new Dictionary<string,string>();
        if (!File.Exists(EnvPath(id))) return result;
        foreach (var line in File.ReadAllLines(EnvPath(id)))
        { var index = line.IndexOf('='); if (index <= 0 || line.StartsWith('#')) continue; result[line[..index]] = line[(index+1)..]; }
        return result;
    }
    public static void SaveEnv(string id, string key, string value)
    {
        if (!Regex.IsMatch(key, "^[A-Z_][A-Z0-9_]*$") || value.Contains('\n') || value.Contains('\r')) throw new InvalidDataException("Имя переменной: A–Z, цифры и _. Значение — одна строка.");
        var values = ReadEnv(id); values[key] = value;
        var path = EnvPath(id); Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllLines(path + ".tmp", values.Select(pair => pair.Key + "=" + pair.Value)); File.Move(path + ".tmp", path,true);
    }
    public static void RemoveEnv(string id, string key)
    { var values = ReadEnv(id); values.Remove(key); File.WriteAllLines(EnvPath(id), values.Select(pair => pair.Key + "=" + pair.Value)); }
    public static void Validate(AgentAsset asset)
    {
        if (asset.Files is null || asset.History is null || asset.RequiredEnv is null) throw new InvalidDataException("Неполный ресурс.");
        if (asset.Kind is not ("skill" or "tool") || asset.Name.Trim().Length == 0 || asset.Description.Trim().Length == 0 || asset.Content.Trim().Length == 0)
            throw new InvalidDataException("Заполните имя, краткое описание и содержимое.");
        if (asset.Content.Length > 100_000) throw new InvalidDataException("Содержимое больше 100 000 символов. Разделите на файлы.");
        foreach (var key in asset.RequiredEnv) if (!Regex.IsMatch(key,"^[A-Z_][A-Z0-9_]*$")) throw new InvalidDataException("Недопустимое имя env: " + key);
        if (asset.Runtime is not ("python" or "shell" or "powershell")) throw new InvalidDataException("Неизвестный runtime.");
        foreach (var file in asset.Files) { SafeEntry(file.Key); if (file.Key.Equals("SKILL.md",StringComparison.OrdinalIgnoreCase) || file.Key.Equals("scripts/run.py",StringComparison.OrdinalIgnoreCase) && asset.Kind == "tool" && asset.Runtime == "python" || file.Key.Equals("scripts/run.sh",StringComparison.OrdinalIgnoreCase) && asset.Kind == "tool" && asset.Runtime == "shell" || file.Key.Equals("scripts/run.ps1",StringComparison.OrdinalIgnoreCase) && asset.Kind == "tool" && asset.Runtime == "powershell") throw new InvalidDataException("Этот путь занят основным файлом ресурса."); if (file.Value.Length > 500_000) throw new InvalidDataException("Файл слишком большой."); }
    }
    public static void Revision(AgentAsset asset, string content, string description)
    { asset.History.Add(new() { Version = asset.Version, Content = asset.Content, Description = asset.Description, Files = new(asset.Files) }); asset.Content = content; asset.Description = description; asset.Version++; }
    public static string SkillMarkdown(AgentAsset asset) =>
        "---\nname: " + JsonSerializer.Serialize(SafeName(asset.Name)) + "\ndescription: " + JsonSerializer.Serialize(asset.Description) + "\n" +
        (asset.RequiredEnv.Count == 0 ? "" : "required_environment_variables:\n" + string.Join("",asset.RequiredEnv.Select(k => "  - name: " + k + "\n    prompt: " + JsonSerializer.Serialize(k) + "\n"))) + "---\n\n" + (asset.Kind == "tool" ? "# " + asset.Name + "\n\n" + asset.Description + "\n\nПеред запуском проверь окружение. Используй скрипт scripts/run." + (asset.Runtime == "python" ? "py" : asset.Runtime == "shell" ? "sh" : "ps1") + " через terminal. Проверь его результат.\n" : asset.Content);
    /// <summary>
    /// Контекст пакета профиля. Файлы ресурса НЕ вставляются в чат целиком:
    /// они лежат на диске, и агент читает нужный по требованию. Вставка всех
    /// файлов в каждый запрос раздувала его на десятки килобайт (скрипт
    /// исполнителя + плейбук) без единой пользы — и тем самым вытесняла
    /// переписку. В перечислении остаются только имена и назначение.
    /// </summary>
    public static string Context(Profile profile, IEnumerable<AgentAsset> all)
    {
        var assets = all.Where(a => profile.AssetIds.Contains(a.Id)).ToList();
        if (assets.Count == 0 && profile.Toolsets.Count == 0 && profile.Prompt.Length == 0) return "";
        var text = new StringBuilder("\n\nПодключённый пакет профиля. Секретные env-значения здесь не передаются.\n");
        text.AppendLine("Специализация профиля: " + profile.Prompt);
        foreach (var a in assets)
        {
            text.AppendLine($"[{a.Kind} {a.Name} v{a.Version}] {a.Description}\n{a.Content}");
            if (a.Files.Count > 0)
                text.AppendLine("Файлы ресурса лежат на диске, в чат не вставлены — прочитай нужный по пути через read_file, когда понадобится: "
                    + string.Join(", ", a.Files.Keys));
            if (a.RequiredEnv.Count > 0) text.AppendLine("Требуются переменные на сервере: " + string.Join(", ", a.RequiredEnv));
        }
        if (profile.Toolsets.Count > 0) text.AppendLine("Предпочтительные тулсеты: " + string.Join(", ",profile.Toolsets) + ". Доступность определяется шлюзом, это не изоляция остальных инструментов.");
        text.AppendLine("Код выше — инструкция/исходник, а не подтверждение установки на сервере. Проверь наличие файлов и env до выполнения. Не запрашивай значения ключей в чате.");
        if (text.Length > 100_000) throw new InvalidDataException("Подключённый пакет слишком большой для чата. Отключите лишние скиллы/файлы.");
        return text.ToString();
    }
    public static void Export(string path, Profile profile, List<AgentAsset> all, bool includeSecrets, string installer)
    {
        var assets = all.Where(a => profile.AssetIds.Contains(a.Id)).ToList();
        foreach (var asset in assets) Validate(asset);
        var env = ReadEnv(profile.Id);
        var names = env.Keys.Concat(assets.SelectMany(a => a.RequiredEnv)).Distinct().ToList();
        var clone = JsonSerializer.Deserialize<Profile>(JsonSerializer.Serialize(profile))!;
        clone.SessionKey = ""; clone.ThreadMessages = 0;
        var bundle = new AgentBundle { Profile = clone, Assets = assets, Tests = profile.TestCases, EnvNames = names };
        var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        using (var zip = ZipFile.Open(temp, ZipArchiveMode.Create))
        {
            void Add(string name, string body) { using var writer = new StreamWriter(zip.CreateEntry(SafeEntry(name)).Open(),new UTF8Encoding(false)); writer.Write(body); }
            Add("agent.json", JsonSerializer.Serialize(bundle,Json));
            Add("SOUL.md",profile.Prompt);
            Add(".env.example",string.Join("\n",names.Select(k=> k+"=")) + "\n");
            if (includeSecrets) Add(".env",string.Join("\n",env.Select(p=> p.Key+"="+p.Value)) + "\n");
            foreach (var a in assets)
            {
                var folder = "skills/" + SafeName(a.Name) + "-" + a.Id[..Math.Min(8,a.Id.Length)] + "/";
                Add(folder + "SKILL.md",SkillMarkdown(a));
                if (a.Kind == "tool") Add(folder + "scripts/run." + (a.Runtime == "python" ? "py" : a.Runtime == "shell" ? "sh" : "ps1"),a.Content);
                foreach (var file in a.Files) Add(folder + SafeEntry(file.Key),file.Value);
            }
            Add("install_agent.py",installer);
            Add("README.md", "# " + profile.Name + "\n\nИмпорт в HermesWorkspace: Профили → Импорт пакета.\n\nНа сервере: python3 install_agent.py --target /path/to/isolated-hermes-home\nУстановщик сохраняет резервные копии. Скрипты не запускаются. Для переноса .env добавьте --include-env.\nЗапускайте Hermes с HERMES_HOME, указывающим на этот каталог.\nТулсеты и провайдер настраиваются в Hermes отдельно; история серверных сессий не переносится.\n");
        }
        File.Move(temp,path,true);
    }
    public static AgentBundle ReadBundle(string path)
    {
        using var zip = ZipFile.OpenRead(path);
        if (zip.Entries.Count > 500 || zip.Entries.Sum(e => e.Length) > 10_000_000) throw new InvalidDataException("Пакет слишком большой.");
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in zip.Entries) { SafeEntry(entry.FullName); if (!names.Add(entry.FullName)) throw new InvalidDataException("Повторяющийся файл в ZIP."); }
        var manifest = zip.GetEntry("agent.json") ?? throw new InvalidDataException("В пакете отсутствует agent.json.");
        using var reader = new StreamReader(manifest.Open());
        var bundle = JsonSerializer.Deserialize<AgentBundle>(reader.ReadToEnd()) ?? throw new InvalidDataException("Пустой манифест.");
        if (bundle.Profile.AssetIds is null || bundle.Profile.Toolsets is null || bundle.Tests is null || bundle.Assets is null) throw new InvalidDataException("Неполный пакет.");
        if (bundle.Schema != 1 || bundle.Assets.Count > 100 || bundle.Assets.Select(a => a.Id).Distinct().Count() != bundle.Assets.Count) throw new InvalidDataException("Неизвестный или неоднозначный формат пакета.");
        foreach (var asset in bundle.Assets) { Validate(asset); if (asset.History.Count > 100 || asset.Files.Count > 100) throw new InvalidDataException("Слишком много версий или файлов."); }
        bundle.Profile.Id = "profile-" + Guid.NewGuid().ToString("N")[..8]; bundle.Profile.ProjectId = ""; bundle.Profile.ProjectTitle = ""; bundle.Profile.SessionKey = "";
        var selected = bundle.Profile.AssetIds.ToHashSet(); bundle.Profile.AssetIds.Clear();
        var mapping = new Dictionary<string,string>();
        foreach (var asset in bundle.Assets) { var old = asset.Id; asset.Id = Guid.NewGuid().ToString("N"); mapping[old] = asset.Id; if (selected.Contains(old)) bundle.Profile.AssetIds.Add(asset.Id); }
        bundle.Profile.TestCases = bundle.Tests;
        foreach (var test in bundle.Profile.TestCases) { test.ThreadId = ""; test.Status = "imported"; test.AssetId = mapping.GetValueOrDefault(test.AssetId, ""); test.AssetVersions = test.AssetVersions.Where(v=>mapping.ContainsKey(v.Key)).ToDictionary(v=>mapping[v.Key],v=>v.Value); }
        return bundle;
    }
}
