using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace HermesChat;

/// <summary>Выбор одного из адресатов для нового диалога. Список, а не ввод
/// с клавиатуры: профилей и шлюзов становится много, и опечатка в id уводила
/// бы разговор не туда. Закрытие без выбора — отмена, а не пустой диалог.</summary>
public sealed class ChooseWindow : Window
{
    private readonly List<(string Id, string Label)> _choices;

    public string ChoiceId { get; private set; } = "";

    public ChooseWindow(string title, List<(string Id, string Label)> choices)
    {
        _choices = choices;
        Title = title;
        Width = 460;
        SizeToContent = SizeToContent.Height;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = (Brush)Application.Current.FindResource("Bg");
        Foreground = (Brush)Application.Current.FindResource("Fg");

        var list = new ListBox
        {
            MaxHeight = 320,
            Background = (Brush)Application.Current.FindResource("Panel"),
            Foreground = (Brush)Application.Current.FindResource("Fg"),
            BorderThickness = new Thickness(0)
        };
        foreach (var (id, label) in choices)
        {
            var item = new ListBoxItem { Content = label, Padding = new Thickness(10, 8, 10, 8), Tag = id };
            item.MouseDoubleClick += (_, _) => { Choose(id); Close(); };
            list.Items.Add(item);
        }
        list.SelectionChanged += (_, _) =>
        {
            if (list.SelectedItem is ListBoxItem chosen) ChoiceId = chosen.Tag as string ?? "";
        };

        var ok = new Button { Content = "Начать диалог", Style = (Style)FindResource("PrimaryBtn"), MinWidth = 150 };
        ok.Click += (_, _) => { if (ChoiceId.Length > 0) Close(); };
        var cancel = new Button { Content = "Отмена", Style = (Style)FindResource("Btn") };
        cancel.Click += (_, _) => Close();

        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        buttons.Children.Add(cancel);
        buttons.Children.Add(ok);

        var root = new StackPanel { Margin = new Thickness(16) };
        root.Children.Add(list);
        root.Children.Add(buttons);
        Content = root;

        Loaded += (_, _) => { ok.IsDefault = true; if (list.Items.Count > 0) list.SelectedIndex = 0; };
    }

    private void Choose(string id) => ChoiceId = id;
}