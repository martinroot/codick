import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  Activity,
  Brain,
  Check,
  Clock,
  Copy,
  Cpu,
  Database,
  Download,
  Globe,
  HardDrive,
  KeyRound,
  Link2,
  Play,
  Plus,
  Power,
  RotateCw,
  Server,
  Share2,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Terminal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Badge } from "@/ui";
import { Button } from "@/ui";
import { Spinner } from "@/ui";
import { H2 } from "@/ui";
import { Card, CardContent } from "@/ui";
import { Checkbox } from "@/ui";
import { Input } from "@/ui";
import { Label } from "@/ui";
import { Select, SelectOption } from "@/ui";
import { Toast } from "@/ui";
import { useToast } from "@/ui";
import { useConfirmDelete } from "@/ui";
import { ConfirmDialog } from "@/ui";
import { useModalBehavior } from "@/hooks/useModalBehavior";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { HermesConsoleModal } from "@/components/HermesConsoleModal";
import { cn, themedBody } from "@/lib/utils";
import { api } from "@/lib/api";
import { copyTextToClipboard } from "@/lib/clipboard";
import {
  gatewayStateNeedsLogs,
  gatewayStateDescription,
  gatewayActionFailedMessage,
  servedProfileRefusal,
  sharedGatewayProfiles,
  sharedGatewayRestartDescription,
  sharedGatewayRestartedMessage,
} from "@/lib/shared-gateway";
import type {
  StatusResponse,
  MemoryStatus,
  MemoryProviderInfo,
  CredentialPoolProvider,
  CheckpointsResponse,
  HooksResponse,
  HookEntry,
  SystemStats,
  UpdateCheckResponse,
  CuratorStatus,
  PortalStatus,
  DebugShareResponse,
  GatewayMigratePlan,
} from "@/lib/api";
import { apiErrorFromResponse, errorMessage } from "@/lib/api-error";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

type BackupImportTarget =
  | { kind: "upload"; file: File }
  | { kind: "path"; path: string };

function backupImportLabel(target: BackupImportTarget | null): string {
  if (!target) return "the archive";
  return target.kind === "upload" ? target.file.name : target.path;
}

function backupFileName(path: string | null): string {
  if (!path) return "No backup created yet";
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * Live action-log viewer for the spawn-based admin actions (doctor, audit,
 * backup, import, skills update, checkpoints prune, gateway start/stop).
 * Polls /api/actions/<name>/status until the process exits.
 */
function ActionLogViewer({
  action,
  onClose,
  onComplete,
}: {
  action: string;
  onClose: () => void;
  onComplete?: (action: string, exitCode: number | null) => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(true);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completeRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    completeRef.current = false;
    const poll = async () => {
      try {
        const st = await api.getActionStatus(action, 400);
        if (cancelled) return;
        setLines(st.lines);
        setRunning(st.running);
        setExitCode(st.exit_code);
        if (!st.running && !completeRef.current) {
          completeRef.current = true;
          onComplete?.(action, st.exit_code);
        }
        if (st.running) timer.current = setTimeout(poll, 1200);
      } catch {
        if (!cancelled) setRunning(false);
      }
    };
    poll();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [action, onComplete]);

  return (
    <Card>
      <CardContent className="py-4">
        <div className="d-flex align-items-center justify-content-between mb-2">
          <div className="d-flex align-items-center gap-2">
            <Terminal className="icon-md text-body-secondary" />
            <span className="font-monospace fs-6">{action}</span>
            {running ? (
              <Badge tone="warning">running</Badge>
            ) : (
              <Badge tone={exitCode === 0 ? "success" : "destructive"}>
                {exitCode === 0 ? "done" : `exit ${exitCode}`}
              </Badge>
            )}
          </div>
          <Button ghost size="icon" onClick={onClose} aria-label="Close log">
            <X />
          </Button>
        </div>
        <pre className="max-h-72 overflow-auto text-wrap text-break sku-backdrop border border-secondary p-3 fs-6 font-monospace text-body-secondary">
          {lines.length ? lines.join("\n") : "Starting…"}
        </pre>
      </CardContent>
    </Card>
  );
}

const HOOK_EVENTS_FALLBACK = [
  "pre_tool_call",
  "post_tool_call",
  "pre_llm_call",
  "post_llm_call",
  "on_session_start",
  "on_session_end",
];

const MEMORY_STATUS_LABEL: Record<MemoryProviderInfo["status"], string> = {
  ready: "ready",
  needs_config: "needs setup",
  unavailable: "unavailable",
  missing: "missing",
};

const MEMORY_STATUS_TONE: Record<
  MemoryProviderInfo["status"],
  "success" | "warning" | "destructive" | "secondary"
> = {
  ready: "success",
  needs_config: "warning",
  unavailable: "destructive",
  missing: "destructive",
};

export default function SystemPage() {
  const { toast, showToast } = useToast();

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [memory, setMemory] = useState<MemoryStatus | null>(null);
  const [pool, setPool] = useState<CredentialPoolProvider[]>([]);
  const [checkpoints, setCheckpoints] = useState<CheckpointsResponse | null>(
    null,
  );
  const [hooks, setHooks] = useState<HooksResponse | null>(null);
  const [curator, setCurator] = useState<CuratorStatus | null>(null);
  const [portal, setPortal] = useState<PortalStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [migratePlan, setMigratePlan] = useState<GatewayMigratePlan | null>(null);

  // Add-credential form.
  const [credProvider, setCredProvider] = useState("openrouter");
  const [credKey, setCredKey] = useState("");
  const [credLabel, setCredLabel] = useState("");
  const [addingCred, setAddingCred] = useState(false);

  const [pendingBackupArchive, setPendingBackupArchive] = useState<string | null>(
    null,
  );
  const [downloadableBackupArchive, setDownloadableBackupArchive] = useState<
    string | null
  >(null);
  const [downloadingBackup, setDownloadingBackup] = useState(false);
  const importUploadInputRef = useRef<HTMLInputElement | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPath, setImportPath] = useState("");
  // Restore-from-backup is destructive (overwrites the live config) and the
  // spawned `hermes import` runs non-interactively (stdin is /dev/null), so
  // its CLI "Continue? [y/N]" prompt would auto-abort. The dashboard owns the
  // consent: confirm here, then call the endpoint with force=true.
  const [importingBackup, setImportingBackup] = useState(false);
  const [importConfirmTarget, setImportConfirmTarget] =
    useState<BackupImportTarget | null>(null);

  // Create-hook modal.
  const [hookModalOpen, setHookModalOpen] = useState(false);
  const closeHookModal = useCallback(() => setHookModalOpen(false), []);
  const hookModalRef = useModalBehavior({
    open: hookModalOpen,
    onClose: closeHookModal,
  });
  const [hookEvent, setHookEvent] = useState("pre_tool_call");
  const [hookCommand, setHookCommand] = useState("");
  const [hookMatcher, setHookMatcher] = useState("");
  const [hookTimeout, setHookTimeout] = useState("");
  const [hookApprove, setHookApprove] = useState(true);
  const [creatingHook, setCreatingHook] = useState(false);

  // ── Update check ───────────────────────────────────────────────────
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResponse | null>(
    null,
  );
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateConfirmOpen, setUpdateConfirmOpen] = useState(false);

  const loadAll = useCallback(() => {
    Promise.allSettled([
      api.getStatus(),
      api.getSystemStats(),
      api.getMemory(),
      api.getCredentialPool(),
      api.getCheckpoints(),
      api.getHooks(),
      api.getCurator(),
      api.getPortal(),
      // Cached (non-forced) check so the version row shows update status on
      // load without a separate effect / a forced network round-trip.
      api.checkHermesUpdate(false),
      api.getGatewayMigratePlan(),
    ])
      .then(([s, st, m, p, c, h, cur, prt, upd, mig]) => {
        if (s.status === "fulfilled") setStatus(s.value);
        if (st.status === "fulfilled") setStats(st.value);
        if (m.status === "fulfilled") setMemory(m.value);
        if (p.status === "fulfilled") setPool(p.value.providers);
        if (c.status === "fulfilled") setCheckpoints(c.value);
        if (h.status === "fulfilled") setHooks(h.value);
        if (cur.status === "fulfilled") setCurator(cur.value);
        if (prt.status === "fulfilled") setPortal(prt.value);
        if (upd.status === "fulfilled") setUpdateInfo(upd.value);
        if (mig.status === "fulfilled") setMigratePlan(mig.value);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // ── Gateway lifecycle ──────────────────────────────────────────────
  // A profile served by the shared multiplexer has no gateway of its own: Restart restarts
  // the ONE process every bot on this device runs in, so confirm first and say so after;
  // Start/Stop answer 409 with an explanation that belongs in a notice, not a raw error.
  const sharedGateway = sharedGatewayProfiles(status);
  const [sharedRestartOpen, setSharedRestartOpen] = useState(false);
  const [servedNotice, setServedNotice] = useState<string | null>(null);
  const runGateway = async (verb: "start" | "stop" | "restart"): Promise<boolean> => {
    setServedNotice(null);
    try {
      if (verb === "start") {
        await api.startGateway();
        setActiveAction("gateway-start");
      } else if (verb === "stop") {
        await api.stopGateway();
        setActiveAction("gateway-stop");
      } else {
        await api.restartGateway();
        setActiveAction("gateway-restart");
      }
      showToast(`Gateway ${verb} started`, "success");
      setTimeout(loadAll, 3000);
      return true;
    } catch (e) {
      const refusal = servedProfileRefusal(e);
      if (refusal) {
        setServedNotice(refusal);
        return false;
      }
      showToast(gatewayActionFailedMessage(verb, errorMessage(e), e), "error");
      return false;
    }
  };
  const requestRestart = () => {
    if (sharedGateway) {
      setSharedRestartOpen(true);
      return;
    }
    void runGateway("restart");
  };
  // Same completion rule as the Desktop: the restart child exiting 0, or still running when the
  // bounded poll ends (in a no-service install it BECOMES the gateway and never exits), is
  // success — then the "(N bots)" toast; a non-zero exit is the action log's failure to show.
  const restartShared = async () => {
    const bots = sharedGateway?.length ?? 0;
    const started = await runGateway("restart");
    if (!started) return;
    for (let attempt = 0; attempt < 18; attempt += 1) {
      await new Promise((r) => setTimeout(r, 1200));
      const st = await api.getActionStatus("gateway-restart", 1).catch(() => null);
      if (st && !st.running) {
        if (st.exit_code != null && st.exit_code !== 0) return;
        break;
      }
    }
    showToast(sharedGatewayRestartedMessage(bots), "success");
  };

  const migrateToMultiplex = async () => {
    try {
      await api.migrateGatewayToMultiplex();
      setActiveAction("gateway-migrate");
      showToast("Migrating to a single multiplexed gateway", "success");
      setTimeout(loadAll, 5000);
    } catch (e) {
      showToast(`Gateway migration failed: ${errorMessage(e)}`, "error");
    }
  };

  // ── Curator ────────────────────────────────────────────────────────
  const toggleCuratorPaused = async () => {
    if (!curator) return;
    try {
      await api.setCuratorPaused(!curator.paused);
      showToast(curator.paused ? "Curator resumed" : "Curator paused", "success");
      loadAll();
    } catch (e) {
      showToast(`Curator toggle failed: ${errorMessage(e)}`, "error");
    }
  };

  // ── Memory ─────────────────────────────────────────────────────────
  // Memory provider selection lives on the /plugins page now (see the
  // read-only display + link below); the dropdown was intentionally
  // dropped from this card during the admin-panel refresh.
  const memoryReset = useConfirmDelete({
    onDelete: useCallback(
      async (target: string) => {
        try {
          const res = await api.resetMemory(
            target as "all" | "memory" | "user",
          );
          showToast(`Reset: ${res.deleted.join(", ") || "nothing"}`, "success");
          loadAll();
        } catch (e) {
          showToast(`Reset failed: ${errorMessage(e)}`, "error");
          throw e;
        }
      },
      [loadAll, showToast],
    ),
  });

  // ── Credential pool ────────────────────────────────────────────────
  const addCredential = async () => {
    if (!credProvider.trim() || !credKey.trim()) {
      showToast("Provider and API key required", "error");
      return;
    }
    setAddingCred(true);
    try {
      await api.addCredentialPoolEntry(
        credProvider.trim(),
        credKey.trim(),
        credLabel.trim() || undefined,
      );
      showToast("Credential added", "success");
      setCredKey("");
      setCredLabel("");
      loadAll();
    } catch (e) {
      showToast(`Failed to add credential: ${errorMessage(e)}`, "error");
    } finally {
      setAddingCred(false);
    }
  };

  const credDelete = useConfirmDelete({
    onDelete: useCallback(
      async (key: string) => {
        const [provider, idxStr] = key.split("|");
        try {
          await api.removeCredentialPoolEntry(provider, Number(idxStr));
          showToast("Credential removed", "success");
          loadAll();
        } catch (e) {
          showToast(`Failed to remove: ${errorMessage(e)}`, "error");
          throw e;
        }
      },
      [loadAll, showToast],
    ),
  });

  // ── Operations ─────────────────────────────────────────────────────
  const runOp = async (fn: () => Promise<{ name: string }>, label: string) => {
    try {
      const res = await fn();
      setActiveAction(res.name);
      showToast(`${label} started`, "success");
    } catch (e) {
      showToast(`${label} failed: ${errorMessage(e)}`, "error");
    }
  };

  const runDashboardBackup = async () => {
    try {
      const res = await api.runBackup();
      setActiveAction(res.name);
      setPendingBackupArchive(res.archive ?? null);
      setDownloadableBackupArchive(null);
      showToast("Backup started", "success");
    } catch (e) {
      showToast(`Backup failed: ${errorMessage(e)}`, "error");
    }
  };

  const handleActionComplete = useCallback(
    (action: string, exitCode: number | null) => {
      if (action === "backup" && pendingBackupArchive) {
        if (exitCode === 0) {
          setDownloadableBackupArchive(pendingBackupArchive);
          showToast("Backup ready to download", "success");
        } else {
          setPendingBackupArchive(null);
        }
      }
    },
    [pendingBackupArchive, showToast],
  );

  const downloadBackup = async () => {
    const archive = downloadableBackupArchive;
    if (!archive) return;
    setDownloadingBackup(true);
    try {
      const res = await api.downloadBackup(archive);
      if (!res.ok) {
        throw apiErrorFromResponse(res.status, await res.text().catch(() => ""), res.url);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = backupFileName(archive);
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      showToast(`Download failed: ${errorMessage(e)}`, "error");
    } finally {
      setDownloadingBackup(false);
    }
  };

  const clearImportFile = () => {
    setImportFile(null);
    if (importUploadInputRef.current) importUploadInputRef.current.value = "";
  };

  const runBackupImport = async (target: BackupImportTarget) => {
    setImportingBackup(true);
    try {
      const res =
        target.kind === "upload"
          ? await api.runImportUpload(target.file, true)
          : await api.runImport(target.path, true);
      setActiveAction(res.name);
      showToast("Import started", "success");
      if (target.kind === "upload") clearImportFile();
    } catch (e) {
      showToast(`Import failed: ${errorMessage(e)}`, "error");
    } finally {
      setImportingBackup(false);
    }
  };

  // ── Debug share ────────────────────────────────────────────────────
  // Unlike the fire-and-forget ops above, `debug share` produces shareable
  // paste URLs that are the whole point — so we surface them as real,
  // copyable links rather than a log tail.
  const [shareRedact, setShareRedact] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [shareResult, setShareResult] = useState<DebugShareResponse | null>(
    null,
  );
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);

  const copyToClipboard = useCallback(
    async (text: string, label: string) => {
      if (await copyTextToClipboard(text)) {
        setCopiedLabel(label);
        setTimeout(
          () => setCopiedLabel((cur) => (cur === label ? null : cur)),
          1500,
        );
      } else {
        showToast("Couldn't copy to clipboard", "error");
      }
    },
    [showToast],
  );

  const runDebugShare = useCallback(async () => {
    setSharing(true);
    setShareResult(null);
    try {
      const res = await api.runDebugShare({ redact: shareRedact });
      setShareResult(res);
      const n = Object.keys(res.urls).length;
      showToast(
        `Uploaded ${n} paste${n === 1 ? "" : "s"}${
          res.redacted ? " (redacted)" : ""
        }`,
        "success",
      );
    } catch (e) {
      showToast(`Debug share failed: ${errorMessage(e)}`, "error");
    } finally {
      setSharing(false);
    }
  }, [shareRedact, showToast]);


  // ── Update check / apply ───────────────────────────────────────────
  const checkForUpdate = useCallback(
    async (force = false) => {
      if (status?.can_update_hermes === false) return;
      setCheckingUpdate(true);
      try {
        const info = await api.checkHermesUpdate(force);
        setUpdateInfo(info);
        if (force) {
          if (info.update_available) {
            showToast(
              info.behind && info.behind > 0
                ? `Update available — ${info.behind} commit${info.behind === 1 ? "" : "s"} behind`
                : "Update available",
              "success",
            );
          } else if (info.behind === 0) {
            showToast("You're on the latest version", "success");
          } else if (info.message) {
            showToast(info.message, "error");
          }
        }
      } catch (e) {
        showToast(`Update check failed: ${errorMessage(e)}`, "error");
      } finally {
        setCheckingUpdate(false);
      }
    },
    [showToast, status?.can_update_hermes],
  );

  // Auto-check (cached) runs inside loadAll on mount; this is the
  // user-triggered forced re-check from the "Check for updates" button.
  const applyUpdate = async () => {
    setUpdateConfirmOpen(false);
    if (status?.can_update_hermes === false) {
      showToast(
        "Hermes updates are managed outside this dashboard.",
        "success",
      );
      return;
    }
    try {
      const resp = await api.updateHermes();
      if (!resp.ok) {
        showToast(
          resp.message ??
            "Updates don't apply from this dashboard.",
          "success",
        );
        return;
      }
      setActiveAction(resp.name ?? "hermes-update");
      showToast("Update started", "success");
    } catch (e) {
      showToast(`Update failed: ${errorMessage(e)}`, "error");
    }
  };

  const checkpointsPrune = useConfirmDelete({
    onDelete: useCallback(async () => {
      try {
        const res = await api.pruneCheckpoints();
        setActiveAction(res.name);
        showToast("Checkpoint prune started", "success");
      } catch (e) {
        showToast(`Prune failed: ${errorMessage(e)}`, "error");
        throw e;
      }
    }, [showToast]),
  });

  // ── Hooks ──────────────────────────────────────────────────────────
  const createHook = async () => {
    if (!hookCommand.trim()) {
      showToast("Command is required", "error");
      return;
    }
    setCreatingHook(true);
    try {
      await api.createHook({
        event: hookEvent,
        command: hookCommand.trim(),
        matcher: hookMatcher.trim() || undefined,
        timeout: hookTimeout.trim() ? Number(hookTimeout) : undefined,
        approve: hookApprove,
      });
      showToast("Hook created", "success");
      setHookCommand("");
      setHookMatcher("");
      setHookTimeout("");
      setHookModalOpen(false);
      loadAll();
    } catch (e) {
      showToast(`Failed to create hook: ${errorMessage(e)}`, "error");
    } finally {
      setCreatingHook(false);
    }
  };

  const hookDelete = useConfirmDelete({
    onDelete: useCallback(
      async (key: string) => {
        const sep = key.indexOf("|");
        const event = key.slice(0, sep);
        const command = key.slice(sep + 1);
        try {
          await api.deleteHook(event, command);
          showToast("Hook removed", "success");
          loadAll();
        } catch (e) {
          showToast(`Failed to remove hook: ${errorMessage(e)}`, "error");
          throw e;
        }
      },
      [loadAll, showToast],
    ),
  });

  if (loading) {
    return (
      <div className="d-flex align-items-center justify-content-center py-24">
        <Spinner className="fs-3 text-primary" />
      </div>
    );
  }

  const gatewayRunning = status?.gateway_running;
  const canUpdateHermes = status?.can_update_hermes !== false;
  const activeMemoryProvider = memory?.active
    ? memory.providers.find((provider) => provider.name === memory.active)
    : null;
  const validEvents = hooks?.valid_events?.length
    ? hooks.valid_events
    : HOOK_EVENTS_FALLBACK;

  return (
    <div className="d-flex flex-column gap-8">
      <Toast toast={toast} />
      <input
        ref={importUploadInputRef}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        className="d-none"
        onChange={(event) => {
          setImportFile(event.currentTarget.files?.[0] ?? null);
        }}
      />

      <ConfirmDialog
        open={sharedRestartOpen}
        onCancel={() => setSharedRestartOpen(false)}
        onConfirm={() => {
          setSharedRestartOpen(false);
          void restartShared();
        }}
        title="Restart the shared gateway?"
        description={sharedGatewayRestartDescription(sharedGateway ?? [])}
        confirmLabel="Restart all"
      />

      <ConfirmDialog
        open={canUpdateHermes && updateConfirmOpen}
        onCancel={() => setUpdateConfirmOpen(false)}
        onConfirm={() => void applyUpdate()}
        title="Update Hermes?"
        description={
          updateInfo && updateInfo.behind && updateInfo.behind > 0
            ? `This will run 'hermes update' (${updateInfo.update_command}) and pull ${updateInfo.behind} new commit${updateInfo.behind === 1 ? "" : "s"}. The gateway restarts when the update finishes; the current session keeps its prompt cache until then.`
            : `This will run 'hermes update' (${updateInfo?.update_command ?? "hermes update"}) and restart the gateway when it finishes.`
        }
        confirmLabel="Update now"
      />

      <DeleteConfirmDialog
        open={memoryReset.isOpen}
        onCancel={memoryReset.cancel}
        onConfirm={memoryReset.confirm}
        title="Reset memory"
        description="This permanently erases the selected built-in memory files. This cannot be undone."
        loading={memoryReset.isDeleting}
      />
      <DeleteConfirmDialog
        open={credDelete.isOpen}
        onCancel={credDelete.cancel}
        onConfirm={credDelete.confirm}
        title="Remove credential"
        description="Remove this pooled API key? The agent will no longer rotate through it."
        loading={credDelete.isDeleting}
      />
      <DeleteConfirmDialog
        open={checkpointsPrune.isOpen}
        onCancel={checkpointsPrune.cancel}
        onConfirm={checkpointsPrune.confirm}
        title="Prune checkpoints"
        description="Delete the rollback checkpoint shadow store? Existing /rollback points will be lost."
        loading={checkpointsPrune.isDeleting}
      />
      <DeleteConfirmDialog
        open={hookDelete.isOpen}
        onCancel={hookDelete.cancel}
        onConfirm={hookDelete.confirm}
        title="Remove shell hook"
        description="Remove this hook from config and revoke its consent? It stops firing on the next restart."
        loading={hookDelete.isDeleting}
      />
      <HermesConsoleModal
        open={consoleOpen}
        onClose={() => setConsoleOpen(false)}
      />

      {/* Create-hook modal */}
      {hookModalOpen && (
        <div
          ref={hookModalRef}
          className="position-fixed top-0 start-0 w-100 h-100 z-3 d-flex align-items-center justify-content-center sku-backdrop p-4"
          onClick={(e) => e.target === e.currentTarget && setHookModalOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <div className={cn(themedBody, "position-relative w-100 max-w-lg border border-secondary bg-body shadow-lg d-flex flex-column")}>
            <Button
              ghost
              size="icon"
              onClick={() => setHookModalOpen(false)}
              className="position-absolute right-2 top-2 text-body-secondary hover:text-foreground"
              aria-label="Close"
            >
              <X />
            </Button>
            <header className="p-5 pb-3 border-bottom border-secondary">
              <h2 className="fw-semibold fs-6 ls-wide">
                New shell hook
              </h2>
            </header>
            <div className="p-5 d-grid gap-4">
              <div className="d-grid gap-2">
                <Label htmlFor="hook-event">Event</Label>
                <Select
                  id="hook-event"
                  value={hookEvent}
                  onValueChange={(v) => setHookEvent(v)}
                >
                  {validEvents.map((ev) => (
                    <SelectOption key={ev} value={ev}>
                      {ev}
                    </SelectOption>
                  ))}
                </Select>
              </div>
              <div className="d-grid gap-2">
                <Label htmlFor="hook-command">Command (absolute path)</Label>
                <Input
                  id="hook-command"
                  autoFocus
                  placeholder="/usr/local/bin/my-hook.sh"
                  value={hookCommand}
                  onChange={(e) => setHookCommand(e.target.value)}
                />
              </div>
              <div className="d-grid grid-cols-2 gap-4">
                <div className="d-grid gap-2">
                  <Label htmlFor="hook-matcher">Matcher (optional)</Label>
                  <Input
                    id="hook-matcher"
                    placeholder="e.g. terminal"
                    value={hookMatcher}
                    onChange={(e) => setHookMatcher(e.target.value)}
                  />
                </div>
                <div className="d-grid gap-2">
                  <Label htmlFor="hook-timeout">Timeout (s)</Label>
                  <Input
                    id="hook-timeout"
                    placeholder="10"
                    value={hookTimeout}
                    onChange={(e) => setHookTimeout(e.target.value)}
                  />
                </div>
              </div>
              <div className="d-flex align-items-center gap-2.5">
                <Checkbox
                  checked={hookApprove}
                  id="hook-approve"
                  onCheckedChange={(checked) => setHookApprove(checked === true)}
                />

                <Label
                  className="cursor-pointer fs-6 fw-normal text-lowercase ls-normal text-body-secondary"
                  htmlFor="hook-approve"
                >
                  Approve now (grant consent so it fires; otherwise it stays
                  configured but inactive)
                </Label>
              </div>
              <p className="fs-6 text-warning">
                Shell hooks run arbitrary commands on this host. Only add scripts
                you trust. Takes effect on the next gateway/session restart.
              </p>
              <div className="d-flex justify-content-end">
                <Button
                  className="text-uppercase"
                  size="sm"
                  onClick={createHook}
                  disabled={creatingHook}
                  prefix={creatingHook ? <Spinner /> : undefined}
                >
                  {creatingHook ? "Creating" : "Create hook"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Live action log */}
      {activeAction && (
        <ActionLogViewer
          action={activeAction}
          onComplete={handleActionComplete}
          onClose={() => setActiveAction(null)}
        />
      )}

      {/* ── Host / system stats ───────────────────────────────────── */}
      <section className="d-flex flex-column gap-3">
        <H2 variant="sm" className="d-flex align-items-center gap-2 text-body-secondary">
          <Server className="icon-md" /> Host
        </H2>
        <Card>
          <CardContent className="py-4">
            <div className="d-grid grid-cols-2 sm:grid-cols-3 row-gap-3 gap-x-6 fs-6">
              <div>
                <div className="fs-6 text-uppercase ls-wide text-body-secondary">OS</div>
                <div>{stats?.os} {stats?.os_release}</div>
              </div>
              <div>
                <div className="fs-6 text-uppercase ls-wide text-body-secondary">Arch</div>
                <div>{stats?.arch}</div>
              </div>
              <div>
                <div className="fs-6 text-uppercase ls-wide text-body-secondary">Host</div>
                <div className="text-truncate">{stats?.hostname}</div>
              </div>
              <div>
                <div className="fs-6 text-uppercase ls-wide text-body-secondary">Python</div>
                <div>{stats?.python_impl} {stats?.python_version}</div>
              </div>
              <div>
                <div className="fs-6 text-uppercase ls-wide text-body-secondary">Hermes</div>
                <div className="d-flex align-items-center gap-2">
                  <span>v{stats?.hermes_version}</span>
                  {canUpdateHermes &&
                    updateInfo &&
                    (updateInfo.update_available ? (
                      <Badge tone="warning">
                        {updateInfo.behind && updateInfo.behind > 0
                          ? `${updateInfo.behind} behind`
                          : "update available"}
                      </Badge>
                    ) : updateInfo.behind === 0 ? (
                      <Badge tone="success">latest</Badge>
                    ) : null)}
                </div>
              </div>
              <div>
                <div className="fs-6 text-uppercase ls-wide text-body-secondary d-flex align-items-center gap-1">
                  <Cpu className="icon-sm" /> CPU
                </div>
                <div>
                  {stats?.cpu_count ?? "—"} cores
                  {typeof stats?.cpu_percent === "number"
                    ? ` · ${stats.cpu_percent.toFixed(0)}%`
                    : ""}
                </div>
              </div>
              {stats?.memory && (
                <div>
                  <div className="fs-6 text-uppercase ls-wide text-body-secondary">Memory</div>
                  <div>
                    {formatBytes(stats.memory.used)} / {formatBytes(stats.memory.total)} ({stats.memory.percent}%)
                  </div>
                </div>
              )}
              {stats?.disk && (
                <div>
                  <div className="fs-6 text-uppercase ls-wide text-body-secondary d-flex align-items-center gap-1">
                    <HardDrive className="icon-sm" /> Disk
                  </div>
                  <div>
                    {formatBytes(stats.disk.used)} / {formatBytes(stats.disk.total)} ({stats.disk.percent}%)
                  </div>
                </div>
              )}
              {typeof stats?.uptime_seconds === "number" && (
                <div>
                  <div className="fs-6 text-uppercase ls-wide text-body-secondary">Uptime</div>
                  <div>{formatDuration(stats.uptime_seconds)}</div>
                </div>
              )}
              {stats?.load_avg && stats.load_avg.length >= 3 && (
                <div>
                  <div className="fs-6 text-uppercase ls-wide text-body-secondary">Load avg</div>
                  <div>{stats.load_avg.map((n) => n.toFixed(2)).join(" / ")}</div>
                </div>
              )}
            </div>
            {stats && !stats.psutil && (
              <p className="mt-3 fs-6 text-body-secondary">
                Install the <span className="font-monospace">psutil</span> extra for
                CPU / memory / disk metrics.
              </p>
            )}
            {canUpdateHermes && (
              <div className="mt-4 d-flex flex-wrap align-items-center gap-2 border-top border-secondary pt-4">
                <Button
                  size="sm"
                  ghost
                  disabled={checkingUpdate}
                  prefix={
                    checkingUpdate ? (
                      <Spinner className="icon-sm" />
                    ) : (
                      <RotateCw className="icon-sm" />
                    )
                  }
                  onClick={() => void checkForUpdate(true)}
                >
                  Check for updates
                </Button>
                {updateInfo?.update_available && updateInfo.can_apply && (
                  <Button
                    size="sm"
                    prefix={<Download className="icon-sm" />}
                    onClick={() => setUpdateConfirmOpen(true)}
                  >
                    Update now
                  </Button>
                )}
                {updateInfo &&
                  !updateInfo.can_apply &&
                  updateInfo.update_available && (
                    <span className="fs-6 text-body-secondary">
                      Update with{"                                "}
                      <span className="font-monospace">{updateInfo.update_command}</span>
                    </span>
                  )}
                {updateInfo?.message && !updateInfo.update_available && (
                  <span className="fs-6 text-body-secondary">
                    {updateInfo.message}
                  </span>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ── Portal ────────────────────────────────────────────────── */}
      <section className="d-flex flex-column gap-3">
        <H2 variant="sm" className="d-flex align-items-center gap-2 text-body-secondary">
          <Globe className="icon-md" /> Nous Portal
        </H2>
        <Card>
          <CardContent className="d-flex flex-column gap-3 py-4">
            <div className="d-flex align-items-center gap-3">
              <Badge tone={portal?.logged_in ? "success" : "secondary"}>
                {portal?.logged_in ? "logged in" : "not logged in"}
              </Badge>
              {portal?.provider && (
                <span className="fs-6 text-body-secondary">
                  inference provider: {portal.provider}
                </span>
              )}
              <a
                href={portal?.subscription_url || "https://portal.nousresearch.com/manage-subscription"}
                target="_blank"
                rel="noreferrer"
                className="ml-auto fs-6 text-primary text-decoration-underline"
              >
                Manage subscription
              </a>
            </div>
            {portal?.features && portal.features.length > 0 && (
              <div className="d-flex flex-column gap-1 border-top border-secondary pt-3">
                <span className="fs-6 text-uppercase ls-wide text-body-secondary">
                  Tool Gateway routing
                </span>
                {portal.features.map((f) => (
                  <div key={f.label} className="d-flex align-items-center justify-content-between fs-6">
                    <span>{f.label}</span>
                    <span className="text-body-secondary">{f.state}</span>
                  </div>
                ))}
              </div>
            )}
            {!portal?.logged_in && (
              <p className="fs-6 text-body-secondary">
                Log in with <span className="font-monospace">hermes portal</span>.
              </p>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ── Curator ───────────────────────────────────────────────── */}
      <section className="d-flex flex-column gap-3">
        <H2 variant="sm" className="d-flex align-items-center gap-2 text-body-secondary">
          <Sparkles className="icon-md" /> Skill curator
        </H2>
        <Card>
          <CardContent className="d-flex align-items-center justify-content-between py-4">
            <div className="d-flex align-items-center gap-3">
              <Badge tone={curator?.paused ? "warning" : curator?.enabled ? "success" : "secondary"}>
                {curator?.paused ? "paused" : curator?.enabled ? "active" : "disabled"}
              </Badge>
              <span className="fs-6 text-body-secondary">
                {curator?.interval_hours ? `every ${curator.interval_hours}h` : ""}
                {curator?.last_run_at ? ` · last run ${new Date(curator.last_run_at).toLocaleString()}` : " · never run"}
              </span>
            </div>
            <div className="d-flex align-items-center gap-2">
              <Button size="sm" ghost onClick={toggleCuratorPaused}>
                {curator?.paused ? "Resume" : "Pause"}
              </Button>
              <Button
                size="sm"
                ghost
                prefix={<Play className="icon-sm" />}
                onClick={() => runOp(api.runCurator, "Curator review")}
              >
                Run now
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ── Gateway ───────────────────────────────────────────────── */}
      <section className="d-flex flex-column gap-3">
        <H2 variant="sm" className="d-flex align-items-center gap-2 text-body-secondary">
          <Power className="icon-md" /> Gateway
        </H2>
        <Card>
          <CardContent className="d-flex align-items-center justify-content-between py-4">
            <div className="d-flex align-items-center gap-3">
              <Badge tone={gatewayRunning ? "success" : "secondary"}>
                {gatewayRunning ? "running" : "stopped"}
              </Badge>
              <span className="fs-6 text-body-secondary">
                {gatewayStateDescription(status?.gateway_state, gatewayRunning)}
              </span>
              {gatewayStateNeedsLogs(status?.gateway_state) && (
                <Link to="/logs?file=gateway" className="fs-6 text-decoration-underline">
                  Open logs
                </Link>
              )}
            </div>
            <div className="d-flex align-items-center gap-2">
              <Button
                size="sm"
                className="text-uppercase"
                onClick={() => runGateway("start")}
                disabled={gatewayRunning}
                prefix={<Play className="icon-sm" />}
              >
                Start
              </Button>
              <Button
                size="sm"
                className="text-uppercase"
                onClick={requestRestart}
                prefix={<RotateCw className="icon-sm" />}
              >
                Restart
              </Button>
              <Button
                size="sm"
                className="text-uppercase text-warning"
                ghost
                onClick={() => runGateway("stop")}
                disabled={!gatewayRunning}
                prefix={<Power className="icon-sm" />}
              >
                Stop
              </Button>
            </div>
          </CardContent>
          {(sharedGateway || servedNotice) && (
            <CardContent className="border-top border-current/10 py-3 fs-6 text-body-secondary" data-slot="shared-gateway-notice">
              {servedNotice ?? `Served by the shared gateway with ${sharedGateway!.join(", ")}.`}
            </CardContent>
          )}
          {migratePlan && !migratePlan.already_multiplexed && migratePlan.profiles.length > 1 && (
            migratePlan.eligible || migratePlan.blockers.length > 0
          ) && (
            <CardContent className="d-flex flex-column gap-2 border-top border-secondary py-4 fs-6">
              <div className="d-flex align-items-center justify-content-between gap-3">
                <span className="text-body-secondary">
                  Your profiles each run their own gateway. One multiplexed gateway serves every profile from a single process.
                </span>
                <Button
                  size="sm"
                  className="text-uppercase"
                  onClick={migrateToMultiplex}
                  disabled={!migratePlan.eligible}
                  title={migratePlan.eligible ? undefined : "Fix the blockers below first"}
                >
                  Migrate to a single multiplexed gateway
                </Button>
              </div>
              {migratePlan.blockers.map((b) => (
                <div key={b} className="text-warning">• {b}</div>
              ))}
            </CardContent>
          )}
        </Card>
      </section>

      {/* ── Memory ────────────────────────────────────────────────── */}
      <section className="d-flex flex-column gap-3">
        <H2 variant="sm" className="d-flex align-items-center gap-2 text-body-secondary">
          <Brain className="icon-md" /> Memory
        </H2>
        <Card>
          <CardContent className="d-flex flex-column gap-4 py-4">
            <div className="d-flex flex-wrap align-items-center column-gap-3 row-gap-1 fs-6 text-body-secondary">
              <span>
                External provider:{"                                "}
                <span className="font-monospace text-body-emphasis">
                  {memory?.active || "built-in only"}
                </span>
              </span>
              {activeMemoryProvider && (
                <Badge tone={MEMORY_STATUS_TONE[activeMemoryProvider.status]}>
                  {MEMORY_STATUS_LABEL[activeMemoryProvider.status]}
                </Badge>
              )}
              <Link to="/plugins" className="text-decoration-underline">
                Change in Plugins →
              </Link>
              <span className="ml-auto">
                Provider setup:{"                                "}
                <Link to="/plugins" className="text-decoration-underline">
                  configure in Plugins
                </Link>
              </span>
            </div>

            {activeMemoryProvider?.status === "missing" && (
              <p className="border border-destructive/50 px-3 py-2 fs-6 text-danger">
                The configured provider is no longer installed. Switch to built-in memory or configure another provider in Plugins.
              </p>
            )}

            <div className="d-flex flex-wrap align-items-center gap-3 border-top border-secondary pt-3">
              <span className="fs-6 text-body-secondary">
                Built-in files — MEMORY.md:{"                                "}
                {formatBytes(memory?.builtin_files.memory ?? 0)} · USER.md:{"                                "}
                {formatBytes(memory?.builtin_files.user ?? 0)}
              </span>
              <div className="d-flex align-items-center gap-2 ml-auto">
                <Button size="sm" ghost className="text-danger" onClick={() => memoryReset.requestDelete("memory")}>
                  Reset MEMORY.md
                </Button>
                <Button size="sm" ghost className="text-danger" onClick={() => memoryReset.requestDelete("user")}>
                  Reset USER.md
                </Button>
                <Button size="sm" ghost className="text-danger" onClick={() => memoryReset.requestDelete("all")}>
                  Reset all
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ── Credential pool ───────────────────────────────────────── */}
      <section className="d-flex flex-column gap-3">
        <H2 variant="sm" className="d-flex align-items-center gap-2 text-body-secondary">
          <KeyRound className="icon-md" /> Credential pool
        </H2>
        <Card>
          <CardContent className="d-flex flex-column gap-4 py-4">
            <div className="d-grid grid-cols-1 sm:grid-cols-4 gap-3 align-items-end">
              <div className="d-grid gap-2">
                <Label htmlFor="cred-provider">Provider</Label>
                <Input id="cred-provider" value={credProvider} onChange={(e) => setCredProvider(e.target.value)} placeholder="openrouter" />
              </div>
              <div className="d-grid gap-2 sm:col-span-2">
                <Label htmlFor="cred-key">API key</Label>
                <Input id="cred-key" type="password" value={credKey} onChange={(e) => setCredKey(e.target.value)} placeholder="sk-…" />
              </div>
              <div className="d-grid gap-2">
                <Label htmlFor="cred-label">Label</Label>
                <Input id="cred-label" value={credLabel} onChange={(e) => setCredLabel(e.target.value)} placeholder="optional" />
              </div>
            </div>
            <div className="d-flex justify-content-end">
              <Button size="sm" className="text-uppercase" onClick={addCredential} disabled={addingCred} prefix={addingCred ? <Spinner /> : undefined}>
                Add key
              </Button>
            </div>
            {pool.length === 0 && (
              <p className="fs-6 text-body-secondary">
                No pooled credentials. Add one above to enable key rotation.
              </p>
            )}
            {pool.map((prov) => (
              <div key={prov.provider} className="d-flex flex-column gap-2">
                <span className="fs-6 text-uppercase ls-wide text-body-secondary">
                  {prov.provider}
                </span>
                {prov.entries.map((entry) => (
                  <div key={`${prov.provider}-${entry.index}`} className="d-flex align-items-center gap-3 border border-secondary sku-backdrop px-3 py-2">
                    <span className="fs-6 fw-medium">{entry.label}</span>
                    <span className="font-monospace fs-6 text-body-secondary">{entry.token_preview}</span>
                    <Badge tone="outline">{entry.auth_type}</Badge>
                    {entry.last_status && <Badge tone="secondary">{entry.last_status}</Badge>}
                    <Button ghost size="icon" className="ml-auto text-danger" aria-label="Remove credential" onClick={() => credDelete.requestDelete(`${prov.provider}|${entry.index}`)}>
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
            ))}
          </CardContent>
        </Card>
      </section>

      {/* ── Operations ────────────────────────────────────────────── */}
      <section className="d-flex flex-column gap-3">
        <H2 variant="sm" className="d-flex align-items-center gap-2 text-body-secondary">
          <Activity className="icon-md" /> Operations
        </H2>
        <Card>
          <CardContent className="d-flex flex-wrap gap-2 py-4">
            <Button size="sm" ghost prefix={<Terminal className="icon-sm" />} onClick={() => setConsoleOpen(true)}>
              Open console
            </Button>
            <Button size="sm" ghost prefix={<Stethoscope className="icon-sm" />} onClick={() => runOp(api.runDoctor, "Doctor")}>
              Run doctor
            </Button>
            <Button size="sm" ghost prefix={<ShieldCheck className="icon-sm" />} onClick={() => runOp(api.runSecurityAudit, "Security audit")}>
              Security audit
            </Button>
            <Button size="sm" ghost prefix={<RotateCw className="icon-sm" />} onClick={() => runOp(api.updateSkillsFromHub, "Skills update")}>
              Update skills
            </Button>
            <Button size="sm" ghost prefix={<Activity className="icon-sm" />} onClick={() => runOp(api.runPromptSize, "Prompt size")}>
              Prompt size
            </Button>
            <Button size="sm" ghost prefix={<Database className="icon-sm" />} onClick={() => runOp(api.runDump, "Support dump")}>
              Support dump
            </Button>
            <Button size="sm" ghost prefix={<RotateCw className="icon-sm" />} onClick={() => runOp(api.runConfigMigrate, "Config migrate")}>
              Migrate config
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="d-flex flex-column gap-4 py-4">
            <div className="d-flex flex-column gap-3 lg:flex-row lg:items-end">
              <div className="d-grid min-w-0 flex-grow-1 gap-2">
                <Label>Full backup</Label>
                <div className="d-flex min-w-0 flex-column gap-2 sm:flex-row sm:items-center">
                  <Button
                    size="sm"
                    ghost
                    prefix={<Database className="icon-sm" />}
                    onClick={() => void runDashboardBackup()}
                  >
                    Create backup
                  </Button>
                  <Button
                    size="sm"
                    ghost
                    disabled={!downloadableBackupArchive || downloadingBackup}
                    prefix={
                      downloadingBackup ? (
                        <Spinner className="icon-sm" />
                      ) : (
                        <Download className="icon-sm" />
                      )
                    }
                    onClick={() => void downloadBackup()}
                  >
                    Download backup
                  </Button>
                  <span
                    className="min-w-0 text-truncate fs-6 text-body-secondary"
                    title={pendingBackupArchive ?? "No backup created yet"}
                  >
                    {backupFileName(pendingBackupArchive)}
                  </span>
                </div>
              </div>
            </div>

            <div className="d-flex flex-column gap-3 border-top border-secondary pt-4 sm:flex-row sm:items-end">
              <div className="d-grid min-w-0 flex-grow-1 gap-2">
                <Label>Restore from backup upload</Label>
                <div className="d-flex min-w-0 flex-column gap-2 sm:flex-row sm:items-center">
                  <Button
                    type="button"
                    size="sm"
                    ghost
                    disabled={importingBackup}
                    prefix={<Upload className="icon-sm" />}
                    onClick={() => importUploadInputRef.current?.click()}
                  >
                    Choose restore zip
                  </Button>
                  <span
                    className="min-w-0 text-truncate fs-6 text-body-secondary"
                    title={importFile?.name ?? "No backup archive selected"}
                  >
                    {importFile?.name ?? "No backup archive selected"}
                  </span>
                </div>
              </div>
              <Button
                size="sm"
                ghost
                disabled={!importFile || importingBackup}
                prefix={importingBackup ? <Spinner /> : undefined}
                onClick={() => {
                  if (!importFile) return;
                  setImportConfirmTarget({ kind: "upload", file: importFile });
                }}
              >
                Restore upload
              </Button>
            </div>

            <div className="d-flex flex-column gap-3 border-top border-secondary pt-4 sm:flex-row sm:items-end">
              <div className="d-grid min-w-0 flex-grow-1 gap-2">
                <Label htmlFor="import-path">Restore from backups path</Label>
                <Input
                  id="import-path"
                  value={importPath}
                  onChange={(e) => setImportPath(e.target.value)}
                  placeholder="$HERMES_HOME/backups/hermes-backup.zip"
                />
              </div>
              <Button
                size="sm"
                ghost
                disabled={!importPath.trim() || importingBackup}
                prefix={importingBackup ? <Spinner /> : undefined}
                onClick={() => {
                  const path = importPath.trim();
                  if (!path) return;
                  setImportConfirmTarget({ kind: "path", path });
                }}
              >
                Restore path
              </Button>
            </div>
            <ConfirmDialog
              open={!!importConfirmTarget}
              title="Restore full Hermes backup?"
              description={`This will overwrite your current Hermes configuration, skills, sessions, and data with the contents of ${backupImportLabel(importConfirmTarget)}. This cannot be undone.`}
              destructive
              confirmLabel="Restore"
              cancelLabel="Cancel"
              onCancel={() => setImportConfirmTarget(null)}
              onConfirm={() => {
                const target = importConfirmTarget;
                setImportConfirmTarget(null);
                if (target) void runBackupImport(target);
              }}
            />
          </CardContent>
        </Card>

        {/* Debug share — uploads a redacted report + logs, returns shareable
            links. Separated from the buttons above because its output is
            persistent, copyable URLs, not a fire-and-forget log tail. */}
        <Card>
          <CardContent className="d-flex flex-column gap-3 py-4">
            <div className="d-flex flex-wrap align-items-center justify-content-between gap-3">
              <div className="d-flex align-items-start gap-2">
                <Share2 className="icon-md mt-1 text-body-secondary" />
                <div className="d-flex flex-column">
                  <span className="fs-6 fw-medium">Share debug report</span>
                  <span className="fs-6 text-body-secondary max-w-prose">
                    Uploads system info + logs to a public paste service and
                    returns links to send the Hermes team. Pastes auto-delete
                    after 6 hours.
                  </span>
                </div>
              </div>
              <Button
                size="sm"
                disabled={sharing}
                prefix={
                  sharing ? (
                    <Spinner className="icon-sm" />
                  ) : (
                    <Share2 className="icon-sm" />
                  )
                }
                onClick={() => void runDebugShare()}
              >
                {sharing ? "Uploading…" : "Generate share link"}
              </Button>
            </div>

            <div className="d-flex align-items-center gap-2.5">
              <Checkbox
                checked={shareRedact}
                disabled={sharing}
                id="share-redact"
                onCheckedChange={(checked) => setShareRedact(checked === true)}
              />

              <Label
                className="cursor-pointer user-select-none fs-6 fw-normal text-lowercase ls-normal text-body-secondary"
                htmlFor="share-redact"
              >
                Redact credential-shaped tokens before upload (recommended)
              </Label>
            </div>

            {shareResult && (
              <div className="d-flex flex-column gap-2 border-top border-secondary pt-3">
                <div className="d-flex align-items-center justify-content-between">
                  <div className="d-flex align-items-center gap-2">
                    <Badge tone="success">uploaded</Badge>
                    {shareResult.redacted ? (
                      <Badge tone="outline">redacted</Badge>
                    ) : (
                      <Badge tone="warning">not redacted</Badge>
                    )}
                    <span className="d-flex align-items-center gap-1 fs-6 text-body-secondary">
                      <Clock className="icon-sm" />
                      auto-deletes in{"                                "}
                      {Math.round(shareResult.auto_delete_seconds / 3600)}h
                    </span>
                  </div>
                  {Object.keys(shareResult.urls).length > 1 && (
                    <Button
                      size="sm"
                      ghost
                      prefix={
                        copiedLabel === "__all__" ? (
                          <Check className="icon-sm" />
                        ) : (
                          <Copy className="icon-sm" />
                        )
                      }
                      onClick={() =>
                        void copyToClipboard(
                          Object.entries(shareResult.urls)
                            .map(([label, url]) => `${label}: ${url}`)
                            .join("\n"),
                          "__all__",
                        )
                      }
                    >
                      Copy all
                    </Button>
                  )}
                </div>

                {Object.entries(shareResult.urls).map(([label, url]) => (
                  <div
                    key={label}
                    className="d-flex align-items-center gap-2 sku-backdrop border border-secondary px-3 py-2"
                  >
                    <Link2 className="icon-sm flex-shrink-0 text-body-secondary" />
                    <span className="font-monospace fs-6 flex-shrink-0 w-24 text-truncate text-body-secondary">
                      {label}
                    </span>
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-monospace fs-6 text-truncate flex-grow-1 text-primary hover:underline"
                    >
                      {url}
                    </a>
                    <Button
                      ghost
                      size="icon"
                      aria-label={`Copy ${label} link`}
                      onClick={() => void copyToClipboard(url, label)}
                    >
                      {copiedLabel === label ? <Check /> : <Copy />}
                    </Button>
                  </div>
                ))}

                {shareResult.failures.length > 0 && (
                  <span className="fs-6 text-danger">
                    Some logs failed to upload: {shareResult.failures.join("; ")}
                  </span>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ── Checkpoints ───────────────────────────────────────────── */}
      <section className="d-flex flex-column gap-3">
        <H2 variant="sm" className="d-flex align-items-center gap-2 text-body-secondary">
          <Database className="icon-md" /> Checkpoints
        </H2>
        <Card>
          <CardContent className="d-flex align-items-center justify-content-between py-4">
            <span className="fs-6 text-body-secondary">
              {checkpoints?.sessions.length ?? 0} session(s) ·{"                                "}
              {formatBytes(checkpoints?.total_bytes ?? 0)}
            </span>
            <Button size="sm" ghost className="text-danger" disabled={!checkpoints?.sessions.length} prefix={<Trash2 className="icon-sm" />} onClick={() => checkpointsPrune.requestDelete("all")}>
              Prune
            </Button>
          </CardContent>
        </Card>
      </section>

      {/* ── Shell hooks ───────────────────────────────────────────── */}
      <section className="d-flex flex-column gap-3">
        <div className="d-flex align-items-center justify-content-between">
          <H2 variant="sm" className="d-flex align-items-center gap-2 text-body-secondary">
            <Terminal className="icon-md" /> Shell hooks
          </H2>
          <Button size="sm" className="text-uppercase" prefix={<Plus className="icon-sm" />} onClick={() => setHookModalOpen(true)}>
            New hook
          </Button>
        </div>
        {(!hooks || hooks.hooks.length === 0) && (
          <Card>
            <CardContent className="py-6 text-center fs-6 text-body-secondary">
              No shell hooks configured.
            </CardContent>
          </Card>
        )}
        {hooks?.hooks.map((h: HookEntry, i) => (
          <Card key={`${h.event}-${i}`}>
            <CardContent className="d-flex align-items-center gap-3 py-3">
              <Badge tone="outline">{h.event}</Badge>
              {h.matcher && (
                <span className="fs-6 text-body-secondary">matcher: {h.matcher}</span>
              )}
              <span className="font-monospace fs-6 text-truncate flex-grow-1">{h.command}</span>
              {h.executable === false && (
                <Badge tone="destructive">not executable</Badge>
              )}
              <Badge tone={h.allowed ? "success" : "warning"}>
                {h.allowed ? "allowed" : "not approved"}
              </Badge>
              <Button
                ghost
                size="icon"
                className="text-danger"
                aria-label="Remove hook"
                onClick={() =>
                  hookDelete.requestDelete(`${h.event}|${h.command ?? ""}`)
                }
              >
                <Trash2 />
              </Button>
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
