import * as React from "react";

/**
 * Which cards are selected, and how the mouse extends that.
 *
 * Selection lives here rather than in the board because the board owns
 * layout and the page owns what is true; the action bar and the cards have to
 * agree about the same set, and one owner is cheaper than reconciling two.
 *
 * ## The anchor is an index, not an id
 *
 * Shift-click means "from where I last clicked to here", which needs a
 * remembered position. It is stored as an **index into reading order** — the
 * flat list of ids, column by column, top to bottom.
 *
 * An id would be the obvious choice and the wrong one: the moment a card is
 * dragged, or deleted, or arrives from the live-update stream, an id-based
 * range silently changes shape. The user asked for "the cards between these
 * two", and a range is a span of positions. That is also why the index is
 * taken from the order the *page* just rendered rather than recomputed here —
 * the two have to be the same list, or the range is off by a column.
 */
export interface UseCardSelection {
  selected: ReadonlySet<string>;
  /** True when at least one card is selected, for the action bar. */
  any: boolean;
  /** Index into reading order of the last card clicked, or null. */
  anchor: number | null;
  setSelected: (ids: Iterable<string>) => void;
  toggle: (id: string, index: number) => void;
  /**
   * Select everything between the anchor and `index`. A no-op with no anchor,
   * because a shift-click with nothing anchored has no meaning — selecting one
   * card there would look like it had worked.
   */
  extendTo: (order: readonly string[], index: number) => void;
  clear: () => void;
}

/** Cards in the order a person reads the board: column by column, top to bottom. */
export function readingOrder(
  columns: readonly { name: string; tasks: readonly { id: string }[] }[],
): string[] {
  return columns.flatMap((column) => column.tasks.map((task) => task.id));
}

export function useCardSelection(): UseCardSelection {
  const [selected, setSelectedState] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [anchor, setAnchor] = React.useState<number | null>(null);

  const setSelected = React.useCallback((ids: Iterable<string>) => {
    setSelectedState(new Set(ids));
  }, []);

  const clear = React.useCallback(() => {
    setSelectedState(new Set());
    setAnchor(null);
  }, []);

  const toggle = React.useCallback((id: string, index: number) => {
    setSelectedState((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // The anchor moves to the card just clicked, so a following shift-click
    // extends from *this* one rather than from where the selection began.
    setAnchor(index);
  }, []);

  const extendTo = React.useCallback(
    (order: readonly string[], index: number) => {
      setSelectedState((prev) => {
        if (anchor === null) return prev;
        // Out of range means the board changed under us; a half-correct range
        // is worse than none, so leave the selection alone.
        if (anchor >= order.length || index >= order.length) return prev;
        const lo = Math.min(anchor, index);
        const hi = Math.max(anchor, index);
        const next = new Set(prev);
        for (let i = lo; i <= hi; i += 1) next.add(order[i]);
        return next;
      });
    },
    [anchor],
  );

  return {
    selected,
    any: selected.size > 0,
    anchor,
    setSelected,
    toggle,
    extendTo,
    clear,
  };
}
