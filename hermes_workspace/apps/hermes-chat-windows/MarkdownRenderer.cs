using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;

namespace HermesChat;

/// <summary>Рендерит поддерживаемый Markdown штатными WPF-элементами.</summary>
public static class MarkdownRenderer
{
    public static StackPanel Render(string? source, double fontSize, Brush foreground, Brush dim,
        Brush background, Brush line, Brush accent, Brush panel)
    {
        var root = new StackPanel { MaxWidth = 760 };
        foreach (var block in MarkdownParser.Parse(source))
        {
            FrameworkElement element = block switch
            {
                MarkdownHeadingBlock heading => Heading(heading, fontSize, foreground, background),
                MarkdownParagraphBlock paragraph => Paragraph(paragraph.Text, fontSize, foreground, background, accent),
                MarkdownCodeBlock code => Code(code, fontSize, foreground, dim, background, line),
                MarkdownListBlock list => List(list, fontSize, foreground, background, accent),
                MarkdownTableBlock table => Table(table, fontSize, foreground, dim, background, line, accent),
                MarkdownQuoteBlock quote => Quote(quote, fontSize, foreground, background, accent),
                MarkdownRuleBlock => new Border { Height = 1, Background = line, Margin = new Thickness(0, 8, 0, 8) },
                _ => Paragraph(block.ToString() ?? "", fontSize, foreground, background, accent)
            };
            element.Margin = new Thickness(0, 0, 0, 8);
            root.Children.Add(element);
        }
        return root;
    }

    private static TextBlock Heading(MarkdownHeadingBlock heading, double size, Brush fg, Brush bg)
    {
        var scale = heading.Level switch { 1 => 1.45, 2 => 1.3, 3 => 1.18, _ => 1.08 };
        var text = InlineText(heading.Text, size * scale, fg, bg, fg);
        text.FontWeight = FontWeights.SemiBold;
        text.Margin = new Thickness(0, heading.Level == 1 ? 5 : 3, 0, 2);
        return text;
    }

    private static TextBlock Paragraph(string text, double size, Brush fg, Brush bg, Brush accent)
    {
        var block = InlineText(text, size, fg, bg, accent);
        block.TextWrapping = TextWrapping.Wrap;
        block.LineHeight = size * 1.45;
        return block;
    }

    private static FrameworkElement Code(MarkdownCodeBlock code, double size, Brush fg, Brush dim,
        Brush bg, Brush line)
    {
        var panel = new StackPanel();
        if (code.Language.Length > 0)
            panel.Children.Add(new TextBlock
            {
                Text = code.Language,
                FontSize = 10,
                Foreground = dim,
                Margin = new Thickness(2, 0, 0, 3)
            });
        var text = new TextBlock
        {
            Text = code.Code,
            FontFamily = new FontFamily("Consolas"),
            FontSize = Math.Max(11, size - 1),
            Foreground = fg,
            TextWrapping = TextWrapping.NoWrap
        };
        panel.Children.Add(new ScrollViewer
        {
            Content = text,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Padding = new Thickness(8, 6, 8, 6)
        });
        return new Border
        {
            Background = bg,
            BorderBrush = line,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(6),
            Child = panel
        };
    }

    private static FrameworkElement List(MarkdownListBlock list, double size, Brush fg, Brush bg, Brush accent)
    {
        var stack = new StackPanel { Margin = new Thickness(0, 2, 0, 0) };
        for (var i = 0; i < list.Items.Count; i++)
        {
            var row = new Grid { Margin = new Thickness(0, 1, 0, 1) };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var marker = new TextBlock
            {
                Text = list.Ordered ? (i + 1) + "." : "•",
                Width = list.Ordered ? 28 : 18,
                Foreground = accent,
                FontSize = size,
                FontWeight = FontWeights.SemiBold
            };
            row.Children.Add(marker);
            var content = Paragraph(list.Items[i], size, fg, bg, accent);
            Grid.SetColumn(content, 1);
            row.Children.Add(content);
            stack.Children.Add(row);
        }
        return stack;
    }

    private static FrameworkElement Quote(MarkdownQuoteBlock quote, double size, Brush fg, Brush bg, Brush accent) =>
        new Border
        {
            BorderBrush = accent,
            BorderThickness = new Thickness(3, 0, 0, 0),
            Padding = new Thickness(10, 2, 4, 2),
            Child = Paragraph(quote.Text, size, fg, bg, accent)
        };

    private static FrameworkElement Table(MarkdownTableBlock table, double size, Brush fg, Brush dim,
        Brush bg, Brush line, Brush accent)
    {
        var columns = Math.Max(1, table.Headers.Count);
        var grid = new Grid();
        for (var column = 0; column < columns; column++)
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star), MinWidth = 70 });
        var rowCount = 1 + table.Rows.Count;
        for (var row = 0; row < rowCount; row++)
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        for (var column = 0; column < columns; column++)
            grid.Children.Add(TableCell(Cell(table.Headers, column), true, row: 0, column, table, size, fg, dim, bg, line, accent));
        for (var row = 0; row < table.Rows.Count; row++)
            for (var column = 0; column < columns; column++)
                grid.Children.Add(TableCell(Cell(table.Rows[row], column), false, row + 1, column, table,
                    size, fg, dim, bg, line, accent));

        return new ScrollViewer
        {
            Content = grid,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            VerticalScrollBarVisibility = ScrollBarVisibility.Disabled
        };
    }

    private static Border TableCell(string text, bool header, int row, int column, MarkdownTableBlock table,
        double size, Brush fg, Brush dim, Brush bg, Brush line, Brush accent)
    {
        var content = Paragraph(text, Math.Max(11, size - 1), header ? fg : dim, bg, accent);
        content.FontWeight = header ? FontWeights.SemiBold : FontWeights.Normal;
        content.TextAlignment = column < table.Alignments.Count ? table.Alignments[column] switch
        {
            "center" => TextAlignment.Center,
            "right" => TextAlignment.Right,
            _ => TextAlignment.Left
        } : TextAlignment.Left;
        var cell = new Border
        {
            Background = header ? bg : Brushes.Transparent,
            BorderBrush = line,
            BorderThickness = new Thickness(0.5),
            Padding = new Thickness(7, 5, 7, 5),
            Child = content
        };
        Grid.SetRow(cell, row);
        Grid.SetColumn(cell, column);
        return cell;
    }

    private static string Cell(IReadOnlyList<string> cells, int index) => index < cells.Count ? cells[index] : "";

    private static TextBlock InlineText(string text, double size, Brush fg, Brush bg, Brush accent)
    {
        var block = new TextBlock { FontSize = size, Foreground = fg, TextWrapping = TextWrapping.Wrap };
        foreach (var span in MarkdownParser.ParseInline(text))
        {
            var run = new Run(span.Text);
            if (span.Code)
            {
                run.FontFamily = new FontFamily("Consolas");
                run.Background = bg;
            }
            if (span.Link is not null)
            {
                run.Foreground = accent;
                run.TextDecorations = TextDecorations.Underline;
                run.ToolTip = span.Link;
            }
            if (span.Strike) run.TextDecorations = TextDecorations.Strikethrough;
            Inline inline = run;
            if (span.Italic) inline = new Italic(inline);
            if (span.Bold) inline = new Bold(inline);
            block.Inlines.Add(inline);
        }
        return block;
    }
}
