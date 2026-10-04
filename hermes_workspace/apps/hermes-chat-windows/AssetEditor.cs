using System.IO;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Win32;

namespace HermesChat;
public sealed class AssetEditor : Window
{
    public AssetEditor(AgentAsset asset, bool existing)
    {
        Title = existing ? "Редактор · " + asset.Name : "Новый " + (asset.Kind == "skill" ? "скилл" : "инструмент");
        Width = 920; Height = 780; MinWidth = 700; MinHeight = 600; WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = (System.Windows.Media.Brush)Application.Current.FindResource("Bg");
        var grid = new Grid { Margin = new Thickness(24) }; grid.RowDefinitions.Add(new() { Height = new GridLength(1,GridUnitType.Star) }); grid.RowDefinitions.Add(new() { Height = GridLength.Auto });
        var panel = new StackPanel(); var scroll = new ScrollViewer { Content = panel, VerticalScrollBarVisibility = ScrollBarVisibility.Auto }; grid.Children.Add(scroll);
        void Label(string text) => panel.Children.Add(new TextBlock { Text = text, Margin = new Thickness(0,12,0,6) });
        TextBox Box(string text, bool multi = false) { var box = new TextBox { Text = text, AcceptsReturn = multi, TextWrapping = multi ? TextWrapping.Wrap : TextWrapping.NoWrap, MinHeight = multi ? 240 : 30, MaxHeight = multi ? 420 : 36, VerticalScrollBarVisibility = ScrollBarVisibility.Auto }; panel.Children.Add(box); return box; }
        Label("Имя"); var name = Box(asset.Name); Label("Кратко: что делает и когда нужен"); var description = Box(asset.Description);
        var runtime = new ComboBox { ItemsSource = new[] { "python", "shell", "powershell" }, SelectedItem = asset.Runtime, Margin = new Thickness(0,12,0,0), Visibility = asset.Kind == "tool" ? Visibility.Visible : Visibility.Collapsed }; panel.Children.Add(runtime);
        Label(asset.Kind == "skill" ? "Инструкция / алгоритм / условия успеха (Markdown без YAML-заголовка)" : "Код инструмента (при сохранении не запускается)"); var content = Box(asset.Content,true);
        Label("Нужные env-переменные — имена через запятую, без значений"); var env = Box(string.Join(", ",asset.RequiredEnv));
        var files = new Dictionary<string,string>(asset.Files); Label("Вспомогательные текстовые файлы"); var fileList = new ListBox { ItemsSource = files.Keys.ToList(), MinHeight = 45, MaxHeight = 120, Foreground = (System.Windows.Media.Brush)FindResource("Fg"), Background = (System.Windows.Media.Brush)FindResource("Panel") }; panel.Children.Add(fileList);
        Label("Путь добавляемого файла в пакете (папка или имя файла)"); var filePath = Box("references/");
        var add = new Button { Content = "Добавить файл…", Style = (Style)FindResource("Btn"), Margin = new Thickness(0,8,0,0) }; panel.Children.Add(add);
        add.Click += (_,_) => { var dialog = new OpenFileDialog { Filter = "Текстовые файлы|*.md;*.txt;*.py;*.sh;*.ps1;*.json;*.yaml;*.yml;*.js;*.csv;*.toml;*.html" }; if (dialog.ShowDialog(this) != true) return; try { var text = File.ReadAllText(dialog.FileName); if (text.Length > 500000) throw new IOException("Файл слишком большой."); var relative = filePath.Text.Trim(); if (relative.EndsWith("/")) relative += Path.GetFileName(dialog.FileName); AgentPackages.SafeEntry(relative); files[relative] = text; fileList.ItemsSource = files.Keys.ToList(); } catch (Exception error) { MessageBox.Show(error.Message); } };
        var remove = new Button { Content = "Убрать выбранный файл", Style = (Style)FindResource("Btn"), Margin = new Thickness(0,8,0,0) }; panel.Children.Add(remove); remove.Click += (_,_) => { if (fileList.SelectedItem is string key) { files.Remove(key); fileList.ItemsSource = files.Keys.ToList(); } };
        Label("История версий"); var versions = new ComboBox { ItemsSource = asset.History.OrderByDescending(r=>r.Version).ToList(), DisplayMemberPath = "Version" }; panel.Children.Add(versions);
        var restore = new Button { Content = "Загрузить версию в редактор", Style = (Style)FindResource("Btn"), Margin = new Thickness(0,8,0,0) }; panel.Children.Add(restore); restore.Click += (_,_) => { if (versions.SelectedItem is AssetRevision revision) { content.Text = revision.Content; description.Text = revision.Description; files = new(revision.Files); fileList.ItemsSource = files.Keys.ToList(); } };
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0,18,0,0) }; Grid.SetRow(buttons,1); grid.Children.Add(buttons);
        var save = new Button { Content = "Сохранить версию", Style = (Style)FindResource("PrimaryBtn") }; buttons.Children.Add(save);
        save.Click += (_,_) => { try { var candidate = new AgentAsset { Name = name.Text.Trim(), Description = description.Text.Trim(), Content = content.Text, Kind = asset.Kind, Runtime = runtime.SelectedItem as string ?? "python", RequiredEnv = env.Text.Split(',',StringSplitOptions.TrimEntries|StringSplitOptions.RemoveEmptyEntries).Distinct().ToList(), Files = files }; AgentPackages.Validate(candidate); if (existing) AgentPackages.Revision(asset,candidate.Content,candidate.Description); else { asset.Content = candidate.Content; asset.Description = candidate.Description; } asset.Name = candidate.Name; asset.RequiredEnv = candidate.RequiredEnv; asset.Runtime = candidate.Runtime; asset.Files = files; DialogResult = true; } catch (Exception error) { MessageBox.Show(error.Message,Title); } };
        Content = grid;
    }
}
