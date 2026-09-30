/** What the step strip renders, derived from a run snapshot.
 *
 * ## Why this is a pure function and not a component
 *
 * The strip's whole job is a judgement, and the judgement is subtle in exactly
 * one place — a review that a rework has made stale. Rendering and deciding in
 * one component would put that decision where no test can reach it, and it is
 * the one thing acceptance check 10 is about: **a stale review that looks
 * current is worse than no review**, because a human who trusts it approves work
 * nobody re-checked.
 *
 * So the derivation is here, pure, and tested on its own.
 *
 * ## Staleness
 *
 * A step is stale when it *was* completed, and a rework has happened since —
 * the run's `rework_cycles` is higher than the cycle the step completed in. The
 * completion is real and stays readable; it just no longer vouches for the work
 * that followed it. Nothing is deleted and no history is rewritten: the spec
 * says the earlier review is *marked* stale, and the full history belongs in the
 * log.
 */

import type {
  PipelineRun,
  PipelineStepAttempt,
  PipelineStepTemplate,
  PipelineTemplateBody,
} from "@/lib/pipelines-api";

export type StripStepState = "done" | "stale" | "current" | "future" | "failed" | "skipped";

export interface StripStep {
  id: string;
  label: string;
  state: StripStepState;
  /** The step's own `type`, so the row can show a transition icon for a condition. */
  type: PipelineStepTemplate["type"];
  attemptNo: number | null;
  errorCode: string | null;
  /** True when this step is waiting on a person. */
  awaitsInput: boolean;
}

/** The run's card badge, using the spec §9 mapping verbatim. */
export function cardLabelForRun(
  status: PipelineRun["status"],
  options: { onReview?: boolean } = {}
): string {
  if (status === "running" && options.onReview) return "Review";
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "waiting_input":
      return "Waiting for input";
    case "blocked":
    case "failed":
      return "Blocked";
    case "completed":
      return "Done";
    case "cancelled":
      return "Cancelled";
  }
}

/** A `user_input` step that completed is a review, not a question. */
function isReview(step: PipelineStepTemplate): boolean {
  return step.type === "user_input";
}

function latestAttempt(attempts: PipelineStepAttempt[], stepId: string) {
  let best: PipelineStepAttempt | null = null;
  for (const attempt of attempts) {
    if (attempt.step_id !== stepId) continue;
    if (!best || attempt.attempt_no > best.attempt_no) best = attempt;
  }
  return best;
}

/**
 * The strip, in template order.
 *
 * A step is `current` when the run names it, which is the backend's answer and
 * not something re-derived here — the executor owns routing, and a second guess
 * at "where are we" is a second thing to be wrong.
 */
export function buildStepStrip(
  template: Pick<PipelineTemplateBody, "steps" | "start_step">,
  run: Pick<
    PipelineRun,
    "status" | "current_step_id" | "attempts" | "rework_cycles" | "input_requests"
  >
): StripStep[] {
  const openRequestSteps = new Set(
    run.input_requests.filter((r) => r.status === "open").map((r) => r.step_id)
  );

  return template.steps.map((step) => {
    const attempt = latestAttempt(run.attempts, step.id);
    const isCurrent = run.current_step_id === step.id;
    const attemptNo = attempt?.attempt_no ?? null;
    const errorCode = attempt?.error_code ?? attempt?.error ?? null;

    let state: StripStepState;
    if (attempt?.status === "failed" || attempt?.status === "unknown") {
      state = "failed";
    } else if (isCurrent) {
      state = "current";
    } else if (attempt?.status === "completed") {
      // Completed, and the run has been back to an edit step since. The
      // completion is kept — it is history — but it no longer speaks for the
      // work that followed.
      state = isReview(step) && run.rework_cycles > 0 ? "stale" : "done";
    } else if (!attempt && run.status === "queued" && step.id === template.start_step) {
      // `start_step` is optional in the body. A template that declares none gets
      // no current step here — guessing the first one would be inventing a
      // position the executor never reported.
      state = "current";
    } else {
      state = "future";
    }

    return {
      id: step.id,
      label: step.type === "condition" ? `${step.id} (transition)` : step.id,
      state,
      type: step.type,
      attemptNo,
      errorCode: state === "failed" ? errorCode : null,
      awaitsInput: openRequestSteps.has(step.id) || (isCurrent && run.status === "waiting_input"),
    };
  });
}

/**
 * Is the run sitting on a review?
 *
 * `running` covers both an agent step and a review step, so this is only
 * answerable from the current step's type — which is why `cardLabelForRun` takes
 * it as data rather than deriving it.
 */
export function isOnReview(
  template: Pick<PipelineTemplateBody, "steps" | "start_step">,
  run: Pick<PipelineRun, "status" | "current_step_id">
): boolean {
  if (run.status !== "running" || !run.current_step_id) return false;
  const step = template.steps.find((s) => s.id === run.current_step_id);
  return Boolean(step && isReview(step));
}

/** The `user_input` request the user has to answer, if any. */
export function openInputRequest(run: Pick<PipelineRun, "input_requests" | "current_step_id">) {
  return (
    run.input_requests.find(
      (r) => r.status === "open" && r.step_id === run.current_step_id
    ) ?? run.input_requests.find((r) => r.status === "open") ?? null
  );
}
