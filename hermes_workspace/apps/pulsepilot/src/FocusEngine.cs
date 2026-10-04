using System.Windows.Threading;

namespace PulsePilot;

/// <summary>
/// Таймер фокуса: по умолчанию 5 минут. По истечении — звук + жёсткий попап поверх всего.
/// </summary>
public class FocusEngine
{
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(1) };
    public event Action<int>? Ticked;          // секунд осталось
    public event Action? Expired;             // время вышло
    public event Action<bool>? RunningChanged;

    public bool IsRunning { get; private set; }
    public int IntervalSeconds { get; set; } = 300;
    public int Remaining { get; private set; }
    public int PostponesLeft { get; set; } = 2;

    public FocusEngine()
    {
        _timer.Tick += (_, _) =>
        {
            Remaining--;
            if (Remaining <= 0)
            {
                Remaining = 0;
                _timer.Stop();
                IsRunning = false;
                RunningChanged?.Invoke(false);
                Ticked?.Invoke(0);
                Expired?.Invoke();
            }
            else Ticked?.Invoke(Remaining);
        };
    }

    public void SetInterval(int minutes)
    {
        IntervalSeconds = Math.Clamp(minutes, 1, 120) * 60;
        if (!IsRunning) Remaining = IntervalSeconds;
    }

    public void Start()
    {
        if (IsRunning) return;
        if (Remaining <= 0) Remaining = IntervalSeconds;
        IsRunning = true;
        _timer.Start();
        RunningChanged?.Invoke(true);
    }

    public void Pause()
    {
        if (!IsRunning) return;
        _timer.Stop();
        IsRunning = false;
        RunningChanged?.Invoke(false);
    }

    public void Reset()
    {
        _timer.Stop();
        IsRunning = false;
        Remaining = IntervalSeconds;
        RunningChanged?.Invoke(false);
        Ticked?.Invoke(Remaining);
    }

    /// <summary>Отсрочка: продлевает текущий забег, но тратит один из разрешённых отсрочек.</summary>
    public bool Postpone(int extraSeconds)
    {
        if (PostponesLeft <= 0) return false;
        PostponesLeft--;
        Remaining += extraSeconds;
        Ticked?.Invoke(Remaining);
        return true;
    }

    public string Fmt(int? seconds = null)
    {
        var s = seconds ?? Remaining;
        return $"{s / 60:00}:{s % 60:00}";
    }
}
