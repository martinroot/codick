using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace PulsePilot;

public class ApiException : Exception
{
    public ApiException(string msg) : base(msg) { }
}

public class ApiClient
{
    private readonly string _url;
    private readonly string _key;
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(20) };
    private static readonly JsonSerializerOptions Opts = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
    };

    public string Url => _url;
    public bool LastCallOk { get; private set; }
    public string LastError { get; private set; } = "";
    public event Action? StatusChanged;

    public ApiClient(string url, string key)
    {
        _url = url.Trim();
        _key = key.Trim();
    }

    private void Ok() { LastCallOk = true; LastError = ""; StatusChanged?.Invoke(); }
    private void Fail(string e) { LastCallOk = false; LastError = e; StatusChanged?.Invoke(); }

    public async Task<JsonElement> PostAsync(string action, Dictionary<string, object?>? data = null)
    {
        var payload = new Dictionary<string, object?> { ["a"] = action };
        if (data != null)
            foreach (var kv in data) payload[kv.Key] = kv.Value;

        var body = new StringContent(JsonSerializer.Serialize(payload, Opts), Encoding.UTF8, "application/json");
        using var req = new HttpRequestMessage(HttpMethod.Post, _url) { Content = body };
        req.Headers.Add("X-P1026-Key", _key);

        using var resp = await Http.SendAsync(req);
        var text = await resp.Content.ReadAsStringAsync();
        if (!resp.IsSuccessStatusCode)
            throw new ApiException($"HTTP {(int)resp.StatusCode}: {Trunc(text)}");

        JsonDocument doc;
        try { doc = JsonDocument.Parse(text); }
        catch (JsonException) { throw new ApiException("Ответ не JSON: " + Trunc(text)); }

        var root = doc.RootElement.Clone();
        if (root.TryGetProperty("ok", out var okEl))
        {
            if (okEl.ValueKind == JsonValueKind.False)
            {
                var err = root.TryGetProperty("error", out var e2) ? e2.ToString() : text;
                Fail(err);
                throw new ApiException(err);
            }
        }
        Ok();
        return root;
    }

    private static string Trunc(string s) => s.Length > 300 ? s[..300] : s;

    public async Task<Tree> GetTreeAsync()
    {
        var root = await PostAsync("tree");
        // Сервер отдаёт либо {ok, tree:{...}}, либо плоский {ok, version, steps, projects}.
        if (root.TryGetProperty("tree", out var t) && t.ValueKind == JsonValueKind.Object)
            root = t;
        return JsonSerializer.Deserialize<Tree>(root.GetRawText(), Opts) ?? new Tree();
    }

    public async Task<FocusInfo> GetFocusAsync()
    {
        var root = await PostAsync("focus_get");
        var el = root.TryGetProperty("focus", out var f) ? f : default;
        if (el.ValueKind == JsonValueKind.Undefined || el.ValueKind == JsonValueKind.Null)
            return new FocusInfo();
        return JsonSerializer.Deserialize<FocusInfo>(el.GetRawText(), Opts) ?? new FocusInfo();
    }

    public Task PingAsync() => PostAsync("ping");
}
