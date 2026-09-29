import * as React from "react";

import {
  kanbanApi,
  type KanbanProfile,
  type KanbanRequestOptions,
  type KanbanTaskDetail,
} from "@/lib/kanban-api";

/**
 * The four operator actions that were previously CLI-only, put where an
 * operator can reach them.
 *
 * ## Why the buttons are conditional
 *
 * Reclaim, terminate, unblock and reassign each only mean something in a
 * particular state, and the server answers 409 when the state has moved on.
 * Rendering all four unconditionally would offer four actions, three of
 * which are wrong right now -- and an operator who learns to click a button
 * that is usually refused stops reading the responses.
 *
 * So each button appears only when it can succeed, judged from the same
 * fields the server judges it from.
 *
 * ## The reason field
 *
 * Every one of these writes to the event log, and an unexplained reclaim is
 * the kind of thing discovered three days later during an incident. The
 * reason is free text with a sensible default, not a form.
 */
export interface RecoveryPanelProps {
  task: KanbanTaskDetail;
  options: KanbanRequestOptions;
  /** Re-read the board after a successful action. */
  onChanged: () => void | Promise<void>;
  /** A 409/400 is a normal answer here, not a failure to hide behind a toast. */
  onError: (message: string) => void;
}

type Action = "reclaim" | "reassign" | "unblock" | "terminate";

const DEFAULTS: Record<Action, string> = {
  reclaim: "reclaimed from the dashboard",
  reassign: "reassigned from the dashboard",
  unblock: "unblocked from the dashboard",
  terminate: "terminated from the dashboard",
};

export function RecoveryPanel({
  task,
  options,
  onChanged,
  onError,
}: RecoveryPanelProps) {
  const [busy, setBusy] = React.useState<Action | null>(null);
  const [reason, setReason] = React.useState("");
  const [profiles, setProfiles] = React.useState<KanbanProfile[] | null>(null);
  const [profile, setProfile] = React.useState("");

  const card = task.task;

  React.useEffect(() => {
    setReason("");
    setBusy(null);
    setProfile("");
  }, [card.id]);

  // "Reclaimable" mirrors the server: an active claim, or a run that never
  // ended. A task sitting in the queue holds neither and has nothing to free.
  const liveRuns = (task.runs ?? []).filter((r) => !r.ended_at);
  // The server names these `claim_lock` / `claim_expires`. A lock that is set
  // but already past its expiry is a claim nobody is honouring -- which is
  // exactly the case reclaim exists for, so presence is the test, not
  // freshness. Freshness is the dispatcher's problem to reap, and #6 already
  // tints those cards amber.
  const hasClaim = Boolean(card.claim_lock);
  const canReclaim = hasClaim || liveRuns.length > 0;
  const canUnblock = card.status === "blocked";
  const canReassign = hasClaim || Boolean(card.assignee);

  // The roster is only fetched when a reassign is possible, so a healthy card
  // never pays for it.
  React.useEffect(() => {
    if (!canReassign || profiles !== null) return;
    let live = true;
    kanbanApi
      .listProfiles(options)
      .then((list) => {
        if (live) setProfiles(list ?? []);
      })
      .catch(() => {
        // A missing roster must not take the panel down. Reassign simply is
        // not offered, and reclaim still works.
        if (live) setProfiles([]);
      });
    return () => {
      live = false;
    };
  }, [canReassign, profiles, options]);

  const run = React.useCallback(
    async (action: Action, fn: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(action);
      try {
        await fn();
        await onChanged();
        setReason("");
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(null);
      }
    },
    [busy, onChanged, onError],
  );

  if (!canReclaim && !canUnblock && !canReassign) {
    return (
      <div className="kb-drawer-section">
        <h3 className="kb-drawer-h3">Recovery</h3>
        <p className="kb-drawer-muted">
          Nothing to recover here — this task holds no claim, has no unfinished run, and is
          not blocked.
        </p>
      </div>
    );
  }

  return (
    <div className="kb-drawer-section">
      <h3 className="kb-drawer-h3">Recovery</h3>

      <label className="kb-recovery-reason">
        <span className="kb-drawer-muted">Reason — recorded on the task</span>
        <input
          className="form-control form-control-sm"
          onChange={(e) => setReason(e.target.value)}
          placeholder={DEFAULTS.reclaim}
          type="text"
          value={reason}
        />
      </label>

      <div className="kb-recovery-actions">
        {canReclaim ? (
          <button
            className="btn btn-sm btn-outline-danger"
            disabled={busy !== null}
            onClick={() =>
              run("reclaim", () =>
                kanbanApi.reclaimTask(card.id, reason || DEFAULTS.reclaim, options),
              )
            }
            title="SIGTERM then SIGKILL the worker holding this claim, and release it without waiting for the TTL"
            type="button"
          >
            {busy === "reclaim" ? "Reclaiming…" : "Reclaim"}
          </button>
        ) : null}

        {liveRuns.map((r) => (
          <button
            className="btn btn-sm btn-outline-danger"
            disabled={busy !== null}
            key={r.id}
            onClick={() =>
              run("terminate", () =>
                kanbanApi.terminateRun(r.id, reason || DEFAULTS.terminate, options),
              )
            }
            title={`Terminate run #${r.id}`}
            type="button"
          >
            {busy === "terminate" ? "Terminating…" : `Terminate run #${r.id}`}
          </button>
        ))}

        {canUnblock ? (
          <button
            className="btn btn-sm btn-outline-secondary"
            disabled={busy !== null}
            onClick={() => run("unblock", () => kanbanApi.unblockTask(card.id, options))}
            title="Move back to To Do"
            type="button"
          >
            {busy === "unblock" ? "Unblocking…" : "Unblock"}
          </button>
        ) : null}

        {canReassign ? (
          <span className="kb-recovery-assign">
            <select
              aria-label="Reassign to profile"
              className="form-select form-select-sm"
              onChange={(e) => setProfile(e.target.value)}
              value={profile}
            >
              <option value="">Unassign</option>
              {(profiles ?? []).map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                  {p.description ? ` — ${p.description}` : ""}
                </option>
              ))}
            </select>
            <button
              className="btn btn-sm btn-outline-secondary"
              disabled={busy !== null || profiles === null}
              onClick={() =>
                run("reassign", () =>
                  kanbanApi.reassignTask(
                    card.id,
                    { profile: profile || null, reclaimFirst: true },
                    options,
                  ),
                )
              }
              title="Reassign, reclaiming a stuck worker first if this task is claimed"
              type="button"
            >
              {busy === "reassign" ? "Reassigning…" : "Reassign"}
            </button>
          </span>
        ) : null}
      </div>
    </div>
  );
}
