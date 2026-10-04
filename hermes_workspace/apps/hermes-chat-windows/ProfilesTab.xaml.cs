using System.Windows;
using System.Windows.Controls;

namespace HermesChat;

/// <summary>Вкладка «Профили оркестраторов»: список профилей, вкладки дерева, редактор.
/// Читает и пишет общее состояние приложения.</summary>
public partial class ProfilesTab : UserControl
{
    public Store State { get; set; } = null!;
    private Profile? _current;
    private bool _loading;

    public ProfilesTab()
    {
        InitializeComponent();
        Studio.RequestTest += (profile,test) => RequestTest?.Invoke(profile,test);
        Studio.RequestConversation += id => RequestConversation?.Invoke(id);
        Studio.Imported += profile => { ProfileList.Items.Refresh(); ProfileList.SelectedItem = profile; };
    }

    /// <summary>Вызывается оболочкой после присвоения State.</summary>
    public void Load()
    {
        ProfileList.ItemsSource = State.Profiles;
        if (State.Profiles.Count > 0 && ProfileList.SelectedItem is null)
            ProfileList.SelectedIndex = 0;
        if (_current is not null) Studio.Bind(State, _current);
    }


    private void OnSelect(object sender, SelectionChangedEventArgs e)
    {
        if (ProfileList.SelectedItem is not Profile profile) return;
        _current = profile;
        _loading = true;
        NameBox.Text = profile.Name;
        ProjectBox.Text = profile.ProjectId;
        ModelBox.Text = profile.Model;
        SessionBox.Text = profile.SessionKey;
        PromptBox.Text = profile.Prompt;
        SkillsBox.Text = string.Join("\n", profile.Skills);
        _loading = false;
        Studio.Bind(State, profile);
        ShowQueue();
    }

    /// <summary>Размер очереди профиля — цифра из снимка дерева, а не обещание.</summary>
    private void ShowQueue()
    {
        var id = ProjectBox.Text.Trim();
        if (id.Length == 0) { QueueNote.Text = "Универсальный агент: своей очереди нет."; return; }
        var count = TreeBriefs.TodoCount(id);
        var title = TreeBriefs.TitleOf(id);
        QueueNote.Text = count == 0
            ? "Снимок дерева не найден или направление пусто — агент не получит очереди."
            : $"Очередь направления: {count} TODO" + (title.Length > 0 ? $" · {title}" : "");
    }

    private void OnNew(object sender, RoutedEventArgs e)
    {
        var profile = new Profile
        {
            Name = "Новый профиль",
            Prompt = "Ты — профильный агент. Опиши здесь свою зону и правила."
        };
        State.Profiles.Add(profile);
        ProfileList.Items.Refresh();
        ProfileList.SelectedItem = profile;
        State.Save();
    }

    private void OnDelete(object sender, RoutedEventArgs e)
    {
        if (_current is null) return;
        if (State.Iterations.Any(j => j.ProfileId == _current.Id && j.Busy)) { MessageBox.Show("Сначала остановите итерацию этого профиля."); return; }
        foreach (var thread in State.Threads.Where(t => t.ProfileId == _current.Id))
        {
            thread.ProfileId = "";
            thread.ProfileName = "";
        }
        foreach (var gateway in State.Gateways.Where(g => g.ProfileId == _current.Id)) gateway.ProfileId = "";
        State.Profiles.Remove(_current);
        _current = null;
        Studio.Bind(State, null);
        ProfileList.Items.Refresh();
        if (ProfileList.Items.Count > 0) ProfileList.SelectedIndex = 0;
        State.Save();
    }

    private void OnSave(object sender, RoutedEventArgs e)
    {
        if (_current is null || _loading) return;
        _current.Name = NameBox.Text.Trim().Length == 0 ? "Без имени" : NameBox.Text.Trim();
        _current.ProjectId = ProjectBox.Text.Trim();
        _current.ProjectTitle = _current.ProjectId.Length > 0 ? TreeBriefs.TitleOf(_current.ProjectId) : "";
        _current.Model = ModelBox.Text.Trim();
        _current.SessionKey = SessionBox.Text.Trim().Length > 0
            ? SessionBox.Text.Trim()
            : _current.ProjectId.Length > 0 ? "agent:profile:" + _current.ProjectId + ":win" : "";
        _current.Prompt = PromptBox.Text;
        _current.Skills = SkillsBox.Text
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
        ProfileList.Items.Refresh();
        State.Save();
        Studio.Bind(State, _current);
        ShowQueue();
    }

    /// <summary>Открыть диалог с этим профилем — чтобы не искать его потом в списке чатов.</summary>
    private void OnChatWithProfile(object sender, RoutedEventArgs e)
    {
        if (_current is null) return;
        RequestThread?.Invoke(_current.Id);
    }

    public event Action<Profile,AgentTestCase>? RequestTest;
    public event Action<string>? RequestConversation;
    public event Action<string>? RequestThread;
}