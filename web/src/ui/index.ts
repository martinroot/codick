/**
 * Barrel for the dashboard's Bootstrap-backed component surface.
 *
 * Import from `@/ui` rather than reaching into `@/ui/primitives` — the
 * split exists so the heavier feature surfaces (kanban board, toasts,
 * dialogs) can land as their own modules without this file becoming the
 * god-export it replaces.
 */

export * from "./primitives";
export * from "./dialog";
export * from "./use-toast";
