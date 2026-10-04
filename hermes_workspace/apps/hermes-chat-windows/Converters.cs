using System.Globalization;
using System.Windows;
using System.Windows.Data;
using System.Windows.Media;

namespace HermesChat;

/// <summary>Строка цвета профиля («#5B9CFF») → кисть. Логика профилей собирается
/// и без WPF, поэтому разбор цвета живёт здесь, а не в модели.</summary>
public sealed class HexBrushConverter : IValueConverter
{
    private static readonly Dictionary<string, Brush> Cache = new();

    public object Convert(object value, Type targetType, object? parameter, CultureInfo culture)
    {
        var hex = value as string ?? "";
        if (Cache.TryGetValue(hex, out var cached)) return cached;
        Brush brush;
        try
        {
            brush = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex));
            brush.Freeze();   // кисть попадает в визуальное дерево, где её нельзя менять
        }
        catch (Exception) { brush = Brushes.SteelBlue; }
        Cache[hex] = brush;
        return brush;
    }

    public object ConvertBack(object value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException("Цвет профиля задаётся строкой, обратное преобразование не нужно.");
}

/// <summary>Инверсия булева значения в видимость: нужен для шаблона ComboBox,
/// где редактируемая и нередактируемая части показываются попеременно.</summary>
public sealed class NotConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
    {
        var flag = value is bool boolean && boolean;
        return flag ? Visibility.Collapsed : Visibility.Visible;
    }

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)
    {
        return value is Visibility visibility && visibility == Visibility.Collapsed;
    }
}