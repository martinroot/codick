using System.IO;
using System.Text.Json;
using Microsoft.Win32;

namespace HermesChat;
public static class WorkspaceMigration
{
    public static void Import(Store store)
    {
        if (store.PulseImported) return;
        var path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PulsePilot", "state.json");
        if (!File.Exists(path)) return;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            var root = doc.RootElement;
            if (root.TryGetProperty("Tree", out var tree) && tree.TryGetProperty("projects", out var projects) && projects.GetArrayLength() > 0)
                ImportTree(tree.GetRawText());
            store.RefreshProfiles();
            if (root.TryGetProperty("ProjectBriefs", out var briefs))
                foreach (var profile in store.Profiles.Where(p => p.IsBound))
                    if (briefs.TryGetProperty(profile.ProjectId, out var brief))
                        profile.Prompt += "\n\nЦель из PulsePilot: " + Read(brief, "Goal") + "\nФакт: " + Read(brief, "Fact") + "\nУсловие перехода: " + Read(brief, "Gate");
            if (root.TryGetProperty("FleetJobs", out var jobs))
                foreach (var job in jobs.EnumerateArray())
                {
                    var profile = store.Profiles.FirstOrDefault(p => p.ProjectId == Read(job,"ProjectId"));
                    if (profile is null) continue;
                    var status = Read(job,"Status");
                    store.Iterations.Add(new WorkspaceIteration
                    {
                        Id = "pulse-" + Read(job,"Id"), ProfileId = profile.Id, NodeId = Read(job,"NodeId"), Title = Read(job,"Title"),
                        Status = status switch { "done" => "done", "review" => "review", "cancelled" => "cancelled", "failed" => "failed", _ => "interrupted" },
                        Result = Read(job,"Result"), Note = "Перенесено из PulsePilot (" + status + "). " + Read(job,"Summary") + "\nЛокер: " + Read(job,"Locker") + ". Проверь сервер перед новым запуском."
                    });
                }
            store.PulseImported = true; store.Save();
        }
        catch (Exception error) { CrashLog.Write("Импорт PulsePilot: " + error.Message); }
    }
    private static string Read(JsonElement item, string key) => item.TryGetProperty(key, out var value) ? value.ToString() : "";
    public static void ImportTree(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        if (root.TryGetProperty("tree", out var nested)) root = nested;
        if (!root.TryGetProperty("projects", out var projects) || projects.ValueKind != JsonValueKind.Array)
            throw new InvalidOperationException("В JSON нет массива projects.");
        var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "HermesWorkspace");
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, "tree-snapshot.json");
        if (File.Exists(path)) File.Copy(path, path + ".backup", true);
        File.WriteAllText(path + ".tmp", root.GetRawText()); File.Move(path + ".tmp", path, true);
        TreeBriefs.Reload();
    }
}
