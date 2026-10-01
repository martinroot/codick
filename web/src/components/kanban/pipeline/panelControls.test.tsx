// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PipelinePanel } from "@/components/kanban/pipeline/PipelinePanel";
import { pipelinesApi } from "@/lib/pipelines-api";
import type { PipelineRun, PipelineTemplate } from "@/lib/pipelines-api";

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
  vi.restoreAllMocks();
});

function draw(node: React.ReactNode): void {
  act(() => root.render(<>{node}</>));
}

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

const template = (over: Partial<PipelineTemplate> = {}): PipelineTemplate =>
  ({
    id: "tpl",
    name: "Weekly report",
    version: "1.0.0",
    readiness: "ready",
    steps: [{ id: "draft", type: "agent", title: "Draft" }],
    ...over,
  }) as PipelineTemplate;

function button(label: string): HTMLButtonElement | null {
  const found = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  return found ?? null;
}

/** Mount the panel with the API stubbed and settled. */
async function mountPanel(over: Partial<PipelineRun> = {}): Promise<void> {
  const current = run(over);
  vi.spyOn(pipelinesApi, "listTemplates").mockResolvedValue({ templates: [template()] } as never);
  vi.spyOn(pipelinesApi, "getRunByCard").mockResolvedValue(current);
  await act(async () => {
    draw(
      <PipelinePanel
        selectedCardId="card_1"
        onRunCreated={() => {}}
        onError={() => {}}
      />,
    );
  });
}

describe("PipelinePanel Stop and Retry", () => {
  it("offers Stop while the run is moving", async () => {
    await mountPanel({ status: "running" });
    expect(button("Stop")).not.toBeNull();
    expect(button("Retry step")).toBeNull();
  });

  it("offers Stop while a question is open, because a stop still works there", async () => {
    await mountPanel({ status: "waiting_input" });
    expect(button("Stop")).not.toBeNull();
  });

  it("offers Retry only for a failed run", async () => {
    await mountPanel({ status: "failed" });
    expect(button("Retry step")).not.toBeNull();
  });

  // A stop button on a blocked run would always 409, and a retry button on one
  // would be a way to blind-repeat an external side effect the runtime cannot
  // establish. Neither is offered, rather than offered and refused.
  it("offers neither Stop nor Retry for a blocked run", async () => {
    await mountPanel({ status: "blocked" });
    expect(button("Stop")).toBeNull();
    expect(button("Retry step")).toBeNull();
  });

  it("offers neither once the run has finished", async () => {
    await mountPanel({ status: "completed" });
    expect(button("Stop")).toBeNull();
    expect(button("Retry step")).toBeNull();
  });

  it("shows what the server decided, not what the click implied", async () => {
    const current = run({ status: "running" });
    const stop = vi.spyOn(pipelinesApi, "stopRun").mockResolvedValue(
      run({ status: "cancelled" }) as PipelineRun,
    );
    vi.spyOn(pipelinesApi, "listTemplates").mockResolvedValue({ templates: [template()] } as never);
    vi.spyOn(pipelinesApi, "getRunByCard").mockResolvedValue(current);
    await act(async () => {
      draw(
        <PipelinePanel
          selectedCardId="card_1"
          onRunCreated={() => {}}
          onError={() => {}}
        />,
      );
    });

    const target = button("Stop");
    expect(target).not.toBeNull();
    await act(async () => {
      target!.click();
    });

    expect(stop).toHaveBeenCalledWith("run_1");
    // The button is gone because the run is cancelled, which is the server's
    // answer — not because the click set a local flag.
    expect(button("Stop")).toBeNull();
  });

  it("re-reads the run when the server refuses the action", async () => {
    const errors: string[] = [];
    const current = run({ status: "running" });
    vi.spyOn(pipelinesApi, "stopRun").mockRejectedValue(new Error("409 run has already finished"));
    const getRun = vi.spyOn(pipelinesApi, "getRun").mockResolvedValue(
      run({ status: "completed" }) as PipelineRun,
    );
    vi.spyOn(pipelinesApi, "listTemplates").mockResolvedValue({ templates: [template()] } as never);
    vi.spyOn(pipelinesApi, "getRunByCard").mockResolvedValue(current);
    await act(async () => {
      draw(
        <PipelinePanel
          selectedCardId="card_1"
          onRunCreated={() => {}}
          onError={(message: string) => errors.push(message)}
        />,
      );
    });

    await act(async () => {
      button("Stop")!.click();
    });

    expect(errors.join(" ")).toContain("Could not stop the run");
    // A refusal must not leave the panel showing a state it invented.
    expect(getRun).toHaveBeenCalledWith("run_1");
    expect(button("Stop")).toBeNull();
  });
});
