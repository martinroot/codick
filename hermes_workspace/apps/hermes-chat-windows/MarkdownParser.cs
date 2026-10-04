using System.Text;
using System.Text.RegularExpressions;

namespace HermesChat;

public abstract record MarkdownBlock;
public sealed record MarkdownParagraphBlock(string Text) : MarkdownBlock;
public sealed record MarkdownHeadingBlock(int Level, string Text) : MarkdownBlock;
public sealed record MarkdownCodeBlock(string Language, string Code) : MarkdownBlock;
public sealed record MarkdownListBlock(bool Ordered, IReadOnlyList<string> Items) : MarkdownBlock;
public sealed record MarkdownTableBlock(IReadOnlyList<string> Headers, IReadOnlyList<IReadOnlyList<string>> Rows,
    IReadOnlyList<string> Alignments) : MarkdownBlock;
public sealed record MarkdownQuoteBlock(string Text) : MarkdownBlock;
public sealed record MarkdownRuleBlock : MarkdownBlock;
public sealed record MarkdownInlineSpan(string Text, bool Bold = false, bool Italic = false,
    bool Code = false, bool Strike = false, string? Link = null);

/// <summary>Небольшой безопасный Markdown-поднабор для нативного WPF-рендера чата.</summary>
public static class MarkdownParser
{
    private static readonly Regex Heading = new(@"^\s*(#{1,6})\s+(.+?)\s*#*\s*$", RegexOptions.Compiled);
    private static readonly Regex ListItem = new(@"^\s*(?:([-+*])|(\d+)[.)])\s+(.+?)\s*$", RegexOptions.Compiled);
    private static readonly Regex Rule = new(@"^\s*(?:-{3,}|\*{3,}|_{3,})\s*$", RegexOptions.Compiled);
    private static readonly Regex TableSeparator = new(@"^:?-{3,}:?$", RegexOptions.Compiled);

    public static IReadOnlyList<MarkdownBlock> Parse(string? markdown)
    {
        if (string.IsNullOrEmpty(markdown)) return Array.Empty<MarkdownBlock>();
        var lines = markdown.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
        var blocks = new List<MarkdownBlock>();
        var i = 0;
        while (i < lines.Length)
        {
            var line = lines[i];
            var trimmed = line.Trim();
            if (trimmed.Length == 0) { i++; continue; }

            if (IsFence(trimmed, out var fence, out var language))
            {
                i++;
                var code = new List<string>();
                while (i < lines.Length && !lines[i].TrimStart().StartsWith(fence, StringComparison.Ordinal))
                    code.Add(lines[i++]);
                if (i < lines.Length) i++;
                blocks.Add(new MarkdownCodeBlock(language, string.Join("\n", code)));
                continue;
            }

            var heading = Heading.Match(line);
            if (heading.Success)
            {
                blocks.Add(new MarkdownHeadingBlock(heading.Groups[1].Length, heading.Groups[2].Value));
                i++;
                continue;
            }

            if (Rule.IsMatch(line)) { blocks.Add(new MarkdownRuleBlock()); i++; continue; }

            if (trimmed.StartsWith(">", StringComparison.Ordinal))
            {
                var quote = new List<string>();
                while (i < lines.Length && lines[i].TrimStart().StartsWith(">", StringComparison.Ordinal))
                    quote.Add(lines[i++].TrimStart()[1..].TrimStart());
                blocks.Add(new MarkdownQuoteBlock(string.Join("\n", quote)));
                continue;
            }

            if (i + 1 < lines.Length && ContainsTableDelimiter(line, lines[i + 1]))
            {
                var headers = SplitTableRow(line);
                var alignments = SplitTableRow(lines[i + 1]).Select(AlignmentOf).ToList();
                i += 2;
                var rows = new List<IReadOnlyList<string>>();
                while (i < lines.Length && lines[i].Contains('|') && lines[i].Trim().Length > 0)
                    rows.Add(SplitTableRow(lines[i++]));
                blocks.Add(new MarkdownTableBlock(headers, rows, alignments));
                continue;
            }

            var firstList = ListItem.Match(line);
            if (firstList.Success)
            {
                var ordered = firstList.Groups[2].Success;
                var items = new List<string>();
                while (i < lines.Length)
                {
                    var match = ListItem.Match(lines[i]);
                    if (!match.Success || match.Groups[2].Success != ordered) break;
                    items.Add(match.Groups[3].Value);
                    i++;
                }
                blocks.Add(new MarkdownListBlock(ordered, items));
                continue;
            }

            var paragraph = new List<string> { line.Trim() };
            i++;
            while (i < lines.Length && lines[i].Trim().Length > 0 && !StartsBlock(lines, i))
                paragraph.Add(lines[i++].Trim());
            blocks.Add(new MarkdownParagraphBlock(string.Join(" ", paragraph)));
        }
        return blocks;
    }

    public static IReadOnlyList<MarkdownInlineSpan> ParseInline(string? text)
    {
        if (string.IsNullOrEmpty(text)) return Array.Empty<MarkdownInlineSpan>();
        var spans = new List<MarkdownInlineSpan>();
        var plain = new StringBuilder();
        void Flush()
        {
            if (plain.Length == 0) return;
            spans.Add(new MarkdownInlineSpan(plain.ToString()));
            plain.Clear();
        }

        for (var i = 0; i < text.Length;)
        {
            if (text[i] == '\\' && i + 1 < text.Length && "\\`*_{}[]()#+-.!|~".Contains(text[i + 1]))
            {
                plain.Append(text[i + 1]); i += 2; continue;
            }
            if (TryDelimited(text, i, "```", out var end, out var value))
            {
                Flush(); spans.Add(new MarkdownInlineSpan(value, Code: true)); i = end; continue;
            }
            if (TryDelimited(text, i, "`", out end, out value))
            {
                Flush(); spans.Add(new MarkdownInlineSpan(value, Code: true)); i = end; continue;
            }
            if ((TryLink(text, i, out end, out var label, out var url)))
            {
                Flush(); spans.Add(new MarkdownInlineSpan(label, Link: url)); i = end; continue;
            }
            if (TryDelimited(text, i, "**", out end, out value) || TryDelimited(text, i, "__", out end, out value))
            {
                Flush(); spans.Add(new MarkdownInlineSpan(value, Bold: true)); i = end; continue;
            }
            if (TryDelimited(text, i, "~~", out end, out value))
            {
                Flush(); spans.Add(new MarkdownInlineSpan(value, Strike: true)); i = end; continue;
            }
            if ((text[i] is '*' or '_') && TryDelimited(text, i, text[i].ToString(), out end, out value))
            {
                Flush(); spans.Add(new MarkdownInlineSpan(value, Italic: true)); i = end; continue;
            }
            plain.Append(text[i++]);
        }
        Flush();
        return spans;
    }

    private static bool StartsBlock(string[] lines, int i)
    {
        var line = lines[i];
        var trimmed = line.Trim();
        if (Heading.IsMatch(line) || Rule.IsMatch(line) || trimmed.StartsWith(">") || IsFence(trimmed, out _, out _)
            || ListItem.IsMatch(line)) return true;
        return i + 1 < lines.Length && ContainsTableDelimiter(line, lines[i + 1]);
    }

    private static bool IsFence(string line, out string fence, out string language)
    {
        fence = ""; language = "";
        if (!(line.StartsWith("```") || line.StartsWith("~~~"))) return false;
        fence = line[..3]; language = line[3..].Trim();
        return true;
    }

    private static bool ContainsTableDelimiter(string header, string separator) =>
        header.Contains('|') && SplitTableRow(separator).Count > 0
        && SplitTableRow(separator).All(cell => TableSeparator.IsMatch(cell));

    private static List<string> SplitTableRow(string line)
    {
        var trimmed = line.Trim();
        if (trimmed.StartsWith('|')) trimmed = trimmed[1..];
        if (trimmed.EndsWith('|')) trimmed = trimmed[..^1];
        return trimmed.Split('|').Select(cell => cell.Trim().Replace("\\|", "|", StringComparison.Ordinal)).ToList();
    }

    private static string AlignmentOf(string separator)
    {
        var left = separator.StartsWith(':');
        var right = separator.EndsWith(':');
        return left && right ? "center" : right ? "right" : "left";
    }

    private static bool TryDelimited(string text, int start, string delimiter, out int end, out string content)
    {
        end = start; content = "";
        if (!text.AsSpan(start).StartsWith(delimiter, StringComparison.Ordinal)) return false;
        var contentStart = start + delimiter.Length;
        var close = text.IndexOf(delimiter, contentStart, StringComparison.Ordinal);
        if (close <= contentStart) return false;
        content = text[contentStart..close];
        end = close + delimiter.Length;
        return true;
    }

    private static bool TryLink(string text, int start, out int end, out string label, out string url)
    {
        end = start; label = ""; url = "";
        if (text[start] != '[') return false;
        var closeLabel = text.IndexOf("](", start + 1, StringComparison.Ordinal);
        var closeUrl = closeLabel < 0 ? -1 : text.IndexOf(')', closeLabel + 2);
        if (closeLabel <= start + 1 || closeUrl <= closeLabel + 2) return false;
        label = text[(start + 1)..closeLabel]; url = text[(closeLabel + 2)..closeUrl];
        end = closeUrl + 1;
        return true;
    }
}
