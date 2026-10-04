using System.Windows;
using System.Windows.Input;

namespace PulsePilot;

public partial class TextInputWindow : Window
{
    public string Value => Box.Text;

    public TextInputWindow(string title, string label, string initial)
    {
        InitializeComponent();
        Title = title;
        Label.Text = label;
        Box.Text = initial;
        Loaded += (_, _) => { Box.Focus(); Box.SelectAll(); };
        KeyDown += (_, e) =>
        {
            if (e.Key == Key.Escape) { DialogResult = false; }
        };
    }

    private void Ok(object s, RoutedEventArgs e) => DialogResult = true;
    private void Cancel(object s, RoutedEventArgs e) => DialogResult = false;
    private void OnChanged(object s, System.Windows.Controls.TextChangedEventArgs e) { }
}
