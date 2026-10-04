using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace PulsePilot;

/// <summary>Клиент OpenAI-совместимого чата (OpenRouter, DeepSeek, Groq, LM Studio — что угодно).</summary>
public class LlmClient
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(120) };
    private static readonly JsonSerializerOptions Opts = new() { PropertyNameCaseInsensitive = true };

    public string LastError { get; private set; } = "";

    public async Task<string> AskAsync(
        AppSettings s,
        IEnumerable<(string role, string content)> messages,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(s.LlmKey))
            throw new InvalidOperationException("Не задан ключ модели — впиши в настройках.");
        if (string.IsNullOrWhiteSpace(s.LlmBaseUrl))
            throw new InvalidOperationException("Не задан адрес API модели.");

        var payload = new Dictionary<string, object?>
        {
            ["model"] = s.LlmModel,
            ["messages"] = messages.Select(m => new Dictionary<string, object?>
            {
                ["role"] = m.role,
                ["content"] = m.content
            }).ToList(),
            ["temperature"] = s.LlmTemperature,
            ["max_tokens"] = s.LlmMaxTokens
        };

        var url = s.LlmBaseUrl.TrimEnd('/') + "/chat/completions";
        using var req = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json")
        };
        req.Headers.Add("Authorization", "Bearer " + s.LlmKey.Trim());
        // OpenRouter просит атрибуцию, без неё часть моделей отвечает 400.
        req.Headers.TryAddWithoutValidation("HTTP-Referer", "https://velvetflux.click/pilot1026");
        req.Headers.TryAddWithoutValidation("X-Title", "PulsePilot");

        using var resp = await Http.SendAsync(req, ct);
        var text = await resp.Content.ReadAsStringAsync(ct);

        if (!resp.IsSuccessStatusCode)
        {
            LastError = $"HTTP {(int)resp.StatusCode}: " + (text.Length > 400 ? text[..400] : text);
            throw new ApiException(LastError);
        }

        using var doc = JsonDocument.Parse(text);
        var root = doc.RootElement;
        if (!root.TryGetProperty("choices", out var choices) || choices.GetArrayLength() == 0)
        {
            var err = root.TryGetProperty("error", out var e) ? e.ToString() : text;
            LastError = "Пустой ответ модели: " + err;
            throw new ApiException(LastError);
        }

        var content = choices[0]
            .GetProperty("message")
            .GetProperty("content")
            .GetString() ?? "";

        LastError = "";
        return content.Trim();
    }
}
