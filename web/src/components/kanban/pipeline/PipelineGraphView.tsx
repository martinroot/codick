import React from "react";

import type { PipelineStepTemplate } from "@/lib/pipelines-api";

import { buildPipelineGraph, stepSummary } from "./pipelineGraph";

/**
 * The pipeline as blocks, in the order the run walks them.
 *
 * A person reading a template JSON has to hold the array, the transitions and
 * the start step in their head at once to picture it. This is that picture:
 * every step a card, every transition an arrow with the guard it answers to,
 * and a loop drawn as the backward arrow it actually is.
 */

const TYPE_BADGE: Record<string, { label: string; className: string }> = {
  agent: { label: "Agent", className: "text-bg-primary" },
  tool: { label: "Tool", className: "text-bg-secondary" },
  user_input: { label: "Input", className: "text-bg-info" },
  condition: { label: "Branch", className: "text-bg-warning" },
  delay: { label: "Wait", className: "text-bg-dark" },
};

export default function PipelineGraphView({
  steps,
  startStep,
}: {
  steps: PipelineStepTemplate[];
  startStep?: string;
}) {
  const graph = React.useMemo(() => buildPipelineGraph(steps, startStep), [steps, startStep]);

  if (!graph.nodes.length) {
    return (
      <p className="text-body-secondary small mb-0">This template has no steps.</p>
    );
  }

  const byId = new Map(graph.nodes.map((n) => [n.step.id, n]));

  return (
    <div className="pipeline-graph">
      {graph.nodes.map((node) => {
        const badge = TYPE_BADGE[node.step.type] ?? { label: node.step.type, className: "text-bg-light border" };
        const outgoing = graph.edges.filter((e) => e.from === node.step.id);
        return (
          <div key={node.step.id} className="mb-2">
            <div
              className={`card border ${node.isStart ? "border-primary" : ""} ${
                node.unreachable ? "opacity-50" : ""
              }`}
            >
              <div className="card-body py-2">
                <div className="d-flex align-items-center gap-2 mb-1">
                  <span className="badge small">{node.index + 1}</span>
                  <span className={`badge ${badge.className}`}>{badge.label}</span>
                  <code className="small">{node.step.id}</code>
                  {node.isStart && <span className="badge text-bg-light border">Start</span>}
                  {node.isEnd && <span className="badge text-bg-success">Finishes</span>}
                  {node.unreachable && (
                    <span className="badge text-bg-danger" title="No branch from the start step reaches this block.">
                      Unreachable
                    </span>
                  )}
                </div>
                {node.step.title && <div className="fw-semibold small">{node.step.title}</div>}
                <div className="small text-body-secondary text-truncate">
                  {stepSummary(node.step)}
                </div>
                {node.loopsFrom.length > 0 && (
                  <div className="small text-body-secondary">
                    ↩ repeats until it passes
                  </div>
                )}
              </div>
            </div>

            {outgoing.length > 0 && (
              <div className="ps-4 border-start ms-2 py-1">
                {outgoing.map((edge, i) => {
                  const target = edge.to ? byId.get(edge.to) : null;
                  const broken = edge.to !== null && !target;
                  return (
                    <div key={`${node.step.id}-${i}`} className="small mb-1">
                      <span className="text-body-tertiary me-1">↓</span>
                      {edge.label && <span className="text-body-secondary me-1">{edge.label}</span>}
                      {broken ? (
                        <span className="text-danger">unknown step “{edge.to}”</span>
                      ) : edge.to === null ? (
                        <span className="text-body-secondary">run finishes</span>
                      ) : (
                        <code className={node.loopsFrom.includes(edge.to) ? "text-warning" : ""}>
                          {edge.to}
                        </code>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}