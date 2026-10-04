using System.Windows;
using System.Windows.Controls;

namespace PulsePilot;

public partial class SettingsWindow : Window
{
    private readonly StateStore _state;

    public SettingsWindow(StateStore state)
    {
        InitializeComponent();
        _state = state;
        UrlBox.Text = state.Settings.ApiUrl;
        KeyBox.Password = state.Settings.ApiKey;
        PollBox.Text = state.Settings.PollSeconds.ToString();
        SoundChk.IsChecked = state.Settings.SoundEnabled;
        AskChk.IsChecked = state.Settings.AskWhatDoing;
        ActChk.IsChecked = state.Settings.TrackActivity;
        LlmUrlBox.Text = state.Settings.LlmBaseUrl;
        LlmKeyBox.Password = state.Settings.LlmKey;
        LlmModelBox.Text = state.Settings.LlmModel;
        PickModelBox.Text = state.Settings.LlmPickModel;
        PickModelHint.Text = "Отдельная модель: reasoning-модели вроде " + state.Settings.LlmModel +
            " тратят весь лимит токенов на внутреннее рассуждение и возвращают пустой ответ. Для выбора задачи нужна быстрая не-reasoning модель. Запасная: " + state.Settings.LlmPickFallbackModel;
        WhereText.Text = "Состояние хранится локально: " + StateStore.Path_;
    }

    private int Num(TextBox box, int fallback, int min, int max) =>
        int.TryParse(box.Text, out var v) ? Math.Clamp(v, min, max) : fallback;

    private async void Test(object s, RoutedEventArgs e)
    {
        WhereText.Text = "проверяю…";
        try
        {
            var api = new ApiClient(UrlBox.Text.Trim(), KeyBox.Password.Trim());
            await api.PingAsync();
            var t = await api.GetTreeAsync();
            WhereText.Text = $"ок · ver {t.Version}, шагов {t.Steps}, проектов {t.Projects.Count}";
            // дерево нужно перерисовать после смены ритма/настроек — Refresh дёрнет главное окно
            WhereText.Foreground = (System.Windows.Media.Brush)FindResource("Accent2");
        }
        catch (Exception ex)
        {
            WhereText.Text = "связь не удалась: " + ex.Message;
            WhereText.Foreground = (System.Windows.Media.Brush)FindResource("Bad");
        }
    }

    private async void TestModel(object s, RoutedEventArgs e)
    {
        WhereText.Text = "проверяю модель…";
        try
        {
            var tmp = new StateStore { Settings = new AppSettings {
                LlmTemperature = _state.Settings.LlmTemperature,
                LlmMaxTokens = _state.Settings.LlmMaxTokens
            } };
            tmp.Settings.LlmBaseUrl = LlmUrlBox.Text.Trim();
            tmp.Settings.LlmKey = LlmKeyBox.Password.Trim();
            tmp.Settings.LlmModel = LlmModelBox.Text.Trim();
            var answer = await new LlmClient().AskAsync(tmp.Settings, new[]
            {
                ("user", "Ответь одним словом: работает?")
            });
            WhereText.Text = "модель отвечает: " + (answer.Length > 120 ? answer[..120] : answer);
            WhereText.Foreground = (System.Windows.Media.Brush)FindResource("Accent2");
        }
        catch (Exception ex)
        {
            WhereText.Text = "модель не ответила: " + ex.Message;
            WhereText.Foreground = (System.Windows.Media.Brush)FindResource("Bad");
        }
    }

    private void Save(object s, RoutedEventArgs e)
    {
        _state.Settings.ApiUrl = UrlBox.Text.Trim();
        _state.Settings.ApiKey = KeyBox.Password.Trim();
        _state.Settings.PollSeconds = Num(PollBox, _state.Settings.PollSeconds, 5, 300);
        _state.Settings.SoundEnabled = SoundChk.IsChecked == true;
        _state.Settings.AskWhatDoing = AskChk.IsChecked == true;
        _state.Settings.LlmBaseUrl = LlmUrlBox.Text.Trim();
        _state.Settings.LlmKey = LlmKeyBox.Password.Trim();
        _state.Settings.LlmModel = LlmModelBox.Text.Trim();
        if (PickModelBox.Text.Trim().Length > 0) _state.Settings.LlmPickModel = PickModelBox.Text.Trim();
        _state.Settings.TrackActivity = ActChk.IsChecked == true;
        _state.Save();
        DialogResult = true;
    }

    private void Cancel(object s, RoutedEventArgs e) => DialogResult = false;
}
