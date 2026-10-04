using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace PulsePilot;

public partial class BlockReasonWindow : Window
{
    public string ReasonKey { get; private set; } = "";
    public string Fact { get; private set; } = "";
    private string _selected = "";

    public BlockReasonWindow(FleetJob job, LockerProbe probe, bool live)
    {
        InitializeComponent();
        TitleText.Text = job.Title;
        LiveText.Text = "Локер: " + (job.Locker.Length > 0 ? job.Locker : "не задан") + " · " + probe.Describe() +
            (live ? " · последняя проверка: живой" : job.LivenessAt > 0 ? " · последняя проверка: не отвечает (" + job.LivenessNote + ")" : " · ещё не проверялся");
        if (_selected.Length == 0 && job.BlockReason.Length > 0) _selected = job.BlockReason;
        foreach (var (key, label) in BlockReasons.All)
        {
            var button = new Button { Content = new TextBlock { Text = label, TextWrapping = TextWrapping.Wrap },
                HorizontalContentAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 0, 0, 6), Padding = new Thickness(12) };
            button.Click += (_, _) => { _selected = key; Highlight(); };
            button.Tag = key;
            Reasons.Children.Add(button);
        }
        if (job.BlockReason.Length > 0 && BlockReasons.Known(job.BlockReason)) FactBox.Text = job.Summary;
        Highlight();
    }

    private void Highlight()
    {
        foreach (var element in Reasons.Children)
        {
            if (element is not Button button) continue;
            var selected = (string)button.Tag == _selected;
            button.BorderBrush = (Brush)FindResource(selected ? "Accent" : "Line");
            button.BorderThickness = new Thickness(selected ? 2 : 1);
        }
    }

    private void Save(object s, RoutedEventArgs e)
    {
        if (_selected.Length == 0) { ErrorText.Text = "Выбери причину — «просто молчит» причиной не является."; return; }
        if (FactBox.Text.Trim().Length < 4) { ErrorText.Text = "Допиши факт: что именно помешало и чего ждёшь."; return; }
        ReasonKey = _selected; Fact = FactBox.Text.Trim(); DialogResult = true;
    }

    private void Cancel(object s, RoutedEventArgs e) => DialogResult = false;
}
