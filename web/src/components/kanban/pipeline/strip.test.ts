import { describe, expect, it } from "vitest";

import type { PipelineRun, PipelineStepTemplate } from "@/lib/pipelines-api";
import {
  buildStepStrip,
  cardLabelForRun,
  isOnReview,
  openInputRequest,
} from "@/components/kanban/pipeline/strip";

const TEMPLATE: { steps: PipelineStepTemplate[]; start_step: string } = {
  start_step: "draft",
  steps: [
    { id: "draft", type: "agent", next: "review" },
    { id: "review", type: "user_input", prompt: "Approve?", next: "publish" },
    { id: "publish", type: "tool", next: null },
  ],
};

function run(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: "run_1",
    template_id: "t",
    template_version: "1.0.0",
    card_id: "t_1",
    status: "queued",
    current_step_id: null,
    step_executions: 0,
    rework_cycles: 0,
    attempts: [],
    input_requests: [],
    events: [],
    ...overrides,
  } as PipelineRun;
}

const completed = (step_id: string, attempt_no = 1) => ({
  id: `att_${step_id}_${attempt_no}`,
  step_id,
  attempt_no,
  status: "completed" as const,
});

describe("cardLabelForRun", () => {
  it("uses the spec §9 mapping", () => {
    expect(cardLabelForRun("queued")).toBe("Queued");
    expect(cardLabelForRun("running")).toBe("Running");
    expect(cardLabelForRun("running", { onReview: true })).toBe("Review");
    expect(cardLabelForRun("waiting_input")).toBe("Waiting for input");
    expect(cardLabelForRun("blocked")).toBe("Blocked");
    expect(cardLabelForRun("failed")).toBe("Blocked");
    expect(cardLabelForRun("completed")).toBe("Done");
    expect(cardLabelForRun("cancelled")).toBe("Cancelled");
  });
});

describe("buildStepStrip", () => {
  it("marks the start step current before anything has run", () => {
    const strip = buildStepStrip(TEMPLATE, run());
    expect(strip[0].state).toBe("current");
    expect(strip[1].state).toBe("future");
    expect(strip[2].state).toBe("future");
  });

  it("collapses a completed step to done and leaves the current one open", () => {
    const strip = buildStepStrip(
      TEMPLATE,
      run({
        status: "running",
        current_step_id: "review",
        attempts: [completed("draft")],
      })
    );
    expect(strip[0].state).toBe("done");
    expect(strip[1].state).toBe("current");
  });

  // Acceptance check 10. A stale review that looks current is worse than no
  // review: a human who trusts it approves work nobody re-checked.
  it("marks an earlier review stale after a rework, and keeps it visible", () => {
    const beforeRework = buildStepStrip(
      TEMPLATE,
      run({
        status: "running",
        current_step_id: "publish",
        attempts: [completed("draft"), completed("review")],
      })
    );
    expect(beforeRework[1].state).toBe("done");

    const afterRework = buildStepStrip(
      TEMPLATE,
      run({
        status: "running",
        current_step_id: "draft",
        rework_cycles: 1,
        attempts: [
          completed("draft"),
          completed("review"),
          // The rework attempt is in flight: the edit step is active, so its
          // latest attempt is running rather than finished.
          { id: "att_draft_2", step_id: "draft", attempt_no: 2, status: "running" as const },
        ],
      })
    );
    // The review is still there and still readable — marked, not deleted.
    expect(afterRework[1]).toBeDefined();
    expect(afterRework[1].state).toBe("stale");
    // The edit step it went back to is the open one.
    expect(afterRework[0].state).toBe("current");
    expect(afterRework[0].attemptNo).toBe(2);
    // And a completed *agent* step is not a review, so it is not marked stale:
    // here that is the review-adjacent draft from the first cycle, so the check
    // is made directly against a non-review completed step instead.
    const agentDone = buildStepStrip(
      TEMPLATE,
      run({
        status: "running",
        current_step_id: "publish",
        rework_cycles: 1,
        attempts: [completed("draft"), completed("review"), completed("publish")],
      })
    );
    expect(agentDone[0].state).toBe("done");
  });

  it("does not call a user_input step stale when no rework happened", () => {
    const strip = buildStepStrip(
      TEMPLATE,
      run({
        status: "completed",
        current_step_id: null,
        attempts: [completed("draft"), completed("review"), completed("publish")],
      })
    );
    expect(strip.map((s) => s.state)).toEqual(["done", "done", "done"]);
  });

  it("shows a failed step as failed and carries its error code", () => {
    const strip = buildStepStrip(
      TEMPLATE,
      run({
        status: "blocked",
        current_step_id: "publish",
        attempts: [
          completed("draft"),
          completed("review"),
          { id: "a3", step_id: "publish", attempt_no: 1, status: "failed", error_code: "tool_error" },
        ],
      })
    );
    expect(strip[2].state).toBe("failed");
    expect(strip[2].errorCode).toBe("tool_error");
  });

  it("marks the waiting step as expecting input", () => {
    const strip = buildStepStrip(
      TEMPLATE,
      run({
        status: "waiting_input",
        current_step_id: "review",
        attempts: [completed("draft")],
        input_requests: [
          {
            id: "req_1",
            step_id: "review",
            status: "open",
            prompt: "Approve?",
          } as PipelineRun["input_requests"][number],
        ],
      })
    );
    expect(strip[1].awaitsInput).toBe(true);
    expect(strip[0].awaitsInput).toBe(false);
  });

  it("labels a condition step as a transition", () => {
    const withCondition = {
      start_step: "draft",
      steps: [
        { id: "draft", type: "agent" as const, next: "route" },
        { id: "route", type: "condition" as const, next: "publish" },
        { id: "publish", type: "tool" as const, next: null },
      ],
    };
    const strip = buildStepStrip(withCondition, run());
    expect(strip[1].label).toContain("transition");
  });
});

describe("isOnReview", () => {
  it("is true only while a user_input step is the current one", () => {
    expect(
      isOnReview(TEMPLATE, run({ status: "running", current_step_id: "review" }))
    ).toBe(true);
    expect(
      isOnReview(TEMPLATE, run({ status: "running", current_step_id: "draft" }))
    ).toBe(false);
    // Waiting on that same step is "Waiting for input", not "Review".
    expect(
      isOnReview(TEMPLATE, run({ status: "waiting_input", current_step_id: "review" }))
    ).toBe(false);
  });
});

describe("openInputRequest", () => {
  it("prefers the current step's request and falls back to any open one", () => {
    const current = {
      id: "req_2",
      step_id: "review",
      status: "open" as const,
      prompt: "Approve?",
    } as PipelineRun["input_requests"][number];
    const older = {
      id: "req_1",
      step_id: "draft",
      status: "open" as const,
      prompt: "Old",
    } as PipelineRun["input_requests"][number];
    expect(
      openInputRequest({ input_requests: [older, current], current_step_id: "review" })?.id
    ).toBe("req_2");
    expect(
      openInputRequest({ input_requests: [older], current_step_id: "publish" })?.id
    ).toBe("req_1");
    expect(openInputRequest({ input_requests: [], current_step_id: null })).toBeNull();
  });
});
