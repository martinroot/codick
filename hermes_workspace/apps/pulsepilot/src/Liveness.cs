using System.Diagnostics;
using System.Net.Http;

namespace PulsePilot;

/// <summary>
/// Разобранный локер. Строка в карточке может быть чем угодно, поэтому спецификация
/// выводится из вида строки, а всё неузнанное честно помечается как непроверяемое.
/// </summary>
public sealed record LockerProbe(string Kind, string Target, string Raw)
{
    public bool Verifiable => Kind is "tmux" or "process" or "url";
    public string Describe() => Kind switch
    {
        "tmux" => "tmux-сессия " + Target,
        "process" => "процесс " + Target,
        "url" => "HTTP " + Target,
        _ => "строка в свободной форме — проверить нечем"
    };
}

public sealed record ProbeResult(bool Ok, string Note);

public static class Liveness
{
    /// <summary>tmux:codick · proc:claude · http(s)://… — всё остальное непроверяемо.</summary>
    public static LockerProbe Parse(string locker)
    {
        var raw = (locker ?? "").Trim();
        if (raw.Length == 0) return new LockerProbe("none", "", raw);
        var colon = raw.IndexOf(':');
        if (colon > 0)
        {
            var scheme = raw[..colon].Trim().ToLowerInvariant();
            var target = raw[(colon + 1)..].Trim();
            if (target.Length > 0)
            {
                if (scheme is "tmux" or "session") return new LockerProbe("tmux", target, raw);
                if (scheme is "proc" or "process") return new LockerProbe("process", target, raw);
            }
        }
        if (raw.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
            raw.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            return new LockerProbe("url", raw, raw);
        return new LockerProbe("text", raw, raw);
    }

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(8) };

    public static async Task<ProbeResult> RunAsync(LockerProbe probe, CancellationToken cancel = default)
    {
        try
        {
            return probe.Kind switch
            {
                "url" => await ProbeUrl(probe.Target, cancel),
                "process" => ProbeProcess(probe.Target),
                "tmux" => await ProbeShell("tmux has-session -t " + Quote(probe.Target), cancel),
                _ => new ProbeResult(false, "Проверять нечем: " + probe.Describe())
            };
        }
        catch (Exception ex) { return new ProbeResult(false, ex.GetType().Name + ": " + ex.Message); }
    }

    private static string Quote(string value) => "\"" + value.Replace("\"", "") + "\"";

    private static async Task<ProbeResult> ProbeUrl(string url, CancellationToken cancel)
    {
        using var response = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancel);
        return new ProbeResult(response.IsSuccessStatusCode, "HTTP " + (int)response.StatusCode + " " + response.ReasonPhrase);
    }

    private static ProbeResult ProbeProcess(string name)
    {
        var found = Process.GetProcessesByName(name.Replace(".exe", "", StringComparison.OrdinalIgnoreCase));
        try
        {
            return found.Length > 0
                ? new ProbeResult(true, found.Length + " процесс(ов) " + name)
                : new ProbeResult(false, "процесс " + name + " не найден");
        }
        finally { foreach (var p in found) p.Dispose(); }
    }

    private static async Task<ProbeResult> ProbeShell(string command, CancellationToken cancel)
    {
        var info = new ProcessStartInfo("cmd.exe", "/c " + command)
        { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
        using var process = Process.Start(info);
        if (process == null) return new ProbeResult(false, "не удалось запустить проверку");
        var stdout = await process.StandardOutput.ReadToEndAsync(cancel);
        await process.WaitForExitAsync(cancel);
        return process.ExitCode == 0
            ? new ProbeResult(true, "команда успешна" + (stdout.Trim().Length > 0 ? ": " + stdout.Trim() : ""))
            : new ProbeResult(false, "команда вернула код " + process.ExitCode);
    }
}

/// <summary>Причины, по которым запуск стоит. Список закрытый: «просто молчит» — не причина.</summary>
public static class BlockReasons
{
    public static readonly (string Key, string Label)[] All =
    {
        ("money", "Нужны деньги"),
        ("access", "Нужен доступ, аккаунт или ключ"),
        ("external", "Жду внешнего ответа"),
        ("crashed", "Процесс упал"),
        ("thinking", "Думает, но без видимого продвижения"),
        ("contention", "Ресурс занят другим запуском"),
        ("decision", "Жду моего решения по существу")
    };

    public static string Label(string key) => All.FirstOrDefault(r => r.Key == key).Label ?? "Причина не указана";
    public static bool Known(string key) => All.Any(r => r.Key == key);
}
