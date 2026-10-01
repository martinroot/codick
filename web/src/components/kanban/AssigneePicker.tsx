import * as React from "react";

import { api, type ProfileInfo } from "@/lib/api";
import { kanbanApi, type KanbanRequestOptions } from "@/lib/kanban-api";

/**
 * Who is on this card.
 *
 * The drawer used to print the assignee as `@w` and stop there. The board's
 * diagnostics, meanwhile, told the reader to "reassign to a real profile" —
 * and offered no way to do it. That is the whole reason this component
 * exists: the sentence is only actionable if the card can act on it.
 *
 * The list is the *real* profile list from `/api/profiles`. It is not a free
 * text field, because a free text field is how `'w'` arrived — it accepts
 * anything and the dispatcher will never spawn a worker for any of it.
 *
 * Two truths are kept visible at once, and neither is silently resolved:
 *
 * - An assignee that is not in the list is kept as the selected value and
 *   marked, instead of being snapped to `default`. Quietly rewriting somebody
 *   else's card would be worse than showing that it is wrong.
 * - The save is refused in the client while it is in flight, and the row that
 *   comes back is the server's. A local optimistic guess about who owns a card
 *   is exactly the kind of lie this board has been removing.
 */
export interface AssigneePickerProps {
  taskId: string;
  assignee: string | null;
  options: KanbanRequestOptions;
  /** Called after a successful save so the board can re-read server state. */
  onSaved?: () => void;
}

export function AssigneePicker({
  taskId,
  assignee,
  options,
  onSaved,
}: AssigneePickerProps) {
  const [profiles, setProfiles] = React.useState<ProfileInfo[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [value, setValue] = React.useState<string>(assignee ?? "");

  // The card behind the drawer can be replaced by a re-read; keep the control
  // showing what the server last said rather than a stale local choice.
  React.useEffect(() => {
    setValue(assignee ?? "");
  }, [taskId, assignee]);

  React.useEffect(() => {
    let live = true;
    api
      .getProfiles()
      .then((payload) => {
        if (live) setProfiles(payload.profiles ?? []);
      })
      .catch((err: unknown) => {
        if (live) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      live = false;
    };
  }, []);

  const known = React.useMemo(
    () => (profiles ?? []).map((p) => p.name),
    [profiles],
  );
  const isOrphan = Boolean(value) && profiles !== null && !known.includes(value);

  const save = async (next: string) => {
    const previous = value;
    setValue(next);
    setSaving(true);
    setSaveError(null);
    try {
      await kanbanApi.patchTask(
        taskId,
        { assignee: next || null },
        options,
      );
      onSaved?.();
    } catch (err) {
      // Put the old value back. Leaving the control showing a write that never
      // happened is the failure mode that makes a board untrustworthy.
      setValue(previous);
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="kb-assignee-picker">
      {profiles === null && !loadError ? (
        <span className="text-body-secondary small">Loading profiles…</span>
      ) : (
        <select
          className="form-select form-select-sm"
          aria-label="Assignee"
          value={value}
          disabled={saving || loadError !== null}
          onChange={(e) => {
            void save(e.target.value);
          }}
        >
          <option value="">— unassigned —</option>
          {isOrphan ? (
            // Kept selectable and marked: the card really does say this, and
            // hiding it would make the picker disagree with the board.
            <option value={value}>
              {value} (not a Hermes profile)
            </option>
          ) : null}
          {(profiles ?? []).map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
              {p.is_default ? " (default)" : ""}
            </option>
          ))}
        </select>
      )}

      {isOrphan ? (
        <p className="kb-assignee-warning small mb-0">
          <code>{value}</code> is not a Hermes profile, so no worker will ever
          be spawned for it. Pick a real profile, or{" "}
          <a href="/profiles/new">create one</a>.
        </p>
      ) : null}

      {saving ? <span className="small text-body-secondary">Saving…</span> : null}

      {loadError ? (
        <p className="kb-assignee-warning small mb-0">
          Could not load the profile list: {loadError}
        </p>
      ) : null}
      {saveError ? (
        <p className="kb-assignee-warning small mb-0">
          Not saved: {saveError}
        </p>
      ) : null}
    </div>
  );
}