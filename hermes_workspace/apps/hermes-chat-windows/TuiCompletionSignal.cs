namespace HermesChat;

/// <summary>Completes a chat turn only after its terminal event has updated the UI model.</summary>
public sealed class TuiCompletionSignal
{
    private readonly TaskCompletionSource<bool> _source =
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    public Task Task => _source.Task;

    public void UiApplied(string eventName)
    {
        if (eventName == "run.completed") _source.TrySetResult(true);
        else if (eventName is "run.failed" or "run.cancelled" or "run.interrupted") _source.TrySetResult(false);
    }

    public void Cancel() => _source.TrySetResult(false);
}
