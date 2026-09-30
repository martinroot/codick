// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DataApiTab } from "@/components/kanban/pipeline/DataApiTab";
import { StepStripView } from "@/components/kanban/pipeline/StepStripView";
import type { StripStep } from "@/components/kanban/pipeline/strip";
import type { PipelineRun, PipelineTemplateBody } from "@/lib/pipelines-api";

// The suite's convention: `react-dom/client` plus `act`, not a testing-library
// dependency this project does not already carry.
let container: HTMLDivElement;
let root: Root;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function draw(node: React.ReactNode): void {
  act(() => root.render(<>{node}</>));
}

const step = (over: Partial<StripStep> & { id: string }): StripStep => ({
  label: over.id,
  state: "future",
  type: "agent",
  attemptNo: null,
  errorCode: null,
  awaitsInput: false,
  ...over,
});

const run = (over: Partial<PipelineRun> = {}): PipelineRun =>
  ({
    id: "run_1",
    template_id: "tpl",
    template_version: "1",
    card_id: "card_1",
    status: "running",
    current_step_id: "draft",
    step_executions: 1,
    rework_cycles: 0,
    attempts: [],
    input_requests: [],
    events: [],
    ...over,
  }) as PipelineRun;

const body: PipelineTemplateBody = { start_step: "draft", steps: [] };

const attempt = (over: Record<string, unknown>) =>
  ({
    id: "a1",
    step_id: "draft",
    attempt_no: 1,
    status: "completed",
    output: null,
    ...over,
  }) as never;

describe("StepStripView", () => {
  it("draws a row per step, not a card per step", () => {
    draw(
      <StepStripView
        steps={[
          step({ id: "draft", state: "done" }),
          step({ id: "review", state: "current", type: "user_input", awaitsInput: true }),
          step({ id: "publish", state: "future" }),
        ]}
      />
    );
    const list = container.querySelector("[aria-label='Pipeline steps']");
    expect(list).not.toBeNull();
    expect(list!.children).toHaveLength(3);
    expect(container.textContent).toContain("review");
  });

  it("marks a stale review as out of date rather than as approved", () => {
    // A stale review drawn as done is the failure this exists to prevent: an
    // operator who trusts the row approves work nobody checked.
    draw(<StepStripView steps={[step({ id: "review", state: "stale", type: "user_input" })]} />);
    const row = container.querySelector("[title*='out of date']") as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.className).toContain("text-warning");
    expect(row.className).not.toContain("text-success");
  });

  it("shows the attempt number, so a rework loop is visible", () => {
    draw(<StepStripView steps={[step({ id: "draft", state: "current", attemptNo: 2 })]} />);
    expect(container.textContent).toContain("×2");
  });

  it("says so when the template declares no steps", () => {
    draw(<StepStripView steps={[]} />);
    expect(container.textContent).toMatch(/no steps/i);
  });
});

describe("DataApiTab", () => {
  it("shows the spec's fields, each with a copy control", () => {
    draw(
      <DataApiTab
        run={run({
          input_requests: [
            {
              id: "req_1",
              step_id: "ask",
              status: "open",
              prompt: "ok?",
              response_schema: { type: "object" },
            },
          ] as never,
        })}
        template={{ ...body, example_response: { approved: true } }}
        validationErrors={[]}
      />
    );
    for (const label of [
      "run_id",
      "step_id",
      "request_id",
      "response_schema",
      "example_response",
      "collected_data",
      "validation_errors",
    ]) {
      expect(container.textContent, label).toContain(label);
    }
    // One copy control per shown field — all seven, including the empty
    // validation_errors list, so a field never appears without a way to take it.
    expect(container.querySelectorAll("button").length).toBe(7);
    expect(container.querySelector("[aria-label='Copy run_id']")).not.toBeNull();
  });

  it("withholds a disclosure, names the path, and still renders the rest", () => {
    draw(
      <DataApiTab
        run={run({ attempts: [attempt({ output: { source: "/home/alice/x.md" } })] })}
        template={body}
        validationErrors={[]}
      />
    );
    expect(container.textContent).toContain("Withheld from this tab");
    expect(container.textContent).toContain("collected_data.draft.source");
    // Refusing one field must not blank the tab: the alternative is a stray path
    // hiding the whole run, and the "fix" being to loosen the check.
    expect(container.textContent).toContain("run_id");
  });

  it("never prints the value it refused", () => {
    draw(
      <DataApiTab
        run={run({ attempts: [attempt({ output: { source: "/home/alice/secret.md" } })] })}
        template={body}
        validationErrors={[]}
      />
    );
    expect(container.textContent).not.toContain("/home/alice/secret.md");
  });

  it("assembles collected data from the attempts' outputs, keyed by step", () => {
    draw(
      <DataApiTab
        run={run({
          attempts: [
            attempt({ step_id: "draft", output: { text: "hi" } }),
            attempt({ step_id: "publish", output: { url: "u" } }),
          ],
        })}
        template={body}
        validationErrors={[]}
      />
    );
    expect(container.textContent).toContain('"draft"');
    expect(container.textContent).toContain('"publish"');
  });

  it("says so when there is no run", () => {
    draw(<DataApiTab run={null} template={null} validationErrors={[]} />);
    expect(container.textContent).toMatch(/No run selected/);
  });
});
