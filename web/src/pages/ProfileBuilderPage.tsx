import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { H2 } from "@/ui";
import { Card, CardContent } from "@/ui";
import { Badge } from "@/ui";
import { Button } from "@/ui";
import { Input } from "@/ui";
import { Label } from "@/ui";
import { Checkbox } from "@/ui";
import { Toast } from "@/ui";
import { useToast } from "@/ui";
import { api } from "@/lib/api";
import type {
  McpHttpAuth,
  McpServerCreate,
  SkillInfo,
  SkillHubResult,
} from "@/lib/api";
import {
  buildMcpServerCreate,
  emptyMcpServerDraft,
  type McpServerDraft,
  type McpTransport,
} from "@/lib/mcp-server-create";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/api-error";

// Profile name rule mirrors the backend (`^[a-z0-9][a-z0-9_-]{0,63}$`).
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

type StepId = "identity" | "model" | "skills" | "mcp" | "review";

const STEPS: { id: StepId; label: string }[] = [
  { id: "identity", label: "Identity" },
  { id: "model", label: "Model" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCPs" },
  { id: "review", label: "Review" },
];

interface ModelChoice {
  provider: string;
  model: string;
  label: string;
}

/**
 * Dashboard-native, full-featured profile builder.
 *
 * Composes the same elements the standalone Models / Skills / MCP pages
 * manage — Name, Description, Model+Provider, Skills (built-in/optional +
 * hub), MCP servers — into one stepped create flow. Nothing is written to
 * disk until "Create profile" on the final step; the single POST /api/profiles
 * call commits model + MCPs + skill selection synchronously and spawns any
 * hub-skill installs (which the success toast reports as in-progress).
 *
 * Skills use REPLACE semantics: the default bundle is seeded server-side, then
 * every seeded skill the user did NOT keep is disabled. The "Start from full
 * bundle" toggle keeps everything (sends no keep list).
 */
export default function ProfileBuilderPage() {
  const navigate = useNavigate();
  const { toast, showToast } = useToast();

  const [step, setStep] = useState<StepId>("identity");

  // ── Step 1: identity ──────────────────────────────────────────────
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  // ── Step 2: model ─────────────────────────────────────────────────
  const [modelChoices, setModelChoices] = useState<ModelChoice[] | null>(null);
  const [modelChoice, setModelChoice] = useState(""); // `${provider}\u0000${model}`
  const [modelFilter, setModelFilter] = useState("");
  const modelLoading = useRef(false);

  // ── Step 3: skills ────────────────────────────────────────────────
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  // keepAll = true: don't send a keep list (full bundle stays active).
  const [keepAll, setKeepAll] = useState(true);
  const [keptSkills, setKeptSkills] = useState<Set<string>>(new Set());
  const [skillFilter, setSkillFilter] = useState("");
  const skillsLoading = useRef(false);
  // Hub search
  const [hubQuery, setHubQuery] = useState("");
  const [hubResults, setHubResults] = useState<SkillHubResult[]>([]);
  const [hubSearching, setHubSearching] = useState(false);
  const [hubSkills, setHubSkills] = useState<SkillHubResult[]>([]);

  // ── Step 4: MCPs ──────────────────────────────────────────────────
  const [mcpServers, setMcpServers] = useState<McpServerCreate[]>([]);
  const [mcpDraft, setMcpDraft] = useState<McpServerDraft>(emptyMcpServerDraft);

  // ── Submit ────────────────────────────────────────────────────────
  const [creating, setCreating] = useState(false);

  const nameValid = PROFILE_NAME_RE.test(name.trim());

  // Lazy-load model choices when the model step is first shown.
  const loadModels = useCallback(() => {
    if (modelChoices !== null || modelLoading.current) return;
    modelLoading.current = true;
    api
      .getModelOptions()
      .then((res) => {
        const flat: ModelChoice[] = [];
        for (const prov of res.providers ?? []) {
          for (const m of prov.models ?? []) {
            flat.push({
              provider: prov.slug,
              model: m,
              label: `${prov.name} · ${m}`,
            });
          }
        }
        setModelChoices(flat);
      })
      .catch(() => setModelChoices([]))
      .finally(() => {
        modelLoading.current = false;
      });
  }, [modelChoices]);

  const loadSkills = useCallback(() => {
    if (skills !== null || skillsLoading.current) return;
    skillsLoading.current = true;
    api
      .getSkills()
      .then((res) => {
        setSkills(res);
        // Default keep = all currently-enabled skills (matches the seeded set).
        setKeptSkills(new Set(res.filter((s) => s.enabled).map((s) => s.name)));
      })
      .catch(() => setSkills([]))
      .finally(() => {
        skillsLoading.current = false;
      });
  }, [skills]);

  useEffect(() => {
    if (step === "model") loadModels();
    if (step === "skills") loadSkills();
  }, [step, loadModels, loadSkills]);

  const runHubSearch = useCallback(() => {
    const q = hubQuery.trim();
    if (!q) return;
    setHubSearching(true);
    api
      .searchSkillsHub(q, "all", 20)
      .then((res) => setHubResults(res.results ?? []))
      .catch(() => setHubResults([]))
      .finally(() => setHubSearching(false));
  }, [hubQuery]);

  const toggleKeep = (skillName: string) => {
    setKeptSkills((prev) => {
      const next = new Set(prev);
      if (next.has(skillName)) next.delete(skillName);
      else next.add(skillName);
      return next;
    });
  };

  const addHubSkill = (r: SkillHubResult) => {
    setHubSkills((prev) =>
      prev.some((x) => x.identifier === r.identifier) ? prev : [...prev, r],
    );
  };
  const removeHubSkill = (identifier: string) =>
    setHubSkills((prev) => prev.filter((x) => x.identifier !== identifier));

  const addMcpDraft = () => {
    let entry: McpServerCreate;
    try {
      entry = buildMcpServerCreate(mcpDraft);
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Invalid MCP server",
        "error",
      );
      return;
    }
    setMcpServers((prev) => [
      ...prev.filter((server) => server.name !== entry.name),
      entry,
    ]);
    setMcpDraft(emptyMcpServerDraft());
  };
  const removeMcp = (n: string) =>
    setMcpServers((prev) => prev.filter((s) => s.name !== n));

  const setMcpTransport = (transport: McpTransport) => {
    setMcpDraft((draft) =>
      transport === "http"
        ? { ...draft, transport, command: "", args: "", env: "" }
        : {
            ...draft,
            transport,
            url: "",
            httpAuth: "none",
            bearerToken: "",
          },
    );
  };

  const setMcpHttpAuth = (httpAuth: McpHttpAuth) => {
    setMcpDraft((draft) => ({
      ...draft,
      httpAuth,
      bearerToken: httpAuth === "header" ? draft.bearerToken : "",
    }));
  };

  const filteredModels = useMemo(() => {
    if (!modelChoices) return [];
    const f = modelFilter.trim().toLowerCase();
    if (!f) return modelChoices;
    return modelChoices.filter((c) => c.label.toLowerCase().includes(f));
  }, [modelChoices, modelFilter]);

  const filteredSkills = useMemo(() => {
    if (!skills) return [];
    const f = skillFilter.trim().toLowerCase();
    if (!f) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(f) ||
        (s.description || "").toLowerCase().includes(f) ||
        (s.category || "").toLowerCase().includes(f),
    );
  }, [skills, skillFilter]);

  const pickedModel = useMemo(
    () =>
      modelChoice
        ? modelChoices?.find(
            (c) => `${c.provider}\u0000${c.model}` === modelChoice,
          )
        : undefined,
    [modelChoice, modelChoices],
  );

  const handleCreate = async () => {
    const n = name.trim();
    if (!PROFILE_NAME_RE.test(n)) {
      showToast("Invalid profile name (lowercase, digits, - and _)", "error");
      setStep("identity");
      return;
    }
    setCreating(true);
    try {
      const res = await api.createProfile({
        name: n,
        clone_from: null,
        description: description.trim() || undefined,
        provider: pickedModel?.provider,
        model: pickedModel?.model,
        mcp_servers: mcpServers.length ? mcpServers : undefined,
        keep_skills: keepAll ? undefined : Array.from(keptSkills),
        hub_skills: hubSkills.length
          ? hubSkills.map((s) => s.identifier)
          : undefined,
      });
      const pending = (res.hub_installs ?? []).filter((h) => h.pid).length;
      showToast(
        pending
          ? `Profile "${n}" created — ${pending} hub skill${pending === 1 ? "" : "s"} installing`
          : `Profile "${n}" created`,
        "success",
      );
      navigate("/profiles");
    } catch (e) {
      showToast(`Create failed: ${errorMessage(e)}`, "error");
    } finally {
      setCreating(false);
    }
  };

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const canAdvance = step !== "identity" || nameValid;

  return (
    <div className="mx-auto w-100 max-w-3xl stack-5 p-4">
      <div className="d-flex align-items-center justify-content-between">
        <H2>New profile</H2>
        <Button ghost onClick={() => navigate("/profiles")}>
          Cancel
        </Button>
      </div>

      {/* Stepper */}
      <div className="d-flex align-items-center gap-2 fs-6">
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            // Identity must be valid before jumping ahead.
            disabled={i > 0 && !nameValid}
            onClick={() => setStep(s.id)}
            className={cn(
              "rounded-circle px-3 py-1 transition",
              s.id === step
                ? "bg-primary text-primary-foreground"
                : i <= stepIndex
                  ? "bg-muted text-body-emphasis"
                  : "text-body-secondary",
              i > 0 && !nameValid && "cursor-not-allowed opacity-50",
            )}
          >
            {i + 1}. {s.label}
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="stack-4 p-5">
          {step === "identity" && (
            <div className="stack-4">
              <div className="stack-2">
                <Label htmlFor="pb-name">Profile name</Label>
                <Input
                  id="pb-name"
                  placeholder="coder"
                  value={name}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setName(e.target.value)
                  }
                />
                {name && !nameValid && (
                  <p className="fs-6 text-danger">
                    Lowercase letters, digits, hyphens and underscores; must
                    start with a letter or digit.
                  </p>
                )}
              </div>
              <div className="stack-2">
                <Label htmlFor="pb-desc">Description (optional)</Label>
                <Input
                  id="pb-desc"
                  placeholder="What this agent profile is for"
                  value={description}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setDescription(e.target.value)
                  }
                />
              </div>
            </div>
          )}

          {step === "model" && (
            <div className="stack-3">
              <p className="fs-6 text-body-secondary">
                Pick the model+provider for this profile. Skip to use the
                default.
              </p>
              <Input
                placeholder="Filter models…"
                value={modelFilter}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setModelFilter(e.target.value)
                }
              />
              {modelChoices === null ? (
                <p className="fs-6 text-body-secondary">Loading models…</p>
              ) : (
                <div className="max-h-72 stack-1 overflow-y-auto">
                  <button
                    onClick={() => setModelChoice("")}
                    className={cn(
                      "d-block w-100 rounded px-3 py-2 text-start fs-6",
                      modelChoice === "" ? "bg-primary/10" : "hover:bg-muted",
                    )}
                  >
                    Use default (set later)
                  </button>
                  {filteredModels.map((c) => {
                    const key = `${c.provider}\u0000${c.model}`;
                    return (
                      <button
                        key={key}
                        onClick={() => setModelChoice(key)}
                        className={cn(
                          "d-block w-100 rounded px-3 py-2 text-start fs-6",
                          modelChoice === key
                            ? "bg-primary/10"
                            : "hover:bg-muted",
                        )}
                      >
                        {c.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {step === "skills" && (
            <div className="stack-4">
              <label className="d-flex align-items-center gap-2 fs-6">
                <Checkbox
                  checked={keepAll}
                  onCheckedChange={(v) => setKeepAll(Boolean(v))}
                />
                Start from the full default skill bundle (recommended)
              </label>
              {!keepAll && (
                <div className="stack-2">
                  <p className="fs-6 text-body-secondary">
                    Choose which built-in / optional skills to keep active.
                    Unchecked skills are disabled in the new profile.
                  </p>
                  <Input
                    placeholder="Filter skills…"
                    value={skillFilter}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setSkillFilter(e.target.value)
                    }
                  />
                  {skills === null ? (
                    <p className="fs-6 text-body-secondary">
                      Loading skills…
                    </p>
                  ) : (
                    <div className="max-h-56 stack-1 overflow-y-auto">
                      {filteredSkills.map((s) => (
                        <label
                          key={s.name}
                          className="d-flex align-items-start gap-2 rounded px-2 py-2 fs-6 hover:bg-muted"
                        >
                          <Checkbox
                            checked={keptSkills.has(s.name)}
                            onCheckedChange={() => toggleKeep(s.name)}
                          />
                          <span className="flex-grow-1">
                            <span className="fw-medium">{s.name}</span>
                            {s.category && (
                              <Badge tone="secondary" className="ml-2">
                                {s.category}
                              </Badge>
                            )}
                            {s.description && (
                              <span className="d-block fs-6 text-body-secondary">
                                {s.description}
                              </span>
                            )}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Skills hub */}
              <div className="stack-2 border-top pt-4">
                <Label>Add from the skills hub</Label>
                <div className="d-flex gap-2">
                  <Input
                    placeholder="Search the hub (e.g. linear, hyperliquid)…"
                    value={hubQuery}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setHubQuery(e.target.value)
                    }
                    onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                      if (e.key === "Enter") runHubSearch();
                    }}
                  />
                  <Button
                    outlined
                    onClick={runHubSearch}
                    disabled={hubSearching}
                  >
                    {hubSearching ? "Searching…" : "Search"}
                  </Button>
                </div>
                {hubResults.length > 0 && (
                  <div className="max-h-48 stack-1 overflow-y-auto">
                    {hubResults.map((r) => (
                      <div
                        key={r.identifier}
                        className="d-flex align-items-center justify-content-between rounded px-2 py-2 fs-6 hover:bg-muted"
                      >
                        <span className="flex-grow-1">
                          <span className="fw-medium">{r.name}</span>
                          <Badge tone="secondary" className="ml-2">
                            {r.source}
                          </Badge>
                          {r.description && (
                            <span className="d-block fs-6 text-body-secondary">
                              {r.description}
                            </span>
                          )}
                        </span>
                        <Button size="sm" ghost onClick={() => addHubSkill(r)}>
                          Add
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {hubSkills.length > 0 && (
                  <div className="d-flex flex-wrap gap-2 pt-1">
                    {hubSkills.map((r) => (
                      <Badge key={r.identifier} className="gap-1">
                        {r.name}
                        <button
                          className="ml-1 fs-6"
                          onClick={() => removeHubSkill(r.identifier)}
                          aria-label={`Remove ${r.name}`}
                        >
                          ×
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {step === "mcp" && (
            <div className="stack-5">
              <div className="d-flex flex-wrap align-items-start justify-content-between gap-3">
                <div className="stack-1">
                  <h3 className="font-expanded fs-6 fw-bold tracking-[0.04em]">
                    MCP servers
                  </h3>
                  <p className="fs-6 text-body-secondary">
                    Add MCP servers to give this profile access to external
                    tools and data.
                  </p>
                </div>
                <span
                  className="fs-6 text-body-secondary"
                  aria-live="polite"
                >
                  {mcpServers.length} configured
                </span>
              </div>

              <div className="stack-4 border border-secondary bg-background/20 p-4 md:p-5">
                <h4 className="fw-medium">Add server</h4>

                <div className="d-grid gap-4 md:grid-cols-2">
                  <div className="d-grid gap-2">
                    <Label htmlFor="pb-mcp-name">Server name</Label>
                    <Input
                      id="pb-mcp-name"
                      placeholder="Enter server name"
                      value={mcpDraft.name}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        setMcpDraft({ ...mcpDraft, name: e.target.value })
                      }
                    />
                  </div>
                  <div className="d-grid gap-2">
                    <Label>Transport</Label>
                    <div
                      className="d-grid grid-cols-2 border border-secondary bg-background/30 p-0.5"
                      role="group"
                      aria-label="MCP transport"
                    >
                      {(
                        [
                          ["http", "HTTP/SSE"],
                          ["stdio", "stdio"],
                        ] as const
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={mcpDraft.transport === value}
                          className={cn(
                            "px-3 py-2 fs-6 fw-medium transition",
                            mcpDraft.transport === value
                              ? "bg-primary text-primary-foreground"
                              : "text-body-secondary hover:bg-muted hover:text-foreground",
                          )}
                          onClick={() => setMcpTransport(value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {mcpDraft.transport === "http" ? (
                  <>
                    <div className="d-grid gap-2">
                      <Label htmlFor="pb-mcp-url">URL</Label>
                      <Input
                        id="pb-mcp-url"
                        placeholder="https://example.com/mcp"
                        value={mcpDraft.url}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          setMcpDraft({ ...mcpDraft, url: e.target.value })
                        }
                      />
                    </div>
                    <div className="d-grid gap-2">
                      <Label>Authentication</Label>
                      <div
                        className="d-grid grid-cols-3 border border-secondary bg-background/30 p-0.5 md:max-w-md"
                        role="group"
                        aria-label="HTTP authentication"
                      >
                        {(
                          [
                            ["none", "None"],
                            ["header", "Bearer token"],
                            ["oauth", "OAuth"],
                          ] as const
                        ).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            aria-pressed={mcpDraft.httpAuth === value}
                            className={cn(
                              "px-2 py-2 fs-6 fw-medium transition",
                              mcpDraft.httpAuth === value
                                ? "bg-primary text-primary-foreground"
                                : "text-body-secondary hover:bg-muted hover:text-foreground",
                            )}
                            onClick={() => setMcpHttpAuth(value)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    {mcpDraft.httpAuth === "header" && (
                      <div className="d-grid gap-2">
                        <Label htmlFor="pb-mcp-bearer-token">
                          Bearer token
                        </Label>
                        <Input
                          id="pb-mcp-bearer-token"
                          type="password"
                          autoComplete="new-password"
                          placeholder="Token or Bearer token"
                          value={mcpDraft.bearerToken}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            setMcpDraft({
                              ...mcpDraft,
                              bearerToken: e.target.value,
                            })
                          }
                        />
                        <p className="fs-6 text-body-secondary">
                          Stored in the new profile&apos;s .env; config.yaml
                          keeps only an environment-variable reference.
                        </p>
                      </div>
                    )}
                    {mcpDraft.httpAuth === "oauth" && (
                      <p className="fs-6 text-body-secondary">
                        After creating the profile, open its MCP page and use
                        Authenticate to complete OAuth.
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <div className="d-grid gap-4 md:grid-cols-2">
                      <div className="d-grid gap-2">
                        <Label htmlFor="pb-mcp-command">Command</Label>
                        <Input
                          id="pb-mcp-command"
                          placeholder="npx"
                          value={mcpDraft.command}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            setMcpDraft({
                              ...mcpDraft,
                              command: e.target.value,
                            })
                          }
                        />
                      </div>
                      <div className="d-grid gap-2">
                        <Label htmlFor="pb-mcp-args">Arguments</Label>
                        <Input
                          id="pb-mcp-args"
                          placeholder="-y @modelcontextprotocol/server"
                          value={mcpDraft.args}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            setMcpDraft({ ...mcpDraft, args: e.target.value })
                          }
                        />
                      </div>
                    </div>
                    <div className="d-grid gap-2">
                      <Label htmlFor="pb-mcp-env">
                        Environment (KEY=VALUE per line)
                      </Label>
                      <textarea
                        id="pb-mcp-env"
                        className="d-flex min-h-[80px] w-100 border border-secondary bg-background/40 px-3 py-2 fs-6 font-courier shadow-sm placeholder:text-muted-foreground focus-visible:border-foreground/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30"
                        placeholder={"API_KEY=secret\nDEBUG=1"}
                        value={mcpDraft.env}
                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                          setMcpDraft({ ...mcpDraft, env: e.target.value })
                        }
                      />
                    </div>
                  </>
                )}

                <div className="d-flex justify-content-end">
                  <Button onClick={addMcpDraft}>Add server</Button>
                </div>
              </div>

              {mcpServers.length > 0 && (
                <div className="stack-2">
                  {mcpServers.map((s) => (
                    <div
                      key={s.name}
                      className="d-flex align-items-center justify-content-between gap-4 border border-secondary bg-muted/40 p-4 fs-6"
                    >
                      <span className="min-w-0">
                        <span className="d-flex flex-wrap align-items-center gap-2">
                          <span className="fw-medium">{s.name}</span>
                          <Badge tone="outline">
                            {s.url ? "HTTP" : "stdio"}
                          </Badge>
                          {s.auth && (
                            <Badge tone="outline">
                              auth: {s.auth === "header" ? "bearer" : s.auth}
                            </Badge>
                          )}
                        </span>
                        <span className="mt-1 d-block break-all fs-6 text-body-secondary">
                          {s.url || [s.command, ...(s.args || [])].join("                ")}
                        </span>
                      </span>
                      <Button
                        size="sm"
                        ghost
                        destructive
                        className="flex-shrink-0"
                        onClick={() => removeMcp(s.name)}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {step === "review" && (
            <div className="stack-3 fs-6">
              <ReviewRow label="Name" value={name.trim() || "—"} />
              <ReviewRow
                label="Description"
                value={description.trim() || "—"}
              />
              <ReviewRow
                label="Model"
                value={pickedModel ? pickedModel.label : "Default (set later)"}
              />
              <ReviewRow
                label="Skills"
                value={
                  keepAll
                    ? "Full default bundle"
                    : `${keptSkills.size} built-in/optional kept` +
                      (hubSkills.length ? ` + ${hubSkills.length} hub` : "")
                }
              />
              {!keepAll && hubSkills.length > 0 && (
                <p className="pl-24 fs-6 text-body-secondary">
                  Hub: {hubSkills.map((s) => s.name).join(", ")}
                </p>
              )}
              {keepAll && hubSkills.length > 0 && (
                <ReviewRow
                  label="Hub skills"
                  value={hubSkills.map((s) => s.name).join(", ")}
                />
              )}
              <ReviewRow
                label="MCP servers"
                value={
                  mcpServers.length
                    ? mcpServers.map((s) => s.name).join(", ")
                    : "None"
                }
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Nav buttons */}
      <div className="d-flex align-items-center justify-content-between">
        <Button
          ghost
          disabled={stepIndex === 0}
          onClick={() => setStep(STEPS[Math.max(0, stepIndex - 1)].id)}
        >
          Back
        </Button>
        {step === "review" ? (
          <Button onClick={handleCreate} disabled={creating || !nameValid}>
            {creating ? "Creating…" : "Create profile"}
          </Button>
        ) : (
          <Button
            disabled={!canAdvance}
            onClick={() =>
              setStep(STEPS[Math.min(STEPS.length - 1, stepIndex + 1)].id)
            }
          >
            Next
          </Button>
        )}
      </div>

      <Toast toast={toast} />
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="d-flex gap-3">
      <span className="w-24 flex-shrink-0 text-body-secondary">{label}</span>
      <span className="flex-grow-1 text-break">{value}</span>
    </div>
  );
}
