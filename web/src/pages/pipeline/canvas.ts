import type { Edge, Node } from "@xyflow/react";

import type { PipelineStepTemplate, PipelineTemplateBody } from "@/lib/pipelines-api";

/**
 * Turning a pipeline template into a canvas, and a canvas back into one.
 *
 * Kept apart from the editor component because this is the part with the
 * judgement in it: which steps become nodes, where they sit, which edge is a
 * plain continuation and which is a guard, and -- the round trip that actually
 * matters -- that what comes back out is the same pipeline that went in.
 */

/**
 * Laid out in layers rather than in a row, because a pipeline that reads
 * left-to-right off a 200px canvas is a pipeline nobody can read. Steps with no
 * incoming edge start a layer; anything whose predecessors are all placed goes
 * one layer below the deepest of them. Guards sit beside their step rather
 * than in the flow, since a case is a property of a step, not a moment in the
 * sequence.
 */
const LAYOUT = { dx: 260, dy: 130, originX: 60, originY: 60 };

export const NODE_KINDS = ["agent", "tool", "user_input", "condition", "delay"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const KIND_LABEL: Record<NodeKind, string> = {
  agent: "Agent step",
  tool: "Tool step",
  user_input: "Ask a person",
  condition: "Branch",
  delay: "Wait",
};

export interface StepNodeData extends Record<string, unknown> {
  label: string;
  kind: NodeKind;
  summary: string;
  profile?: string;
  /** Displayed from the chosen profile, not written to the template: a step
   *  names a profile, and the profile owns its model. */
  model?: string;
  instruction?: string;
  tool?: string;
  seconds?: number;
  prompt?: string;
  /** Guard text per outgoing edge, kept on the edge so a branch reads as one. */
}

export function templateToNodes(
  body: PipelineTemplateBody | null,
): { nodes: Node<StepNodeData>[]; edges: Edge[] } {
  const steps = Array.isArray(body?.steps) ? body.steps : [];
  const byId = new Map<string, PipelineStepTemplate>();
  for (const step of steps) if (step?.id) byId.set(step.id, step);

  const targets = (step?: PipelineStepTemplate): (string | null)[] => {
    if (!step) return [];
    if (step.type === "condition") {
      const out: (string | null)[] = (step.cases ?? []).map((c) => c?.next ?? null);
      if (step.default?.fail) out.push(null);
      else if (typeof step.default?.next === "string") out.push(step.default.next);
      return out;
    }
    return [typeof step.next === "string" ? step.next : null];
  };

  // Depth is measured *forwards* from the start, as the longest path that
  // reaches a step. Measuring back from the leaves gives the same numbers
  // upside down, which is a graph that runs bottom-up: the step that must go
  // first ends up at the bottom.
  //
  // A cycle has no longest path, so "keep relaxing until it stops improving"
  // never stops -- it walks the loop forever, raising every layer by one each
  // time. A step is therefore placed the first time the walk reaches it and
  // never moved again. A loop that passes through the start comes back to a
  // step that already has a depth, is left alone, and shows up as the backward
  // edge it is. The walk terminates on exactly the template that most needs to
  // open.
  const depth = new Map<string, number>();
  const walkFrom = (startId: string) => {
    const queue: string[] = [startId];
    const seen = new Set<string>([startId]);
    depth.set(startId, 0);
    while (queue.length) {
      const id = queue.shift() as string;
      const here = depth.get(id) ?? 0;
      for (const target of targets(byId.get(id))) {
        if (!target || !byId.has(target) || seen.has(target)) continue;
        seen.add(target);
        depth.set(target, here + 1);
        queue.push(target);
      }
    }
  };

  const start = body?.start_step && byId.has(body.start_step) ? body.start_step : steps[0]?.id;
  if (start && byId.has(start)) walkFrom(start);
  // Anything the start cannot reach still has to draw, just not as part of the
  // flow: a headless chain of its own below the rest.
  let orphanRow = 0;
  for (const step of steps) {
    if (depth.has(step.id)) continue;
    const d = depth.size ? Math.max(...depth.values()) + 2 : 0;
    depth.set(step.id, d + orphanRow);
    orphanRow += 1;
  }

  const rowsByDepth = new Map<number, number>();
  const nodes: Node<StepNodeData>[] = steps.map((step) => {
    const d = depth.get(step.id) ?? 0;
    const row = rowsByDepth.get(d) ?? 0;
    rowsByDepth.set(d, row + 1);
    return {
      id: step.id,
      type: "default",
      position: {
        x: LAYOUT.originX + row * LAYOUT.dx,
        y: LAYOUT.originY + d * LAYOUT.dy,
      },
      data: {
        label: step.title ?? step.id,
        kind: (step.type as NodeKind) ?? "agent",
        summary: summarise(step),
        profile: step.profile,
        instruction: step.instruction,
        tool: step.tool,
        seconds: step.seconds,
        prompt: step.prompt,
      },
    };
  });

  const EDGE_COLOUR: Record<string, string> = {
    agent: "#6366f1",
    tool: "#10b981",
    user_input: "#f59e0b",
    condition: "#ec4899",
    delay: "#64748b",
  };
  const colourOf = (from: string): string => EDGE_COLOUR[byId.get(from)?.type ?? "agent"] ?? "#94a3b8";
  const edgeBase = (id: string, source: string, target: string, label?: string): Edge => ({
    id,
    source,
    target,
    label,
    style: { stroke: colourOf(source), strokeWidth: 2 },
    labelStyle: { fill: colourOf(source), fontSize: 11 },
    labelBgStyle: { fill: "#ffffffdd" },
    markerEnd: { type: "arrowclosed" as never, color: colourOf(source) },
  });

  const edges: Edge[] = [];
  for (const step of steps) {
    if (step.type === "condition") {
      (step.cases ?? []).forEach((c, i) => {
        if (!c?.next) return;
        const edge = edgeBase(`${step.id}->case-${i}`, step.id, c.next, describe(c.when));
        // A rework case is a loop: routed as a right-angle edge so it reads as
        // a return rather than as the next step.
        if (c.rework) {
          edge.type = "smoothstep";
          edge.style = { ...edge.style, strokeDasharray: "5 4" };
          edge.label = `${edge.label} · rework`;
        }
        edges.push(edge);
      });
      if (typeof step.default?.next === "string") {
        edges.push(
          edgeBase(
            `${step.id}->default`,
            step.id,
            step.default.next,
            step.default.fail ? `fail: ${step.default.fail}` : "otherwise",
          ),
        );
      }
      continue;
    }
    if (typeof step.next === "string") {
      edges.push(edgeBase(`${step.id}->next`, step.id, step.next));
    }
  }

  return { nodes, edges };
}

function summarise(step: PipelineStepTemplate): string {
  if (step.type === "tool") return step.tool ?? "tool";
  if (step.type === "delay") return step.seconds ? `${step.seconds}s wait` : "wait";
  if (step.type === "user_input") return (step.prompt ?? "ask").slice(0, 70);
  return (step.instruction ?? step.profile ?? step.type).slice(0, 70);
}

function describe(when: unknown): string {
  const w = when as { op?: string; left?: unknown; right?: unknown } | undefined;
  if (!w || typeof w !== "object" || !w.op) return "when";
  if (w.op === "exists") return `${String(w.left ?? "?")} exists`;
  return `${String(w.left ?? "?")} ${w.op} ${String(w.right ?? "?")}`;
}

/** A blank block, so the palette and the canvas agree on what a new step is. */
export function newStep(id: string, kind: NodeKind, position: { x: number; y: number }): Node<StepNodeData> {
  return {
    id,
    type: "default",
    position,
    data: {
      label: id,
      kind,
      summary: KIND_LABEL[kind],
      seconds: kind === "delay" ? 3 : undefined,
      profile: kind === "agent" ? "default" : undefined,
      tool: kind === "tool" ? "" : undefined,
      prompt: kind === "user_input" ? "" : undefined,
      instruction: kind === "agent" ? "" : undefined,
    },
  };
}

/**
 * The canvas back to a template.
 *
 * Node positions are dropped on purpose: they are where the author drew, not
 * what the run does, and storing them would make every dragged block a template
 * revision for no behavioural change. What is kept is what the executor reads.
 */
export function nodesToTemplate(
  nodes: Node<StepNodeData>[],
  edges: Edge[],
  meta: { id: string; version: string; name: string; startStep?: string },
): PipelineTemplateBody {
  // An edge label is a ReactNode, not a string: React Flow renders it as one.
  // Everything below only ever needs its text.
  const labelOf = (e: Edge): string => (typeof e.label === "string" ? e.label : "");
  const edgesFrom = (id: string) => edges.filter((e) => e.source === id);
  const firstTarget = (id: string): string | null => {
    const plain = edgesFrom(id).find((e) => !e.label);
    if (plain) return plain.target;
    const labelled = edgesFrom(id)[0];
    return labelled ? labelled.target : null;
  };

  const steps: PipelineStepTemplate[] = nodes.map((node) => {
    const d = node.data ?? ({} as StepNodeData);
    const outgoing = edgesFrom(node.id);
    const step: PipelineStepTemplate = { id: node.id, type: d.kind ?? "agent" };
    if (d.label && d.label !== node.id) step.title = d.label;
    if (d.profile) step.profile = d.profile;
    if (d.tool) step.tool = d.tool;
    if (d.instruction) step.instruction = d.instruction;
    if (d.prompt) step.prompt = d.prompt;
    if (d.kind === "delay") step.seconds = d.seconds ?? 0;

    if (d.kind === "condition") {
      const cases = outgoing
        .filter((e) => labelOf(e) && !["otherwise", "fail"].some((p) => labelOf(e).startsWith(p)))
        .map((e) => ({ when: parseWhen(labelOf(e)), next: e.target }));
      if (cases.length) step.cases = cases;
      const fallback = outgoing.find(
        (e) => !labelOf(e) || labelOf(e).startsWith("otherwise") || labelOf(e).startsWith("fail"),
      );
      if (fallback) {
        if (labelOf(fallback).startsWith("fail")) {
          step.default = { fail: labelOf(fallback).slice(5) };
        } else {
          step.default = { next: fallback.target };
        }
      }
      return step;
    }

    const next = firstTarget(node.id);
    step.next = next ?? null;
    return step;
  });

  const start = meta.startStep ?? nodes[0]?.id ?? steps[0]?.id;
  return {
    schema_version: "1.0",
    id: meta.id,
    name: meta.name,
    start_step: start,
    inputs_schema: { type: "object", properties: {} },
    steps,
  };
}

const OP_WORDS = /^(.+?)\s+(eq|ne|gt|gte|lt|lte|exists)\s*(.*)$/;

/** Edge labels are text a person typed; this is how it goes back to a `when`. */
export function parseWhen(label: string): Record<string, unknown> {
  const match = OP_WORDS.exec(label.trim());
  if (!match) return { op: "exists", left: label.trim() };
  const [, left, op, right] = match;
  const numeric = Number(right);
  if (op !== "exists" && right !== "" && !Number.isNaN(numeric)) {
    return { op, left, right: numeric };
  }
  if (op === "exists") return { op, left };
  return { op, left, right };
}

export function stepOfNode(node: Node<StepNodeData> | undefined): PipelineStepTemplate | null {
  return node ? stepOfSafe(node) : null;
}

function stepOfSafe(node: Node<StepNodeData>): PipelineStepTemplate {
  const d = node.data ?? ({} as StepNodeData);
  const step: PipelineStepTemplate = { id: node.id, type: d.kind ?? "agent" };
  if (d.label) step.title = d.label;
  return step;
}