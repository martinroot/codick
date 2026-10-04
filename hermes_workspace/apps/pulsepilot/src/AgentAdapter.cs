using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace PulsePilot;

public sealed class AgentAdapterException(int statusCode) : Exception($"Agent Bridge: HTTP {statusCode}")
{
    public int StatusCode { get; } = statusCode;
}

public sealed class AgentAdapter
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(20) };
    public async Task<JsonElement> Call(string endpoint, string key, string path, object? body = null)
    {
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
            throw new InvalidOperationException("Нужен HTTP(S) адрес Agent Bridge.");
        using var request = new HttpRequestMessage(body == null ? HttpMethod.Get : HttpMethod.Post, endpoint.TrimEnd('/') + path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        if (body != null) request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        using var response = await Http.SendAsync(request);
        if (!response.IsSuccessStatusCode) throw new AgentAdapterException((int)response.StatusCode);
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return doc.RootElement.Clone();
    }
}
