import type { StripStep } from "@/components/kanban/pipeline/strip";

/** Bootstrap 5 markup for the strip's states. Icons come from bootstrap-icons. */
const STATE_CLASS: Record<StripStep["state"], string> = {
  done: "text-success",
  stale: "text-warning",
  current: "text-primary",
  future: "text-body-secondary",
  failed: "text-danger",
  skipped: "text-body-tertiary",
};

const STATE_ICON: Record<StripStep["state"], string> = {
  done: "bi-check-circle-fill",
  stale: "bi-exclamation-triangle-fill",
  current: "bi-play-circle-fill",
  future: "bi-circle",
  failed: "bi-x-circle-fill",
  skipped: "bi-dash-circle",
};

const STATE_TITLE: Record<StripStep["state"], string> = {
  done: "Done",
  stale: "Review passed, then rework sent it back — this approval is out of date",
  current: "Running now",
  future: "Not started",
  failed: "Failed",
  skipped: "Skipped",
};

/** A `condition` step is a fork, not a unit of work — say so on the row. */
const TYPE_ICON: Record<StripStep["type"], string | null> = {
  agent: null,
  tool: "bi-tools",
  user_input: "bi-chat-left-text",
  condition: "bi-signpost-split",
  // A delay does work of a sort -- it just consumes no model and no tool -- so
  // it belongs on the strip, not silently dropped from it.
  delay: "bi-hourglass-split",
};

export interface StepStripViewProps {
  steps: StripStep[];
}

/**
 * The step strip (spec §9): a compact row of steps, never a card per step.
 *
 * The judgement about what each step *is* lives in `buildStepStrip` and is tested
 * there; this file only draws what it was told. That split is the point — the
 * stale-review rule is the part worth testing, and it is unreachable from inside
 * a component that also renders.
 *
 * Stale is `text-warning` and never `text-success`: a review that has been sent
 * back looks approved to anyone who has not read this file, and an operator who
 * trusts it approves work nobody checked.
 */
export function StepStripView({ steps }: StepStripViewProps) {
  if (steps.length === 0) {
    return <p className="text-body-secondary small mb-0">This template declares no steps.</p>;
  }
  return (
    <ol
      className="list-unstyled d-flex flex-wrap align-items-center gap-2 mb-0"
      aria-label="Pipeline steps"
    >
      {steps.map((step, index) => (
        <li key={step.id} className="d-flex align-items-center gap-2">
          {index > 0 && (
            <span className="bi bi-chevron-right text-body-tertiary small" aria-hidden="true" />
          )}
          <span
            className={`d-inline-flex align-items-center gap-1 small ${STATE_CLASS[step.state]}`}
            title={STATE_TITLE[step.state]}
          >
            <i className={`bi ${STATE_ICON[step.state]}`} aria-hidden="true" />
            <span className="text-body">{step.label}</span>
            {step.attemptNo !== null && step.attemptNo > 1 && (
              // A second attempt is the visible trace of a rework loop.
              <span className="badge text-bg-light border">×{step.attemptNo}</span>
            )}
            {step.awaitsInput && (
              <i className="bi bi-hourglass-split" title="Waiting for input" aria-label="Waiting for input" />
            )}
            {step.errorCode && (
              <span className="badge text-bg-danger">{step.errorCode}</span>
            )}
            {TYPE_ICON[step.type] && (
              <i className={`bi ${TYPE_ICON[step.type]} text-body-tertiary`} aria-label={step.type} />
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
