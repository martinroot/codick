using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace PulsePilot;

/// <summary>Показывает, что предложила модель, и даёт выбрать. Ничего не запускает сам — только выбирает узел.</summary>
public partial class AiTaskWindow : Window
{
    public string NodeId { get; private set; } = "";
    public string Why { get; private set; } = "";
    public bool IsBusy { get; private set; }
    public string Guidance => GuidanceBox.Text;
    /// <summary>Повторный запрос с теми же кандидатами и новой формулировкой оператора.</summary>
    public Action? Retry { get; set; }
    /// <summary>Оператор взял задачу. Окно закрывается, приложение продолжает работу.</summary>
    public event Action<string, string>? Chosen;
    /// <summary>
    /// Отменяет текущий запрос, если он ещё идёт. Источник мог быть уже освобождён завершившимся
    /// запросом — закрытие окна не должно из-за этого ронять приложение.
    /// </summary>
    public void CancelPending()
    {
        var pending = _pending;
        _pending = null;
        if (pending == null) return;
        try { pending.Cancel(); }
        catch (ObjectDisposedException) { /* запрос уже завершился — отменять нечего */ }
    }
    private CancellationTokenSource? _pending;
    /// <summary>Запоминает текущий запрос, чтобы его можно было отменить закрытием окна.</summary>
    public void TrackRequest(CancellationTokenSource cts) => _pending = cts;
    /// <summary>Забывает запрос: он завершился, отменять его уже не нужно.</summary>
    public void ForgetRequest() => _pending = null;
    /// <summary>Окно закрыто: ответы модели больше некуда показывать.</summary>
    public bool IsDisposed { get; private set; }
    public AiTaskWindow(Project project, ProjectBrief brief, int candidateCount)
    {
        InitializeComponent();
        TitleText.Text = project.Title;
        GoalText.Text = (brief.Goal.Length > 0 ? "Цель: " + brief.Goal + " · " : "") +
            (brief.Gate.Length > 0 ? "масштаб: " + brief.Gate : "масштаб не задан") +
            " · исполнимых кандидатов: " + candidateCount;
        RetryButton.Click += (_, _) => { if (!IsBusy) Retry?.Invoke(); };
        Closed += (_, _) => { IsDisposed = true; CancelPending(); };
        GuidanceBox.KeyDown += (_, e) =>
        {
            if (e.Key == System.Windows.Input.Key.Enter && System.Windows.Input.Keyboard.Modifiers.HasFlag(System.Windows.Input.ModifierKeys.Control))
            { e.Handled = true; if (!IsBusy) Retry?.Invoke(); }
        };
    }

    public void SetBusy(string text)
    {
        IsBusy = true;
        StatusText.Text = text; ErrorText.Text = ""; WhyText.Text = ""; Note("");
        RawText.Text = "";
        Options.Children.Clear(); RetryButton.IsEnabled = false; TakeButton.IsEnabled = false;
        CloseButton.Content = "Закрыть";
    }

    public void SetError(string text)
    {
        IsBusy = false; StatusText.Text = ""; ErrorText.Text = text; RetryButton.IsEnabled = true;
    }

    /// <summary>Показывает сырой ответ модели, когда разобрать его не удалось — чтобы видеть, что она вернула.</summary>
    public void SetRaw(string answer)
    {
        RawText.Text = answer.Trim().Length == 0
            ? "(модель вернула пустой ответ — весь лимит токенов ушёл на внутреннее рассуждение)"
            : answer.Trim();
    }

    /// <summary>Служебная пометка, например о том, что ответила запасная модель.</summary>
    public void Note(string text)
    {
        NoteText.Text = text;
        NoteText.Visibility = text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>Показывает предложения модели. Всё, чего нет в дереве, уже отброшено вызывающим кодом.</summary>
    public void Show(string why, IReadOnlyList<AiPick.Candidate> candidates, IReadOnlyDictionary<string, Node> byId)
    {
        IsBusy = false; ErrorText.Text = ""; RetryButton.IsEnabled = true;
        StatusText.Text = candidates.Count == 0
            ? "Модель не предложила ни одной задачи из списка кандидатов. Уточни словами или закрой окно."
            : "Варианты — выбери один. Ctrl+Enter в поле выше — спросить заново.";
        WhyText.Text = why.Length > 0 ? "Почему: " + why : "";
        Options.Children.Clear();
        var shown = new List<AiPick.Candidate>();
        foreach (var c in candidates)
            if (byId.ContainsKey(c.NodeId) && shown.All(x => x.NodeId != c.NodeId)) shown.Add(c);
        for (var i = 0; i < shown.Count; i++)
        {
            var c = shown[i];
            var node = byId[c.NodeId];
            var button = new Button
            {
                Content = new StackPanel
                {
                    Children =
                    {
                        new TextBlock { Text = (i == 0 ? "Предложение: " : "Запасной: ") + "[" + c.NodeId + "] " + node.Title, TextWrapping = TextWrapping.Wrap, FontWeight = i == 0 ? FontWeights.SemiBold : FontWeights.Normal },
                        new TextBlock { Text = c.Why.Length > 0 ? c.Why : "пояснения не дал", TextWrapping = TextWrapping.Wrap, FontSize = 11.5, Foreground = (Brush)FindResource("FgDim"), Margin = new Thickness(0, 3, 0, 0) }
                    }
                },
                HorizontalContentAlignment = HorizontalAlignment.Left,
                Margin = new Thickness(0, 0, 0, 8),
                Padding = new Thickness(12)
            };
            var captured = c.NodeId; var capturedWhy = c.Why;
            button.Click += (_, _) => Select(captured, capturedWhy);
            Options.Children.Add(button);
        }
        TakeButton.IsEnabled = false;
        if (shown.Count > 0) Select(shown[0].NodeId, shown[0].Why);
    }

    private void Select(string id, string why)
    {
        NodeId = id; Why = why;
        TakeButton.IsEnabled = true;
        foreach (var element in Options.Children)
            if (element is Button b) b.BorderThickness = new Thickness(0);
    }

    private void Take(object s, RoutedEventArgs e) { Chosen?.Invoke(NodeId, Why); Close(); }
    private void RetryNow(object s, RoutedEventArgs e) { if (!IsBusy) Retry?.Invoke(); }
    private void Cancel(object s, RoutedEventArgs e) { _pending?.Cancel(); Close(); }
}
