using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;

namespace PulsePilot;

/// <summary>Чат-планировщик: дешёвая модель видит всё дерево, прогресс и лог идей.</summary>
public partial class ChatPlanner
{
}

public static class ChatUi
{
    private static readonly SolidColorBrush BgUser = new(Color.FromRgb(0x23, 0x27, 0x34));
    private static readonly SolidColorBrush BgAi = new(Color.FromRgb(0x1A, 0x1D, 0x26));
    private static readonly SolidColorBrush FgDim = new(Color.FromRgb(0x98, 0xA0, 0xB3));
    private static readonly SolidColorBrush Accent = new(Color.FromRgb(0x5B, 0x8C, 0xFF));
    private static readonly SolidColorBrush Accent2 = new(Color.FromRgb(0x39, 0xD3, 0xA6));

    /// <summary>Действие, доступное прямо в ответе модели.</summary>
    public sealed class Action2
    {
        public string Label { get; init; } = "";
        public string NodeId { get; init; } = "";
        public string Kind { get; init; } = "focus";   // focus | plan | blocker
        public string? BlockerId { get; init; }
        public string? Note { get; init; }
    }

    public static List<Action2> ParseActions(string text)
    {
        var res = new List<Action2>();
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.Trim().TrimStart('-', '*', ' ');
            string kind;
            if (line.StartsWith("**Дальше:**", StringComparison.OrdinalIgnoreCase)) kind = "focus";
            else if (line.StartsWith("**Блокер:**", StringComparison.OrdinalIgnoreCase)) kind = "blocker";
            else if (line.StartsWith("Дальше:", StringComparison.OrdinalIgnoreCase)) kind = "focus";
            else if (line.StartsWith("Блокер:", StringComparison.OrdinalIgnoreCase)) kind = "blocker";
            else continue;

            var ids = System.Text.RegularExpressions.Regex.Matches(line, @"\[(\d+)\]")
                .Select(x => x.Groups[1].Value).ToList();
            if (ids.Count == 0) continue;

            var rest = line[(line.IndexOf(':') + 1)..].Trim().TrimStart('*', ' ');
            var title = rest;
            foreach (var id in ids)
                title = title.Replace("[" + id + "]", "").Trim();
            title = title.Trim('-', '—', ' ', ':').Trim();
            if (title.Length > 40) title = title[..39] + "…";

            if (kind == "blocker" && ids.Count >= 2)
                res.Add(new Action2
                {
                    Kind = kind, Label = $"{title}  ⛔ ждёт [{ids[1]}]", NodeId = ids[0], BlockerId = ids[1], Note = title
                });
            else
                res.Add(new Action2
                {
                    Kind = kind, Label = (kind == "blocker" ? "⛔ " : "▶ ") + title, NodeId = ids[0], Note = title
                });
        }
        return res;
    }

    public static void Add(StackPanel panel, ChatMessage m, ScrollViewer scroll, Action<Action2>? onNodeAction = null)
    {
        var isUser = m.Role == "user";
        var bd = new Border
        {
            Background = isUser ? BgUser : BgAi,
            BorderBrush = isUser ? Accent : new SolidColorBrush(Color.FromRgb(0x2E, 0x34, 0x44)),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(9, 7, 9, 7),
            Margin = new Thickness(0, 0, 0, 8),
            HorizontalAlignment = isUser ? HorizontalAlignment.Right : HorizontalAlignment.Left
        };
        var sp = new StackPanel();
        bd.Child = sp;
        sp.Children.Add(new TextBlock
        {
            Text = isUser ? "ты" : "планировщик",
            FontSize = 10,
            Foreground = isUser ? Accent2 : Accent,
            FontWeight = FontWeights.SemiBold
        });
        sp.Children.Add(new TextBlock
        {
            Text = StripActionLines(m.Text),
            TextWrapping = TextWrapping.Wrap,
            FontSize = 12.5,
            Foreground = new SolidColorBrush(Color.FromRgb(0xE8, 0xEB, 0xF2)),
            Margin = new Thickness(0, 3, 0, 0)
        });

        // Строки-действия показываем не текстом, а кнопками — по ним можно кликнуть.
        if (!isUser && onNodeAction != null)
        {
            foreach (var act in ParseActions(m.Text))
            {
                var btn = new Button
                {
                    Content = act.Label,
                    Margin = new Thickness(0, 4, 0, 0),
                    Padding = new Thickness(8, 4, 8, 4),
                    FontSize = 11.5,
                    HorizontalAlignment = HorizontalAlignment.Left,
                    BorderBrush = act.Kind == "blocker"
                        ? new SolidColorBrush(Color.FromRgb(0xFF, 0x5C, 0x7A))
                        : new SolidColorBrush(Color.FromRgb(0x39, 0xD3, 0xA6)),
                    Background = new SolidColorBrush(Color.FromRgb(0x23, 0x27, 0x34)),
                    ToolTip = act.Kind == "blocker"
                        ? $"Пометить: {act.Label} (клик — записать блокер)"
                        : "Клик — взять в фокус"
                };
                var a = act;
                btn.Click += (_, _) => onNodeAction(a);
                sp.Children.Add(btn);
            }
        }

        panel.Children.Add(bd);
        scroll.Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => scroll.ScrollToEnd()));
    }

    /// <summary>Убирает служебные строки-действия из текста — они показываются кнопками.</summary>
    private static string StripActionLines(string text)
    {
        var keep = text.Split('\n')
            .Where(l =>
            {
                var s = l.TrimStart('-', '*', ' ');
                return !s.StartsWith("**Дальше:**", StringComparison.OrdinalIgnoreCase)
                    && !s.StartsWith("**Блокер:**", StringComparison.OrdinalIgnoreCase)
                    && !s.StartsWith("Дальше:", StringComparison.OrdinalIgnoreCase)
                    && !s.StartsWith("Блокер:", StringComparison.OrdinalIgnoreCase);
            });
        return string.Join("\n", keep).TrimEnd();
    }

    /// <summary>Открытый доступ к очистке служебных строк — для тестов.</summary>
    public static string StripActionLinesForTest(string text) => StripActionLines(text);

    /// <summary>Единый контекст: дерево, прогресс, блокеры, активность, лог.</summary>
    public static string BuildContext(Tree tree, StateStore state, string focusNodeId, ActivityTracker? act = null)
        => Planner.BuildContext(tree, state, focusNodeId, act);

    public const string SystemPrompt = """
        Ты — советник оператора нескольких проектов с LLM-агентами в локерах.
        Работай пошагово: одно действие оператора, одно поручение агенту, один критерий результата.
        Отвечай максимум четырьмя короткими строками. Не выводи меню вариантов и кнопки «Дальше».
        Если данных мало, задай один уточняющий вопрос. Не выдумывай зависимости и статусы агентов.
        Учитывай текущий микро-шаг и результаты: продолжай его, пока не получен результат
        или агент явно не переведён в ожидание. Отсутствие ввода не доказывает безделье.
        1000 подтверждённых микроитераций = +0.1 на условной шкале внимания, не релиз продукта.
        """;
}
