namespace HermesChat;

/// <summary>Route through exactly the two stored conversations selected by the owner.</summary>
public sealed class WorkspaceChatRelay(Store store)
{
    public static bool NeedsProfileContext(Profile? profile, bool hasUserHistory,
        IReadOnlyDictionary<string, int> lastAssetVersions, IEnumerable<AgentAsset> assets)
    {
        if (profile is null) return false;
        if (!hasUserHistory) return true;
        return assets.Any(asset => profile.AssetIds.Contains(asset.Id)
            && (!lastAssetVersions.TryGetValue(asset.Id, out var version) || version < asset.Version));
    }

    public ChatThread Resolve(Profile profile, Gateway? gateway)
    {
        var binding = store.ChatBindings.GetValueOrDefault(profile.Id)
            ?? throw new InvalidOperationException("Выберите два чата в настройках проекта.");
        if (string.IsNullOrWhiteSpace(binding.OrchestratorThreadId) || string.IsNullOrWhiteSpace(binding.ExecutorThreadId)
            || binding.OrchestratorThreadId == binding.ExecutorThreadId)
            throw new InvalidOperationException("Нужны два разных чата: оркестратор и исполнитель.");
        var orchestrator = store.Threads.FirstOrDefault(t => t.Id == binding.OrchestratorThreadId)
            ?? throw new InvalidOperationException("Чат оркестратора удалён.");
        var executor = store.Threads.FirstOrDefault(t => t.Id == binding.ExecutorThreadId)
            ?? throw new InvalidOperationException("Чат исполнителя удалён.");
        if (orchestrator.ProfileId != profile.Id)
            throw new InvalidOperationException("Чат оркестратора должен принадлежать выбранному проекту.");
        var gatewayId = store.ProjectGateways.GetValueOrDefault(profile.Id, "");
        if (gatewayId.Length == 0 || executor.GatewayId != gatewayId || !store.Gateways.Any(g => g.Id == gatewayId))
            throw new InvalidOperationException("Чат исполнителя должен принадлежать назначенному шлюзу.");
        if (gateway is not null && gateway.Id != gatewayId)
            throw new InvalidOperationException("Шлюз поручения изменился. Выберите чаты заново.");
        if (store.ChatBindings.Any(pair => pair.Key != profile.Id &&
            (pair.Value.ExecutorThreadId == executor.Id || pair.Value.OrchestratorThreadId == orchestrator.Id)))
            throw new InvalidOperationException("Один чат уже связан с другим проектом. Создайте отдельный диалог на том же шлюзе.");
        if (orchestrator.RemoteSessionId.Length > 0 && executor.RemoteSessionId == orchestrator.RemoteSessionId
            && executor.GatewayId == orchestrator.GatewayId)
            throw new InvalidOperationException("Два чата ссылаются на одну сессию. Создайте отдельную сессию исполнителя.");
        return gateway is null ? orchestrator : executor;
    }
}
