using System.Windows;
using System.Windows.Controls;

namespace HermesChat;

/// <summary>Доступ к телу и заголовку живого пузыря, построенного BuildBubble.</summary>
public static class LiveBubbleAccess
{
    public static bool TryGetContent(Border? bubble, out StackPanel stack, out TextBlock meta, out Border body)
    {
        if (bubble?.Child is StackPanel content)
        {
            var header = content.Children.OfType<TextBlock>()
                .FirstOrDefault(child => child.Tag as string == "message-meta");
            var bodyBorder = content.Children.OfType<Border>()
                .FirstOrDefault(child => child.Tag as string == "message-body");
            if (header is not null && bodyBorder is not null)
            {
                stack = content;
                meta = header;
                body = bodyBorder;
                return true;
            }
        }

        stack = null!;
        meta = null!;
        body = null!;
        return false;
    }

    /// <summary>Вставить строку процесса перед телом ответа, сохраняя его внизу ленты.</summary>
    public static void InsertBeforeBody(Panel panel, UIElement element)
    {
        var body = panel.Children.OfType<Border>()
            .FirstOrDefault(child => child.Tag as string == "message-body");
        var index = body is null ? panel.Children.Count : panel.Children.IndexOf(body);
        panel.Children.Insert(index, element);
    }
}
