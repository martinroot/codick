using PulsePilot;
using System.Text.Json;
var count = 0;
void Check(bool value, string message) { if (!value) throw new Exception(message); Console.WriteLine("PASS " + message); count++; }
var temp = Path.Combine(Path.GetTempPath(), "fleet-tests-" + Guid.NewGuid().ToString("N"));
StateStore.TestDataDirectory = temp;
try
{
    Check(!FleetRules.Actionable(new Node { Id = "1", Lane = "wiki", Title = "Goal" }), "Wiki is context");
    Check(!FleetRules.Actionable(new Node { Lane = "todo", Title = "ЦЕЛЬ 100/день" }), "Goals are not delegated as tasks");
    Check(!FleetRules.Actionable(new Node { Lane = "todo", Title = "Deferred", Body = "@deferred" }), "Deferred work not dispatched");
    Check(FleetRules.Actionable(new Node { Lane = "todo", Title = "Test payment" }), "Executable todo available");
    var first = new FleetJob { ProjectId = "a", Resource = "repo", Status = "running" };
    var second = new FleetJob { ProjectId = "b", Resource = "other" };
    Check(FleetRules.CanStart(second, new[] { first, second }, 3), "Different projects execute together");
    second.Resource = "repo";
    Check(!FleetRules.CanStart(second, new[] { first, second }, 7), "Shared resource blocks conflicting work");
    second.Resource = "other"; second.ProjectId = "a";
    Check(!FleetRules.CanStart(second, new[] { first, second }, 7), "Same project does not get conflicting runs");
    second.ProjectId = "b";
    Check(!FleetRules.CanStart(second, new[] { first, new FleetJob { Status = "running", ProjectId = "c", Resource = "c" }, new FleetJob { Status = "unknown", ProjectId = "d", Resource = "d" }, second }, 3), "Unknown outcome keeps slot reserved");
    first.Status = "review"; second.Resource = "repo";
    Check(!FleetRules.CanStart(second, new[] { first, second }, 7), "Review holds resource until operator accepts");
    first.Status = "waiting_input";
    Check(FleetRules.Attention(first, 100, 300), "Agent input goes to operator queue");
    first.Status = "running"; first.Source = "manual"; first.CheckedAt = 100; first.NextCheckAt = 400;
    Check(!FleetRules.Attention(first, 399, 300) && FleetRules.Attention(first, 400, 300), "Manual worker has a review deadline");
    first.Source = "api"; first.ProgressAt = 100; first.CheckedAt = 500; first.NextCheckAt = 800;
    Check(FleetRules.Attention(first, 500, 300), "Responsive API cannot conceal absent progress");
    var neglected = new FleetJob { Status = "prepared", Source = "manual", CreatedAt = 1000 };
    Check(!FleetRules.Neglected(neglected, 1000, 300), "Fresh prepared job stays quiet");
    Check(FleetRules.Neglected(neglected, 1600, 300), "Neglected prepared job is detected after two stale intervals");
    Check(FleetRules.Attention(neglected, 1600, 300), "Neglected prepared job reaches the operator queue");
    neglected.Status = "running"; neglected.CheckedAt = 1600; neglected.NextCheckAt = 1900;
    Check(!FleetRules.Neglected(neglected, 5000, 300), "Neglected applies to prepared jobs only");
    var tmux = Liveness.Parse("tmux:codick");
    Check(tmux.Kind == "tmux" && tmux.Target == "codick" && tmux.Verifiable, "tmux locker is verifiable");
    Check(Liveness.Parse("proc:claude").Kind == "process", "Process locker is parsed");
    Check(Liveness.Parse("https://example.test/health").Kind == "url", "Url locker is parsed");
    Check(!Liveness.Parse("сессия на сервере разработки").Verifiable, "Free-form locker is honestly unverifiable");
    Check(!Liveness.Parse("").Verifiable, "Empty locker is unverifiable");
    var silent = new FleetJob { Status = "running", Source = "manual", CheckedAt = 1000, NextCheckAt = 5000 };
    Check(!FleetRules.UnreasonedSilence(silent, 1200, 300), "Fresh silence is not yet a problem");
    Check(FleetRules.UnreasonedSilence(silent, 1300, 300) && FleetRules.Attention(silent, 1300, 300), "Unnamed silence reaches the operator queue");
    silent.BlockReason = "money"; silent.BlockSince = 1300; silent.NextCheckAt = 5000;
    Check(!FleetRules.UnreasonedSilence(silent, 1300, 300), "Named reason stops the unnamed-silence nagging");
    Check(BlockReasons.Known("money") && !BlockReasons.Known("отмазка"), "Block reason list is closed");
    var deadLocker = new FleetJob { Status = "running", Source = "manual", CheckedAt = 1000, NextCheckAt = 9000, LivenessAt = 1200, LivenessOk = false };
    Check(FleetRules.Attention(deadLocker, 1300, 300), "Dead locker reaches the operator queue immediately");
    var json = JsonDocument.Parse("{\"status\":\"completed\",\"version\":5,\"result\":\"artifact\",\"progress_at\":600}");
    FleetRules.ApplyRemote(first, json.RootElement, 600);
    Check(first.Status == "review" && first.Result == "artifact", "Completed report requires review");
    using var old = JsonDocument.Parse("{\"status\":\"running\",\"version\":4}");
    FleetRules.ApplyRemote(first, old.RootElement, 700);
    Check(first.Status == "review", "Old event cannot reverse completion");
    var store = new StateStore { FleetJobs = new() { first }, Settings = new() { LlmKey = "test-only" }, WorkUntil = 900 };
    store.Save(); var reloaded = StateStore.Load();
    Check(reloaded.FleetJobs.Single().Id == first.Id && reloaded.WorkUntil == 900, "Concurrent jobs and work block survive restart");
    var saved = new FleetJob { ProjectId = "p", Status = "blocked", BlockReason = "access", BlockSince = 5, LivenessAt = 6, LivenessOk = true, LivenessNote = "живой" };
    new StateStore { FleetJobs = new() { saved } }.Save();
    var back = StateStore.Load().FleetJobs.Single();
    Check(back.BlockReason == "access" && back.BlockSince == 5 && back.LivenessAt == 6 && back.LivenessOk && back.LivenessNote == "живой",
        "Liveness and block reason survive restart");
    var allowed = new HashSet<string> { "10", "11" };
    var picks = AiPick.Parse("ВЫБОР: 11\nПОЧЕМУ: быстрее всего и без внешнего\nАЛЬТЕРНАТИВА: 10", allowed, out var chosenId, out var whyText);
    Check(chosenId == "11" && whyText == "быстрее всего и без внешнего", "Ai choice and reason are parsed");
    Check(picks.Count == 2 && picks[0].NodeId == "11" && picks[1].NodeId == "10", "Alternative is offered as fallback");
    var invented = AiPick.Parse("ВЫБОР: 999\nПОЧЕМУ: красиво", allowed, out var fakeId, out _);
    Check(fakeId.Length == 0 && invented.Count == 0, "Model cannot invent a node id");
    var mixed = AiPick.Parse("ВЫБОР: 999\nПОЧЕМУ: нет такой\nАЛЬТЕРНАТИВА: 10", allowed, out var onlyAlt, out _);
    Check(onlyAlt.Length == 0 && mixed.Count == 1 && mixed[0].NodeId == "10", "Valid alternative survives an invented choice");
    Check(AiPick.Parse("**ВЫБОР:** 10\nПОЧЕМУ: ок", allowed, out var boldId, out _).Count == 1 && boldId == "10",
        "Markdown around the tag is tolerated");
    var candidateProject = new Project { Id = "9", Title = "П", Nodes = new() {
        new Node { Id = "1", Lane = "wiki", Title = "Wiki" },
        new Node { Id = "2", Lane = "todo", Title = "ЦЕЛЬ 100" },
        new Node { Id = "3", Lane = "todo", Title = "Отложено", Body = "@deferred" },
        new Node { Id = "4", Lane = "todo", Title = "Сделать", Done = 1 },
        new Node { Id = "5", Lane = "todo", Title = "Живая задача" } } };
    var live = AiPick.Candidates(candidateProject, new StateStore(), new Tree());
    Check(live.Count == 1 && live[0].Id == "5", "Ai candidates exclude wiki, goals, deferred and closed work");
    var withBlocker = new StateStore();
    withBlocker.SetBlockers("5", new List<string> { "6" });
    candidateProject.Nodes.Add(new Node { Id = "6", Lane = "wiki", Title = "Зависимость", Done = 0 });
    var treeWith = new Tree { Projects = new() { candidateProject } };
    Check(AiPick.Candidates(candidateProject, withBlocker, treeWith).All(n => n.Id != "5"), "Blocked node is not offered to the model");
    candidateProject.Nodes.Find(n => n.Id == "6")!.Done = 1;
    Check(AiPick.Candidates(candidateProject, withBlocker, treeWith).Any(n => n.Id == "5"), "Closed blocker releases the node back to the model");
    var request = AiPick.BuildRequest(candidateProject, new ProjectBrief { Goal = "деньги", Gate = "1 MVP" },
        live, new[] { new FleetJob { ProjectId = "9", NodeId = "5", Title = "старое", Status = "running", BlockReason = "money" } }, "хочу быстро");
    Check(request.Contains("[5]") && request.Contains("деньги") && request.Contains("хочу быстро")
        && request.Contains("Нужны деньги") && request.Contains("УЖЕ В РАБОТЕ"), "Request carries goal, running work and operator words");
    var settings = new StateStore().Settings;
    Check(settings.LlmPickModel != settings.LlmModel && settings.LlmPickModel.Length > 0, "Task picking uses a separate non-reasoning model");
    var withModel = new StateStore { Settings = new() { LlmPickModel = "x/y", LlmPickFallbackModel = "a/b" } };
    withModel.Save();
    Check(StateStore.Load().Settings.LlmPickModel == "x/y" && StateStore.Load().Settings.LlmPickFallbackModel == "a/b",
        "Pick model settings survive restart");
    Console.WriteLine($"{count} checks passed");
}
finally { if (Directory.Exists(temp)) Directory.Delete(temp, true); StateStore.TestDataDirectory = null; }
