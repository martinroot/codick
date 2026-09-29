import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Plus,
  RotateCw,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Select, SelectOption } from "@nous-research/ui/ui/components/select";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { H2 } from "@nous-research/ui/ui/components/typography/h2";
import { api } from "@/lib/api";
import type { WebhookRoute, WebhooksResponse } from "@/lib/api";
import { copyTextToClipboard } from "@/lib/clipboard";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { useConfirmDelete } from "@nous-research/ui/hooks/use-confirm-delete";
import { useModalBehavior } from "@/hooks/useModalBehavior";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { Input } from "@nous-research/ui/ui/components/input";
import { Label } from "@nous-research/ui/ui/components/label";
import { usePageHeader } from "@/contexts/usePageHeader";
import { cn, themedBody } from "@/lib/utils";
import { errorMessage } from "@/lib/api-error";

interface CreatedWebhook {
  url: string;
  secret: string;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    void copyTextToClipboard(value).then((copied) => {
      if (!copied) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);
  return (
    <Button
      ghost
      size="icon"
      title="Copy"
      aria-label="Copy"
      onClick={handleCopy}
      className="text-body-secondary hover:text-foreground"
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

export default function WebhooksPage() {
  const [data, setData] = useState<WebhooksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [enabling, setEnabling] = useState(false);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [restartMessage, setRestartMessage] = useState<string | null>(null);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const { toast, showToast } = useToast();
  const { setEnd } = usePageHeader();

  // New subscription modal state
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState("");
  const [deliver, setDeliver] = useState("log");
  const [deliverOnly, setDeliverOnly] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedWebhook | null>(null);

  const closeCreateModal = useCallback(() => {
    setCreateModalOpen(false);
    setCreated(null);
  }, []);
  const createModalRef = useModalBehavior({
    open: createModalOpen,
    onClose: closeCreateModal,
  });

  const enabled = data?.enabled ?? false;
  const subscriptions = data?.subscriptions ?? [];

  const loadWebhooks = useCallback(() => {
    return api
      .getWebhooks()
      .then(setData)
      .catch(() => showToast("Failed to load webhooks", "error"))
      .finally(() => setLoading(false));
  }, [showToast]);

  useEffect(() => {
    loadWebhooks();
  }, [loadWebhooks]);

  const watchRestartOutcome = useCallback(async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        const st = await api.getActionStatus("gateway-restart", 5);
        if (st.running) continue;
        if (st.exit_code !== 0 && st.exit_code !== null) {
          setRestartMessage(null);
          setRestartNeeded(true);
          setRestartError(`Gateway restart failed with exit ${st.exit_code}.`);
          showToast(
            `Gateway restart failed (exit ${st.exit_code}) — restart manually`,
            "error",
          );
        } else {
          setRestartMessage(null);
          setRestartNeeded(false);
          setRestartError(null);
        }
        return;
      } catch {
        // The dashboard may briefly lose its connection while the gateway restarts.
      }
    }
    setRestartMessage(null);
  }, [showToast]);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try {
      await api.restartGateway();
      setRestartNeeded(false);
      setRestartError(null);
      setRestartMessage("Gateway restarting…");
      showToast("Gateway restarting…", "success");
      setTimeout(() => void loadWebhooks(), 4000);
      void watchRestartOutcome();
    } catch (e) {
      setRestartNeeded(true);
      setRestartError(errorMessage(e));
      showToast(`Failed to restart: ${errorMessage(e)}`, "error");
    } finally {
      setRestarting(false);
    }
  }, [loadWebhooks, showToast, watchRestartOutcome]);

  const handleEnableWebhooks = useCallback(async () => {
    setEnabling(true);
    setRestartNeeded(false);
    setRestartError(null);
    try {
      const result = await api.enableWebhooks();
      await loadWebhooks();
      if (result.restart_started) {
        setRestartMessage("Webhooks enabled; gateway restarting…");
        showToast("Webhooks enabled; gateway restarting…", "success");
        setTimeout(() => void loadWebhooks(), 4000);
        void watchRestartOutcome();
      } else {
        const detail = result.restart_error ? `: ${result.restart_error}` : ".";
        setRestartMessage(null);
        setRestartNeeded(true);
        setRestartError(`Gateway restart failed${detail}`);
        showToast(`Webhooks enabled; gateway restart failed${detail}`, "error");
      }
    } catch (e) {
      showToast(`Failed to enable webhooks: ${errorMessage(e)}`, "error");
    } finally {
      setEnabling(false);
    }
  }, [loadWebhooks, showToast, watchRestartOutcome]);

  const resetForm = useCallback(() => {
    setName("");
    setDescription("");
    setEvents("");
    setDeliver("log");
    setDeliverOnly(false);
    setPrompt("");
  }, []);

  const handleCreate = async () => {
    if (!name.trim()) {
      showToast("Name required", "error");
      return;
    }
    setCreating(true);
    try {
      const eventsList = events
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);
      const res = await api.createWebhook({
        name: name.trim(),
        description: description.trim() || undefined,
        events: eventsList.length ? eventsList : undefined,
        deliver,
        deliver_only: deliverOnly,
        prompt: prompt.trim() || undefined,
      });
      showToast("Created ✓", "success");
      setCreated({ url: res.url, secret: res.secret });
      resetForm();
      loadWebhooks();
    } catch (e) {
      showToast(`Failed to create: ${errorMessage(e)}`, "error");
    } finally {
      setCreating(false);
    }
  };

  const [togglingName, setTogglingName] = useState<string | null>(null);

  const handleToggleEnabled = useCallback(
    async (subName: string, nextEnabled: boolean) => {
      setTogglingName(subName);
      try {
        await api.setWebhookEnabled(subName, nextEnabled);
        showToast(
          nextEnabled ? `Enabled: "${subName}"` : `Disabled: "${subName}"`,
          "success",
        );
        loadWebhooks();
      } catch (e) {
        showToast(`Error: ${errorMessage(e)}`, "error");
      } finally {
        setTogglingName(null);
      }
    },
    [loadWebhooks, showToast],
  );

  const webhookDelete = useConfirmDelete({
    onDelete: useCallback(
      async (name: string) => {
        try {
          await api.deleteWebhook(name);
          showToast(`Deleted: "${name}"`, "success");
          loadWebhooks();
        } catch (e) {
          showToast(`Error: ${errorMessage(e)}`, "error");
          throw e;
        }
      },
      [loadWebhooks, showToast],
    ),
  });

  // Put "New subscription" button in page header
  useLayoutEffect(() => {
    setEnd(
      <Button
        className="text-uppercase"
        size="sm"
        disabled={!enabled || enabling}
        prefix={<Plus />}
        onClick={() => {
          setCreated(null);
          setCreateModalOpen(true);
        }}
      >
        New subscription
      </Button>,
    );
    return () => {
      setEnd(null);
    };
  }, [setEnd, enabled, enabling, loading]);

  if (loading) {
    return (
      <div className="d-flex align-items-center justify-content-center py-24">
        <Spinner className="fs-3 text-primary" />
      </div>
    );
  }

  const pendingName = webhookDelete.pendingId ?? "";

  return (
    <div className="d-flex flex-column gap-6">
      <Toast toast={toast} />

      <DeleteConfirmDialog
        open={webhookDelete.isOpen}
        onCancel={webhookDelete.cancel}
        onConfirm={webhookDelete.confirm}
        title="Delete webhook"
        description={
          pendingName
            ? `"${pendingName}" — this will permanently remove this webhook subscription.`
            : "This will permanently remove this webhook subscription."
        }
        loading={webhookDelete.isDeleting}
      />

      {/* Create subscription modal */}
      {createModalOpen && (
        <div
          ref={createModalRef}
          className="position-fixed top-0 start-0 w-100 h-100 z-[100] d-flex align-items-center justify-content-center bg-background/85 p-4"
          onClick={(e) => e.target === e.currentTarget && closeCreateModal()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-webhook-title"
        >
          <div className={cn(themedBody, "position-relative w-100 max-w-lg border border-secondary bg-card shadow-2xl d-flex flex-column max-h-[90vh] overflow-y-auto")}>
            <Button
              ghost
              size="icon"
              onClick={closeCreateModal}
              className="position-absolute right-2 top-2 text-body-secondary hover:text-foreground"
              aria-label="Close"
            >
              <X />
            </Button>

            <header className="p-5 pb-3 border-bottom border-secondary">
              <h2
                id="create-webhook-title"
                className="fs-4 fw-semibold fs-6 ls-wide"
              >
                New subscription
              </h2>
            </header>

            {created ? (
              <div className="p-5 d-grid gap-4">
                <p className="fs-6 text-body-secondary">
                  Subscription created. Copy the secret now — it is only shown
                  once.
                </p>

                <div className="d-grid gap-2">
                  <Label>Webhook URL</Label>
                  <div className="d-flex align-items-center gap-2 border border-secondary bg-background/40 px-3 py-2">
                    <span className="flex-grow-1 min-w-0 text-truncate font-monospace fs-6">
                      {created.url}
                    </span>
                    <CopyButton value={created.url} />
                  </div>
                </div>

                <div className="d-grid gap-2">
                  <Label>Secret (shown once)</Label>
                  <div className="d-flex align-items-center gap-2 border border-warning/40 bg-warning/10 px-3 py-2">
                    <span className="flex-grow-1 min-w-0 text-truncate font-monospace fs-6">
                      {created.secret}
                    </span>
                    <CopyButton value={created.secret} />
                  </div>
                </div>

                <div className="d-flex justify-content-end">
                  <Button
                    className="text-uppercase"
                    size="sm"
                    onClick={closeCreateModal}
                  >
                    Done
                  </Button>
                </div>
              </div>
            ) : (
              <div className="p-5 d-grid gap-4">
                <div className="d-grid gap-2">
                  <Label htmlFor="webhook-name">Name</Label>
                  <Input
                    id="webhook-name"
                    autoFocus
                    placeholder="e.g. github-push"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>

                <div className="d-grid gap-2">
                  <Label htmlFor="webhook-description">Description</Label>
                  <Input
                    id="webhook-description"
                    placeholder="What this webhook does (optional)"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>

                <div className="d-grid gap-2">
                  <Label htmlFor="webhook-events">Events</Label>
                  <Input
                    id="webhook-events"
                    placeholder="comma-separated, leave empty for all"
                    value={events}
                    onChange={(e) => setEvents(e.target.value)}
                  />
                </div>

                <div className="d-grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="d-grid gap-2">
                    <Label htmlFor="webhook-deliver">Deliver to</Label>
                    <Select
                      id="webhook-deliver"
                      value={deliver}
                      onValueChange={(v) => setDeliver(v)}
                    >
                      <SelectOption value="log">Log</SelectOption>
                      <SelectOption value="telegram">Telegram</SelectOption>
                      <SelectOption value="discord">Discord</SelectOption>
                      <SelectOption value="slack">Slack</SelectOption>
                      <SelectOption value="email">Email</SelectOption>
                      <SelectOption value="github_comment">
                        GitHub comment
                      </SelectOption>
                    </Select>
                  </div>

                  <div className="d-grid gap-2">
                    <Label htmlFor="webhook-deliver-only">Deliver only</Label>
                    <label className="d-flex align-items-center gap-2 fs-6 text-body-secondary h-9">
                      <input
                        id="webhook-deliver-only"
                        type="checkbox"
                        checked={deliverOnly}
                        onChange={(e) => setDeliverOnly(e.target.checked)}
                      />
                      Skip the agent, deliver payload directly
                    </label>
                  </div>
                </div>

                <div className="d-grid gap-2">
                  <Label htmlFor="webhook-prompt">Prompt</Label>
                  <textarea
                    id="webhook-prompt"
                    className="d-flex min-h-[80px] w-100 border border-secondary bg-background/40 px-3 py-2 fs-6 font-courier shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30 focus-visible:border-foreground/25"
                    placeholder="Instructions for the agent when this webhook fires (optional)"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                  />
                </div>

                <div className="d-flex justify-content-end">
                  <Button
                    className="text-uppercase"
                    size="sm"
                    onClick={handleCreate}
                    disabled={creating}
                    prefix={creating ? <Spinner /> : undefined}
                  >
                    {creating ? "Creating…" : "Create"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {!enabled && (
        <Card className="border-warning/50">
          <CardContent className="d-flex flex-column gap-4 py-6 fs-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="d-flex align-items-start gap-3">
              <Webhook className="icon-lg flex-shrink-0 text-warning" />
              <div className="d-flex flex-column gap-1">
                <span className="fw-medium">Webhook receiver disabled</span>
                <span className="text-body-secondary">
                  Webhooks are their own gateway platform. Enable them here to
                  accept incoming HTTP events; chat channels are only needed
                  when a subscription delivers to Telegram, Discord, Slack, or
                  another channel.
                </span>
              </div>
            </div>
            <Button
              size="sm"
              className="text-uppercase flex-shrink-0"
              onClick={handleEnableWebhooks}
              disabled={enabling}
              prefix={enabling ? <Spinner /> : <Webhook className="icon-md" />}
            >
              {enabling ? "Enabling…" : "Enable webhooks"}
            </Button>
          </CardContent>
        </Card>
      )}

      {restartMessage && !restartNeeded && (
        <Card className="border-secondary">
          <CardContent className="d-flex align-items-center gap-2 p-4 fs-6 text-body-secondary">
            <RotateCw className="icon-md flex-shrink-0 text-warning" />
            <span>{restartMessage}</span>
          </CardContent>
        </Card>
      )}

      {restartNeeded && (
        <Card className="border-warning/50">
          <CardContent className="d-flex flex-column gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="d-flex align-items-start gap-2 fs-6">
              <AlertTriangle className="mt-1 icon-md flex-shrink-0 text-warning" />
              <span>
                {restartError ??
                  "Webhooks are enabled, but the gateway still needs a restart before the receiver can come online."}
              </span>
            </div>
            <Button
              size="sm"
              className="text-uppercase flex-shrink-0"
              onClick={handleRestart}
              disabled={restarting}
              prefix={restarting ? <Spinner /> : <RotateCw className="icon-md" />}
            >
              {restarting ? "Restarting…" : "Restart gateway"}
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="d-flex flex-column gap-3">
        <H2
          variant="sm"
          className="d-flex align-items-center gap-2 text-body-secondary"
        >
          <Webhook className="icon-md" />
          Subscriptions ({subscriptions.length})
        </H2>

        <p className="fs-6 text-body-secondary -mt-1">
          Subscription changes hot-reload once the webhook receiver is running.
          Disabled subscriptions reject incoming events.
        </p>

        {subscriptions.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center fs-6 text-body-secondary">
              No webhook subscriptions yet.
            </CardContent>
          </Card>
        )}

        {subscriptions.map((sub: WebhookRoute) => (
          <Card key={sub.name}>
            <CardContent className="d-flex align-items-start gap-4 py-4">
              <div className={cn("flex-grow-1 min-w-0", !sub.enabled && "opacity-60")}>
                <div className="d-flex align-items-center gap-2 mb-1 flex-wrap">
                  <span className="fw-medium fs-6 text-truncate">
                    {sub.name}
                  </span>
                  <Badge tone="outline">{sub.deliver}</Badge>
                  {sub.deliver_only && (
                    <Badge tone="secondary">deliver only</Badge>
                  )}
                  {!sub.enabled && <Badge tone="warning">disabled</Badge>}
                </div>

                {sub.description && (
                  <p className="fs-6 text-body-secondary mb-2">
                    {sub.description}
                  </p>
                )}

                <div className="d-flex align-items-center gap-1 flex-wrap mb-2">
                  {sub.events.length === 0 ? (
                    <Badge tone="secondary">(all)</Badge>
                  ) : (
                    sub.events.map((evt) => (
                      <Badge key={evt} tone="secondary">
                        {evt}
                      </Badge>
                    ))
                  )}
                </div>

                <div className="d-flex align-items-center gap-2 fs-6 text-body-secondary">
                  <span className="flex-grow-1 min-w-0 text-truncate font-monospace">
                    {sub.url}
                  </span>
                  <CopyButton value={sub.url} />
                </div>
              </div>

              <div className="d-flex align-items-center gap-1 flex-shrink-0">
                <Button
                  ghost
                  size="sm"
                  className="text-uppercase"
                  disabled={togglingName === sub.name}
                  onClick={() => handleToggleEnabled(sub.name, !sub.enabled)}
                >
                  {sub.enabled ? "Disable" : "Enable"}
                </Button>
                <Button
                  ghost
                  destructive
                  size="icon"
                  title="Delete"
                  aria-label="Delete"
                  onClick={() => webhookDelete.requestDelete(sub.name)}
                >
                  <Trash2 />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
