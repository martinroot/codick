/**
 * The eight routes under Kanban Desk, Servers and Marketplace that are in
 * the rail before they are built.
 *
 * Each is `SectionPage` with its own copy, kept together because they are
 * all one line long today. The first one to get real behaviour becomes its
 * own file and drops out of here.
 */

import SectionPage from "./SectionPage";

export function KanbanFleetDashboardPage() {
  return (
    <SectionPage
      api="/api/status, /api/analytics"
      intent="Fleet-wide view: what the agents are doing right now across every profile and server, and what needs a human."
      section="Kanban Desk"
      title="Fleet Dashboard"
    />
  );
}

export function KanbanTemplateBuilderPage() {
  return (
    <SectionPage
      intent="Compose the card templates the desk offers when a task is created — fields, defaults, which column a new card lands in."
      section="Kanban Desk"
      title="Template Builder"
    />
  );
}

export function ServersListPage() {
  return (
    <SectionPage
      api="/api/ssh/ownership, /api/health"
      intent="Every host CoDick talks to, with what each one is running and whether it answered last time."
      section="Servers"
      title="Servers — List"
    />
  );
}

export function ServerWakePage() {
  return (
    <SectionPage
      intent="Bring an offline server back: wake-on-LAN, or a queued SSH that retries until the host answers."
      section="Servers"
      title="Wake Up"
    />
  );
}

export function ServerLogsPage() {
  return (
    <SectionPage
      intent="Tail the agent, error and gateway logs per host, the way `hermes logs` does on the CLI."
      section="Servers"
      title="Servers — Logs"
    />
  );
}

export function ServerDoctorPage() {
  return (
    <SectionPage
      api="/api/ops/doctor, /api/health"
      intent="Run the real doctor against this host and lay the findings out as pass/fail rows."
      section="Servers"
      title="Doctor"
    />
  );
}

export function MarketplaceViewPage() {
  return (
    <SectionPage
      intent="Browse what is installable — the curated catalogue, with who publishes each entry and what it pulls in."
      section="Marketplace"
      title="Marketplace — View"
    />
  );
}

export function MarketplaceSetupPage() {
  return (
    <SectionPage
      intent="Point CoDick at the catalogues to trust, and decide which of them may install without asking."
      section="Marketplace"
      title="Marketplace — Setup"
    />
  );
}
