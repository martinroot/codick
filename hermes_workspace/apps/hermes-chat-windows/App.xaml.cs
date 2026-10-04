using System.Windows;
using System.Windows.Threading;

namespace HermesChat;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        DispatcherUnhandledException += OnCrash;
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
            CrashLog.Write("Фоновый поток: " + args.ExceptionObject);
        base.OnStartup(e);
    }

    private void OnCrash(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        // Логируем и НЕ роняем процесс: иначе один клик по косметической кнопке
        // уничтожит всю ленту диалога, и пользователь скажет «упало».
        CrashLog.Write(e.Exception.ToString());
        e.Handled = true;
        try
        {
            MessageBox.Show(
                "Ошибка: " + e.Exception.Message + "\n\nПодробности: %APPDATA%\\HermesChat\\error.log",
                "HermesChat", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        catch (Exception) { /* во время завершения работы MessageBox недоступен */ }
    }
}