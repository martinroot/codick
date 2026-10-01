import React from "react";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { pipelinesApi } from "@/lib/pipelines-api";
import type { PipelineStepTemplate, PipelineTemplateBody } from "@/lib/pipelines-api";

import {
  KIND_LABEL,
  NODE_KINDS,
  newStep,
  nodesToTemplate,
  templateToNodes,
  type NodeKind,
  type StepNodeData,
} from "./canvas";

/**
 * The pipeline editor.
 *
 * This is the thing the whole product is for: a run you can read as a shape
 * before it costs anything. The JSON stays the storage format -- the server
 * validates it, versions it and the executor walks it -- but nobody should have
 * to author it by hand to see whether a pipeline makes sense.
 */

function Palette({ onAdd }: { onAdd: (kind: NodeKind) => void }) {
  return (
    <div className="d-flex flex-column gap-1">
      <div className="small text-body-secondary mb-1">Add a block</div>
      {NODE_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          className="btn btn-sm btn-outline-secondary text-start"
          onClick={() => onAdd(kind)}
        >
          {KIND_LABEL[kind]}
        </button>
      ))}
    </div>
  );
}

function Inspector({
  node,
  onChange,
  onDelete,
}: {
  node: Node<StepNodeData>;
  onChange: (data: Partial<StepNodeData>) => void;
  onDelete: () => void;
}) {
  const d = node.data;
  const set = (patch: Partial<StepNodeData>) => onChange(patch);
  return (
    <div className="d-flex flex-column gap-2">
      <div className="small text-body-secondary">
        <code>{node.id}</code>
      </div>
      <label className="small mb-0">
        Title
        <input
          className="form-control form-control-sm"
          value={d.label ?? ""}
          onChange={(e) => set({ label: e.target.value })}
        />
      </label>
      {d.kind === "agent" && (
        <>
          <label className="small mb-0">
            Profile
            <input
              className="form-control form-control-sm"
              placeholder="researcher, writer, word-editor…"
              value={d.profile ?? ""}
              onChange={(e) => set({ profile: e.target.value })}
            />
          </label>
          <label className="small mb-0">
            Instruction
            <textarea
              className="form-control form-control-sm"
              rows={4}
              value={d.instruction ?? ""}
              onChange={(e) => set({ instruction: e.target.value })}
            />
          </label>
        </>
      )}
      {d.kind === "tool" && (
        <label className="small mb-0">
          Tool
          <input
            className="form-control form-control-sm"
            placeholder="documents.export_docx"
            value={d.tool ?? ""}
            onChange={(e) => set({ tool: e.target.value })}
          />
        </label>
      )}
      {d.kind === "user_input" && (
        <label className="small mb-0">
          Question
          <textarea
            className="form-control form-control-sm"
            rows={3}
            value={d.prompt ?? ""}
            onChange={(e) => set({ prompt: e.target.value })}
          />
        </label>
      )}
      {d.kind === "delay" && (
        <label className="small mb-0">
          Seconds
          <input
            type="number"
            min={0}
            max={300}
            className="form-control form-control-sm"
            value={d.seconds ?? 0}
            onChange={(e) => set({ seconds: Number(e.target.value) })}
          />
        </label>
      )}
      <button type="button" className="btn btn-sm btn-outline-danger" onClick={onDelete}>
        Remove block
      </button>
    </div>
  );
}

function Canvas() {
  const [templates, setTemplates] = React.useState<{ id: string; name: string | null }[]>([]);
  const [templateId, setTemplateId] = React.useState<string>("");
  const [body, setBody] = React.useState<PipelineTemplateBody | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<StepNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string>("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    pipelinesApi
      .listTemplates()
      .then((res) => {
        setTemplates(res.templates);
        setTemplateId((current) => current || res.templates[0]?.id || "");
      })
      .catch((err) => setStatus(`Could not list templates: ${String(err)}`));
  }, []);

  const load = React.useCallback((id: string) => {
    if (!id) return;
    setBusy(true);
    pipelinesApi
      .getTemplate(id)
      .then((row) => {
        const loaded = row.template ?? null;
        setBody(loaded);
        const { nodes: n, edges: e } = templateToNodes(loaded);
        setNodes(n);
        setEdges(e);
        setSelected(null);
        setStatus("");
      })
      .catch((err) => setStatus(`Could not load template: ${String(err)}`))
      .finally(() => setBusy(false));
  }, [setNodes, setEdges]);

  React.useEffect(() => {
    if (templateId) load(templateId);
  }, [templateId, load]);

  const addBlock = (kind: NodeKind) => {
    const id = `${kind}_${Date.now().toString(36).slice(-4)}`;
    const node = newStep(id, kind, {
      x: 80 + nodes.length * 40,
      y: 80 + nodes.length * 30,
    });
    setNodes((current) => [...current, node]);
    setSelected(id);
  };

  const connect = (connection: Connection) => {
    setEdges((current) => addEdge({ ...connection, id: `e-${connection.source}-${connection.target}` }, current));
  };

  const current = nodes.find((n) => n.id === selected) ?? null;

  const validateAndStore = async () => {
    setBusy(true);
    setStatus("");
    const name = body?.name ?? templateId ?? "pipeline";
    const built = nodesToTemplate(nodes, edges, {
      id: templateId || name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      version: "1.0.0",
      name,
      startStep: body?.start_step ?? nodes[0]?.id,
    });
    try {
      const result = await pipelinesApi.validateTemplate(built as never);
      if (!result.valid) {
        setStatus(`Not valid yet: ${JSON.stringify(result.errors).slice(0, 300)}`);
        return;
      }
      await pipelinesApi.storeTemplate(built as never);
      setStatus("Stored. Every block is drawn; only what you fill in is what runs.");
      setBody(built);
      load(templateId);
    } catch (err) {
      setStatus(`Could not store: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="d-flex flex-column gap-2">
      <div className="d-flex flex-wrap gap-2 align-items-end">
        <div style={{ minWidth: "16rem" }}>
          <label className="form-label small mb-1" htmlFor="design-template">
            Template
          </label>
          <select
            id="design-template"
            className="form-select form-select-sm"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
          >
            {templates.length === 0 && <option value="">No templates yet</option>}
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name ?? t.id}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => void validateAndStore()}
          disabled={busy || nodes.length === 0}
        >
          {busy ? "Working…" : "Validate and store"}
        </button>
        {status && <span className="small text-body-secondary">{status}</span>}
      </div>

      <div className="row g-2">
        <div className="col-12 col-lg-2">
          <Palette onAdd={addBlock} />
        </div>
        <div className="col-12 col-lg-7">
          <div style={{ height: "62vh", minHeight: "26rem" }} className="border rounded bg-body-tertiary">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={connect}
              onNodeClick={(_, node) => setSelected(node.id)}
              fitView
            >
              <Background />
              <Controls />
            </ReactFlow>
          </div>
        </div>
        <div className="col-12 col-lg-3">
          {current ? (
            <Inspector
              node={current}
              onChange={(patch) =>
                setNodes((all) =>
                  all.map((n) => (n.id === current.id ? { ...n, data: { ...n.data, ...patch } } : n)),
                )
              }
              onDelete={() => {
                setNodes((all) => all.filter((n) => n.id !== current.id));
                setEdges((all) => all.filter((e) => e.source !== current.id && e.target !== current.id));
                setSelected(null);
              }}
            />
          ) : (
            <p className="small text-body-secondary mb-0">Pick a block to edit it.</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PipelineDesigner() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}

export type { PipelineStepTemplate };