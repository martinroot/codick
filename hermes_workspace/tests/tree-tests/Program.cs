using HermesChat;
using System.Text.Json.Nodes;
var root = AppContext.BaseDirectory;
var path = Path.Combine(root, "tree-snapshot.json");
var original = File.Exists(path) ? File.ReadAllText(path) : null;
try
{
    File.WriteAllText(path, """
    {"metadata":{"keep":"yes"},"tree":{"projects":[{"id":"tree-test","title":"Test","nodes":[{"id":"a","title":"Work","body":"@lock:db","lane":"todo","done":false}]}]}}
    """);
    TreeBriefs.Reload();
    void Check(bool ok, string name) { if(!ok) throw new Exception(name); Console.WriteLine("PASS " + name); }
    Check(TreeBriefs.TodoOf("tree-test").Count == 1, "real nested tree is readable");
    var changed = TreeBriefs.Apply("tree-test", new[] { new TreeEdit { Op="rewrite", Id="a", Title="Updated", Body="@lock:db criterion" } });
    Check(changed.applied == 1 && TreeBriefs.TodoOf("tree-test")[0].Title == "Updated", "real rewrite reloads TODO queue");
    var document = JsonNode.Parse(File.ReadAllText(path))!;
    Check(document["metadata"]?["keep"]?.ToString()=="yes" && document["tree"]?["projects"] is JsonArray, "nested wrapper and unrelated metadata survive writing");
    var bytes = File.ReadAllText(path);
    var invalid = TreeBriefs.Apply("tree-test", new[] { new TreeEdit { Op="rewrite", Id="a", Title="must not leak" }, new TreeEdit { Op="add", Id="", Title="bad" } });
    Check(invalid.applied == 0 && invalid.rejected.Count > 0 && File.ReadAllText(path) == bytes, "invalid edit batch cannot partially write tree");
    var done = TreeBriefs.Apply("tree-test", new[] { new TreeEdit { Op="done", Id="a" } });
    Check(done.applied == 1 && TreeBriefs.TodoOf("tree-test").Count == 0, "accepted node leaves real TODO queue");
    Check(File.Exists(path+".backup"), "tree mutation preserves a backup");
}
finally { if(original is null) File.Delete(path); else File.WriteAllText(path,original); TreeBriefs.Reload(); }