using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace PulsePilot;

public sealed class ActivitySlice
{
    public string App { get; set; } = "";
    public string Title { get; set; } = "";
    public int Seconds { get; set; }
    public int Keys { get; set; }   // клавиши за этот срез
    public string When { get; set; } = "";
}

public sealed class ActivityDay
{
    public string Date { get; set; } = "";
    public int FocusSeconds { get; set; }       // время в фокусе всего
    public int TypingSeconds { get; set; }      // секунды, когда был ввод
    public int IdleSeconds { get; set; }        // простой без ввода
    public int Samples { get; set; }
    public Dictionary<string, int> ByApp { get; set; } = new();
    public List<ActivitySlice> Slices { get; set; } = new();
}

/// <summary>
/// Честный учёт активности: какое окно в фокусе, был ли ввод, был ли простой.
/// Опрос раз в 2 секунды через P/Invoke — почти не ест CPU (важно для 2-ядерной машины).
/// </summary>
public class ActivityTracker
{
    private const int IntervalMs = 2000;
    private const int MaxSlices = 400;

    private readonly System.Windows.Threading.DispatcherTimer _timer =
        new() { Interval = TimeSpan.FromMilliseconds(IntervalMs) };

    private string _currentApp = "";
    private string _currentTitle = "";
    private DateTime _sliceStart = DateTime.Now;
    private int _sliceKeys;
    private DateTime _lastInput = DateTime.Now;
    private uint _prevKeyCount;

    public ActivityDay Today { get; private set; } = new();
    public event Action? Tick;

    public bool Enabled { get; set; } = true;

    // P/Invoke
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO
    {
        public int cbSize;
        public uint dwTime;
    }
    [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    public void Start()
    {
        Today = LoadDay(DateTime.Today);
        _timer.Tick += OnTick;
        _timer.Start();
    }

    public void Stop()
    {
        _timer.Stop();
        FlushSlice();
        SaveDay();
    }

    private void OnTick(object? s, EventArgs e)
    {
        if (!Enabled) return;
        try { Sample(); }
        catch { }
    }

    private void Sample()
    {
        var (app, title) = Foreground();
        var input = ReadInput();

        if (app != _currentApp)
        {
            FlushSlice();
            _currentApp = app;
            _currentTitle = title;
            _sliceStart = DateTime.Now;
            _sliceKeys = 0;
        }
        else
        {
            _currentTitle = title;
        }

        var now = DateTime.Now;
        if (input) _lastInput = now;

        var typed = input;
        if (typed) _sliceKeys++;

        var idleNow = (now - _lastInput).TotalSeconds >= 20;

        var step = IntervalMs / 1000;
        Today.Samples++;
        if (idleNow)
            Today.IdleSeconds += step;
        else
        {
            Today.FocusSeconds += step;
            if (typed) Today.TypingSeconds += step;
        }

        if (app.Length > 0)
        {
            var key = Normalize(app);
            Today.ByApp.TryGetValue(key, out var cur);
            Today.ByApp[key] = cur + step;
        }

        // Срез держим до 5 минут, чтобы в логе не было тысяч строк.
        if ((now - _sliceStart).TotalSeconds > 300) FlushSlice();

        Tick?.Invoke();
    }

    private bool ReadInput()
    {
        var info = new LASTINPUTINFO { cbSize = Marshal.SizeOf<LASTINPUTINFO>() };
        if (!GetLastInputInfo(ref info)) return false;
        // Счётчик тиков ввода растёт при нажатии клавиш; мышь им не считаем.
        var typed = info.dwTime != _prevKeyCount;
        _prevKeyCount = info.dwTime;
        return typed;
    }

    private (string app, string title) Foreground()
    {
        var h = GetForegroundWindow();
        if (h == IntPtr.Zero) return ("", "");
        var len = GetWindowTextLength(h);
        if (len <= 0) return ("", "");
        var sb = new StringBuilder(len + 2);
        GetWindowText(h, sb, sb.Capacity);
        var title = sb.ToString();
        if (title.Length > 120) title = title[..120];

        var cls = new StringBuilder(64);
        GetClassName(h, cls, cls.Capacity);
        var app = cls.ToString();
        if (app.StartsWith("ApplicationFrameWindow")) app = "UWP";
        if (app.Length == 0) app = "unknown";
        return (app, title);
    }

    private void FlushSlice()
    {
        if (_currentApp.Length == 0) return;
        var secs = (int)(DateTime.Now - _sliceStart).TotalSeconds;
        if (secs < 3) return;
        Today.Slices.Add(new ActivitySlice
        {
            App = Normalize(_currentApp),
            Title = _currentTitle,
            Seconds = secs,
            Keys = _sliceKeys,
            When = _sliceStart.ToString("HH:mm")
        });
        if (Today.Slices.Count > MaxSlices) Today.Slices.RemoveRange(0, Today.Slices.Count - MaxSlices);
        _sliceStart = DateTime.Now;
        _sliceKeys = 0;
    }

    private static string Normalize(string app) => app switch
    {
        var s when s.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) => s[..^4].ToLowerInvariant(),
        _ => app.ToLowerInvariant()
    };

    private static string Dir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PulsePilot");

    private string DayPath(string date) => Path.Combine(Dir, "activity-" + date + ".json");

    private ActivityDay LoadDay(DateTime d)
    {
        try
        {
            var path = DayPath(d.ToString("yyyy-MM-dd"));
            if (File.Exists(path))
                return System.Text.Json.JsonSerializer.Deserialize<ActivityDay>(File.ReadAllText(path))
                       ?? NewDay(d);
        }
        catch { }
        return NewDay(d);
    }

    private static ActivityDay NewDay(DateTime d) => new() { Date = d.ToString("yyyy-MM-dd") };

    public void SaveDay()
    {
        try
        {
            Directory.CreateDirectory(Dir);
            var path = DayPath(Today.Date);
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, System.Text.Json.JsonSerializer.Serialize(Today));
            File.Move(tmp, path, true);
        }
        catch { }
    }

    /// <summary>Топ приложений за день по минутам.</summary>
    public List<(string App, int Minutes)> TopApps(int count = 6)
        => Today.ByApp
            .OrderByDescending(kv => kv.Value)
            .Take(count)
            .Select(kv => (kv.Key, kv.Value / 60))
            .ToList();

    public string HumanToday()
    {
        var f = TimeSpan.FromSeconds(Today.FocusSeconds);
        var t = TimeSpan.FromSeconds(Today.TypingSeconds);
        var i = TimeSpan.FromSeconds(Today.IdleSeconds);
        return $"в фокусе {f:hh\\:mm}, ввод {t:hh\\:mm}, простой {i:hh\\:mm}";
    }
}
