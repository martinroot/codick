using System.Windows;
using System.Windows.Controls;

namespace PulsePilot;
public sealed class ProjectBriefWindow : Window
{
    public ProjectBriefWindow(Project project, ProjectBrief brief)
    {
        Title = "Цель и экономика · " + project.Title; Width = 660; Height = 580;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = (System.Windows.Media.Brush)Application.Current.FindResource("Bg");
        var stack = new StackPanel { Margin = new Thickness(24) };
        TextBox Field(string title, string value)
        {
            stack.Children.Add(new TextBlock { Text = title, Margin = new Thickness(0, 12, 0, 6), TextWrapping = TextWrapping.Wrap });
            var box = new TextBox { Text = value, Height = 90, AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            stack.Children.Add(box); return box;
        }
        var goal = Field("Цель направления", brief.Goal);
        var fact = Field("Подтверждённый факт: показатель, период и источник", brief.Fact);
        var gate = Field("Условие масштабирования / следующий проверяемый рубеж", brief.Gate);
        var save = new Button { Content = "Сохранить", Style = (Style)Application.Current.FindResource("PrimaryBtn"), Margin = new Thickness(0, 20, 0, 0) };
        save.Click += (_, _) => { brief.Goal = goal.Text.Trim(); brief.Fact = fact.Text.Trim(); brief.Gate = gate.Text.Trim(); DialogResult = true; };
        stack.Children.Add(save); Content = new ScrollViewer { Content = stack, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
    }
}
