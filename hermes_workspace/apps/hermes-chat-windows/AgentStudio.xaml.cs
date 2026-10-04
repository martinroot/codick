using System.IO;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Microsoft.Win32;

namespace HermesChat;
public partial class AgentStudio : UserControl
{
    private Store? _store;
    private Profile? _profile;
    private string _trainingAssetId = "";
    public event Action<Profile,AgentTestCase>? RequestTest;
    public event Action<string>? RequestConversation;
    public event Action<Profile>? Imported;
    public AgentStudio() { InitializeComponent(); }
    public void Bind(Store state, Profile? profile)
    {
        if (_profile?.Id != profile?.Id) { NativeTiles.Children.Clear(); EnvValue.Clear(); EnvKey.Clear(); TestPrompt.Clear(); TestExpected.Clear(); _trainingAssetId = ""; ExportSecrets.IsChecked = false; ImportSecrets.IsChecked = false; }
        _store = state; _profile = profile; IsEnabled = profile is not null; Refresh();
    }
    private TextBlock Text(string value, int size = 13, string color = "Fg") => new() { Text = value, FontSize = size, Foreground = (Brush)FindResource(color), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0,0,0,8) };
    private Button Button(string label, Action action)
    { var b = new Button { Content = label, Style = (Style)FindResource("Btn"), Margin = new Thickness(0,4,6,0) }; b.Click += (_,_) => Guard(action); return b; }
    private void Guard(Action action) { try { action(); } catch (Exception error) { MessageBox.Show(error.Message,"Мастерская агента"); } }
    private Border Card(StackPanel content) => new() { Child = content, CornerRadius = new CornerRadius(12), BorderThickness = new Thickness(1), BorderBrush = (Brush)FindResource("Line"), Background = (Brush)FindResource("Panel"), Padding = new Thickness(18), Margin = new Thickness(0,0,12,12) };
    public void Refresh()
    {
        if (_store is null || _profile is null || SkillTiles is null) return;
        StudioTitle.Text = _profile.Name;
        StudioSummary.Text = $"Подключено: {_profile.AssetIds.Count} ресурсов · {_profile.Toolsets.Count} тулсетов · {_profile.TestCases.Count} проверок";
        FillAssets(SkillTiles,"skill",SkillSearch.Text); FillAssets(ToolTiles,"tool",ToolSearch.Text);
        EnvRows.Children.Clear();
        var env = AgentPackages.ReadEnv(_profile.Id);
        foreach (var key in env.Keys) { var row = new DockPanel { Margin = new Thickness(0,4,0,4) }; var remove = Button("Убрать", () => { AgentPackages.RemoveEnv(_profile.Id,key); Refresh(); }); DockPanel.SetDock(remove,Dock.Right); row.Children.Add(remove); row.Children.Add(Text(key + "  ••••••••")); EnvRows.Children.Add(row); }
        var missing = _store.Assets.Where(a=>_profile.AssetIds.Contains(a.Id)).SelectMany(a=>a.RequiredEnv).Distinct().Where(k=>!env.ContainsKey(k)).ToList();
        if (missing.Count > 0) EnvRows.Children.Add(Text("Нужно заполнить: " + string.Join(", ",missing),13,"Warn"));
        TestHistory.Children.Clear();
        foreach (var test in _profile.TestCases.OrderByDescending(t=>t.At))
        {
            var panel = new StackPanel();
            var outdated = test.AssetVersions.Any(v => _store.Assets.FirstOrDefault(a=>a.Id == v.Key)?.Version != v.Value);
            panel.Children.Add(Text(test.Status + (outdated ? " · ресурс изменён, повторите тест" : ""),12,outdated ? "Warn" : "Accent"));
            panel.Children.Add(Text(test.Prompt,16)); panel.Children.Add(Text("Критерии: " + test.Expected,12,"Dim"));
            if (test.Result.Length > 0) panel.Children.Add(new Expander { Header = "Сохранённый результат", Foreground = (Brush)FindResource("Fg"), Content = new TextBox { Text = test.Result, IsReadOnly = true, TextWrapping = TextWrapping.Wrap, MaxHeight = 180, VerticalScrollBarVisibility = ScrollBarVisibility.Auto } });
            var actions = new WrapPanel();
            if (test.ThreadId.Length > 0) actions.Children.Add(Button("Открыть чат",()=>RequestConversation?.Invoke(test.ThreadId)));
            if (test.Result.Length > 0)
            {
                actions.Children.Add(Button("Проверка пройдена",()=> { if (outdated) throw new InvalidOperationException("Скилл изменился. Повторите тест актуальной версии."); test.Status = "passed"; _store.Save(); Refresh(); }));
                actions.Children.Add(Button("Нужно исправить",()=>{test.Status="failed"; _store.Save(); Refresh();}));
            }
            panel.Children.Add(actions); TestHistory.Children.Add(Card(panel));
        }
    }
    private void FillAssets(WrapPanel tiles, string kind, string search)
    {
        tiles.Children.Clear();
        var assets = _store!.Assets.Where(a=>a.Kind == kind && (a.Name+" "+a.Description).Contains(search,StringComparison.OrdinalIgnoreCase)).ToList();
        foreach (var asset in assets)
        {
            var panel = new StackPanel { Width = 260 }; panel.Children.Add(Text(asset.StatusLine,11,"Accent")); panel.Children.Add(Text(asset.Name,18)); panel.Children.Add(Text(asset.Description,13,"Dim"));
            if (asset.RequiredEnv.Count > 0) panel.Children.Add(Text("ENV · " + string.Join(", ",asset.RequiredEnv),11,"Warn"));
            var enabled = new CheckBox { Content = "Подключён к профилю", IsChecked = _profile!.AssetIds.Contains(asset.Id), Foreground = (Brush)FindResource("Fg"), Margin = new Thickness(0,8,0,8) };
            enabled.Click += (_,_) => { if (enabled.IsChecked == true) { if (!_profile.AssetIds.Contains(asset.Id)) _profile.AssetIds.Add(asset.Id); } else _profile.AssetIds.Remove(asset.Id); _store.Save(); StudioSummary.Text = $"Подключено {_profile.AssetIds.Count} ресурсов"; }; panel.Children.Add(enabled);
            var actions = new WrapPanel(); actions.Children.Add(Button("Открыть / изменить",()=>Edit(asset,true))); actions.Children.Add(Button("Тестировать",()=> { _trainingAssetId=asset.Id; if (!_profile!.AssetIds.Contains(asset.Id)) { _profile.AssetIds.Add(asset.Id); _store!.Save(); } TestPrompt.Text = "Проверь «"+asset.Name+"»: "; TestExpected.Text = asset.Description; StudioTabs.SelectedIndex=2; }));
            actions.Children.Add(Button("Копия",()=>{var copy=System.Text.Json.JsonSerializer.Deserialize<AgentAsset>(System.Text.Json.JsonSerializer.Serialize(asset))!; copy.Id=Guid.NewGuid().ToString("N");copy.Name+=" · копия";_store.Assets.Add(copy);_store.Save();Refresh();}));
            panel.Children.Add(actions); tiles.Children.Add(Card(panel));
        }
        if (assets.Count == 0) tiles.Children.Add(Text("Пока пусто. Создайте ресурс или импортируйте SKILL.md.",14,"Dim"));
    }
    private void Edit(AgentAsset asset,bool existing)
    { var editor = new AssetEditor(asset,existing) { Owner = Window.GetWindow(this) }; if (editor.ShowDialog() != true) return; if (!existing) { _store!.Assets.Add(asset); _profile!.AssetIds.Add(asset.Id); } _store!.Save(); Refresh(); }
    private void OnSearch(object sender, TextChangedEventArgs e) { if (_store is not null && _profile is not null) Refresh(); }
    private void OnNewSkill(object sender,RoutedEventArgs e) => Guard(()=>Edit(new() { Kind="skill" },false));
    private void OnNewTool(object sender,RoutedEventArgs e) => Guard(()=>Edit(new() { Kind="tool" },false));
    private void OnImportSkill(object sender,RoutedEventArgs e) => Guard(()=>
    {
        var file = new OpenFileDialog { Filter = "Скилл Markdown|*.md" }; if (file.ShowDialog() != true) return;
        var raw=File.ReadAllText(file.FileName); var name=Regex.Match(raw,@"(?m)^name:\s*(.+)$").Groups[1].Value.Trim().Trim('"','\''); var desc=Regex.Match(raw,@"(?m)^description:\s*(.+)$").Groups[1].Value.Trim().Trim('"','\'');
        var body=Regex.Replace(raw,@"\A---\r?\n.*?\r?\n---\r?\n", "",RegexOptions.Singleline);
        Edit(new() {Name=name.Length>0?name:Path.GetFileNameWithoutExtension(file.FileName),Description=desc,Content=body,Kind="skill"},false);
    });
    private void OnScanHermes(object sender, RoutedEventArgs e) => Guard(() =>
    {
        var roots = new[] {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "hermes", "skills"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".hermes", "skills"),
            Path.Combine(Environment.GetEnvironmentVariable("HERMES_HOME") ?? "", "skills")
        }.Where(Path.IsPathRooted).Where(Directory.Exists).Distinct().ToList();
        var count = 0;
        foreach (var root in roots)
            foreach (var path in Directory.EnumerateFiles(root, "SKILL.md", SearchOption.AllDirectories).Take(500))
            {
                if (new FileInfo(path).Length > 100000) continue;
                var raw = File.ReadAllText(path);
                var name = Regex.Match(raw, @"(?m)^name:\s*(.+)$").Groups[1].Value.Trim().Trim('"','\'');
                var desc = Regex.Match(raw, @"(?m)^description:\s*(.+)$").Groups[1].Value.Trim().Trim('"','\'');
                if (name.Length == 0 || desc.Length == 0 || _store!.Assets.Any(a => a.Name == name && a.Kind == "skill")) continue;
                var body = Regex.Replace(raw,@"\A---\r?\n.*?\r?\n---\r?\n", "", RegexOptions.Singleline);
                var asset = new AgentAsset { Name = name, Description = desc, Content = body };
                foreach (var variable in Regex.Matches(raw,@"(?m)^\s+- name:\s*([A-Z_][A-Z0-9_]*)"))
                    asset.RequiredEnv.Add(((Match)variable).Groups[1].Value);
                var directory = Path.GetDirectoryName(path)!;
                foreach (var file in Directory.EnumerateFiles(directory,"*",SearchOption.AllDirectories).Take(100))
                {
                    if (Path.GetFileName(file) == "SKILL.md" || new FileInfo(file).Length > 100000 ||
                        !new[] { ".md", ".txt", ".json", ".yaml", ".yml", ".py", ".sh", ".ps1", ".js", ".toml", ".csv" }.Contains(Path.GetExtension(file).ToLowerInvariant())) continue;
                    asset.Files[Path.GetRelativePath(directory,file).Replace('\\','/')] = File.ReadAllText(file);
                }
                AgentPackages.Validate(asset); _store.Assets.Add(asset); count++;
            }
        _store!.Save(); Refresh();
        MessageBox.Show($"Добавлено {count} скиллов с этой машины. Для удалённого сервера импортируйте пакет.", "Библиотека скиллов");
    });
    private static string ToolDescription(ToolsetInfo toolset) => toolset.Name.ToLowerInvariant() switch
    {
        "terminal" => "Команды и процессы в окружении агента.",
        "web" or "web_search" => "Поиск и чтение страниц в интернете.",
        "browser" => "Работа с веб-интерфейсами через браузер.",
        "file" or "file_system" => "Чтение и изменение файлов на стороне агента.",
        "skills" => "Поиск, чтение и поддержка скиллов.",
        "memory" => "Сохранение контекста между разговорами.",
        "execute_code" => "Выполнение кода через среду агента.",
        _ => "Набор действий: " + string.Join(", ",toolset.Tools)
    };
    private async void OnRefreshToolsets(object sender,RoutedEventArgs e)
    {
        if (_store is null || _profile is null) return;
        var selectedProfile=_profile;
        NativeTiles.Children.Clear(); ToolStatus.Text="Читаю доступные инструменты шлюза…";
        var gateway=_store.Gateways.FirstOrDefault(g=>g.Id==_store.ProjectGateways.GetValueOrDefault(selectedProfile.Id)) ?? _store.Gateways.FirstOrDefault(g=>g.ProfileId==selectedProfile.Id);
        try
        {
            using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(20));
            var client=new HermesClient(_store.Settings,gateway?.Url,gateway?.Token); var list=await client.ReadToolsetsAsync(timeout.Token);
            if (_profile != selectedProfile) return;
            foreach(var toolset in list)
            {
                var panel=new StackPanel{Width=260};panel.Children.Add(Text(toolset.Name,18)); panel.Children.Add(Text(ToolDescription(toolset),13,"Dim"));panel.Children.Add(Text(string.Join(", ",toolset.Tools),11,"Dim"));panel.Children.Add(Text(toolset.Enabled && toolset.Configured?"Доступен на шлюзе":"Не включён / не настроен",12,toolset.Enabled&&toolset.Configured?"Good":"Warn"));
                var prefer=new CheckBox{Content="Предпочтителен для профиля",IsChecked=selectedProfile.Toolsets.Contains(toolset.Name),Foreground=(Brush)FindResource("Fg")}; prefer.Click+=(_,_)=>{ if(prefer.IsChecked==true){if(!selectedProfile.Toolsets.Contains(toolset.Name))selectedProfile.Toolsets.Add(toolset.Name);}else selectedProfile.Toolsets.Remove(toolset.Name);_store.Save();}; panel.Children.Add(prefer);NativeTiles.Children.Add(Card(panel));
            }
            ToolStatus.Text=list.Count>0?$"Шлюз: {gateway?.Name??"локальный"} · {list.Count} тулсетов. Права определяются настройками сервера.":"Шлюз не вернул каталог тулсетов. Свои инструменты можно создавать независимо.";
        }catch(Exception error){if(_profile==selectedProfile) ToolStatus.Text="Каталог недоступен: "+error.Message;}
    }
    private void OnStartTest(object sender,RoutedEventArgs e)=>Guard(()=>
    {
        if(_profile is null || _store is null) return;
        if(TestPrompt.Text.Trim().Length==0 || TestExpected.Text.Trim().Length==0)throw new InvalidOperationException("Заполните задачу и критерии проверки.");
        var test=new AgentTestCase{AssetId=_trainingAssetId,Prompt=TestPrompt.Text,Expected=TestExpected.Text,Status="testing",At=DateTimeOffset.Now.ToUnixTimeSeconds(),AssetVersions=_store.Assets.Where(a=>_profile.AssetIds.Contains(a.Id)).ToDictionary(a=>a.Id,a=>a.Version)};
        _profile.TestCases.Add(test);_store.Save();RequestTest?.Invoke(_profile,test);
    });
    private (AgentTestCase Test,ChatMessage Message) LastAnswer()
    {
        var test=_profile!.TestCases.Where(t=>t.ThreadId.Length>0).OrderByDescending(t=>t.At).FirstOrDefault()??throw new InvalidOperationException("Сначала создайте тестовый чат.");
        var thread=_store!.Threads.FirstOrDefault(t=>t.Id==test.ThreadId)??throw new InvalidOperationException("Тестовый чат не найден.");
        if(thread.Messages.Any(m=>m.Status=="running")) throw new InvalidOperationException("Дождитесь завершения ответа.");
        var answer=thread.Messages.LastOrDefault(m=>m.IsAgent);
        if(answer is null || answer.Status!="ok" || answer.Text.Length==0)throw new InvalidOperationException("Нет успешно завершённого ответа в последнем тесте.");
        return(test,answer);
    }
    private void OnCaptureResult(object sender,RoutedEventArgs e)=>Guard(()=> {var last=LastAnswer();last.Test.Result=last.Message.Text;last.Test.AssetVersions=new(last.Message.AssetVersions);last.Test.Status="review";_store!.Save();Refresh();});
    private void OnAnswerToSkill(object sender,RoutedEventArgs e)=>Guard(()=>
    {
        var last=LastAnswer();
        var target = _store!.Assets.FirstOrDefault(a=>a.Id==last.Test.AssetId && a.Kind=="skill");
        if (target is null) { Edit(new(){Kind="skill",Name="",Description="",Content=last.Message.Text},false); return; }
        var draft = System.Text.Json.JsonSerializer.Deserialize<AgentAsset>(System.Text.Json.JsonSerializer.Serialize(target))!;
        draft.Content = last.Message.Text;
        var editor = new AssetEditor(draft,false){Owner=Window.GetWindow(this)};
        if(editor.ShowDialog()!=true)return;
        AgentPackages.Revision(target,draft.Content,draft.Description); target.Name=draft.Name; target.RequiredEnv=draft.RequiredEnv; target.Files=draft.Files;
        _store.Save(); Refresh();
    });
    private void OnSaveEnv(object sender,RoutedEventArgs e)=>Guard(()=>{AgentPackages.SaveEnv(_profile!.Id,EnvKey.Text.Trim(),EnvValue.Password);EnvValue.Clear();EnvKey.Clear();Refresh();});
    private void OnExport(object sender,RoutedEventArgs e)=>Guard(()=>
    {
        var file=new SaveFileDialog{Filter="Пакет агента ZIP|*.zip",FileName=AgentPackages.SafeName(_profile!.Name)+"-agent.zip"};if(file.ShowDialog()!=true)return;
        var installer=File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"install_agent.py")); AgentPackages.Export(file.FileName,_profile,_store!.Assets,ExportSecrets.IsChecked==true,installer);PackageStatus.Text="Пакет сохранён: "+file.FileName;
    });
    private void OnImportBundle(object sender,RoutedEventArgs e)=>Guard(()=>
    {
        var file=new OpenFileDialog{Filter="Пакет агента ZIP|*.zip"};if(file.ShowDialog()!=true)return;
        var bundle=AgentPackages.ReadBundle(file.FileName);if(ImportSecrets.IsChecked==true)AgentPackages.ImportEnv(file.FileName,bundle.Profile.Id);_store!.Assets.AddRange(bundle.Assets);_store.Profiles.Add(bundle.Profile);_store.Save();Imported?.Invoke(bundle.Profile);PackageStatus.Text="Профиль импортирован. Заполните env на этой машине / сервере.";
    });
}
