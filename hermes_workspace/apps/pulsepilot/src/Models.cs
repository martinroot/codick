using System.Text.Json;
using System.Text.Json.Serialization;

namespace PulsePilot;

/// <summary>Сервер отдаёт числа часто строками ("ver":"10") — принимаем оба варианта.</summary>
public sealed class FlexInt : System.Text.Json.Serialization.JsonConverter<int>
{
    public override int Read(ref System.Text.Json.Utf8JsonReader reader, Type t, JsonSerializerOptions o)
    {
        if (reader.TokenType == JsonTokenType.String)
        {
            var s = reader.GetString();
            return int.TryParse(s, out var v) ? v : 0;
        }
        return reader.TokenType == JsonTokenType.Number ? reader.GetInt32() : 0;
    }

    public override void Write(Utf8JsonWriter w, int value, JsonSerializerOptions o) => w.WriteNumberValue(value);
}

public class Node
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("project_id")] public string ProjectId { get; set; } = "";
    [JsonPropertyName("lane")] public string Lane { get; set; } = "todo";
    [JsonPropertyName("title")] public string Title { get; set; } = "";
    [JsonPropertyName("body")] public string Body { get; set; } = "";
    [JsonPropertyName("done")][JsonConverter(typeof(FlexInt))] public int Done { get; set; }
    [JsonPropertyName("ver")][JsonConverter(typeof(FlexInt))] public int Ver { get; set; }
    [JsonPropertyName("sort_order")][JsonConverter(typeof(FlexInt))] public int SortOrder { get; set; }
    [JsonPropertyName("created_at")] public string CreatedAt { get; set; } = "";
    [JsonPropertyName("updated_at")] public string UpdatedAt { get; set; } = "";
}

public class Project
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("title")] public string Title { get; set; } = "";
    [JsonPropertyName("note")] public string Note { get; set; } = "";
    [JsonPropertyName("ver")][JsonConverter(typeof(FlexInt))] public int Ver { get; set; }
    [JsonPropertyName("sort_order")][JsonConverter(typeof(FlexInt))] public int SortOrder { get; set; }
    [JsonPropertyName("todo_done")][JsonConverter(typeof(FlexInt))] public int TodoDone { get; set; }
    [JsonPropertyName("todo_total")][JsonConverter(typeof(FlexInt))] public int TodoTotal { get; set; }
    [JsonPropertyName("nodes")] public List<Node> Nodes { get; set; } = new();
}

public class Tree
{
    [JsonPropertyName("version")][JsonConverter(typeof(FlexInt))] public int Version { get; set; }
    [JsonPropertyName("steps")][JsonConverter(typeof(FlexInt))] public int Steps { get; set; }
    [JsonPropertyName("projects")] public List<Project> Projects { get; set; } = new();

    public Project? ById(string id) => Projects.FirstOrDefault(p => p.Id == id);
    public Node? NodeById(string id)
    {
        foreach (var p in Projects)
        {
            var n = p.Nodes.FirstOrDefault(x => x.Id == id);
            if (n != null) return n;
        }
        return null;
    }
    public Project? ProjectOfNode(string nodeId) => Projects.FirstOrDefault(p => p.Nodes.Any(n => n.Id == nodeId));
}

public class FocusInfo
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("node_id")] public string? NodeId { get; set; }
    [JsonPropertyName("note")] public string Note { get; set; } = "";
    [JsonPropertyName("updated_at")] public string UpdatedAt { get; set; } = "";
    [JsonPropertyName("node")] public Node? Node { get; set; }
    [JsonPropertyName("project")] public Project? Project { get; set; }
}
