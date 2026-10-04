using System.IO;
using System.Text;
using System.Windows;
using System.Windows.Threading;

namespace PulsePilot;

public partial class App : Application
{
    private static string ErrorPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PulsePilot", "error.log");

    protected override void OnStartup(StartupEventArgs e)
    {
        DispatcherUnhandledException += (_, args) =>
        {
            Log(args.Exception);
            // Не роняем приложение из-за одной ошибки в обработчике: показываем причину, но продолжаем жить.
            args.Handled = true;
            try
            {
                MessageBox.Show("Что-то пошло не так.\n\n" + args.Exception.Message +
                    "\n\nПодробности записаны в error.log.", "PulsePilot", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
            catch { /* MessageBox может быть недоступен при закрытии приложения */ }
        };
        AppDomain.CurrentDomain.UnhandledException += (_, args) => Log(args.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, args) => Log(args.Exception);
        base.OnStartup(e);
    }

    internal static void Log(Exception? ex)
    {
        if (ex == null) return;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(ErrorPath)!);
            var text = DateTime.Now.ToString("HH:mm:ss.fff") + " " + ex + Environment.NewLine + Environment.NewLine;
            File.AppendAllText(ErrorPath, text, Encoding.UTF8);
        }
        catch { /* лог недоступен — молча теряем, чтобы не зациклиться */ }
    }
}
