using System.Diagnostics;
using System.Net.Http;

namespace HermesChat;

/// <summary>
/// Держит `hermes serve` запущенным. TUI gateway живёт именно в нём: на порту
/// api_server (8642, aiohttp) WebSocket-эндпоинта нет вовсе — /api/capabilities
/// там отдаёт 404, — поэтому без этого процесса подключиться не к чему.
///
/// Свой процесс на каждую локальную копию: адрес и порт берём из настроек
/// диалога, внешние шлюзы не трогаем (у них serve поднят на своей машине).
/// </summary>
public static class ServeProcess
{
    private static readonly Dictionary<string, Process> Running = new();
    private static readonly object Gate = new();

    /// <summary>Проверить, что по адресу отвечает TUI gateway, и поднять его, если нет.</summary>
    /// <param name="address">Куда подключаемся.</param>
    /// <param name="ct">Отмена.</param>
    /// <param name="allowLocalSpawn">
    /// Разрешено ли поднимать `hermes serve` на этом адресе. Для адреса внешнего
    /// шлюза — всегда false: там serve живёт на своей машине, а для адреса
    /// SSH-ТУННЕЛЯ (127.0.0.1:&lt;проброшенный порт&gt;) поднимать нечего и нельзя:
    /// порт уже занят туннелем, второй процесс там не стартует, и оператор получает
    /// невнятное «не поднялся» вместо «порт занят».
    /// </param>
    public static async Task EnsureAsync(Uri address, CancellationToken ct = default, bool allowLocalSpawn = true)
    {
        if (!allowLocalSpawn) return;                       // адрес обслуживает внешний шлюз
        if (!IsLocal(address) || await IsAliveAsync(address, ct).ConfigureAwait(false)) return;

        lock (Gate)
        {
            if (Running.TryGetValue(address.ToString(), out var existing) && !existing.HasExited) return;

            var start = new ProcessStartInfo
            {
                FileName = "hermes.cmd",
                Arguments = $"serve --port {address.Port} --host {address.Host} --skip-build",
                WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            // .cmd не запускается напрямую через UseShellExecute=false — нужен cmd.exe.
            var process = new Process { StartInfo = start, EnableRaisingEvents = true };
            process.OutputDataReceived += (_, _) => { };
            process.ErrorDataReceived += (_, _) => { };
            if (!process.Start())
                throw new InvalidOperationException("не удалось запустить hermes serve");
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            Running[address.ToString()] = process;
        }

        // Процесс поднимается не мгновенно: ждём, пока /api/ws начнёт отвечать.
        for (var attempt = 0; attempt < 40; attempt++)
        {
            if (await IsAliveAsync(address, ct).ConfigureAwait(false)) return;
            await Task.Delay(500, ct).ConfigureAwait(false);
        }
        throw new InvalidOperationException(
            $"hermes serve не поднялся на {address} — проверь, что команда hermes доступна");
    }

    /// <summary>Отвечает ли по этому адресу корень serve (он и раздаёт токен).</summary>
    private static async Task<bool> IsAliveAsync(Uri address, CancellationToken ct)
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
            var html = await http.GetStringAsync(new Uri(address, "/"), ct).ConfigureAwait(false);
            return html.Contains("__HERMES_SESSION_TOKEN__", StringComparison.Ordinal);
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>Локальный адрес — значит serve можно и нужно поднимать у нас.
    /// Проверка по имени хоста, а не по IP: на этой машине адрес может быть задан
    /// как localhost, 127.0.0.1 или именем интерфейса.</summary>
    private static bool IsLocal(Uri address)
    {
        var host = address.Host;
        return host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || System.Net.IPAddress.TryParse(host, out var ip)
               && System.Net.IPAddress.IsLoopback(ip);
    }
}
