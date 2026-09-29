import { useEffect, useLayoutEffect, useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router";
import {
  Package,
  Search,
  Wrench,
  X,
  Cpu,
  Globe,
  Shield,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  Eye,
  Paintbrush,
  Brain,
  Blocks,
  Code,
  Zap,
  Filter,
  Download,
  RefreshCw,
  FileText,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  Loader2,
  Pencil,
  Plus,
} from "lucide-react";
import { api } from "@/lib/api";
import type {
  SkillInfo,
  ToolsetInfo,
  SkillHubResult,
  SkillHubSource,
  SkillHubInstalledEntry,
  SkillHubPreview,
  SkillHubScan,
} from "@/lib/api";
import { useProfileScope } from "@/contexts/useProfileScope";
import { ToolsetConfigDrawer } from "@/components/ToolsetConfigDrawer";
import { SkillEditorDialog } from "@/components/SkillEditorDialog";
import { LoadErrorNotice } from "@/components/LoadErrorNotice";
import { useToast } from "@/ui";
import { Toast } from "@/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui";
import { Badge } from "@/ui";
import { Button } from "@/ui";
import { ListItem } from "@/ui";
import { Spinner } from "@/ui";
import { Switch } from "@/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui";
import { cn } from "@/lib/utils";
import { Input } from "@/ui";
import { useI18n } from "@/i18n";
import { en } from "@/i18n/en";
import { usePageHeader } from "@/contexts/usePageHeader";
import { PluginSlot } from "@/plugins";
import { errorMessage } from "@/lib/api-error";

/* ------------------------------------------------------------------ */
/*  Types & helpers                                                    */
/* ------------------------------------------------------------------ */

const CATEGORY_LABELS: Record<string, string> = {
  mlops: "MLOps",
  "mlops/cloud": "MLOps / Cloud",
  "mlops/evaluation": "MLOps / Evaluation",
  "mlops/inference": "MLOps / Inference",
  "mlops/models": "MLOps / Models",
  "mlops/training": "MLOps / Training",
  "mlops/vector-databases": "MLOps / Vector DBs",
  mcp: "MCP",
  "red-teaming": "Red Teaming",
  ocr: "OCR",
  p5js: "p5.js",
  ai: "AI",
  ux: "UX",
  ui: "UI",
};

function prettyCategory(
  raw: string | null | undefined,
  generalLabel: string,
): string {
  if (!raw) return generalLabel;
  if (CATEGORY_LABELS[raw]) return CATEGORY_LABELS[raw];
  return raw
    .split(/[-_/]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const TOOLSET_ICONS: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
  computer: Cpu,
  web: Globe,
  security: Shield,
  vision: Eye,
  design: Paintbrush,
  ai: Brain,
  integration: Blocks,
  code: Code,
  automation: Zap,
};

function toolsetIcon(
  name: string,
): React.ComponentType<{ className?: string }> {
  const lower = name.toLowerCase();
  for (const [key, icon] of Object.entries(TOOLSET_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return Wrench;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function SkillsPage() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [toolsets, setToolsets] = useState<ToolsetInfo[]>([]);
  const [loading, setLoading] = useState(true);
  // Humanized error from the last skills/toolsets load; drives a persistent
  // Retry notice. `loadNonce` re-runs the load effect on Retry.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"skills" | "toolsets" | "hub">("skills");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [togglingSkills, setTogglingSkills] = useState<Set<string>>(new Set());
  const [configToolset, setConfigToolset] = useState<ToolsetInfo | null>(null);
  // Skill editor dialog: open + which skill is being edited (null = create).
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorSkill, setEditorSkill] = useState<string | null>(null);
  const { toast, showToast } = useToast();
  const { t } = useI18n();
  const { setAfterTitle, setEnd } = usePageHeader();

  // ── Profile scoping ──
  // The write target comes from the GLOBAL profile switcher (sidebar) via
  // ProfileContext — one selector for the whole dashboard, deep-linkable
  // as ?profile=<name>. This page just consumes it: the fetchJSON layer
  // appends the param automatically; we still pass it explicitly where the
  // call signature supports it (clearer, and robust if a caller bypasses
  // the auto-injection).
  const {
    profile: selectedProfile,
  } = useProfileScope();

  useEffect(() => {
    // Promise-chain shape: setState fires only inside async callbacks so the
    // effect body stays lint-clean (react-hooks/set-state-in-effect). On a
    // profile switch the old list stays visible until the new one arrives.
    let cancelled = false;
    Promise.all([
      api.getSkills(selectedProfile || undefined),
      api.getToolsets(selectedProfile || undefined),
    ])
      .then(([s, tsets]) => {
        if (cancelled) return;
        setSkills(s);
        setToolsets(tsets);
        setLoadError(null);
      })
      .catch((e: unknown) => !cancelled && setLoadError(errorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selectedProfile, loadNonce]);

  /* ---- Toggle skill ---- */
  const handleToggleSkill = async (skill: SkillInfo) => {
    setTogglingSkills((prev) => new Set(prev).add(skill.name));
    try {
      await api.toggleSkill(skill.name, !skill.enabled, selectedProfile || undefined);
      setSkills((prev) =>
        prev.map((s) =>
          s.name === skill.name ? { ...s, enabled: !s.enabled } : s,
        ),
      );
      showToast(
        `${skill.name} ${skill.enabled ? t.common.disabled : t.common.enabled}`,
        "success",
      );
    } catch {
      showToast(`${t.common.failedToToggle} ${skill.name}`, "error");
    } finally {
      setTogglingSkills((prev) => {
        const next = new Set(prev);
        next.delete(skill.name);
        return next;
      });
    }
  };

  /* ---- Refresh toolsets after a config change ---- */
  const refreshToolsets = async () => {
    try {
      const tsets = await api.getToolsets(selectedProfile || undefined);
      setToolsets(tsets);
    } catch {
      /* non-fatal: the drawer already toasted on the failing write */
    }
  };

  /* ---- Skill editor (create / edit SKILL.md) ---- */
  const openCreateEditor = useCallback(() => {
    setEditorSkill(null);
    setEditorOpen(true);
  }, []);
  // ── "Learn a skill" panel ──────────────────────────────────────────────
  // Open-ended: dir + URL + free-text inputs are composed into a single-line
  // /learn command and handed to the chat. /learn resolves to a normal agent
  // turn (command.dispatch → send), so the live agent gathers the sources
  // with its own tools and authors the skill via skill_manage. No backend
  // distill endpoint — one code path with the CLI/TUI/gateway /learn.
  const navigate = useNavigate();
  const [learnOpen, setLearnOpen] = useState(false);
  const [learnDir, setLearnDir] = useState("");
  const [learnUrl, setLearnUrl] = useState("");
  const [learnText, setLearnText] = useState("");
  const openLearn = useCallback(() => {
    setLearnDir("");
    setLearnUrl("");
    setLearnText("");
    setLearnOpen(true);
  }, []);
  const submitLearn = useCallback(() => {
    const segs: string[] = [];
    const dir = learnDir.trim();
    const url = learnUrl.trim();
    const text = learnText.trim();
    if (dir) segs.push(`local source: ${dir}`);
    if (url) segs.push(`URL: ${url}`);
    if (text) segs.push(text);
    // Flatten to a single line — the chat composer submits on the first Enter.
    const composed = segs.join("; ").replace(/\s*\n\s*/g, " ").trim();
    if (!composed) return;
    setLearnOpen(false);
    navigate(`/chat?learn=${encodeURIComponent(composed)}`);
  }, [learnDir, learnUrl, learnText, navigate]);
  const openEditEditor = useCallback((skillName: string) => {
    setEditorSkill(skillName);
    setEditorOpen(true);
  }, []);
  const handleEditorSaved = useCallback(
    (skillName: string) => {
      showToast(`${skillName} saved ✓`, "success");
      // Reload the list so a newly created skill (or an edited description)
      // shows up immediately.
      api
        .getSkills(selectedProfile || undefined)
        .then(setSkills)
        .catch(() => {});
    },
    [selectedProfile, showToast],
  );

  /* ---- Derived data ---- */
  const lowerSearch = search.toLowerCase();
  const isSearching = search.trim().length > 0;

  const searchMatchedSkills = useMemo(() => {
    if (!isSearching) return [];
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(lowerSearch) ||
        s.description.toLowerCase().includes(lowerSearch) ||
        (s.category ?? "").toLowerCase().includes(lowerSearch),
    );
  }, [skills, isSearching, lowerSearch]);

  const activeSkills = useMemo(() => {
    if (isSearching) return [];
    if (!activeCategory)
      return [...skills].sort((a, b) => a.name.localeCompare(b.name));
    return skills
      .filter((s) =>
        activeCategory === "__none__"
          ? !s.category
          : s.category === activeCategory,
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [skills, activeCategory, isSearching]);

  const allCategories = useMemo(() => {
    const cats = new Map<string, number>();
    for (const s of skills) {
      const key = s.category || "__none__";
      cats.set(key, (cats.get(key) || 0) + 1);
    }
    return [...cats.entries()]
      .sort((a, b) => {
        if (a[0] === "__none__") return -1;
        if (b[0] === "__none__") return 1;
        return a[0].localeCompare(b[0]);
      })
      .map(([key, count]) => ({
        key,
        name: prettyCategory(key === "__none__" ? null : key, t.common.general),
        count,
      }));
  }, [skills, t]);

  const enabledCount = skills.filter((s) => s.enabled).length;

  useLayoutEffect(() => {
    if (loading) {
      setAfterTitle(null);
      setEnd(null);
      return;
    }
    setAfterTitle(
      <span className="d-flex align-items-center gap-2 text-nowrap fs-6 text-body-secondary">
        {t.skills.enabledOf
          .replace("{enabled}", String(enabledCount))
          .replace("{total}", String(skills.length))}
      </span>,
    );
    setEnd(
      <div className="position-relative w-100 min-w-0 sm:max-w-xs">
        <Search className="position-absolute left-2.5 top-1/2 -translate-y-1/2 icon-sm text-body-secondary" />
        <Input
          className="h-8 rounded-0 pl-8 pr-7 fs-6"
          placeholder={t.common.search}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <Button
            ghost
            size="xs"
            className="position-absolute right-1.5 top-1/2 -translate-y-1/2 text-body-secondary hover:text-foreground"
            onClick={() => setSearch("")}
            aria-label={t.common.clear}
          >
            <X />
          </Button>
        )}
      </div>,
    );
    return () => {
      setAfterTitle(null);
      setEnd(null);
    };
  }, [
    enabledCount,
    loading,
    search,
    setAfterTitle,
    setEnd,
    skills.length,
    t,
  ]);

  const filteredToolsets = useMemo(() => {
    return toolsets.filter(
      (ts) =>
        !search ||
        ts.name.toLowerCase().includes(lowerSearch) ||
        ts.label.toLowerCase().includes(lowerSearch) ||
        ts.description.toLowerCase().includes(lowerSearch),
    );
  }, [toolsets, search, lowerSearch]);

  /* ---- Loading ---- */
  if (loading) {
    return (
      <div className="d-flex align-items-center justify-content-center py-24">
        <Spinner className="fs-3 text-primary" />
      </div>
    );
  }

  return (
    <div className="d-flex flex-column gap-4">
      <PluginSlot name="skills:top" />
      <Toast toast={toast} />

      {loadError && (
        <LoadErrorNotice
          what={t.skills.loadWhat ?? en.skills.loadWhat!}
          detail={loadError}
          onRetry={() => {
            setLoading(true);
            setLoadNonce((n) => n + 1);
          }}
        />
      )}

      <div className="d-flex flex-column sm:flex-row sm:items-start gap-4">
        <aside aria-label={t.skills.title} className="sm:w-56 sm:shrink-0">
          <div className="sm:sticky sm:top-0">
            <div className="d-flex flex-column rounded-0 border border-secondary bg-muted/20">
              <div className="d-none sm:flex align-items-center gap-2 px-3 py-2 border-bottom border-secondary">
                <Filter className="icon-sm text-body-tertiary" />
                <span className="fw-semibold fs-6 tracking-[0.12em] text-body-secondary">
                  {t.skills.filters}
                </span>
              </div>

              <div className="d-flex sm:flex-col gap-1 overflow-x-auto sm:overflow-x-visible scrollbar-none p-2">
                <PanelItem
                  icon={Package}
                  label={`${t.skills.all} (${skills.length})`}
                  active={view === "skills" && !isSearching}
                  onClick={() => {
                    setView("skills");
                    setActiveCategory(null);
                    setSearch("");
                  }}
                />
                <PanelItem
                  icon={Wrench}
                  label={`${t.skills.toolsets} (${toolsets.length})`}
                  active={view === "toolsets"}
                  onClick={() => {
                    setView("toolsets");
                    setSearch("");
                  }}
                />
                <PanelItem
                  icon={Search}
                  label="Browse hub"
                  active={view === "hub"}
                  onClick={() => {
                    setView("hub");
                    setSearch("");
                  }}
                />
              </div>

              {view === "skills" &&
                !isSearching &&
                allCategories.length > 0 && (
                  <div className="d-none sm:flex flex-column border-top border-secondary">
                    <div className="px-3 pt-2 pb-1 fw-semibold fs-6 tracking-[0.12em] text-body-tertiary">
                      {t.skills.categories}
                    </div>
                    <div className="d-flex flex-column p-2 pt-1 gap-px max-h-[calc(100vh-340px)] overflow-y-auto">
                      {allCategories.map(({ key, name, count }) => {
                        const isActive = activeCategory === key;

                        return (
                          <ListItem
                            key={key}
                            active={isActive}
                            onClick={() =>
                              setActiveCategory(isActive ? null : key)
                            }
                            className="rounded-0 px-2 py-1 fs-6"
                          >
                            <span className="flex-grow-1 text-truncate">{name}</span>
                            <span
                              className={`fs-6 tabular-nums ${ isActive ? "text-text-secondary" : "text-text-tertiary" }`}
                            >
                              {count}
                            </span>
                          </ListItem>
                        );
                      })}
                    </div>
                  </div>
                )}
            </div>
          </div>
        </aside>

        <div className="flex-grow-1 min-w-0">
          {isSearching ? (
            <Card className="rounded-0">
              <CardHeader className="py-3 px-4">
                <div className="d-flex align-items-center justify-content-between">
                  <CardTitle className="fs-6 d-flex align-items-center gap-2">
                    <Search className="icon-md" />
                    {t.skills.title}
                  </CardTitle>
                  <Badge tone="secondary" className="fs-6">
                    {t.skills.resultCount
                      .replace("{count}", String(searchMatchedSkills.length))
                      .replace(
                        "{s}",
                        searchMatchedSkills.length !== 1 ? "s" : "",
                      )}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {searchMatchedSkills.length === 0 ? (
                  <p className="fs-6 text-body-secondary text-center py-8">
                    {t.skills.noSkillsMatch}
                  </p>
                ) : (
                  <div className="d-grid gap-1">
                    {searchMatchedSkills.map((skill) => (
                      <SkillRow
                        key={skill.name}
                        skill={skill}
                        toggling={togglingSkills.has(skill.name)}
                        onToggle={() => handleToggleSkill(skill)}
                        onEdit={() => openEditEditor(skill.name)}
                        noDescriptionLabel={t.skills.noDescription}
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ) : view === "skills" ? (
            /* Skills list */
            <Card className="rounded-0">
              <CardHeader className="py-3 px-4">
                <div className="d-flex align-items-center justify-content-between">
                  <CardTitle className="fs-6 d-flex align-items-center gap-2">
                    <Package className="icon-md" />
                    {activeCategory
                      ? prettyCategory(
                          activeCategory === "__none__" ? null : activeCategory,
                          t.common.general,
                        )
                      : t.skills.all}
                  </CardTitle>
                  <div className="d-flex align-items-center gap-2">
                    <Badge tone="secondary" className="fs-6">
                      {t.skills.skillCount
                        .replace("{count}", String(activeSkills.length))
                        .replace("{s}", activeSkills.length !== 1 ? "s" : "")}
                    </Badge>
                    <Button
                      size="sm"
                      outlined
                      onClick={openLearn}
                      prefix={<Sparkles />}
                    >
                      Learn a skill
                    </Button>
                    <Button
                      size="sm"
                      outlined
                      onClick={openCreateEditor}
                      prefix={<Plus />}
                    >
                      New skill
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {loadError ? null : activeSkills.length === 0 ? (
                  <div className="d-flex flex-column align-items-center gap-3 py-8 text-center">
                    <p className="fs-6 text-body-secondary">
                      {skills.length === 0
                        ? t.skills.noSkills
                        : t.skills.noSkillsMatch}
                    </p>
                    {skills.length === 0 && (
                      <div className="d-flex flex-wrap justify-content-center gap-2">
                        <Button size="sm" onClick={() => setView("hub")}>
                          {t.skills.browseHub ?? en.skills.browseHub}
                        </Button>
                        <Button size="sm" outlined onClick={openCreateEditor}>
                          {t.skills.createSkill ?? en.skills.createSkill}
                        </Button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="d-grid gap-1">
                    {activeSkills.map((skill) => (
                      <SkillRow
                        key={skill.name}
                        skill={skill}
                        toggling={togglingSkills.has(skill.name)}
                        onToggle={() => handleToggleSkill(skill)}
                        onEdit={() => openEditEditor(skill.name)}
                        noDescriptionLabel={t.skills.noDescription}
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ) : view === "toolsets" ? (
            /* Toolsets grid */
            <>
              {filteredToolsets.length === 0 ? (
                <Card className="rounded-0">
                  <CardContent className="py-8 text-center fs-6 text-body-secondary">
                    {t.skills.noToolsetsMatch}
                  </CardContent>
                </Card>
              ) : (
                <div className="d-grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {filteredToolsets.map((ts) => {
                    const TsIcon = toolsetIcon(ts.name);
                    const labelText = ts.label.trim() || ts.name;

                    return (
                      <Card key={ts.name} className="position-relative rounded-0">
                        <CardContent className="py-4">
                          <div className="d-flex align-items-start gap-3">
                            <TsIcon className="icon-lg text-body-secondary flex-shrink-0 mt-1" />
                            <div className="flex-grow-1 min-w-0">
                              <div className="d-flex align-items-center gap-2 mb-1">
                                <span className="fw-medium fs-6">
                                  {labelText}
                                </span>
                                <Badge
                                  tone={ts.enabled ? "success" : "outline"}
                                  className="fs-6"
                                >
                                  {ts.enabled
                                    ? t.common.active
                                    : t.common.inactive}
                                </Badge>
                              </div>
                              <p className="fs-6 text-body-secondary mb-2">
                                {ts.description}
                              </p>
                              {ts.enabled && !ts.configured && (
                                <p className="fs-6 text-amber-300 mb-2">
                                  {t.skills.setupNeeded}
                                </p>
                              )}
                              {ts.tools.length > 0 && (
                                <div className="d-flex flex-wrap gap-1">
                                  {ts.tools.map((tool) => (
                                    <Badge
                                      key={tool}
                                      tone="secondary"
                                      className="fs-6 font-monospace"
                                    >
                                      {tool}
                                    </Badge>
                                  ))}
                                </div>
                              )}
                              {ts.tools.length === 0 && (
                                <span className="fs-6 text-body-tertiary">
                                  {ts.enabled
                                    ? t.skills.toolsetLabel.replace(
                                        "{name}",
                                        ts.name,
                                      )
                                    : t.skills.disabledForCli}
                                </span>
                              )}
                              <div className="mt-3">
                                <Button
                                  size="sm"
                                  outlined
                                  onClick={() => setConfigToolset(ts)}
                                  prefix={<Wrench />}
                                >
                                  Configure
                                </Button>
                              </div>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <HubBrowser showToast={showToast} profile={selectedProfile || undefined} />
          )}
        </div>
      </div>
      {configToolset && (
        <ToolsetConfigDrawer
          toolset={configToolset}
          profile={selectedProfile || undefined}
          onClose={() => setConfigToolset(null)}
          onChanged={() => void refreshToolsets()}
        />
      )}
      <SkillEditorDialog
        open={editorOpen}
        editName={editorSkill}
        profile={selectedProfile || undefined}
        onClose={() => setEditorOpen(false)}
        onSaved={handleEditorSaved}
      />
      <Dialog open={learnOpen} onOpenChange={setLearnOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Learn a skill</DialogTitle>
            <DialogDescription>
              Point Hermes at anything and it will distill a reusable skill —
              following the house authoring standards. Fill in any combination
              below; the agent gathers the sources and writes the skill in chat.
            </DialogDescription>
          </DialogHeader>
          <div className="d-grid gap-3 py-2">
            <div className="d-grid gap-2">
              <label className="fs-6 fw-medium text-body-secondary">
                Local file or directory
              </label>
              <Input
                placeholder="~/projects/some-sdk (read with read_file / search_files)"
                value={learnDir}
                onChange={(e) => setLearnDir(e.target.value)}
              />
            </div>
            <div className="d-grid gap-2">
              <label className="fs-6 fw-medium text-body-secondary">
                URL
              </label>
              <Input
                placeholder="https://docs.example.com/api (fetched with web_extract)"
                value={learnUrl}
                onChange={(e) => setLearnUrl(e.target.value)}
              />
            </div>
            <div className="d-grid gap-2">
              <label className="fs-6 fw-medium text-body-secondary">
                Anything else — describe the workflow, paste notes, or say
                "what we just did"
              </label>
              <textarea
                className="min-h-[90px] w-100 rounded-2 border border-input bg-transparent px-3 py-2 fs-6 shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                placeholder="e.g. how I file an expense report: open the portal, …"
                value={learnText}
                onChange={(e) => setLearnText(e.target.value)}
              />
            </div>
          </div>
          <div className="d-flex justify-content-end gap-2 pt-1">
            <Button ghost onClick={() => setLearnOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={submitLearn}
              prefix={<Sparkles />}
              disabled={!learnDir.trim() && !learnUrl.trim() && !learnText.trim()}
            >
              Learn it
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <PluginSlot name="skills:bottom" />
    </div>
  );
}

function SkillRow({
  skill,
  toggling,
  onToggle,
  onEdit,
  noDescriptionLabel,
}: SkillRowProps) {
  return (
    <div className="group d-flex align-items-start gap-3 px-3 py-2.5 transition hover:bg-muted/40">
      <div className="pt-0.5 flex-shrink-0">
        <Switch
          checked={skill.enabled}
          onCheckedChange={onToggle}
          disabled={toggling}
        />
      </div>
      <div className="flex-grow-1 min-w-0">
        <div className="d-flex align-items-center gap-2 mb-1">
          <span
            className={`font-monospace fs-6 ${ skill.enabled ? "text-foreground" : "text-muted-foreground" }`}
          >
            {skill.name}
          </span>
        </div>
        <p className="fs-6 text-body-secondary leading-relaxed line-clamp-2">
          {skill.description || noDescriptionLabel}
        </p>
      </div>
      <Button
        ghost
        size="icon"
        className="flex-shrink-0 text-body-secondary opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground"
        title="Edit SKILL.md"
        aria-label={`Edit ${skill.name}`}
        onClick={onEdit}
      >
        <Pencil />
      </Button>
    </div>
  );
}

function PanelItem({ active, icon: Icon, label, onClick }: PanelItemProps) {
  return (
    <ListItem
      active={active}
      onClick={onClick}
      className={cn(
        "rounded-0 text-nowrap px-2.5 py-2",
        "text-[0.7rem] tracking-[0.08em] text-uppercase",
        active && "bg-foreground/90 text-background hover:text-background",
      )}
    >
      <Icon className="icon-sm flex-shrink-0" />
      <span className="flex-grow-1 text-truncate">{label}</span>
    </ListItem>
  );
}

interface PanelItemProps {
  active: boolean;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}

interface SkillRowProps {
  noDescriptionLabel: string;
  onToggle: () => void;
  onEdit: () => void;
  skill: SkillInfo;
  toggling: boolean;
}

/* ------------------------------------------------------------------ */
/*  Hub browser — search the skill hub, preview, scan, install         */
/* ------------------------------------------------------------------ */

/** Map a trust level to a Badge tone + label + icon. */
function trustVisual(level: string): {
  tone: "success" | "secondary" | "warning" | "outline";
  label: string;
} {
  switch (level) {
    case "trusted":
      return { tone: "success", label: "trusted" };
    case "builtin":
      return { tone: "secondary", label: "builtin" };
    case "community":
      return { tone: "warning", label: "community" };
    default:
      return { tone: "outline", label: level || "unknown" };
  }
}

/** Map a scan verdict to tone + icon. */
function verdictVisual(verdict: string): {
  tone: "success" | "warning" | "destructive";
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
} {
  switch (verdict) {
    case "safe":
      return { tone: "success", Icon: ShieldCheck, label: "Safe" };
    case "caution":
      return { tone: "warning", Icon: ShieldAlert, label: "Caution" };
    case "dangerous":
      return { tone: "destructive", Icon: ShieldAlert, label: "Dangerous" };
    default:
      return { tone: "warning", Icon: ShieldQuestion, label: verdict };
  }
}

const SEVERITY_TONE: Record<string, "destructive" | "warning" | "secondary" | "outline"> = {
  critical: "destructive",
  high: "destructive",
  medium: "warning",
  low: "secondary",
};

function HubBrowser({
  showToast,
  profile,
}: {
  showToast: (msg: string, kind: "success" | "error") => void;
  /** Optional profile scoping installs + installed-state badges. */
  profile?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkillHubResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [sourceCounts, setSourceCounts] = useState<Record<string, number>>({});
  const [timedOut, setTimedOut] = useState<string[]>([]);
  const [searchMs, setSearchMs] = useState<number | null>(null);

  // Landing state: which hubs are wired up + featured skills.
  const [sources, setSources] = useState<SkillHubSource[]>([]);
  const [featured, setFeatured] = useState<SkillHubResult[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);

  // identifier -> installed entry (drives "Installed" badges).
  const [installed, setInstalled] = useState<Record<string, SkillHubInstalledEntry>>({});

  // Live action log for the most recent install/update.
  const [action, setAction] = useState<string | null>(null);
  const [actionLog, setActionLog] = useState<string[]>([]);
  const [actionRunning, setActionRunning] = useState(false);

  // Detail dialog (preview + scan for a single skill).
  const [detail, setDetail] = useState<SkillHubResult | null>(null);

  /* ---- Load connected hubs + featured skills on mount ---- */
  useEffect(() => {
    let cancelled = false;
    api
      .getSkillHubSources(profile)
      .then((r) => {
        if (cancelled) return;
        setSources(r.sources);
        setFeatured(r.featured);
        setInstalled(r.installed);
      })
      .catch(() => {
        /* leave landing minimal on failure */
      })
      .finally(() => {
        if (!cancelled) setSourcesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profile]);

  /* ---- Search ---- */
  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setSearched(true);
    const t0 = performance.now();
    try {
      const r = await api.searchSkillsHub(q, "all", 20, profile);
      setResults(r.results);
      setSourceCounts(r.source_counts || {});
      setTimedOut(r.timed_out || []);
      setInstalled((prev) => ({ ...prev, ...(r.installed || {}) }));
    } catch (e) {
      showToast(`Hub search failed: ${errorMessage(e)}`, "error");
      setResults([]);
      setSourceCounts({});
      setTimedOut([]);
    } finally {
      setSearchMs(Math.round(performance.now() - t0));
      setSearching(false);
    }
  }, [query, showToast, profile]);

  /* ---- Poll a spawned action's log until it exits ---- */
  useEffect(() => {
    if (!action) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const st = await api.getActionStatus(action, 200);
        if (cancelled) return;
        setActionLog(st.lines);
        setActionRunning(st.running);
        if (st.running) {
          timer = setTimeout(poll, 1200);
        } else {
          // Install finished — refresh installed-state so badges update.
          api
            .getSkillHubSources(profile)
            .then((r) => !cancelled && setInstalled(r.installed))
            .catch(() => {});
        }
      } catch {
        if (!cancelled) setActionRunning(false);
      }
    };
    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [action, profile]);

  const install = useCallback(
    async (identifier: string) => {
      try {
        const res = await api.installSkillFromHub(identifier, profile);
        showToast(`Installing ${identifier}…`, "success");
        setActionLog([]);
        setActionRunning(true);
        setAction(res.name);
        setDetail(null);
      } catch (e) {
        showToast(`Install failed: ${errorMessage(e)}`, "error");
      }
    },
    [showToast, profile],
  );

  const updateAll = useCallback(async () => {
    try {
      const res = await api.updateSkillsFromHub(profile);
      showToast("Updating installed skills…", "success");
      setActionLog([]);
      setActionRunning(true);
      setAction(res.name);
    } catch (e) {
      showToast(`Update failed: ${errorMessage(e)}`, "error");
    }
  }, [showToast, profile]);

  const isInstalled = useCallback(
    (identifier: string) => Boolean(installed[identifier]),
    [installed],
  );

  const showLanding = !searched && !searching;

  return (
    <div className="d-flex flex-column gap-3">
      {/* ── Search bar ── */}
      <Card className="rounded-0">
        <CardContent className="py-4 d-flex flex-column gap-3">
          <div className="d-flex align-items-center gap-2">
            <div className="position-relative flex-grow-1">
              <Search className="position-absolute left-2.5 top-1/2 -translate-y-1/2 icon-sm text-body-secondary" />
              <Input
                className="h-8 pl-8 fs-6"
                placeholder="Search the skill hub (GitHub, official, community)…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runSearch();
                }}
              />
            </div>
            <Button
              size="sm"
              onClick={() => void runSearch()}
              disabled={searching || !query.trim()}
              prefix={searching ? <Spinner /> : <Search className="icon-sm" />}
            >
              Search
            </Button>
            <Button
              size="sm"
              outlined
              onClick={() => void updateAll()}
              prefix={<RefreshCw className="icon-sm" />}
            >
              Update all
            </Button>
          </div>

          {/* Connected hubs strip — proves the tab is wired up. */}
          <ConnectedHubs sources={sources} loading={sourcesLoading} />
        </CardContent>
      </Card>

      {/* ── Install/update action log ── */}
      {action && (
        <Card className="rounded-0">
          <CardContent className="py-3">
            <div className="d-flex align-items-center gap-2 mb-2">
              <Download className="icon-sm text-body-secondary" />
              <span className="font-monospace fs-6">{action}</span>
              {actionRunning ? (
                <Badge tone="warning">running</Badge>
              ) : (
                <Badge tone="success">done</Badge>
              )}
              {!actionRunning && (
                <Button
                  ghost
                  size="xs"
                  className="ml-auto text-body-secondary"
                  onClick={() => setAction(null)}
                  aria-label="Dismiss"
                >
                  <X className="icon-sm" />
                </Button>
              )}
            </div>
            <pre className="max-h-48 overflow-auto text-wrap text-break bg-background/50 border border-secondary p-2 fs-6 font-monospace text-body-secondary">
              {actionLog.length ? actionLog.join("\n") : "Starting…"}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* ── Landing: featured skills (before any search) ── */}
      {showLanding && (
        <>
          {sourcesLoading ? (
            <div className="d-flex align-items-center justify-content-center py-12">
              <Spinner className="fs-4 text-primary" />
            </div>
          ) : featured.length > 0 ? (
            <div className="d-flex flex-column gap-2">
              <div className="d-flex align-items-center gap-2 px-1">
                <Sparkles className="icon-sm text-primary" />
                <span className="fw-semibold fs-6 tracking-[0.12em] text-body-secondary text-uppercase">
                  Featured skills
                </span>
                <span className="fs-6 text-body-tertiary">
                  from the Hermes index — search above for thousands more
                </span>
              </div>
              {featured.map((r) => (
                <HubResultCard
                  key={r.identifier}
                  result={r}
                  installed={isInstalled(r.identifier)}
                  onOpen={() => setDetail(r)}
                  onInstall={() => void install(r.identifier)}
                />
              ))}
            </div>
          ) : (
            <Card className="rounded-0">
              <CardContent className="py-10 text-center fs-6 text-body-secondary">
                Search the hub above to browse installable skills from the
                connected sources.
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* ── Searching spinner ── */}
      {searching && (
        <div className="d-flex align-items-center justify-content-center py-8">
          <Spinner className="fs-4 text-primary" />
        </div>
      )}

      {/* ── Search results ── */}
      {!searching && searched && (
        <>
          <SearchMeta
            count={results.length}
            sourceCounts={sourceCounts}
            timedOut={timedOut}
            ms={searchMs}
          />
          {results.length === 0 ? (
            <Card className="rounded-0">
              <CardContent className="py-8 text-center fs-6 text-body-secondary">
                No matching skills found in the hub.
              </CardContent>
            </Card>
          ) : (
            results.map((r) => (
              <HubResultCard
                key={r.identifier}
                result={r}
                installed={isInstalled(r.identifier)}
                onOpen={() => setDetail(r)}
                onInstall={() => void install(r.identifier)}
              />
            ))
          )}
        </>
      )}

      {/* ── Detail dialog: preview + scan ── */}
      {detail && (
        <SkillDetailDialog
          result={detail}
          installed={isInstalled(detail.identifier)}
          onClose={() => setDetail(null)}
          onInstall={() => void install(detail.identifier)}
          showToast={showToast}
        />
      )}
    </div>
  );
}

/* ---- Connected hubs strip ---- */
function ConnectedHubs({
  sources,
  loading,
}: {
  sources: SkillHubSource[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <p className="fs-6 text-body-secondary">Connecting to skill hubs…</p>
    );
  }
  if (sources.length === 0) {
    return (
      <p className="fs-6 text-body-secondary">
        Results come from the same sources as{"                                "}
        <span className="font-monospace">hermes skills search</span>.
      </p>
    );
  }
  return (
    <div className="d-flex flex-wrap align-items-center gap-2">
      <span className="d-flex align-items-center gap-1 fs-6 text-body-tertiary">
        <Globe className="icon-sm" />
        Connected hubs:
      </span>
      {sources.map((s) => {
        const down =
          (s.id === "hermes-index" && s.available === false) ||
          (s.id === "github" && s.rate_limited === true);
        return (
          <Badge
            key={s.id}
            tone={down ? "outline" : "secondary"}
            className={cn("fs-6", down && "opacity-60")}
            title={
              s.id === "github" && s.rate_limited
                ? "GitHub API rate-limited — set GITHUB_TOKEN to raise the limit"
                : s.id === "hermes-index" && s.available === false
                  ? "Centralized index unavailable — falling back to live sources"
                  : undefined
            }
          >
            {s.label}
            {s.id === "github" && s.rate_limited ? " (rate-limited)" : ""}
          </Badge>
        );
      })}
    </div>
  );
}

/* ---- Search result-count + per-source breakdown ---- */
function SearchMeta({
  count,
  sourceCounts,
  timedOut,
  ms,
}: {
  count: number;
  sourceCounts: Record<string, number>;
  timedOut: string[];
  ms: number | null;
}) {
  const entries = Object.entries(sourceCounts).filter(([, n]) => n > 0);
  return (
    <div className="d-flex flex-wrap align-items-center gap-2 px-1 fs-6 text-body-tertiary">
      <Badge tone="secondary" className="fs-6">
        {count} result{count !== 1 ? "s" : ""}
      </Badge>
      {ms != null && <span>{(ms / 1000).toFixed(1)}s</span>}
      {entries.length > 0 && (
        <span className="d-flex flex-wrap align-items-center gap-2">
          {entries.map(([sid, n]) => (
            <span key={sid} className="font-monospace">
              {sid}:{n}
            </span>
          ))}
        </span>
      )}
      {timedOut.length > 0 && (
        <span className="d-flex align-items-center gap-1 text-amber-400">
          <AlertTriangle className="icon-sm" />
          {timedOut.join(", ")} timed out
        </span>
      )}
    </div>
  );
}

/* ---- One result card ---- */
function HubResultCard({
  result,
  installed,
  onOpen,
  onInstall,
}: {
  result: SkillHubResult;
  installed: boolean;
  onOpen: () => void;
  onInstall: () => void;
}) {
  const trust = trustVisual(result.trust_level);
  return (
    <Card className="rounded-0 transition hover:bg-muted/30">
      <CardContent className="py-3 d-flex align-items-start gap-3">
        <button
          type="button"
          className="flex-grow-1 min-w-0 text-start"
          onClick={onOpen}
          aria-label={`Open ${result.name}`}
        >
          <div className="d-flex flex-wrap align-items-center gap-2 mb-1">
            <span className="font-monospace fs-6 hover:underline">
              {result.name}
            </span>
            <Badge tone={trust.tone} className="fs-6">
              {trust.label}
            </Badge>
            <Badge tone="secondary" className="fs-6">
              {result.source}
            </Badge>
            {installed && (
              <Badge tone="success" className="fs-6">
                installed
              </Badge>
            )}
          </div>
          <p className="fs-6 text-body-secondary line-clamp-2">
            {result.description}
          </p>
          <div className="d-flex flex-wrap align-items-center gap-1 mt-1">
            {result.tags.slice(0, 5).map((tag) => (
              <span
                key={tag}
                className="text-[0.65rem] font-monospace text-body-tertiary border border-secondary px-1 py-px"
              >
                {tag}
              </span>
            ))}
          </div>
          <p className="fs-6 font-monospace text-body-tertiary text-truncate mt-1">
            {result.identifier}
          </p>
        </button>
        <div className="d-flex flex-shrink-0 flex-column gap-2">
          <Button
            size="sm"
            outlined
            onClick={onOpen}
            prefix={<FileText className="icon-sm" />}
          >
            Details
          </Button>
          {installed ? (
            <Button size="sm" ghost disabled prefix={<CheckCircle2 className="icon-sm" />}>
              Installed
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={onInstall}
              prefix={<Download className="icon-sm" />}
            >
              Install
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* ---- Detail dialog: SKILL.md preview + on-demand security scan ---- */
function SkillDetailDialog({
  result,
  installed,
  onClose,
  onInstall,
  showToast,
}: {
  result: SkillHubResult;
  installed: boolean;
  onClose: () => void;
  onInstall: () => void;
  showToast: (msg: string, kind: "success" | "error") => void;
}) {
  const [tab, setTab] = useState<"readme" | "scan">("readme");
  const [preview, setPreview] = useState<SkillHubPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [scan, setScan] = useState<SkillHubScan | null>(null);
  const [scanning, setScanning] = useState(false);
  const trust = trustVisual(result.trust_level);

  useEffect(() => {
    let cancelled = false;
    setPreviewLoading(true);
    api
      .previewSkillFromHub(result.identifier)
      .then((p) => !cancelled && setPreview(p))
      .catch((e) => {
        if (!cancelled) showToast(`Preview failed: ${errorMessage(e)}`, "error");
      })
      .finally(() => !cancelled && setPreviewLoading(false));
    return () => {
      cancelled = true;
    };
  }, [result.identifier, showToast]);

  const runScan = useCallback(async () => {
    setScanning(true);
    setTab("scan");
    try {
      const s = await api.scanSkillFromHub(result.identifier);
      setScan(s);
    } catch (e) {
      showToast(`Scan failed: ${errorMessage(e)}`, "error");
    } finally {
      setScanning(false);
    }
  }, [result.identifier, showToast]);

  return (
    <Dialog open onOpenChange={(o: boolean) => !o && onClose()}>
      <DialogContent className="max-w-3xl rounded-0">
        <DialogHeader>
          <DialogTitle className="d-flex flex-wrap align-items-center gap-2 fs-6">
            <Package className="icon-md" />
            {result.name}
            <Badge tone={trust.tone} className="fs-6">
              {trust.label}
            </Badge>
            <Badge tone="secondary" className="fs-6">
              {result.source}
            </Badge>
            {installed && (
              <Badge tone="success" className="fs-6">
                installed
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Preview the SKILL.md source and run a security scan for {result.name}{"                                "}
            before installing.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-1 d-flex flex-column gap-1">
          <p className="fs-6 text-body-secondary">{result.description}</p>
          <p className="fs-6 font-monospace text-body-tertiary text-truncate">
            {result.identifier}
          </p>
        </div>

        {/* Action row */}
        <div className="mt-3 d-flex flex-wrap align-items-center gap-2 border-y border-secondary py-2.5">
          <Button
            size="sm"
            outlined={tab !== "readme"}
            onClick={() => setTab("readme")}
            prefix={<FileText className="icon-sm" />}
          >
            Read SKILL.md
          </Button>
          <Button
            size="sm"
            outlined={tab !== "scan"}
            onClick={() => void runScan()}
            disabled={scanning}
            prefix={
              scanning ? (
                <Loader2 className="icon-sm animate-spin" />
              ) : (
                <Shield className="icon-sm" />
              )
            }
          >
            {scan ? "Re-scan" : "Security scan"}
          </Button>
          <div className="ml-auto d-flex align-items-center gap-3">
            {result.repo && (
              <a
                href={`https://github.com/${result.repo}`}
                target="_blank"
                rel="noreferrer"
                className="d-inline-flex align-items-center gap-1 fs-6 text-primary hover:underline"
              >
                <ExternalLink className="icon-sm" />
                {result.repo}
              </a>
            )}
            {installed ? (
              <Button size="sm" ghost disabled prefix={<CheckCircle2 className="icon-sm" />}>
                Installed
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={onInstall}
                prefix={<Download className="icon-sm" />}
              >
                Install
              </Button>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="mt-3 max-h-[55vh] overflow-auto">
          {tab === "readme" ? (
            previewLoading ? (
              <div className="d-flex align-items-center justify-content-center py-12">
                <Spinner className="fs-4 text-primary" />
              </div>
            ) : preview ? (
              <div className="d-flex flex-column gap-2.5">
                {preview.tags.length > 0 && (
                  <div className="d-flex flex-wrap align-items-center gap-1">
                    {preview.tags.map((tag) => (
                      <span
                        key={tag}
                        className="text-[0.65rem] font-monospace text-body-tertiary border border-secondary px-1 py-px"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                {preview.files.length > 0 && (
                  <div className="fs-6 text-body-tertiary">
                    <span className="tracking-[0.1em] text-uppercase">
                      Files:{"                                "}
                    </span>
                    <span className="font-monospace">{preview.files.join("                                                                                                                                                                                                                                                                ")}</span>
                  </div>
                )}
                <pre className="text-wrap text-break bg-background/50 border border-secondary p-3 fs-6 font-monospace text-body-secondary leading-relaxed">
                  {(preview.skill_md || "").trim() || "(SKILL.md is empty)"}
                </pre>
              </div>
            ) : (
              <p className="fs-6 text-body-secondary text-center py-10">
                Couldn't load the skill source.
              </p>
            )
          ) : (
            <ScanPanel scan={scan} scanning={scanning} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ---- Visual security-scan result ---- */
function ScanPanel({
  scan,
  scanning,
}: {
  scan: SkillHubScan | null;
  scanning: boolean;
}) {
  if (scanning && !scan) {
    return (
      <div className="d-flex flex-column align-items-center justify-content-center gap-2 py-12">
        <Loader2 className="icon-xl animate-spin text-primary" />
        <span className="fs-6 text-body-secondary">
          Fetching, quarantining, and scanning…
        </span>
      </div>
    );
  }
  if (!scan) {
    return (
      <p className="fs-6 text-body-secondary text-center py-10">
        Run a security scan to inspect this skill for risky patterns before
        installing.
      </p>
    );
  }

  const v = verdictVisual(scan.verdict);
  const policyTone =
    scan.policy === "allow"
      ? "success"
      : scan.policy === "ask"
        ? "warning"
        : "destructive";
  const policyLabel =
    scan.policy === "allow"
      ? "Install allowed"
      : scan.policy === "ask"
        ? "Needs confirmation"
        : "Install blocked";

  return (
    <div className="d-flex flex-column gap-3">
      {/* Verdict header */}
      <div className="d-flex flex-wrap align-items-center gap-2 border border-secondary p-3">
        <v.Icon
          className={cn(
            "icon-xl",
            scan.verdict === "safe"
              ? "text-emerald-400"
              : scan.verdict === "dangerous"
                ? "text-red-400"
                : "text-amber-400",
          )}
        />
        <div className="d-flex flex-column">
          <div className="d-flex align-items-center gap-2">
            <span className="fs-6 fw-medium">Verdict: {v.label}</span>
            <Badge tone={v.tone} className="fs-6">
              {scan.verdict}
            </Badge>
          </div>
          <span className="fs-6 text-body-tertiary">
            {scan.trust_level} source · {scan.findings.length} finding
            {scan.findings.length !== 1 ? "s" : ""}
          </span>
        </div>
        <Badge tone={policyTone} className="ml-auto fs-6">
          {policyLabel}
        </Badge>
      </div>

      {/* Severity tally */}
      <div className="d-flex flex-wrap align-items-center gap-2">
        {(["critical", "high", "medium", "low"] as const).map((sev) => {
          const n = scan.severity_counts[sev] || 0;
          if (n === 0) return null;
          return (
            <Badge key={sev} tone={SEVERITY_TONE[sev]} className="fs-6">
              {n} {sev}
            </Badge>
          );
        })}
        {scan.findings.length === 0 && (
          <span className="d-flex align-items-center gap-1 fs-6 text-emerald-400">
            <CheckCircle2 className="icon-sm" />
            No risky patterns detected
          </span>
        )}
      </div>

      <p className="fs-6 text-body-tertiary">{scan.policy_reason}</p>

      {/* Findings */}
      {scan.findings.length > 0 && (
        <div className="d-flex flex-column border border-secondary divide-y divide-border">
          {scan.findings.map((f, i) => (
            <div key={i} className="d-flex align-items-start gap-2 p-2">
              <Badge tone={SEVERITY_TONE[f.severity] || "outline"} className="fs-6 flex-shrink-0">
                {f.severity}
              </Badge>
              <div className="flex-grow-1 min-w-0">
                <div className="d-flex flex-wrap align-items-center gap-2">
                  <span className="fs-6 fw-medium">{f.category}</span>
                  <span className="fs-6 font-monospace text-body-tertiary text-truncate">
                    {f.file}:{f.line}
                  </span>
                </div>
                <p className="fs-6 text-body-secondary">{f.description}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
