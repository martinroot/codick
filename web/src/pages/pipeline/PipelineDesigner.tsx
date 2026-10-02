import React from "react";
import {
  Background,
  Controls,
  ReactFlow,
  type NodeTypes,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { api, type ProfileInfo } from "@/lib/api";
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
import { StepNode } from "./StepNode";

const NODE_TYPES: NodeTypes = { default: StepNode };

const KIND_COLOUR: Record<string, string> = {
  agent: "#6366f1",
  tool: "#10b981",
  user_input: "#f59e0b",
  condition: "#ec4899",
  delay: "#64748b",
};

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

/**
 * A profile picker for a step, not a reassignment control: this one does not
 * write through to a card. It offers the real profiles and, when the step names
 * something that is not one, says so instead of saving a typo that fails at
 * run time.
 */
/** "provider\0model" back apart, or nothing when the default's model stands. */
export function pick(choice: string): ModelChoice | undefined {
  if (!choice) return undefined;
  const [provider, model] = choice.split("\u0000");
  return provider && model ? { provider, model, label: choice } : undefined;
}

interface ModelChoice {
  provider: string;
  model: string;
  label: string;
}

function ProfileSelect({
  value,
  profiles,
  onChange,
  onCreate,
}: {
  value: string;
  profiles: ProfileInfo[];
  onChange: (name: string) => void;
  onCreate: () => void;
}) {
  const known = profiles.map((p) => p.name);
  const orphan = Boolean(value) && !known.includes(value);
  return (
    <div className="d-flex gap-1">
      <select
        className="form-select form-select-sm"
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Pick a profile…</option>
        {orphan && <option value={value}>{value} (not a Hermes profile)</option>}
        {profiles.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
            {p.model ? ` — ${p.model}` : ""}
          </option>
        ))}
      </select>
      <button type="button" className="btn btn-sm btn-outline-secondary" onClick={onCreate}>
        New
      </button>
    </div>
  );
}

function Inspector({
  node,
  profiles,
  onChange,
  onDelete,
  onCreateProfile,
  modelChoices,
  onLoadModels,
  busy,
}: {
  node: Node<StepNodeData>;
  profiles: ProfileInfo[];
  onChange: (data: Partial<StepNodeData>) => void;
  onDelete: () => void;
  onCreateProfile: (name: string, choice?: ModelChoice) => void;
  modelChoices: ModelChoice[] | null;
  onLoadModels: () => void;
  busy: boolean;
}) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const [choice, setChoice] = React.useState("");
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
            <ProfileSelect
              value={d.profile ?? ""}
              profiles={profiles}
              onChange={(next) => set({ profile: next })}
              onCreate={() => setDraft("")}
            />
            {draft !== null && (
              <div className="d-flex flex-column gap-1 border rounded p-2">
                <input
                  className="form-control form-control-sm"
                  autoFocus
                  placeholder="researcher"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setDraft(null);
                  }}
                />
                {modelChoices === null ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary"
                    onClick={onLoadModels}
                  >
                    Choose a model…
                  </button>
                ) : (
                  <select
                    className="form-select form-select-sm"
                    value={choice}
                    onChange={(e) => setChoice(e.target.value)}
                  >
                    <option value="">Model from the default profile</option>
                    {modelChoices.map((c) => (
                      <option key={`${c.provider}\u0000${c.model}`} value={`${c.provider}\u0000${c.model}`}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy}
                  onClick={() => onCreateProfile(draft, pick(choice))}
                >
                  {busy ? "Creating…" : "Create"}
                </button>
              </div>
            )}
          </label>
          {d.model && (
            <div className="small text-body-secondary">
              Runs on <code>{d.model}</code>
            </div>
          )}
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
  const [status, setStatus] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [profiles, setProfiles] = React.useState<ProfileInfo[]>([]);
  const [modelChoices, setModelChoices] = React.useState<ModelChoice[] | null>(null);

  const loadModelChoices = React.useCallback(() => {
    api
      .getModelOptions()
      .then((res) => {
        const flat: ModelChoice[] = [];
        for (const prov of res.providers ?? []) {
          for (const m of prov.models ?? []) {
            flat.push({ provider: prov.slug, model: m, label: `${prov.name} · ${m}` });
          }
        }
        setModelChoices(flat);
      })
      .catch(() => setModelChoices([]));
  }, []);

  const loadProfiles = React.useCallback(() => {
    api
      .getProfiles()
      .then((res) => setProfiles(res.profiles ?? []))
      .catch(() => setProfiles([]));
  }, []);

  React.useEffect(loadProfiles, [loadProfiles]);

  /** A step names a profile; the profile owns the model. Showing the model
   *  next to the step is what tells you what a run will actually spend. */
  const modelFor = React.useCallback(
    (name?: string) => profiles.find((p) => p.name === name)?.model ?? undefined,
    [profiles],
  );

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
        setNodes(n.map((node) => ({ ...node, data: { ...node.data, model: modelFor(node.data?.profile) } })));
        setEdges(e);
        setSelected(null);
        setStatus("");
      })
      .catch((err) => setStatus(`Could not load template: ${String(err)}`))
      .finally(() => setBusy(false));
  }, [setNodes, setEdges, modelFor]);

  React.useEffect(() => {
    if (templateId) load(templateId);
  }, [templateId, load]);

  /**
   * Creating a profile from inside the designer, because a pipeline step that
   * names a profile nobody has yet is the most common way to end up with a run
   * that cannot start. Cloned from the default so it has a provider and a
   * model without asking for a key.
   */
  const createProfile = async (raw: string, choice?: ModelChoice) => {
    const name = raw.trim();
    if (!name) {
      setStatus("Give the profile a name first.");
      return;
    }
    setBusy(true);
    try {
      // A step names a profile and the profile owns the model, so choosing a
      // model here is the only place it can be chosen. Cloned from the default
      // first so the provider's credentials come with it; the model and
      // provider are then set explicitly from the choice.
      // `no_skills` is rejected by the server alongside any clone: the source
      // profile decides what comes with it. Sending both made every creation
      // fail with a mutual-exclusion error.
      await api.createProfile({
        name,
        clone_from_default: true,
        provider: choice?.provider,
        model: choice?.model,
      });
      loadProfiles();
      setStatus(`Created profile ${name}.`);
    } catch (err) {
      setStatus(`Could not create profile: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

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
          <div className="d-flex flex-wrap gap-3 small text-body-secondary">
            {NODE_KINDS.map((kind) => (
              <span key={kind} className="d-inline-flex align-items-center gap-1">
                <span
                  className="rounded-circle d-inline-block"
                  style={{ width: 10, height: 10, background: KIND_COLOUR[kind] }}
                />
                {KIND_LABEL[kind]}
              </span>
            ))}
          </div>
          <div style={{ height: "62vh", minHeight: "26rem" }} className="border rounded bg-body-tertiary">
            <ReactFlow
              nodeTypes={NODE_TYPES}
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
              profiles={profiles}
              onCreateProfile={(name, picked) => void createProfile(name, picked)}
              modelChoices={modelChoices}
              onLoadModels={loadModelChoices}
              busy={busy}
              onChange={(patch) =>
                setNodes((all) =>
                  all.map((n) => {
                    if (n.id !== current.id) return n;
                    const next = { ...n.data, ...patch };
                    // Choosing a profile is also choosing its model.
                    if (patch.profile !== undefined) next.model = modelFor(patch.profile);
                    return { ...n, data: next };
                  }),
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