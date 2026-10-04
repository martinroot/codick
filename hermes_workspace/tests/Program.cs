using HermesChat;
using System.Text.Json;

var passed = 0;
void Check(bool value, string label) { if (!value) throw new Exception(label); passed++; Console.WriteLine("PASS " + label); }
var p = new Profile { Id = "p", ProjectId = "1", Name = "Project" };
var g = new Gateway { Id = "g" };
Store Make() => new() { Profiles = new() { p }, Gateways = new() { g }, ProjectGateways = new() { [p.Id] = g.Id } };
TreeBriefs.Todos = new() { new() { Id = "1", Title = "First" }, new() { Id = "2", Title = "Second" }, new() { Id = "3", Title = "ЦЕЛЬ revenue" }, new() { Id = "4", Title = "Later", Body = "@deferred" } };
var store = Make(); var calls = 0;
var engine = new WorkspaceCoordinator(store, (_, gateway, _, _) => { calls++; return Task.FromResult(gateway is null ? "{\"accepted\":true,\"reason\":\"Tests passed\",\"next_id\":\"2\"}" : "Verified result"); });
engine.Propose(p);
Check(calls == 0 && store.Iterations.Single().Status == "approval", "proposal never executes without approval");
await engine.ApproveAsync(store.Iterations[0]);
Check(calls == 2 && store.Iterations[0].Status == "done", "execution followed by separate review");
Check(store.Iterations[1].NodeId == "2" && store.Iterations[1].Status == "approval" && calls == 2, "next step waits for a fresh approval");
await engine.ApproveAsync(store.Iterations[0]); Check(calls == 2, "duplicate approval does not repeat execution");
try { engine.Propose(p); Check(false, "duplicate proposal"); } catch (InvalidOperationException) { Check(true, "pending proposal blocks duplicates"); }
Check(!WorkspaceCoordinator.Actionable(TreeBriefs.Todos[2]) && !WorkspaceCoordinator.Actionable(TreeBriefs.Todos[3]), "goals and deferred tasks excluded");
var contextProfile = new Profile { Id = "context", AssetIds = new() { "brief" } };
var contextAsset = new AgentAsset { Id = "brief", Version = 3 };
Check(WorkspaceChatRelay.NeedsProfileContext(contextProfile, false, new Dictionary<string,int>(), new[] { contextAsset }), "new chat gets its profile context once");
Check(WorkspaceChatRelay.NeedsProfileContext(contextProfile, true, new Dictionary<string,int> { ["brief"] = 2 }, new[] { contextAsset }), "changed skill is injected into an existing chat once");
Check(!WorkspaceChatRelay.NeedsProfileContext(contextProfile, true, new Dictionary<string,int> { ["brief"] = 3 }, new[] { contextAsset }), "profile and skill context is not repeated on every turn");
Check(!WorkspaceChatRelay.NeedsProfileContext(null, true, new Dictionary<string,int>(), new[] { contextAsset }), "executor chat does not receive orchestrator profile context");
var taskProfile = new Profile { Id = "route-profile", ProjectId = "1", Name = "Spy AI", Prompt = "ORCHESTRATOR_CONTEXT_MUST_NOT_ENTER_EXECUTOR_CHAT" };
var taskGateway = new Gateway { Id = "route-gateway" };
var taskStore = new Store { Profiles = new() { taskProfile }, Gateways = new() { taskGateway }, ProjectGateways = new() { [taskProfile.Id] = taskGateway.Id } };
var oldTodoBody = TreeBriefs.Todos[0].Body;
TreeBriefs.Todos[0].Body = "TREE_BODY_MUST_NOT_ENTER_EXECUTOR_CHAT";
string executorMessage = "";
var taskEngine = new WorkspaceCoordinator(taskStore, (_, gateway, prompt, _) =>
{
    if (gateway is not null) { executorMessage = prompt; return Task.FromResult("executor evidence"); }
    return Task.FromResult("{\"accepted\":false,\"reason\":\"Need owner review\",\"next_id\":\"\"}");
});
taskEngine.Propose(taskProfile);
taskStore.Iterations.Single().Instruction = "Разведи три поля в документации.";
await taskEngine.ApproveAsync(taskStore.Iterations.Single());
Check(executorMessage.Contains("Задача #1") && executorMessage.Contains("Поручение") && !executorMessage.Contains(taskProfile.Prompt)
    && !executorMessage.Contains(TreeBriefs.Todos[0].Body) && executorMessage.Contains("одной короткой строкой"), "executor chat gets a terse task without profile/tree boilerplate");
TreeBriefs.Todos[0].Body = oldTodoBody;
var recoveryStore = Make();
TreeBriefs.Todos[0].Body = "FULL_TREE_BODY_SHOULD_NOT_BE_REPEATED";
var staleReview = new WorkspaceIteration { ProfileId = p.Id, GatewayId = g.Id, NodeId = "1", Title = "First", Status = "review", Result = "FULL_OLD_EXECUTOR_RESULT_SHOULD_NOT_BE_REPEATED", Note = "Нужно только вернуть содержимое документа." };
recoveryStore.Iterations.Add(staleReview);
string plannerPrompt = "";
var recoveryEngine = new WorkspaceCoordinator(recoveryStore, (_, gateway, prompt, _) =>
{
    if (gateway is not null) return Task.FromResult("Задача #1 готова — проверка: документ показан.");
    if (prompt.StartsWith("Ты оркестратор проекта"))
    {
        plannerPrompt = prompt;
        return Task.FromResult("{\"task_id\":\"1\",\"instruction\":\"Верни первые строки документа; ничего не меняй.\",\"reason\":\"Дозапрос недостающего доказательства.\",\"needs_owner\":false,\"tree\":[]}");
    }
    return Task.FromResult("{\"accepted\":true,\"reason\":\"Документ предъявлен и соответствует TODO.\",\"next_id\":\"\",\"tree\":[]}");
}) { LoopPauseSeconds = 1, LoopMaxTicks = 1 };
recoveryEngine.StartLoop(p);
for (var wait = 0; wait < 40 && recoveryEngine.IsLooping(p.Id); wait++) await Task.Delay(100);
Check(staleReview.Status == "retry" && recoveryStore.Iterations.Any(j => j.NodeId == "1" && j.Status == "done"), "START retries an unresolved review through the executor chat instead of stopping for an owner");
Check(!plannerPrompt.Contains("FULL_TREE_BODY_SHOULD_NOT_BE_REPEATED") && !plannerPrompt.Contains("FULL_OLD_EXECUTOR_RESULT_SHOULD_NOT_BE_REPEATED"), "planner receives IDs, titles and short notes instead of full prior transcripts");
TreeBriefs.Todos[0].Body = oldTodoBody;
var valid = WorkspaceDecision.Parse("```json\n{\"accepted\":false,\"reason\":\"No evidence\",\"next_id\":\"2\"}\n```", new[] { "2" });
Check(!valid.Accepted && valid.NextId == "", "rejected result cannot schedule next task");
try { WorkspaceDecision.Parse("{\"accepted\":true,\"reason\":\"OK\",\"next_id\":\"unknown\"}", new[] { "2" }); Check(false, "unknown id"); } catch (InvalidOperationException) { Check(true, "unknown model-proposed ID rejected"); }
var bad = Make(); var badEngine = new WorkspaceCoordinator(bad, (_, gateway, _, _) => Task.FromResult(gateway is null ? "invalid json" : "result"));
badEngine.Propose(p); await badEngine.ApproveAsync(bad.Iterations[0]);
Check(bad.Iterations.Single().Status == "review", "invalid review keeps result for human review");
badEngine.AcceptResult(bad.Iterations[0]); Check(bad.Iterations[0].Status == "done", "manual result acceptance");
var broken = Make(); var brokenEngine = new WorkspaceCoordinator(broken, (_,_,_,_) => throw new InvalidOperationException("Gateway failed"));
brokenEngine.Propose(p); await brokenEngine.ApproveAsync(broken.Iterations[0]); Check(broken.Iterations.Single().Status == "failed", "transport failure is not completion");
var blocked = Make(); blocked.ProjectGateways.Clear(); var blockedEngine = new WorkspaceCoordinator(blocked, (_,_,_,_) => Task.FromResult("")); blockedEngine.Propose(p);
try { await blockedEngine.ApproveAsync(blocked.Iterations[0]); Check(false, "unassigned gateway"); } catch (InvalidOperationException) { Check(blocked.Iterations[0].Status == "approval", "unassigned gateway preserves approval"); }
var concurrent = Make(); var hold = new TaskCompletionSource<string>(); var concurrentEngine = new WorkspaceCoordinator(concurrent, (_,_,_,ct) => hold.Task.WaitAsync(ct));
concurrentEngine.Propose(p); var running = concurrentEngine.ApproveAsync(concurrent.Iterations[0]);
var p2 = new Profile { Id = "p2", ProjectId = "2" }; concurrent.Profiles.Add(p2); concurrent.ProjectGateways[p2.Id] = g.Id; concurrentEngine.Propose(p2);
try { await concurrentEngine.ApproveAsync(concurrent.Iterations[1]); Check(false, "busy gateway"); } catch (InvalidOperationException) { Check(true, "same gateway cannot run two projects simultaneously"); }
concurrent.Iterations[0].NextCheckAt = 1; concurrentEngine.CheckTimers(); Check(concurrent.Iterations[0].NextCheckAt > DateTimeOffset.Now.ToUnixTimeSeconds(), "watchdog reminders reschedule");
concurrentEngine.Stop(concurrent.Iterations[0]); await running; Check(concurrent.Iterations[0].Status == "cancelled", "cancellation persists explicit status");
Check(JsonSerializer.Deserialize<WorkspaceIteration>(JsonSerializer.Serialize(store.Iterations[1]))?.NodeId == "2", "approval state survives JSON roundtrip");

// ── Вердикт оркестратора: комментарий, владелец, правки дерева ────────────────
var rich = WorkspaceDecision.Parse(
    "Рассуждение перед JSON.\n{\"accepted\":true,\"reason\":\"ок\",\"next_id\":\"2\"," +
    "\"commentary\":\"Сделал разбор, блокеров нет\",\"tree\":[{\"op\":\"done\",\"id\":\"1\"}," +
    "{\"op\":\"add\",\"lane\":\"todo\",\"id\":\"1-a\",\"title\":\"Новый\",\"body\":\"разобрать\"}]}",
    new[] { "2" });
Check(rich.Commentary == "Сделал разбор, блокеров нет", "orchestrator commentary survives parsing");
Check(rich.Tree.Count == 2 && rich.Tree[0].Op == "done" && rich.Tree[1].Id == "1-a", "tree edits parsed");
Check(!rich.NeedsOwner, "owner not requested when not asked");
var owner = WorkspaceDecision.Parse(
    "{\"accepted\":false,\"reason\":\"нужен кред\",\"next_id\":\"\",\"needs_owner\":true," +
    "\"owner_question\":\"Дай доступ к базе\",\"tree\":[]}", Array.Empty<string>());
Check(owner.NeedsOwner && owner.OwnerQuestion == "Дай доступ к базе", "owner request carries one question");
try
{
    WorkspaceDecision.Parse("{\"accepted\":false,\"reason\":\"нужно\",\"next_id\":\"\",\"needs_owner\":true}", Array.Empty<string>());
    Check(false, "owner without question");
}
catch (InvalidOperationException) { Check(true, "owner request without a question is rejected"); }

// ── Цикл START/STOP ───────────────────────────────────────────────────────────
TreeBriefs.Todos = new() { new() { Id = "1", Title = "First" }, new() { Id = "2", Title = "Second" } };
var loopStore = Make();
loopStore.Gateways[0].ReadyError = "";
var loopTicks = 0;
var looping = new WorkspaceCoordinator(loopStore, (_, gateway, _, _) =>
{
    loopTicks++;
    return Task.FromResult(gateway is null
        ? (loopTicks % 3 == 1 ? "{\"task_id\":\"" + (loopTicks == 1 ? "1" : "2") + "\",\"instruction\":\"do it\",\"reason\":\"goal\"}" : "{\"accepted\":true,\"reason\":\"ок\",\"next_id\":\"\",\"commentary\":\"тик\",\"tree\":[]}")
        : "сделано");
});
looping.LoopPauseSeconds = 1; looping.LoopMaxTicks = 2;
looping.StartLoop(p);
Check(looping.IsLooping(p.Id), "START marks the loop as running");
for (var wait = 0; wait < 100 && looping.IsLooping(p.Id); wait++) await Task.Delay(100);
Check(loopTicks >= 4, "loop ran several ticks without an owner in the chat");
Check(loopStore.Iterations.Count(j => j.Status == "done") >= 2, "loop iterations completed");
Check(loopStore.Iterations.All(j => j.Commentary == "тик" || j.Commentary == ""), "each tick keeps its commentary");
looping.StopLoop(p.Id);
Check(!looping.IsLooping(p.Id), "STOP clears the loop flag");

// needs_owner останавливает цикл сам — иначе он будет долбить задачу без человека.
var ownerStore = Make();
ownerStore.Gateways[0].ReadyError = "";
var ownerLoop = new WorkspaceCoordinator(ownerStore, (_, gateway, _, _) => Task.FromResult(gateway is null
    ? "{\"accepted\":false,\"reason\":\"нужен доступ\",\"next_id\":\"\",\"needs_owner\":true,\"owner_question\":\"Дай креды\",\"tree\":[]}"
    : "сделано"));
ownerLoop.LoopPauseSeconds = 1;
ownerLoop.StartLoop(p);
for (var wait = 0; wait < 100 && ownerLoop.IsLooping(p.Id); wait++) await Task.Delay(100);
Check(!ownerLoop.IsLooping(p.Id), "loop stops itself when the owner is needed");
Check(ownerStore.Iterations.Any(j => j.Status == "owner"), "owner question persisted as its own status");


// The actual relay routes through existing thread identities and never creates a chat.
var routed = Make();
var orchThread = new ChatThread { Id = "orch-existing", ProfileId = p.Id, GatewayId = "local", RemoteSessionId = "orch-session" };
var execThread = new ChatThread { Id = "exec-existing", GatewayId = g.Id, RemoteSessionId = "exec-session" };
routed.Threads.AddRange(new[] { orchThread, execThread });
routed.ChatBindings[p.Id] = new WorkspaceChatBinding { OrchestratorThreadId = orchThread.Id, ExecutorThreadId = execThread.Id };
var relay = new WorkspaceChatRelay(routed);
Check(ReferenceEquals(relay.Resolve(p, null), orchThread) && ReferenceEquals(relay.Resolve(p, g), execThread), "relay uses the selected existing chats in both directions");
Check(routed.Threads.Count == 2 && execThread.RemoteSessionId == "exec-session", "relay preserves history and remote session identity");
routed.ChatBindings[p.Id].ExecutorThreadId = orchThread.Id;
try { relay.Resolve(p, g); Check(false, "same chat route"); } catch (InvalidOperationException) { Check(true, "two roles cannot use the same chat"); }
routed.ChatBindings[p.Id].ExecutorThreadId = execThread.Id;
execThread.GatewayId = "wrong";
try { relay.Resolve(p, g); Check(false, "wrong gateway route"); } catch (InvalidOperationException) { Check(true, "wrong executor gateway cannot silently fall back"); }
execThread.GatewayId = g.Id;
routed.ChatBindings["other-project"] = new WorkspaceChatBinding { OrchestratorThreadId = "another", ExecutorThreadId = execThread.Id };
try { relay.Resolve(p, g); Check(false, "shared chat route"); } catch (InvalidOperationException) { Check(true, "different projects cannot contaminate one executor chat"); }
routed.ChatBindings.Remove("other-project");
Check(JsonSerializer.Deserialize<WorkspaceChatBinding>(JsonSerializer.Serialize(routed.ChatBindings[p.Id]))?.ExecutorThreadId == execThread.Id, "chat bindings survive restart serialization");
Check(!WorkspaceCoordinator.Actionable(new() { Body = "@blocked" }) && !WorkspaceCoordinator.Actionable(new() { Body = "@owner" }), "owner and blocked TODOs do not start");

// A next_id in a successful review no longer leaves the loop stuck on its own proposal.
TreeBriefs.Todos = new() { new() { Id = "1", Title = "One" }, new() { Id = "2", Title = "Two" } };
var nextStore = Make(); var plans = 0; var nextExecutions = 0;
var nextLoop = new WorkspaceCoordinator(nextStore, (_, gw, prompt, ct) =>
{
    if (gw is not null) { nextExecutions++; return Task.FromResult("evidence"); }
    if (prompt.Contains("task_id")) { plans++; return Task.FromResult("{\"task_id\":\"" + plans + "\",\"instruction\":\"verify\",\"reason\":\"goal\"}"); }
    return Task.FromResult("{\"accepted\":true,\"reason\":\"verified\",\"next_id\":\"" + (nextExecutions == 1 ? "2" : "") + "\"}");
}) { LoopPauseSeconds = 1, LoopMaxTicks = 2 };
nextLoop.StartLoop(p);
for (var wait = 0; wait < 60 && nextLoop.IsLooping(p.Id); wait++) await Task.Delay(100);
Check(plans == 2 && nextExecutions == 2 && nextStore.Iterations.All(j => j.Status == "done"), "next_id cannot stall autonomous continuation");

// STOP cancels the in-flight executor and prevents review/next execution.
var stopStore = Make(); var entered = new TaskCompletionSource(); var cancelledRun = new TaskCompletionSource(); var stopCalls = 0;
var stopLoop = new WorkspaceCoordinator(stopStore, async (_, gw, prompt, ct) =>
{
    stopCalls++;
    if (gw is null) return "{\"task_id\":\"1\",\"instruction\":\"verify\",\"reason\":\"goal\"}";
    entered.SetResult();
    try { await Task.Delay(Timeout.Infinite, ct); }
    finally { cancelledRun.SetResult(); }
    return "unreachable";
});
stopLoop.StartLoop(p); await entered.Task.WaitAsync(TimeSpan.FromSeconds(3)); stopLoop.StopLoop(p.Id);
await cancelledRun.Task.WaitAsync(TimeSpan.FromSeconds(3));
for (var wait = 0; wait < 30 && stopStore.Iterations[0].Busy; wait++) await Task.Delay(50);
Check(stopCalls == 2 && stopStore.Iterations[0].Status == "cancelled", "STOP cancels executor and prevents a wake/review");

// Global resource locks work across two different gateways.
TreeBriefs.Todos[0].Body = "@lock:production-db";
var lockStore = Make(); var otherProfile = new Profile { Id = "other", ProjectId = "2" }; var otherGateway = new Gateway { Id = "other-gateway" };
lockStore.Profiles.Add(otherProfile); lockStore.Gateways.Add(otherGateway); lockStore.ProjectGateways[otherProfile.Id] = otherGateway.Id;
var lockHold = new TaskCompletionSource<string>();
var locksEngine = new WorkspaceCoordinator(lockStore, (_, _, _, ct) => lockHold.Task.WaitAsync(ct));
locksEngine.Propose(p); var firstLockRun = locksEngine.ApproveAsync(lockStore.Iterations[0]); locksEngine.Propose(otherProfile);
try { await locksEngine.ApproveAsync(lockStore.Iterations[1]); Check(false, "resource lock"); } catch (InvalidOperationException) { Check(true, "same resource cannot run concurrently on different gateways"); }
locksEngine.Stop(lockStore.Iterations[0]); await firstLockRun;
TreeBriefs.Todos[0].Body = "";

// Owner resumption reviews already obtained evidence without rerunning the executor.
var resumeStore = Make(); var reviewOnly = 0; var executorAgain = 0;
resumeStore.Iterations.Add(new WorkspaceIteration { ProfileId = p.Id, GatewayId = g.Id, NodeId = "1", Status = "owner", Result = "old evidence" });
var resumeEngine = new WorkspaceCoordinator(resumeStore, (_, gw, _, _) =>
{
    if (gw is not null) { executorAgain++; return Task.FromResult("unexpected"); }
    reviewOnly++; return Task.FromResult("{\"accepted\":true,\"reason\":\"owner clarified criterion\",\"next_id\":\"\"}");
}) { LoopMaxTicks = 0 };
await resumeEngine.ApplyConversationAsync(p, "{\"commentary\":\"answered\",\"tree\":[],\"resume\":false}");
Check(resumeStore.Iterations[0].Status == "owner" && reviewOnly == 0, "ordinary owner discussion cannot silently release a blocker");
await resumeEngine.ApplyConversationAsync(p, "{\"commentary\":\"continue\",\"tree\":[],\"resume\":true}");
Check(executorAgain == 0 && reviewOnly == 1 && resumeStore.Iterations[0].Status == "done", "owner reply wakes review without repeating server work");

var rejectedStore = Make(); var rejectionCalls = 0;
var retryLoop = new WorkspaceCoordinator(rejectedStore, (_, gw, prompt, _) =>
{
    if (gw is not null) return Task.FromResult("insufficient evidence");
    if (prompt.Contains("task_id")) return Task.FromResult("{\"task_id\":\"1\",\"instruction\":\"different approach\",\"reason\":\"repair\"}");
    rejectionCalls++; return Task.FromResult("{\"accepted\":false,\"reason\":\"test failed\",\"next_id\":\"\"}");
}) { LoopPauseSeconds = 1, LoopMaxTicks = 6 };
retryLoop.StartLoop(p);
for (var wait = 0; wait < 60 && retryLoop.IsLooping(p.Id); wait++) await Task.Delay(100);
Check(rejectionCalls == 3 && rejectedStore.Iterations.Last().Status == "owner", "three failed validations pause for an owner decision");
Check(WorkspaceDecision.Parse("{\"accepted\":true,\"reason\":\"done but needs product decision\",\"next_id\":\"\",\"needs_owner\":true,\"owner_question\":\"Which market?\"}", Array.Empty<string>()).NeedsOwner, "accepted result can still require an owner decision");

foreach (var terminal in new[] { "run.failed", "run.cancelled", "run.interrupted" })
{
    var completion = new TuiCompletionSignal(); completion.UiApplied(terminal);
    Check(completion.Task.IsCompleted, terminal + " releases the chat wait instead of hanging");
}
var partialSignal = new TuiCompletionSignal(); partialSignal.UiApplied("message.delta");
Check(!partialSignal.Task.IsCompleted, "partial output cannot wake the orchestrator");
Check(WorkspaceDecision.DisplayText("{\"accepted\":true,\"reason\":\"verified\",\"tree\":[]}")?.Contains("Результат принят") == true, "structured verdict is displayed as readable chat text");

passed += await TuiTransportTests.RunAsync();
passed += AssetTests.Run();

// ── Параллельные запуски и вопросы шлюза ─────────────────────────────────
// Регрессия, из-за которой стриминг «сбрасывался» при переключении чата:
// состояние ответа жило в полях вкладки, и второй чат затирал первый.
var runs = new RunRegistry();
var chatA = new ChatThread { Id = "A" };
var chatB = new ChatThread { Id = "B" };
var answerA = new ChatMessage();
Check(runs.TryBegin("A", chatA, answerA, out var runA) && runA!.Cts is null, "run registers before the answer starts");
Check(!runs.IsBusy("A"), "registered run is not busy until a cancellation token appears");
runA!.Cts = new CancellationTokenSource();
Check(runs.IsBusy("A"), "run with a token counts as busy");
Check(runs.TryBegin("B", chatB, new ChatMessage(), out var runB), "a second chat can answer while the first is streaming");
runB!.Cts = new CancellationTokenSource();
Check(runs.IsBusy("A") && runs.IsBusy("B"), "two chats stream independently");
Check(runs.BackgroundCount("A") == 1 && runs.BackgroundCount("B") == 1, "background count reports the other chat, not the open one");
Check(runs.AnyBusy, "STOP stays available while any chat answers");
Check(!runs.TryBegin("A", chatA, new ChatMessage(), out _), "a second answer to the same chat is refused");

// Переключение чата не прерывает фон: события идут в сообщение своего запуска.
runA!.StreamEvents = 12;
Check(runs["B"] is { } switched && !ReferenceEquals(switched.Message, answerA) && switched.Busy,
    "switching chats swaps the live message without touching the background run");
Check(runs["A"]!.Busy && runs["A"]!.StreamEvents == 12, "background streaming continues after a chat switch");

// Ответ на вопрос уходит в сокет ИМЕННО своего диалога.
var asked = new ChatMessage { WaitingClarification = true, ClarifyRequestId = "srq-1" };
var runC = new ChatRun("C", new ChatThread { Id = "C" }, asked);
runC.Cts = new CancellationTokenSource();
runs.TryBegin("C", runC.Thread, runC.Message, out _);
Check(ReferenceEquals(runs.ByMessage(asked.Id)?.ThreadId, "C"), "a clarify button finds the run that asked, not the open chat");
Check(runs.ByMessage("нет-такого") is null, "unknown message id resolves to no run");
runs.End("C");

// STOP глушит открытый чат и не трогает фоновый.
var stoppedB = runs.Stop("B");
Check(stoppedB is not null && !runs.IsBusy("B") && runs.IsBusy("A"), "STOP cancels only the open chat");
Check(stoppedB!.Cts is null, "stopped run releases its cancellation token");
Check(runs.Stop("B") is null, "stopping an idle chat does nothing");

// Завершение ответа снимает регистрацию, но сохраняет соединение сессии.
runs["A"]!.Gateway = null;
runs["A"]!.Address = "ws://127.0.0.1:9119";
runs.End("A");
Check(!runs.IsBusy("A") && runs["A"] is null, "a finished answer leaves the registry");
Check(runs.Runs.Count == 0 && !runs.AnyBusy, "no stale runs keep STOP visible");

// Закрытие вкладки останавливает всё, что ещё отвечает.
runs.TryBegin("A", chatA, new ChatMessage(), out var lateA);
runs.TryBegin("B", chatB, new ChatMessage(), out var lateB);
lateA!.Cts = new CancellationTokenSource(); lateB!.Cts = new CancellationTokenSource();
var stoppedAll = runs.StopAll();
Check(stoppedAll.Count == 2 && stoppedAll.All(r => r.Cts is null) && !runs.AnyBusy,
    "closing the tab stops background answers instead of leaving them writing");

// Разбор вопроса шлюза: ответ без выбора, один выбор и мультивыбор.
var parsed = ClarifyRequestParser.Parse(System.Text.Json.Nodes.JsonNode.Parse(
    """{"session_id":"s","questions":[{"qid":"q0","question":"Продолжать?","choices":["Да","Нет"],"multi_select":false}]}"""));
Check(parsed.Count == 1 && parsed[0].Qid == "q0" && parsed[0].Choices.Count == 2 && !parsed[0].MultiSelect,
    "clarify request from the gateway parses into one answerable question");
Check(ClarifyRequestParser.Parse(System.Text.Json.Nodes.JsonNode.Parse("""{"questions":[]}""")).Count == 0,
    "an empty clarify set yields no dialog instead of a broken one");
var replay = ClarifyRequestParser.Parse(System.Text.Json.Nodes.JsonNode.Parse(
    """{"questions":[{"qid":"q0","question":"Что делать?","multi_select":true}],"answers":{"q0":"[\"Один\",\"Два\"]"}}"""));
Check(replay.Count == 1 && replay[0].SelectedChoices.Count == 2,
    "replayed locked answers restore multi-select state after reconnect");
// ── Регрессия: разрешение, пришедшее без живого запуска ──────────────────
// Approval живёт в очереди tools/approval на шлюзе и приходит отдельным
// запросом — часто уже после того, как ответ дописался. Поиск адресата ответа
// среди живых запусков возвращал null, кнопка молча ничего не делала, и блок
// висел на экране до перезапуска.
var store2 = new PendingRequestStore<ChatMessage, string>();
var box = new ChatMessage { WaitingApproval = true, ApprovalRequestId = "ap-1" };
var asked2 = new ChatMessage { WaitingClarification = true, ClarifyRequestId = "srq-9" };
store2.Remember(new PendingRequestStore<ChatMessage, string>.Entry("ap-1", "approval", "ws-a", box));
store2.Remember(new PendingRequestStore<ChatMessage, string>.Entry("srq-9", "clarify", "ws-b", asked2));
Check(store2.Count == 2, "an approval and a clarify request are tracked side by side");
Check(store2.Find("approval", "ap-1")?.Transport == "ws-a",
    "each request remembers the socket that asked, so the answer goes back to the right chat");
Check(store2.FindByMessage("approval", box.Id, m => m.Id)?.Id == "ap-1",
    "a button resolves its request by message id with no live run in sight");
Check(store2.FindByMessage("clarify", asked2.Id, m => m.Id)?.Transport == "ws-b",
    "a background clarify is answered over its own socket, not the open chat");
Check(store2.FindByMessage("approval", asked2.Id, m => m.Id) is null,
    "a request of one kind is never mistaken for the other kind");
Check(store2.FindByMessage("approval", "нет-такого", m => m.Id) is null,
    "an unknown message id resolves to no request");

// Один клик — один ответ: повторный не отправляет ничего.
var taken = store2.Take("approval", "ap-1");
Check(taken is not null && store2.Count == 1, "answering removes the request from the store");
Check(store2.Take("approval", "ap-1") is null, "a second click on the same approval sends nothing");

// Закрытие вкладки забывает всё, но уже отвеченное не всплывает снова.
store2.Clear();
Check(store2.Count == 0 && store2.FindByMessage("clarify", asked2.Id, m => m.Id) is null,
    "closing the window forgets unanswered requests instead of leaving a stuck panel");

Console.WriteLine($"{passed} checks passed");

namespace HermesChat
{
    public sealed class ChatThread { public string Id {get;set;} = ""; public string ProfileId {get;set;} = ""; public string GatewayId {get;set;} = ""; public string RemoteSessionId {get;set;} = ""; public List<ChatMessage> Messages {get;set;} = new(); }
    // Минимальные модели запуска: реестр проверяется без UI, но на тех же полях,
    // что и боевые. Неполные модели здесь были бы проверкой другого кода.
    public sealed class ChatMessage
    {
        public string Id {get;set;} = Guid.NewGuid().ToString("N");
        public string Role {get;set;} = "agent";
        public string Text {get;set;} = "";
        public string Streaming {get;set;} = "";
        public string Status {get;set;} = "";
        public string Note {get;set;} = "";
        public string RunId {get;set;} = "";
        public bool WaitingApproval {get;set;}
        public bool WaitingClarification {get;set;}
        public string ApprovalRequestId {get;set;} = "";
        public string ClarifyRequestId {get;set;} = "";
        public List<ClarifyQuestionData> ClarifyQuestions {get;set;} = new();
        public List<ToolStep> Tools {get;set;} = new();
        public bool IsAgent => Role == "agent";
    }
    public sealed class ToolStep { public string Tool {get;set;} = ""; public bool Running {get;set;} }
    public sealed class Store { public List<ChatThread> Threads {get;set;} = new(); public List<Profile> Profiles { get; set; } = new(); public List<Gateway> Gateways { get; set; } = new(); public Dictionary<string,WorkspaceChatBinding> ChatBindings {get;set;} = new(); public Dictionary<string,string> ProjectGateways { get; set; } = new(); public List<WorkspaceIteration> Iterations { get; set; } = new(); public void Save() {} }
    public sealed class Profile { public string Id {get;set;} = ""; public string ProjectId {get;set;} = ""; public string Name {get;set;} = ""; public string Prompt {get;set;} = ""; public string ProjectTitle {get;set;} = ""; public string SessionKey {get;set;} = ""; public int ThreadMessages {get;set;} public List<string> AssetIds {get;set;} = new(); public List<string> Toolsets {get;set;} = new(); public List<AgentTestCase> TestCases {get;set;} = new(); public bool IsBound => ProjectId.Length > 0; }
    public sealed class Gateway { public string Id {get;set;} = ""; public string ReadyError {get;set;} = ""; }
    public sealed class TreeBrief { public sealed class TodoItem { public string Id {get;set;} = ""; public string Title {get;set;} = ""; public string Body {get;set;} = ""; public string Lane {get;set;} = "todo"; public bool Done {get;set;} } }
    public sealed class TreeEdit { public string Op {get;set;} = ""; public string Id {get;set;} = ""; public string Title {get;set;} = ""; public string Body {get;set;} = ""; public string Lane {get;set;} = "todo"; }
    public static class TreeBriefs
    {
        public static List<TreeBrief.TodoItem> Todos {get;set;} = new();
        public static List<TreeBrief.TodoItem> TodoOf(string id) => Todos.Where(t => !t.Done).ToList();
        // Запись в тестах не нужна: проверяем разбор правок, а не файл. Но сигнатура
        // должна совпадать с боевой, иначе тест проверит не тот вызов.
        public static (int applied, List<string> rejected) Apply(string projectId, IEnumerable<TreeEdit> edits)
            => (edits.Count(), new List<string>());
    }
    public static class CrashLog { public static List<string> Lines {get;set;} = new(); public static void Write(string message) => Lines.Add(message); }
}
