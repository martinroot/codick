import { describe, expect, it } from "vitest";

import type { PipelineStepTemplate } from "@/lib/pipelines-api";
import { buildPipelineGraph, describeWhen, stepSummary } from "@/components/kanban/pipeline/pipelineGraph";

/**
 * The array a template stores is not the shape a run takes: a condition jumps
 * backwards, a loop returns to an earlier step, and a step nobody reaches still
 * sits in the array. A diagram drawn in declaration order would draw a process
 * the run does not follow, so these pin the order that comes from the
 * transitions.
 */

const linear: PipelineStepTemplate[] = [
  { id: "read", type: "delay", seconds: 3, next: "draft" },
  { id: "draft", type: "agent", instruction: "draw the screens", next: "check" },
  { id: "check", type: "condition", next: null, cases: [] },
];

describe("buildPipelineGraph", () => {
  it("follows the transitions rather than the array order", () => {
    const graph = buildPipelineGraph(linear, "read");
    expect(graph.nodes.map((n) => n.step.id)).toEqual(["read", "draft", "check"]);
    expect(graph.nodes[0].isStart).toBe(true);
  });

  it("marks the step that finishes the run", () => {
    const graph = buildPipelineGraph(linear, "read");
    expect(graph.nodes.find((n) => n.step.id === "check")?.isEnd).toBe(true);
    expect(graph.nodes.find((n) => n.step.id === "draft")?.isEnd).toBe(false);
  });

  it("orders a backwards branch the way it runs, not the way it is written", () => {
    const steps: PipelineStepTemplate[] = [
      { id: "score", type: "condition", cases: [{ when: { op: "lt", left: "score", right: 8 }, next: "revise" }], default: { next: "ship" } },
      { id: "revise", type: "agent", instruction: "make it better", next: "score" },
      { id: "ship", type: "agent", instruction: "done", next: null },
    ];
    const graph = buildPipelineGraph(steps, "score");
    expect(graph.nodes.map((n) => n.step.id)).toEqual(["score", "revise", "ship"]);
    // The loop is the backward edge, so it belongs to the step that jumps
    // back -- revise returns to score, and score goes forward to it.
    expect(graph.nodes.find((n) => n.step.id === "revise")?.loopsFrom).toEqual(["score"]);
    expect(graph.nodes.find((n) => n.step.id === "score")?.loopsFrom).toEqual([]);
    expect(graph.edges.some((e) => e.kind === "case" && e.to === "revise")).toBe(true);
    expect(graph.edges.some((e) => e.kind === "default" && e.to === "ship")).toBe(true);
  });

  it("flags a step no branch can reach instead of silently drawing it in line", () => {
    const steps: PipelineStepTemplate[] = [
      { id: "a", type: "agent", next: null },
      { id: "orphan", type: "agent", next: null },
    ];
    const graph = buildPipelineGraph(steps, "a");
    const orphan = graph.nodes.find((n) => n.step.id === "orphan");
    expect(orphan?.unreachable).toBe(true);
    expect(graph.nodes.find((n) => n.step.id === "a")?.unreachable).toBe(false);
  });

  it("does not hang on a cycle and still visits every step once", () => {
    const steps: PipelineStepTemplate[] = [
      { id: "a", type: "condition", cases: [{ when: { op: "exists", left: "x" }, next: "a" }], default: { next: null } },
    ];
    const graph = buildPipelineGraph(steps, "a");
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].isEnd).toBe(true);
  });

  it("reports a transition naming a step the template does not contain", () => {
    const steps: PipelineStepTemplate[] = [{ id: "a", type: "agent", next: "ghost" }];
    expect(buildPipelineGraph(steps, "a").danglingTargets).toEqual(["ghost"]);
  });

  it("starts at the first step when start_step names nothing", () => {
    expect(buildPipelineGraph(linear, "ghost").nodes[0].step.id).toBe("read");
  });
});

describe("describeWhen", () => {
  it("names the comparison it is guarding", () => {
    expect(describeWhen({ op: "gte", left: "steps.score.output", right: 8 })).toBe(
      "steps.score.output gte 8",
    );
    expect(describeWhen({ op: "exists", left: "steps.doc.output.artifact" })).toBe(
      "steps.doc.output.artifact exists",
    );
  });

  it("reads a compound guard as one line", () => {
    const label = describeWhen({
      op: "all",
      conditions: [
        { op: "exists", left: "a" },
        { op: "lt", left: "b", right: 3 },
      ],
    });
    expect(label).toContain("and");
    expect(label.length).toBeLessThanOrEqual(60);
  });
});

describe("stepSummary", () => {
  it("says what the block is for, from whichever field carries it", () => {
    expect(stepSummary({ id: "f", type: "tool", tool: "documents.fill_docx" })).toBe("documents.fill_docx");
    expect(stepSummary({ id: "w", type: "delay", seconds: 5 })).toBe("wait 5s");
    expect(stepSummary({ id: "a", type: "agent", instruction: "draw it" })).toBe("draw it");
  });
});