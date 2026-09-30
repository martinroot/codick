import * as React from "react";

/**
 * The trash target.
 *
 * ## Why this is a button and not only a `drop` handler
 *
 * The reference plugin solved this with a floating pointer proxy: a
 * `pointermove`/`pointerup` pair that follows the finger, because HTML5 drag
 * and drop does not fire on a touchscreen at all. That is the right diagnosis
 * and the wrong place to put the only copy of a capability — a `dragover`
 * handler is a mouse affordance wearing a costume, and on a touch device it is
 * simply an element that never reacts.
 *
 * So this is a real `<button>`, which means it is reachable by Tab, by Enter
 * and Space, and by a finger, and it acts on the current selection when there
 * is one. The HTML5 `drop` handler is an addition on top of a control that
 * already works, not the control itself.
 *
 * ## It never deletes anything itself
 *
 * `onRequest` hands ids to the page, which puts them through the same confirm
 * as the drawer and the action bar. A drop zone that deletes on contact would
 * be the only irreversible action on this board with no confirmation at all,
 * and the fastest one to hit by accident — the pointer is already near the edge
 * of the board, which is exactly where this lives.
 */
export interface TrashZoneProps {
  /** Ids this would destroy right now: the dragged card, else the selection. */
  count: number;
  /** True while a card is being dragged, which is when the zone expands. */
  dragging: boolean;
  disabled?: boolean;
  onRequest: (taskIds: string[]) => void;
}

export function TrashZone({ count, dragging, disabled, onRequest }: TrashZoneProps) {
  const [over, setOver] = React.useState(false);
  // A drop that ends over the zone must not also end over whatever is beneath
  // it, and the browser will happily do both.
  const armed = !disabled && count > 0;

  return (
    <div
      className={[
        "kb-trash",
        dragging ? "kb-trash-open" : "",
        over ? "kb-trash-over" : "",
        armed ? "kb-trash-armed" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onDragEnter={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={(event) => {
        // Ignore the leave events fired for child nodes; only leaving the zone
        // itself should stand it down.
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setOver(false);
      }}
      onDragOver={(event) => {
        if (!armed) return;
        // Without preventDefault the drop never fires at all.
        event.preventDefault();
        // The DOM only allows four effects and "delete" is not one of them.
        // "move" is the honest signal: the card is leaving the board, and it
        // is what the cursor shows on every platform that honours it.
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        if (!armed) return;
        event.preventDefault();
        event.stopPropagation();
        const id = event.dataTransfer.getData("text/plain");
        setOver(false);
        onRequest(id ? [id] : []);
      }}
    >
      <button
        aria-label={
          armed
            ? `Delete ${count} selected card${count === 1 ? "" : "s"}`
            : "Select a card to delete it"
        }
        className="kb-trash-button"
        disabled={!armed}
        onClick={() => armed && onRequest([])}
        title={
          armed
            ? "Delete the selected cards"
            : "Select a card, or drag one here, to delete it"
        }
        type="button"
      >
        <span aria-hidden="true" className="kb-trash-glyph">
          ⌫
        </span>
        <span className="kb-trash-label">
          {armed
            ? `Delete ${count} card${count === 1 ? "" : "s"}`
            : dragging
              ? "Drop here to delete"
              : "Delete"}
        </span>
      </button>
    </div>
  );
}
