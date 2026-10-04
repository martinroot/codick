using HermesChat;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;

internal static class TuiTransportTests
{
    public static async Task<int> RunAsync()
    {
        var passed = 0;
        void Check(bool ok, string label) { if (!ok) throw new Exception(label); passed++; Console.WriteLine("PASS " + label); }
        foreach (var disconnect in new[] { false, true })
        {
            using var portPicker = new TcpListener(IPAddress.Loopback, 0); portPicker.Start();
            var port = ((IPEndPoint)portPicker.LocalEndpoint).Port; portPicker.Stop();
            using var listener = new HttpListener(); var url = $"http://127.0.0.1:{port}/"; listener.Prefixes.Add(url); listener.Start();
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            string resumed = "", submitted = "";
            var final = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            var server = Task.Run(async () =>
            {
                var html = await listener.GetContextAsync().WaitAsync(deadline.Token);
                var bytes = Encoding.UTF8.GetBytes("__HERMES_SESSION_TOKEN__ = \"mock-token\"");
                await html.Response.OutputStream.WriteAsync(bytes, deadline.Token); html.Response.Close();
                var upgrade = await listener.GetContextAsync().WaitAsync(deadline.Token);
                using var socket = (await upgrade.AcceptWebSocketAsync(null)).WebSocket;
                var buffer = new byte[65536];
                async Task Send(JsonObject message) => await socket.SendAsync(Encoding.UTF8.GetBytes(message.ToJsonString()), WebSocketMessageType.Text, true, deadline.Token);
                while (socket.State == WebSocketState.Open)
                {
                    var received = await socket.ReceiveAsync(buffer, deadline.Token);
                    if (received.MessageType == WebSocketMessageType.Close) return;
                    var request = JsonNode.Parse(Encoding.UTF8.GetString(buffer, 0, received.Count))!;
                    var method = request["method"]?.ToString();
                    if (method == "session.resume") resumed = request["params"]?["session_id"]?.ToString() ?? "";
                    if (method == "prompt.submit") submitted = request["params"]?["text"]?.ToString() ?? "";
                    if (disconnect && method == "prompt.submit")
                    { await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "test disconnect", deadline.Token); return; }
                    await Send(new JsonObject { ["jsonrpc"]="2.0", ["id"]=request["id"]?.DeepClone(),
                        ["result"]=new JsonObject { ["session_id"]="runtime-test", ["stored_session_id"]="selected-existing" } });
                    if (method == "prompt.submit")
                    {
                        await Send(new JsonObject { ["method"]="event", ["params"]=new JsonObject { ["type"]="message.complete", ["text"]="verified reply" } });
                        await final.Task.WaitAsync(deadline.Token);
                        await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "test complete", deadline.Token);
                        return;
                    }
                }
            });
            using var gateway = new TuiGateway(new Uri(url));
            var closed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            gateway.OnEvent += (kind, data) => { if (kind == "message.complete") final.TrySetResult(data?["text"]?.ToString() ?? ""); };
            gateway.OnDisconnected += () => closed.TrySetResult();
            await gateway.ConnectAsync(deadline.Token);
            await gateway.ResumeSessionAsync("selected-existing", deadline.Token);
            Check(gateway.StoredSessionId == "selected-existing" && resumed == "selected-existing", "real WS resumes selected stored session");
            if (disconnect)
            {
                try { await gateway.SubmitAsync("task via chat", deadline.Token); Check(false,"closed request"); }
                catch (IOException) { Check(true,"socket closure fails pending chat request without waiting forever"); }
                await closed.Task.WaitAsync(deadline.Token);
                Check(!final.Task.IsCompleted,"socket closure cannot fabricate a final executor result");
            }
            else
            {
                await gateway.SubmitAsync("task via chat", deadline.Token);
                Check(await final.Task.WaitAsync(deadline.Token) == "verified reply" && submitted == "task via chat", "real prompt.submit and final reply use the chat transport");
            }
            await server.WaitAsync(deadline.Token);
        }
        return passed;
    }
}
