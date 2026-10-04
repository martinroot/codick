using System.Windows;
using System.Windows.Media;

namespace HermesChat;

public partial class SettingsWindow : Window
{
    private readonly Store _store;

    public SettingsWindow(Store store)
    {
        InitializeComponent();
        _store = store;
        BaseBox.Text = store.Settings.BaseUrl;
        KeyBox.Password = store.Settings.ApiKey;
        SessionKeyBox.Text = store.Settings.DefaultSessionKey;
        ModelBox.Text = store.Settings.Model;
        ReasoningBox.IsChecked = store.Settings.ShowReasoning;
        ToolsBox.IsChecked = store.Settings.ShowTools;
        if (store.Settings.ApiKey.Length == 0) KeyNote.Text = "Пусто — приложение попробует взять ключ из %LOCALAPPDATA%\\hermes\\.env при запуске.";
        KeyNote.Text += " Память длинной переписки: ключ сессии '" + store.Settings.DefaultSessionKey +
                       "' общий с этим окном; уникальный для него.";
    }

    private async void OnSaveAndProbe(object sender, RoutedEventArgs e)
    {
        var url = BaseBox.Text.Trim();
        if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed) || parsed.Scheme is not ("http" or "https"))
        {
            Fail("Адрес должен быть http:// или https://");
            return;
        }
        var key = KeyBox.Password.Trim();
        if (key.Length < 8) { Fail("Ключ слишком короткий."); return; }

        _store.Settings.BaseUrl = url.TrimEnd('/');
        _store.Settings.ApiKey = key;
        _store.Settings.DefaultSessionKey = SessionKeyBox.Text.Trim();
        _store.Settings.Model = ModelBox.Text.Trim().Length == 0 ? "hermes-agent" : ModelBox.Text.Trim();
        _store.Settings.ShowReasoning = ReasoningBox.IsChecked == true;
        _store.Settings.ShowTools = ToolsBox.IsChecked == true;
        _store.Save();

        ProbeNote.Text = "Проверяю…";
        var client = new HermesClient(_store.Settings);
        var probe = await client.ProbeAsync(CancellationToken.None);
        if (!probe.Ok) { Fail(probe.Note); return; }
        // Показываем окружение до закрытия окна: иначе async-метод не успеет и пользователь
        // ничего не увидит.
        await ShowEnvironmentAsync(client);
        _store.Save();
        DialogResult = true;
    }

    /// <summary>Показывает то, что агент реально имеет: память, навыки, инструменты.
    /// Раньше окно обещало «память», но не показывало, подключена ли она — поэтому
    /// расхождение с консолью невозможно было заметить.</summary>
    private async Task ShowEnvironmentAsync(HermesClient client)
    {
        try
        {
            var toolsets = await client.ReadToolsetsAsync(CancellationToken.None);
            var configured = toolsets.Where(t => t.Configured).ToList();
            ToolsNote.Text = "Инструменты шлюза: " +
                (configured.Count == 0 ? "ни одного" : string.Join(", ", configured.Take(6).Select(t => t.Name)))
                + (configured.Count > 6 ? $" и ещё {configured.Count - 6}" : "");
            ToolsNote.ToolTip = string.Join("\n", configured.Select(t => t.Name + ": " + string.Join(", ", t.Tools.Take(8))));

            var skills = client.ReadSkills();
            EnvNote.Text =
                $"Навыков на диске: {skills.Count}." +
                (skills.Count == 0
                    ? " Агент будет работать без них."
                    : " Доступны в кнопке «Навыки» диалога.");
        }
        catch (Exception error) { ToolsNote.Text = "Не удалось прочитать окружение: " + error.Message; }
    }

    private void Fail(string note)
    {
        ProbeNote.Text = "Не получилось: " + note;
        ProbeNote.Foreground = (Brush)FindResource("Bad");
    }

    private void OnCancel(object sender, RoutedEventArgs e)
    {
        // DialogResult работает только при ShowDialog — закрываемся так же, как от «Сохранить».
        DialogResult = false;
    }
}