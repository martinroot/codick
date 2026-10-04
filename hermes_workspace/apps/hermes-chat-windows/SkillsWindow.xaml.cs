using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace HermesChat;

public partial class SkillsWindow : Window
{
    private readonly List<SkillInfo> _all;
    private readonly List<string> _chosen;

    public SkillsWindow(List<SkillInfo> all, List<string> chosen)
    {
        InitializeComponent();
        _all = all;
        _chosen = chosen;
        List.ItemsSource = all;
        List.SelectedItem = all.FirstOrDefault(s => chosen.Contains(s.Name));
        Update();
        List.SelectionChanged += (_, _) => Update();
    }

    private SkillInfo? Current => List.SelectedItem as SkillInfo;

    private void Update()
    {
        AttachBtn.IsEnabled = Current is not null && !_chosen.Contains(Current.Name);
        if (Current is not null) Description.Text = Current.Description;
        Chosen.Text = _chosen.Count == 0
            ? "К диалогу не прикреплено ни одного навыка."
            : "В диалоге: " + string.Join(", ", _chosen);
    }

    private void OnAttach(object sender, RoutedEventArgs e)
    {
        if (Current is null || _chosen.Contains(Current.Name)) return;
        _chosen.Add(Current.Name);
        Update();
    }

    private void OnDetach(object sender, RoutedEventArgs e)
    {
        if (List.SelectedItem is not SkillInfo skill) return;
        if (_chosen.Remove(skill.Name)) Update();
    }

    private void OnOk(object sender, RoutedEventArgs e)
    {
        DialogResult = true;
    }
}