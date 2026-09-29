import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Routes,
  Route,
  NavLink,
  Navigate,
  useLocation,
} from "react-router";
import {
  Activity,
  BarChart3,
  BookOpen,
  ChevronDown,
  Clock,
  Code,
  Cpu,
  Database,
  Eye,
  FolderOpen,
  FileText,
  Gauge,
  Globe,
  Heart,
  Kanban,
  LayoutTemplate,
  Moon,
  KeyRound,
  LayoutGrid,
  Menu,
  MessageSquare,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Puzzle,
  Radio,
  Settings,
  Shield,
  ShieldCheck,
  Server,
  Sparkles,
  Square,
  Star,
  Store,
  Stethoscope,
  Terminal,
  Users,
  Webhook,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@/ui";
import { SelectionSwitcher } from "@/ui";
import { Spinner } from "@/ui";
import { Typography } from "@/ui";
import { cn } from "@/lib/utils";
import { TopBar } from "@/components/TopBar";
import { useBelowBreakpoint } from "@/ui";
import { useSidebarStatus } from "@/hooks/useSidebarStatus";
import { AuthWidget } from "@/components/AuthWidget";
import { PageHeaderProvider } from "@/contexts/PageHeaderProvider";
import { ProfileProvider } from "@/contexts/ProfileProvider";
import { useProfileScope } from "@/contexts/useProfileScope";
import { ProfileSwitcher } from "@/components/ProfileSwitcher";
import { ProfileScopeBanner } from "@/components/ProfileScopeBanner";
import { MemoryPressureBanner } from "@/components/MemoryPressureBanner";
import { MultiplexStandaloneBanner } from "@/components/MultiplexStandaloneBanner";
// Route pages are lazy-loaded so the initial dashboard shell does not pay for
// every admin surface (and heavy deps like xterm) up front.
const ConfigPage = lazy(() => import("@/pages/ConfigPage"));
const DocsPage = lazy(() => import("@/pages/DocsPage"));
const EnvPage = lazy(() => import("@/pages/EnvPage"));
const FilesPage = lazy(() => import("@/pages/FilesPage"));
const SessionsPage = lazy(() => import("@/pages/SessionsPage"));
const LogsPage = lazy(() => import("@/pages/LogsPage"));
const AnalyticsPage = lazy(() => import("@/pages/AnalyticsPage"));
const ModelsPage = lazy(() => import("@/pages/ModelsPage"));
const CronPage = lazy(() => import("@/pages/CronPage"));
const ProfilesPage = lazy(() => import("@/pages/ProfilesPage"));
const ProfileBuilderPage = lazy(() => import("@/pages/ProfileBuilderPage"));
const SkillsPage = lazy(() => import("@/pages/SkillsPage"));
const PluginsPage = lazy(() => import("@/pages/PluginsPage"));
const McpPage = lazy(() => import("@/pages/McpPage"));
const PairingPage = lazy(() => import("@/pages/PairingPage"));
const ChannelsPage = lazy(() => import("@/pages/ChannelsPage"));
const WebhooksPage = lazy(() => import("@/pages/WebhooksPage"));
const SystemPage = lazy(() => import("@/pages/SystemPage"));
const DashboardPage = lazy(() => import("@/pages/DashboardPage"));
const ChatPage = lazy(() => import("@/pages/ChatPage"));
const KanbanMainPage = lazy(() => import("@/pages/KanbanMainPage"));
const KanbanFleetDashboardPage = lazy(() =>
  import("@/pages/FleetSections").then((m) => ({ default: m.KanbanFleetDashboardPage })),
);
const KanbanTemplateBuilderPage = lazy(() =>
  import("@/pages/FleetSections").then((m) => ({ default: m.KanbanTemplateBuilderPage })),
);
const ServersListPage = lazy(() =>
  import("@/pages/FleetSections").then((m) => ({ default: m.ServersListPage })),
);
const ServerWakePage = lazy(() =>
  import("@/pages/FleetSections").then((m) => ({ default: m.ServerWakePage })),
);
const ServerLogsPage = lazy(() =>
  import("@/pages/FleetSections").then((m) => ({ default: m.ServerLogsPage })),
);
const ServerDoctorPage = lazy(() =>
  import("@/pages/FleetSections").then((m) => ({ default: m.ServerDoctorPage })),
);
const MarketplaceViewPage = lazy(() =>
  import("@/pages/FleetSections").then((m) => ({ default: m.MarketplaceViewPage })),
);
const MarketplaceSetupPage = lazy(() =>
  import("@/pages/FleetSections").then((m) => ({ default: m.MarketplaceSetupPage })),
);
import { useI18n } from "@/i18n";
import type { Translations } from "@/i18n/types";
import { PluginPage, PluginSlot, usePlugins } from "@/plugins";
import type { PluginManifest } from "@/plugins";
import { useTheme } from "@/themes";
import { isDashboardEmbeddedChatEnabled } from "@/lib/dashboard-flags";
import { latchChatActivation } from "@/lib/chat-activation";
import { api } from "@/lib/api";

function RouteFallback({ label = "Loading…" }: { label?: string }) {
  return (
    <div
      className="d-flex min-h-[12rem] flex-grow-1 align-items-center justify-content-center"
      aria-busy="true"
      aria-live="polite"
    >
      <div className="d-flex align-items-center gap-2 fs-6 text-body-secondary">
        <Spinner />
        <span>{label}</span>
      </div>
    </div>
  );
}


function UnknownRouteFallback({ pluginsLoading }: { pluginsLoading: boolean }) {
  if (pluginsLoading) {
    // Render nothing during the plugin-load window — a spinner here would just flash.
    return null;
  }
  return <Navigate to="/sessions" replace />;
}

const CHAT_NAV_ITEM: NavItem = {
  path: "/chat",
  labelKey: "chat",
  label: "Chat",
  icon: Terminal,
  group: "workspace",
  accent: "primary",
};

/**
 * Built-in routes except /chat.  Chat is rendered persistently (outside
 * <Routes>) when embedded — see the persistent chat host block rendered
 * inline near the bottom of this file — so the PTY child, WebSocket,
 * and xterm instance survive when the user visits another tab and comes
 * back.  A `display:none` toggle hides the terminal without unmounting.
 * The host itself is still deferred until the first /chat visit so the
 * xterm chunk is not downloaded on unrelated pages.  Routing still owns
 * the URL so /chat deep-links, browser back/forward, and nav highlight
 * keep working.
 */
const BUILTIN_ROUTES_CORE: Record<string, ComponentType> = {
  "/": DashboardPage,
  "/sessions": SessionsPage,
  "/files": FilesPage,
  "/analytics": AnalyticsPage,
  "/models": ModelsPage,
  "/logs": LogsPage,
  "/cron": CronPage,
  "/skills": SkillsPage,
  "/plugins": PluginsPage,
  "/mcp": McpPage,
  "/pairing": PairingPage,
  "/channels": ChannelsPage,
  "/webhooks": WebhooksPage,
  "/system": SystemPage,
  "/profiles": ProfilesPage,
  "/profiles/new": ProfileBuilderPage,
  "/config": ConfigPage,
  "/env": EnvPage,
  "/docs": DocsPage,
  "/kanban": KanbanMainPage,
  "/kanban/fleet": KanbanFleetDashboardPage,
  "/kanban/templates": KanbanTemplateBuilderPage,
  "/servers": ServersListPage,
  "/servers/wakeup": ServerWakePage,
  "/servers/logs": ServerLogsPage,
  "/servers/doctor": ServerDoctorPage,
  "/marketplace": MarketplaceViewPage,
  "/marketplace/setup": MarketplaceSetupPage,
  // The board was previewed here before the desk section existed; anyone
  // holding the old link lands on the same board.
  "/kanban-preview": KanbanMainPage,
};

// Route placeholder for /chat.  The persistent ChatPage host (rendered
// outside <Routes> when embedded chat is on) paints on top; this empty
// element just claims the path so the `*` catch-all redirect doesn't
// fire when the user navigates to /chat.
function ChatRouteSink() {
  return null;
}

/**
 * The rail's sections, in the order they appear.
 *
 * Grouping is what makes a fifteen-item rail scannable: "where do
 * automations live" should not mean reading every label to find out.
 */
const NAV_GROUPS: NavGroup[] = [
  {
    id: "workspace",
    label: "Workspace",
    accent: "primary",
    icon: LayoutGrid,
  },
  { id: "models", label: "Models & Data", accent: "info", icon: Cpu },
  {
    id: "desk",
    label: "Kanban Desk",
    accent: "primary",
    icon: Kanban,
  },
  { id: "servers", label: "Servers", accent: "info", icon: Server },
  { id: "marketplace", label: "Marketplace", accent: "success", icon: Store },
  {
    id: "automation",
    label: "Automation",
    accent: "success",
    icon: Zap,
  },
  {
    id: "extensions",
    label: "Extensions",
    accent: "warning",
    icon: Puzzle,
  },
  { id: "plugins", label: "Plugins", accent: "danger", icon: Plug },
  { id: "system", label: "System", accent: "secondary", icon: Wrench },
];

const BUILTIN_NAV_REST: NavItem[] = [
  {
    path: "/kanban/fleet",
    label: "Dashboard флота",
    icon: Gauge,
    group: "desk",
    accent: "primary",
  },
  {
    path: "/kanban",
    label: "Main",
    icon: Kanban,
    group: "desk",
    accent: "primary",
  },
  {
    path: "/kanban/templates",
    label: "Конструктор шаблонов",
    icon: LayoutTemplate,
    group: "desk",
    accent: "primary",
  },
  {
    path: "/servers",
    label: "List",
    icon: Server,
    group: "servers",
    accent: "info",
  },
  {
    path: "/servers/wakeup",
    label: "WakeUp new",
    icon: Moon,
    group: "servers",
    accent: "info",
  },
  {
    path: "/servers/logs",
    label: "Logs",
    icon: FileText,
    group: "servers",
    accent: "info",
  },
  {
    path: "/servers/doctor",
    label: "Doctor",
    icon: Stethoscope,
    group: "servers",
    accent: "info",
  },
  {
    path: "/marketplace",
    label: "view",
    icon: Store,
    group: "marketplace",
    accent: "success",
  },
  {
    path: "/marketplace/setup",
    label: "Setup",
    icon: Square,
    group: "marketplace",
    accent: "success",
  },

  {
    path: "/",
    label: "Dashboard",
    icon: Gauge,
    group: "workspace",
    accent: "primary",
  },
  {
    path: "/sessions",
    labelKey: "sessions",
    label: "Sessions",
    icon: MessageSquare,
    group: "workspace",
    accent: "primary",
  },
  {
    path: "/files",
    label: "Files",
    icon: FolderOpen,
    group: "workspace",
    accent: "primary",
  },
  {
    path: "/logs",
    labelKey: "logs",
    label: "Logs",
    icon: FileText,
    group: "workspace",
    accent: "primary",
  },
  {
    path: "/models",
    labelKey: "models",
    label: "Models",
    icon: Cpu,
    group: "models",
    accent: "info",
  },
  {
    path: "/analytics",
    labelKey: "analytics",
    label: "Analytics",
    icon: BarChart3,
    group: "models",
    accent: "info",
  },
  {
    path: "/cron",
    labelKey: "cron",
    label: "Cron",
    icon: Clock,
    group: "automation",
    accent: "success",
  },
  {
    path: "/channels",
    label: "Channels",
    icon: Radio,
    group: "automation",
    accent: "success",
  },
  {
    path: "/webhooks",
    label: "Webhooks",
    icon: Webhook,
    group: "automation",
    accent: "success",
  },
  {
    path: "/plugins",
    labelKey: "plugins",
    label: "Plugins",
    icon: Puzzle,
    group: "extensions",
    accent: "warning",
  },
  {
    path: "/skills",
    labelKey: "skills",
    label: "Skills",
    icon: Package,
    group: "extensions",
    accent: "warning",
  },
  { path: "/mcp", label: "MCP", icon: Plug, group: "extensions", accent: "warning" },
  {
    path: "/profiles",
    labelKey: "profiles",
    label: "Profiles",
    icon: Users,
    group: "system",
    accent: "secondary",
  },
  {
    path: "/pairing",
    label: "Pairing",
    icon: ShieldCheck,
    group: "system",
    accent: "secondary",
  },
  {
    path: "/config",
    labelKey: "config",
    label: "Config",
    icon: Settings,
    group: "system",
    accent: "secondary",
  },
  {
    path: "/env",
    labelKey: "keys",
    label: "Keys",
    icon: KeyRound,
    group: "system",
    accent: "secondary",
  },
  {
    path: "/system",
    label: "System",
    icon: Wrench,
    group: "system",
    accent: "secondary",
  },
  {
    path: "/docs",
    labelKey: "documentation",
    label: "Documentation",
    icon: BookOpen,
    group: "system",
    accent: "secondary",
  },
];

const ICON_MAP: Record<string, ComponentType<{ className?: string }>> = {
  Activity,
  BarChart3,
  Clock,
  Cpu,
  FileText,
  FolderOpen,
  Kanban,
  KeyRound,
  MessageSquare,
  Package,
  Settings,
  Puzzle,
  Sparkles,
  Terminal,
  Globe,
  Database,
  Shield,
  Users,
  Wrench,
  Zap,
  Heart,
  Star,
  Code,
  Eye,
};

function resolveIcon(name: string): ComponentType<{ className?: string }> {
  return ICON_MAP[name] ?? Puzzle;
}

function buildNavItems(
  builtIn: NavItem[],
  manifests: PluginManifest[],
): NavItem[] {
  const items = [...builtIn];

  for (const manifest of manifests) {
    if (manifest.tab.override) continue;
    if (manifest.tab.hidden) continue;

    const pluginItem: NavItem = {
      path: manifest.tab.path,
      label: manifest.label,
      icon: resolveIcon(manifest.icon),
      // Plugin tabs have no group of their own — they are rendered in
      // their own section at the foot of the rail — but they still need
      // an icon tint, and the accent of the section they are shown in
      // is the one that reads correctly next to it.
      group: "plugins",
      accent: "danger",
    };

    const pos = manifest.tab.position ?? "end";
    if (pos === "end") {
      items.push(pluginItem);
    } else if (pos.startsWith("after:")) {
      const target = "/" + pos.slice(6);
      const idx = items.findIndex((i) => i.path === target);
      items.splice(idx >= 0 ? idx + 1 : items.length, 0, pluginItem);
    } else if (pos.startsWith("before:")) {
      const target = "/" + pos.slice(7);
      const idx = items.findIndex((i) => i.path === target);
      items.splice(idx >= 0 ? idx : items.length, 0, pluginItem);
    } else {
      items.push(pluginItem);
    }
  }

  return items;
}

/** Split merged nav into built-in sidebar entries vs plugin tabs, preserving plugin order hints. */
function partitionSidebarNav(
  builtIn: NavItem[],
  manifests: PluginManifest[],
): { coreItems: NavItem[]; pluginItems: NavItem[] } {
  const merged = buildNavItems(builtIn, manifests);
  const builtinPaths = new Set(builtIn.map((i) => i.path));
  const coreItems: NavItem[] = [];
  const pluginItems: NavItem[] = [];
  for (const item of merged) {
    if (builtinPaths.has(item.path)) coreItems.push(item);
    else pluginItems.push(item);
  }
  return { coreItems, pluginItems };
}

function buildRoutes(
  builtinRoutes: Record<string, ComponentType>,
  manifests: PluginManifest[],
): Array<{
  key: string;
  path: string;
  element: ReactNode;
}> {
  const byOverride = new Map<string, PluginManifest>();
  const addons: PluginManifest[] = [];

  for (const m of manifests) {
    if (m.tab.override) {
      byOverride.set(m.tab.override, m);
    } else {
      addons.push(m);
    }
  }

  const routes: Array<{
    key: string;
    path: string;
    element: ReactNode;
  }> = [];

  for (const [path, Component] of Object.entries(builtinRoutes)) {
    const om = byOverride.get(path);
    if (om) {
      routes.push({
        key: `override:${om.name}`,
        path,
        element: <PluginPage name={om.name} />,
      });
    } else {
      routes.push({ key: `builtin:${path}`, path, element: <Component /> });
    }
  }

  for (const m of addons) {
    if (m.tab.hidden) continue;
    if (m.tab.path === "/plugins") continue;
    if (builtinRoutes[m.tab.path]) continue;
    routes.push({
      key: `plugin:${m.name}`,
      path: m.tab.path,
      element: <PluginPage name={m.name} />,
    });
  }

  for (const m of manifests) {
    if (!m.tab.hidden) continue;
    if (m.tab.path === "/plugins") continue;
    if (builtinRoutes[m.tab.path] || m.tab.override) continue;
    routes.push({
      key: `plugin:hidden:${m.name}`,
      path: m.tab.path,
      element: <PluginPage name={m.name} />,
    });
  }

  return routes;
}

const SIDEBAR_COLLAPSED_KEY = "hermes-sidebar-collapsed";

export default function App() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const { manifests, loading: pluginsLoading } = usePlugins();
  const { theme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      } catch { /* localStorage may be unavailable in private browsing */ }
      return next;
    });
  }, []);
  const isMobile = useBelowBreakpoint(1024);
  const isDesktopCollapsed = collapsed && !isMobile;
  const tooltipWarmRef = useRef(0);
  const sidebarStatus = useSidebarStatus();
  const isDocsRoute = pathname === "/docs" || pathname === "/docs/";
  const normalizedPath = pathname.replace(/\/$/, "") || "/";
  /*
   * The dashboard's wash is the main column's background, which means the
   * route has to be known here rather than inside the page. Painted any
   * lower it stops at the content's padding, leaving flat bands above, on
   * both sides and below.
   */
  const isDashboardRoute = normalizedPath === "/";
  const isChatRoute = normalizedPath === "/chat";
  const embeddedChat = isDashboardEmbeddedChatEnabled();
  // Defer mounting the persistent chat host (and its xterm chunk) until the
  // user has actually opened /chat at least once. Sticky after that so the
  // PTY survives later tab switches.
  const [chatHostMounted, setChatHostMounted] = useState(isChatRoute);
  useEffect(() => {
    setChatHostMounted((prev) => latchChatActivation(prev, isChatRoute));
  }, [isChatRoute]);

  // `dashboard.show_token_analytics` gates the Analytics nav item.  The
  // page itself remains reachable by URL (it renders an explanation when
  // the flag is off — see AnalyticsPage), but hiding the nav entry avoids
  // surfacing misleading token/cost numbers in the sidebar.  Default off.
  const [showTokenAnalytics, setShowTokenAnalytics] = useState(false);
  useEffect(() => {
    api
      .getConfig()
      .then((cfg) => {
        const dash = (cfg?.dashboard ?? {}) as {
          show_token_analytics?: unknown;
        };
        setShowTokenAnalytics(dash.show_token_analytics === true);
      })
      .catch(() => setShowTokenAnalytics(false));
  }, []);

  // A plugin can replace the built-in /chat page via `tab.override: "/chat"`
  // in its manifest.  When one does, `buildRoutes` already swaps the route
  // element for <PluginPage /> — but we also have to suppress the
  // persistent ChatPage host below, or the plugin's page and the built-in
  // terminal would paint on top of each other.  The override is niche
  // (nothing ships overriding /chat today) but it's an advertised
  // extension point, so preserve the pre-persistence contract: when a
  // plugin owns /chat, the built-in chat UI is entirely absent.
  //
  // Waiting on `pluginsLoading` is load-bearing: manifests arrive
  // asynchronously from /api/dashboard/plugins, so on initial render
  // `chatOverriddenByPlugin` is always false.  Without the loading
  // gate, the persistent host would mount, spawn a PTY, and THEN get
  // yanked out from under the user when the plugin's manifest resolves
  // — killing the session mid-paint.  Delaying host mount by the
  // plugin-load window (typically <50ms, worst case 2s safety timeout)
  // is the cheaper trade-off.
  const chatOverriddenByPlugin = useMemo(
    () => manifests.some((m) => m.tab.override === "/chat"),
    [manifests],
  );

  const builtinRoutes = useMemo(
    () => ({
      ...BUILTIN_ROUTES_CORE,
      ...(embeddedChat ? { "/chat": ChatRouteSink } : {}),
    }),
    [embeddedChat],
  );

  const builtinNav = useMemo(() => {
    const base = embeddedChat
      ? [CHAT_NAV_ITEM, ...BUILTIN_NAV_REST]
      : BUILTIN_NAV_REST;
    return showTokenAnalytics
      ? base
      : base.filter((n) => n.path !== "/analytics");
  }, [embeddedChat, showTokenAnalytics]);

  const sidebarNav = useMemo(
    () => partitionSidebarNav(builtinNav, manifests),
    [builtinNav, manifests],
  );
  const routes = useMemo(
    () => buildRoutes(builtinRoutes, manifests),
    [builtinRoutes, manifests],
  );
  const pluginTabMeta = useMemo(
    () =>
      manifests
        .filter((m) => !m.tab.hidden)
        .map((m) => ({
          path: m.tab.override ?? m.tab.path,
          label: m.label,
        })),
    [manifests],
  );

  const layoutVariant = theme.layoutVariant ?? "standard";

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [mobileOpen]);

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setMobileOpen(false);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return (
    <ProfileProvider>
    <div
      data-layout-variant={layoutVariant}
      className="d-flex h-dvh max-h-dvh min-h-0 flex-column overflow-hidden bg-body text-body-emphasis antialiased"
    >
      <SelectionSwitcher />

      <div
        aria-hidden
        className="pointer-events-none position-fixed top-0 start-0 w-100 h-100 z-0"
      >
        <PluginSlot name="backdrop" />
      </div>

      <header
        className={cn(
          // Native Bootstrap display utilities, deliberately. This used to
          // be `lg:hidden` (a generated utility) fighting a bare `d-flex`
          // (also generated) for the same property, from two different
          // layers — and the header stayed on screen at desktop widths.
          // `d-lg-none` and `d-flex` are ordered correctly within
          // Bootstrap's own utilities, so the responsive one wins by
          // construction instead of by luck.
          "d-lg-none d-flex flex-column position-fixed top-0 start-0 end-0 z-40 min-h-14",
          "flex-row align-items-center gap-2 px-4 py-2",
          "border-bottom",
          "bg-body-tertiary",
        )}
        // Bootstrap's own variables, with the tertiary surface as the
        // fallback. The old chain ended in `var(--background-base)`, which
        // no longer exists — and a var() with no fallback makes the whole
        // declaration invalid at computed-value time, so the header would
        // have come out transparent rather than merely unstyled.
        style={{
          background:
            "var(--component-header-background, var(--bs-tertiary-bg))",
        }}
      >
        <Button
          ghost
          size="icon"
          onClick={() => setMobileOpen(true)}
          aria-label={t.app.openNavigation}
          aria-expanded={mobileOpen}
          aria-controls="app-sidebar"
          className="text-body-secondary hover:text-midground"
        >
          <Menu />
        </Button>

        <Typography className="fw-bold text-[0.95rem] leading-[0.95] tracking-[0.05em] text-body">
          {t.app.brand}
        </Typography>
      </header>

      {mobileOpen && (
        <Button
          ghost
          aria-label={t.app.closeNavigation}
          onClick={closeMobile}
          className={cn(
            "d-lg-none position-fixed top-0 start-0 w-100 h-100 z-40 p-0",
            "bg-black/70",
          )}
        />
      )}

      {/* Single mobile header clearance for the banner stack + content. The
          fixed lg:hidden header is h-14/z-40; previously each banner carried
          its own mt-14 AND the content kept pt-14, so two visible banners
          stacked three offsets (NS-656 review P3). One spacer, applied once. */}
      <div aria-hidden className="h-14 flex-shrink-0 lg:hidden" />
      <PluginSlot name="header-banner" />
      <ProfileScopeBanner />
      <MemoryPressureBanner status={sidebarStatus} />
      <MultiplexStandaloneBanner status={sidebarStatus} />

      {/*
        The strip spans the full shell width, above the rail as well as
        above the content — so the app's identity sits in the one place a
        left rail and a page header cannot both claim. It lives here,
        outside the rail/main row, because that is the only level at
        which "full width" means anything.
      */}
      <TopBar status={sidebarStatus} />

      <div className="d-flex flex-column overflow-hidden flex-grow-1 min-h-0 min-w-0">
        <div className="d-flex flex-grow-1 min-h-0 min-w-0">
          {/*
            Bootstrap dashboard template: the rail is a `bg-body-tertiary`
            column with real padding, not a second copy of the canvas
            divided by a hairline. `align-items-stretch` is what lets the
            nav-pill links span the full rail width, and the padding lives
            on the rail itself so the sections inside it do not each
            re-declare an inset.
          */}
          <aside
            id="app-sidebar"
            aria-label={t.app.navigation}
            className={cn(
              // `offcanvas-lg` is the mechanism doing the work here: below
              // the lg breakpoint the rail is a fixed, off-canvas drawer
              // that slides in when `.show` is present; from lg up
              // Bootstrap un-fixes it into an ordinary flex child. That is
              // exactly the reference template's split — a drawer on
              // mobile, a static rail on desktop — and it means no two
              // utilities ever contend for `position`, which is what left
              // the rail overlaying the content at desktop widths.
              "offcanvas-lg offcanvas-start app-rail",
              "d-flex flex-column align-items-stretch p-3",
              "bg-body-tertiary border-end",
              collapsed && "app-rail-collapsed",
              mobileOpen && "show",
            )}
          >
            <div
              className={cn(
                "d-flex flex-shrink-0 align-items-center gap-2 pb-2 mb-2 border-bottom",
                collapsed ? "lg:justify-content-center" : "justify-content-between",
              )}
            >
              <div
                className={cn(
                  "d-flex align-items-center gap-2",
                  collapsed && "lg:hidden",
                )}
              >
                <PluginSlot name="header-left" />
              </div>

              <Button
                ghost
                size="icon"
                onClick={closeMobile}
                aria-label={t.app.closeNavigation}
                className="d-lg-none text-body-secondary"
              >
                <X />
              </Button>

              <Button
                ghost
                size="icon"
                onClick={toggleCollapsed}
                aria-label={
                  collapsed ? t.common.expand : t.common.collapse
                }
                className="d-none d-lg-flex text-body-secondary hover:text-midground"
              >
                {collapsed ? (
                  <PanelLeftOpen className="icon-md" />
                ) : (
                  <PanelLeftClose className="icon-md" />
                )}
              </Button>
            </div>

            <ProfileSwitcher collapsed={isDesktopCollapsed} />

            <nav
              /*
               * `flex-nowrap` is load-bearing, not tidiness. Bootstrap's
               * `.nav` sets `flex-wrap: wrap`, and with
               * `flex-direction: column` that wraps items into *sideways
               * tracks* rather than down the list — so the sections laid
               * themselves out in two columns and the second one ran off
               * the rail.
               */
              className="nav flex-column flex-nowrap flex-grow-1 min-h-0 overflow-y-auto overflow-x-hidden pb-2"
              aria-label={t.app.navigation}
            >
              {NAV_GROUPS.map((group) => {
                // Plugin tabs are registered at runtime and are not part
                // of the built-in set, so they are read from their own
                // list — but they render as an ordinary section, not as
                // a separate block under the rail.
                const items =
                  group.id === "plugins"
                    ? sidebarNav.pluginItems
                    : sidebarNav.coreItems.filter(
                        (item) => item.group === group.id,
                      );
                if (items.length === 0) return null;
                return (
                  <SidebarNavGroup
                    closeMobile={closeMobile}
                    collapsed={isDesktopCollapsed}
                    group={group}
                    items={items}
                    key={group.id}
                    t={t}
                    tooltipWarmRef={tooltipWarmRef}
                  />
                );
              })}
            </nav>

            {/*
              The auth widget is the one thing that stays at the foot of
              the rail: it only means anything to a signed-out user, and
              putting it in the top strip would give a global-looking
              control to the minority who can see it.
            */}
            <div
              className={cn(
                "d-flex flex-shrink-0 flex-column",
                isDesktopCollapsed && "lg:hidden",
              )}
            >
              <AuthWidget />
            </div>
          </aside>

          {/*
            The reference template's main column: the strip and the page
            header sit on `bg-body-tertiary` (the same surface as the rail)
            and the content below sits on the plain `bg-body` canvas. The
            column wraps PageHeaderProvider rather than the other way
            round, so the strip is genuinely the first thing in the column
            — inside the provider it rendered *below* the page header,
            because the provider's own header comes first.
          */}
          <div
            className={cn(
              "d-flex flex-column flex-grow-1 min-w-0 min-h-0 position-relative z-2 bg-body",
              isDashboardRoute && "sku-main",
              isChatRoute && "pb-0 pt-0",
              isDocsRoute && "min-h-0 flex-grow-1",
            )}
          >
            <PluginSlot name="pre-main" />
            <PageHeaderProvider pluginTabs={pluginTabMeta}>
              <div
                className={cn(
                  "w-100 min-w-0",
                  /*
                   * The inset the reference has. The horizontal part is
                   * load-bearing: a Bootstrap `row` pulls itself 0.75rem
                   * outside its container with negative margins to make
                   * room for its gutters, so a container with no horizontal
                   * padding lets the row hang past the viewport edge.
                   *
                   * The top is the same value for a different reason — it
                   * was simply missing, which left the first row of every
                   * page flush against the header bar above it.
                   */
                  !isChatRoute && "px-3 pt-3 pb-4",
                  (isDocsRoute || isChatRoute) &&
                    "min-h-0 d-flex flex-grow-1 flex-column",
                )}
              >
                <ProfileKeyedRoutes>
                  <Suspense fallback={<RouteFallback />}>
                    <Routes>
                      {routes.map(({ key, path, element }) => (
                        <Route key={key} path={path} element={element} />
                      ))}
                      <Route
                        path="*"
                        element={
                          <UnknownRouteFallback pluginsLoading={pluginsLoading} />
                        }
                      />
                    </Routes>
                  </Suspense>
                </ProfileKeyedRoutes>

                {embeddedChat &&
                  !chatOverriddenByPlugin &&
                  (pluginsLoading ? (
                    isChatRoute ? (
                      <RouteFallback label="Loading chat…" />
                    ) : null
                  ) : chatHostMounted ? (
                    <div
                      data-chat-active={isChatRoute ? "true" : "false"}
                      className={cn(
                        "min-h-0 min-w-0",
                        isChatRoute ? "d-flex flex-grow-1 flex-column" : "d-none",
                      )}
                      aria-hidden={!isChatRoute}
                    >
                      <Suspense
                        fallback={
                          isChatRoute ? (
                            <RouteFallback label="Loading chat…" />
                          ) : null
                        }
                      >
                        <ChatPage isActive={isChatRoute} />
                      </Suspense>
                    </div>
                  ) : isChatRoute ? (
                    <RouteFallback label="Loading chat…" />
                  ) : null)}
              <PluginSlot name="post-main" />
            </div>
            </PageHeaderProvider>
          </div>
        </div>
      </div>

      <PluginSlot name="overlay" />
    </div>
    </ProfileProvider>
  );
}

/**
 * Remounts the entire routed page tree when the global management profile
 * changes. Pages load their data on mount; without this, a page opened
 * under profile A would keep showing A's state while writes (via the
 * fetchJSON ?profile= injection) silently targeted the newly selected
 * profile B — the exact stale-target footgun the switcher exists to kill.
 * Keying by profile resets every page's local state so it refetches under
 * the new scope. The persistent ChatPage host below handles its own
 * remount (channel keyed on scopedProfile).
 */
function ProfileKeyedRoutes({ children }: { children: ReactNode }) {
  const { profile } = useProfileScope();
  return <div key={profile || "__own__"} className="contents">{children}</div>;
}

/**
 * One collapsible section of the rail.
 *
 * The heading is a real button with `aria-expanded` and a caret that
 * rotates, rather than a heading with a click handler — a section that
 * folds has to be operable from the keyboard and announce its state.
 *
 * A section containing the current page always starts open, and refuses
 * to close while the user is inside it. Folding the section you are
 * navigating in would hide the page you are on.
 */
function SidebarNavGroup({
  closeMobile,
  collapsed,
  group,
  items,
  tooltipWarmRef,
  t,
}: SidebarNavGroupProps) {
  const { label, accent, icon: GroupIcon } = group;
  // Collapsed by default. A rail of five headings is scannable at a
  // glance; a rail of nineteen rows is a list to read.
  const [open, setOpen] = useState(false);
  const regionId = `hermes-rail-group-${group.id}`;
  const headingId = `${regionId}-heading`;

  // `useLocation` rather than a prop: the rail is the thing that has to
  // know which page is showing, and it already lives inside the router.
  const { pathname } = useLocation();
  const holdsCurrentPage = items.some(
    (item) =>
      pathname === item.path ||
      (item.path !== "/" && pathname.startsWith(`${item.path}/`)),
  );

  if (collapsed) {
    // Collapsed, there is no room for a heading, and a collapsed section
    // would hide every icon behind a toggle nobody can read. Flat list.
    return (
      <ul className="nav nav-pills flex-column gap-1 mb-2">
        {items.map((item) => (
          <SidebarNavLink
            closeMobile={closeMobile}
            collapsed={collapsed}
            item={item}
            key={item.path}
            t={t}
            tooltipWarmRef={tooltipWarmRef}
          />
        ))}
      </ul>
    );
  }

  const expanded = open || holdsCurrentPage;

  return (
    <div className="nav-section">
      <button
        aria-controls={regionId}
        aria-expanded={expanded}
        className={cn(
          "btn btn-toggle w-100 d-flex align-items-center gap-2 px-2 py-1",
          "nav-section-heading border-0 bg-transparent text-start",
        )}
        id={headingId}
        onClick={() => setOpen((prev) => !prev)}
        type="button"
      >
        <GroupIcon aria-hidden className={cn("icon-sm", `text-${accent}`)} />

        <span className="flex-grow-1 text-truncate">{label}</span>

        {/*
          The count sits between the label and the caret: a heading that
          says how much is behind it is scannable without opening it.
        */}
        <span className="nav-section-count">{items.length}</span>

        <ChevronDown
          aria-hidden
          className={cn("icon-sm", expanded ? "rotate-180" : "")}
          style={{ transition: "transform 0.15s ease-in-out" }}
        />
      </button>

      <div aria-labelledby={headingId} id={regionId}>
        {expanded && (
          <ul className="nav nav-pills flex-column gap-1 mt-1">
            {items.map((item) => (
              <SidebarNavLink
                closeMobile={closeMobile}
                collapsed={collapsed}
                item={item}
                key={item.path}
                t={t}
                tooltipWarmRef={tooltipWarmRef}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface SidebarNavGroupProps {
  closeMobile: () => void;
  collapsed: boolean;
  group: NavGroup;
  items: NavItem[];
  t: Translations;
  tooltipWarmRef: TooltipWarmRef;
}

function SidebarNavLink({
  closeMobile,
  collapsed,
  item,
  tooltipWarmRef,
  t,
}: SidebarNavLinkProps) {
  const { path, label, labelKey, icon: Icon, accent } = item;
  const [hovered, setHovered] = useState(false);
  const [tooltipAnchor, setTooltipAnchor] = useState<HTMLElement | null>(null);

  const navLabel = labelKey
    ? ((t.app.nav as Record<string, string>)[labelKey] ?? label)
    : label;
  const showTooltip = (event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
    setHovered(true);
    setTooltipAnchor(event.currentTarget);
  };
  const hideTooltip = () => {
    setHovered(false);
    setTooltipAnchor(null);
  };

  return (
    <li
      className="nav-item"
      onMouseEnter={collapsed ? showTooltip : undefined}
      onMouseLeave={collapsed ? hideTooltip : undefined}
    >
      <NavLink
        to={path}
        end={path === "/sessions"}
        onClick={closeMobile}
        aria-label={collapsed ? navLabel : undefined}
        onFocus={collapsed ? showTooltip : undefined}
        onBlur={collapsed ? hideTooltip : undefined}
        className={({ isActive }) =>
          // The reference template's rail item. The parent <ul> carries
          // `nav-pills`, so the pill shape, padding and active background
          // all come from Bootstrap — spelling them out here as well just
          // fought the cascade.
          // The item carries its section's tint as a soft background —
          // Bootstrap's own `*-subtle`, which is that colour at low
          // alpha. It gives a rail of plain links enough surface to scan,
          // and it means an item still says which section it belongs to
          // when that section is collapsed.
          cn(
            "nav-link d-flex align-items-center gap-2 fw-semibold",
            isActive
              ? "active"
              : `bg-${accent}-subtle border border-${accent}-subtle`,
          )
        }
      >
        {({ isActive }) => (
          <>
            <Icon
              className={cn(
                "flex-shrink-0 icon-md",
                // The item's tint, so a section's icons read as a family.
                // On the active page the pill behind it is already the
                // accent, so the icon takes the pill's own foreground
                // rather than competing with it.
                isActive ? undefined : `text-${accent}`,
              )}
            />

            <span
              className={cn(
                "text-truncate",
                collapsed ? "lg:opacity-0" : "lg:opacity-100",
              )}
            >
              {navLabel}
            </span>
          </>
        )}
      </NavLink>

      {collapsed && hovered && tooltipAnchor && (
        <SidebarTooltip anchor={tooltipAnchor} label={navLabel} warmRef={tooltipWarmRef} />
      )}
    </li>
  );
}

function SidebarTooltip({ anchor, label, warmRef }: SidebarTooltipProps) {
  const rect = anchor.getBoundingClientRect();
  const sidebar = document.getElementById("app-sidebar");
  const sidebarRight = sidebar?.getBoundingClientRect().right ?? rect.right;
  const [isWarm, setIsWarm] = useState(false);

  useEffect(() => {
    if (!warmRef) {
      setIsWarm(false);
      return;
    }
    const now = Date.now();
    setIsWarm(now - warmRef.current < 300);
    warmRef.current = now;
    return () => {
      if (warmRef) warmRef.current = Date.now();
    };
  }, [warmRef]);

  return createPortal(
    <span
      className={cn(
        "position-fixed z-3 pointer-events-none",
        "px-2 py-1",
        "bg-body border border-current/20 shadow-lg",
        "font-sans fw-semibold fs-6 tracking-[0.1em] text-body text-uppercase",
      )}
      style={{
        top: rect.top + rect.height / 2,
        left: sidebarRight + 8,
        transform: "translateY(-50%)",
        opacity: isWarm ? 1 : undefined,
        animation: isWarm ? "none" : "sidebar-tooltip-in 120ms ease-out",
      }}
    >
      {label}
    </span>,
    document.body,
  );
}

type TooltipWarmRef = React.RefObject<number>;

interface NavItem {
  icon: ComponentType<{ className?: string }>;
  label: string;
  labelKey?: string;
  path: string;
  /**
   * Section this item is filed under, and the icon's tint. Both come
   * from Bootstrap's own utility palette, so they follow the colour
   * mode rather than carrying hex values of their own.
   */
  group: NavGroupId;
  accent: NavAccent;
}

/** The rail's sections, in order. */
type NavGroupId =
  | "workspace"
  | "models"
  | "desk"
  | "servers"
  | "marketplace"
  | "automation"
  | "extensions"
  | "plugins"
  | "system";

/** Bootstrap utility tint applied to a nav item's icon. */
type NavAccent =
  | "primary"
  | "success"
  | "info"
  | "warning"
  | "danger"
  | "secondary";

interface NavGroup {
  id: NavGroupId;
  label: string;
  /** The section's own icon, so a heading is identifiable without its list. */
  icon: ComponentType<{ className?: string }>;
  /**
   * The icon beside the heading, and each member's icon tint. A section
   * reads as a unit when its items share a colour, which is why this is
   * a property of the group rather than of every item.
   */
  accent: NavAccent;
}

interface SidebarNavLinkProps {
  closeMobile: () => void;
  collapsed: boolean;
  item: NavItem;
  t: Translations;
  tooltipWarmRef: TooltipWarmRef;
}

interface SidebarTooltipProps {
  anchor: HTMLElement;
  label: string;
  warmRef?: TooltipWarmRef;
}

