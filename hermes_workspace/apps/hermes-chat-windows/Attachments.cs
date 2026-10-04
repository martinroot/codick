using System.IO;
using System.Windows;
using System.Windows.Media.Imaging;

namespace HermesChat;

/// <summary>Вложения: скриншот из буфера, перетащенный или выбранный файл.
/// Файл копируется в каталог аппликашена — агент читает его по абсолютному пути.</summary>
public static class Attachments
{
    public static string Root { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "HermesChat", "attachments");

    public static Attachment FromClipboard()
    {
        if (!Clipboard.ContainsImage())
            throw new InvalidOperationException("В буфере обмена нет изображения. Скопируй скриншот (Win+Shift+S) и попробуй снова.");
        var image = Clipboard.GetImage()
            ?? throw new InvalidOperationException("Не удалось прочитать изображение из буфера.");

        byte[] bytes;
        using (var ms = new MemoryStream())
        {
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(image));
            encoder.Save(ms);
            bytes = ms.ToArray();
        }
        var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss-fff");
        var name = $"screenshot-{stamp}.png";
        var path = Write(name, bytes);
        return new Attachment
        {
            Name = name,
            Path = path,
            Size = bytes.Length,
            IsImage = true,
            PreviewBase64 = Convert.ToBase64String(bytes)
        };
    }

    public static Attachment FromPath(string source)
    {
        var info = new FileInfo(source);
        if (!info.Exists) throw new FileNotFoundException("Файл не найден: " + source, source);
        if (info.Length > 64L * 1024 * 1024)
            throw new InvalidOperationException("Файл больше 64 МБ — агент столько не возьмёт.");

        // Копируем, а не отдаём оригинал: агент работает с файлом по этому пути и может его переписать.
        var name = Sanitize(info.Name);
        var attachment = new Attachment
        {
            Name = name,
            Path = Write(name, File.ReadAllBytes(info.FullName)),
            Size = info.Length,
            IsImage = IsImage(name)
        };
        if (attachment.IsImage) attachment.PreviewBase64 = TryThumbnail(attachment.Path);
        return attachment;
    }

    private static string Write(string name, byte[] bytes)
    {
        Directory.CreateDirectory(Root);
        var path = Path.Combine(Root, name);
        var stem = Path.GetFileNameWithoutExtension(name);
        var extension = Path.GetExtension(name);
        var stamp = 1;
        while (File.Exists(path))
            path = Path.Combine(Root, $"{stem}-{stamp++}{extension}");
        File.WriteAllBytes(path, bytes);
        return path;
    }

    private static bool IsImage(string name) =>
        Path.GetExtension(name).ToLowerInvariant() is ".png" or ".jpg" or ".jpeg" or ".gif" or ".bmp" or ".webp";

    /// <summary>Миниатюра не больше 320px — в ленте полноразмерный скриншот только шумит.</summary>
    private static string? TryThumbnail(string path)
    {
        try
        {
            var image = new BitmapImage();
            image.BeginInit();
            image.CacheOption = BitmapCacheOption.OnLoad;
            image.StreamSource = new MemoryStream(File.ReadAllBytes(path));
            image.DecodePixelWidth = 320;
            image.EndInit();
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(image));
            using var ms = new MemoryStream();
            encoder.Save(ms);
            return Convert.ToBase64String(ms.ToArray());
        }
        catch (Exception) { return null; }   // нечитаемое изображение не должно ломать отправку
    }

    private static string Sanitize(string name)
    {
        var bad = Path.GetInvalidFileNameChars();
        var cleaned = new string(name.Select(ch => bad.Contains(ch) ? '_' : ch).ToArray()).Trim();
        return cleaned.Length == 0 ? "file.bin" : cleaned[..Math.Min(cleaned.Length, 120)];
    }
}