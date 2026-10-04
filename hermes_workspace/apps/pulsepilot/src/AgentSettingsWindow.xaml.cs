using System.Windows;
namespace PulsePilot;
public partial class AgentSettingsWindow : Window
{
    private readonly StateStore _state;
    public AgentSettingsWindow(StateStore state) { InitializeComponent(); _state = state; UrlBox.Text = state.Settings.AgentBaseUrl; KeyBox.Password = state.Settings.AgentKey; StaleBox.Text = state.Settings.AgentStaleMinutes.ToString(); }
    private void Save(object s, RoutedEventArgs e)
    {
        var url = UrlBox.Text.Trim();
        if (url.Length > 0 && (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") || KeyBox.Password.Length == 0))
        { ErrorText.Text = "Укажи HTTP(S) URL и token Bridge либо оставь URL пустым для ручных локеров."; return; }
        _state.Settings.AgentBaseUrl = url; _state.Settings.AgentKey = KeyBox.Password;
        _state.Settings.AgentStaleMinutes = int.TryParse(StaleBox.Text, out var minutes) ? Math.Clamp(minutes, 1, 120) : 5;
        _state.Save(); DialogResult = true;
    }
    private void Cancel(object s, RoutedEventArgs e) => DialogResult = false;
}
