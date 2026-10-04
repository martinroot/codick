namespace PulsePilot;

public static class Sound
{
    // Short cue off the UI thread: the alert opens immediately, audio failure never blocks it.
    private static int _playing;
    private static void Cue(bool done)
    {
        if (Interlocked.Exchange(ref _playing, 1) != 0) return;
        _ = Task.Run(() =>
        {
            try
            {
                Console.Beep(done ? 784 : 880, 90);
                Console.Beep(done ? 1047 : 1175, 140);
            }
            catch { }
            finally { Interlocked.Exchange(ref _playing, 0); }
        });
    }
    public static void PlayFocusUp() => Cue(false);
    public static void PlayDone() => Cue(true);
    public static void PlayTick() => Cue(false);
}
