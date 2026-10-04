using System.Text.Json.Nodes;

namespace HermesChat;

public sealed class ClarifyQuestionData
{
    public string Qid { get; set; } = "";
    public string Question { get; set; } = "";
    public List<string> Choices { get; set; } = new();
    public bool MultiSelect { get; set; }
    public string? Answer { get; set; }
    public string SelectedChoice { get; set; } = "";
    public string FreeText { get; set; } = "";
    public List<string> SelectedChoices { get; set; } = new();
}

/// <summary>Parses TUI server-request clarify frames and replayed locked answers.</summary>
public static class ClarifyRequestParser
{
    public static List<ClarifyQuestionData> Parse(JsonNode? parameters)
    {
        var envelope = parameters as JsonObject;
        var payload = envelope?["payload"] as JsonObject ?? envelope;
        if (payload?["questions"] is not JsonArray rows) return new List<ClarifyQuestionData>();
        var locked = payload?["answers"] as JsonObject;
        var result = new List<ClarifyQuestionData>();
        foreach (var row in rows.OfType<JsonObject>())
        {
            var qid = (string?)row["qid"] ?? "";
            var question = (string?)row["question"] ?? "";
            if (qid.Length == 0 || question.Length == 0) continue;
            var choices = row["choices"] is JsonArray array
                ? array.Select(choice => choice?.ToString() ?? "").Where(choice => choice.Length > 0).ToList()
                : new List<string>();
            var multiSelect = row["multi_select"]?.GetValue<bool>() ?? false;
            var answer = locked?[qid]?.ToString();
            var state = new ClarifyQuestionData
            {
                Qid = qid,
                Question = question,
                Choices = choices,
                MultiSelect = multiSelect,
                Answer = answer
            };
            if (answer is not null)
            {
                if (multiSelect)
                {
                    try
                    {
                        if (JsonNode.Parse(answer) is JsonArray selected)
                            state.SelectedChoices = selected.Select(item => item?.ToString() ?? "")
                                .Where(item => item.Length > 0).ToList();
                        else state.FreeText = answer;
                    }
                    catch (System.Text.Json.JsonException) { state.FreeText = answer; }
                }
                else if (choices.Contains(answer, StringComparer.Ordinal)) state.SelectedChoice = answer;
                else state.FreeText = answer;
            }
            result.Add(state);
        }
        return result;
    }
}
