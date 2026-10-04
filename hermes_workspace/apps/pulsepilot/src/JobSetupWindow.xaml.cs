using System.Windows;
namespace PulsePilot;
public partial class JobSetupWindow : Window
{
    private readonly FleetJob _job;
    public JobSetupWindow(FleetJob job) { InitializeComponent(); _job = job; TitleText.Text = job.Title; LockerBox.Text = job.Locker; ResourceBox.Text = job.Resource; PromptBox.Text = job.Prompt; }
    private void Save(object s, RoutedEventArgs e)
    {
        if (PromptBox.Text.Trim().Length < 10 || ResourceBox.Text.Trim().Length == 0) return;
        _job.Locker = LockerBox.Text.Trim(); _job.Resource = ResourceBox.Text.Trim(); _job.Prompt = PromptBox.Text.Trim(); DialogResult = true;
    }
    private void Cancel(object s, RoutedEventArgs e) => DialogResult = false;
}
