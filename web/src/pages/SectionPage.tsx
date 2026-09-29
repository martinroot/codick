/**
 * The landing surface for a route that exists in the rail but has no
 * behaviour behind it yet.
 *
 * A nav entry pointing at a 404 is worse than no nav entry: it looks like
 * the feature is broken rather than unbuilt. This renders an honest
 * "planned, nothing here yet" instead -- the route works, the page is
 * reachable and titled, and the emptiness is stated rather than implied.
 *
 * When a section gets its real implementation this component stops being
 * used by that route; it stays for the rest.
 */

import * as React from "react";
import { usePageHeader } from "@/contexts/usePageHeader";

export interface SectionPageProps {
  /** Matches the rail label exactly, so the page and the nav agree. */
  title: string;
  /** The rail section this page belongs to, shown as context. */
  section: string;
  /** What this page is going to do, in the owner's words where possible. */
  intent: string;
  /** The surface it will talk to once built, if that is already decided. */
  api?: string;
}

export default function SectionPage({ title, section, intent, api }: SectionPageProps) {
  const { setAfterTitle, setEnd } = usePageHeader();

  React.useEffect(() => {
    setAfterTitle(null);
    setEnd(null);
  }, [setAfterTitle, setEnd]);

  return (
    <div className="d-flex flex-column gap-3">
      <div className="d-flex flex-wrap align-items-center gap-2">
        <h1 className="h4 mb-0">{title}</h1>
        <span className="badge text-bg-secondary">{section}</span>
        <span className="badge text-bg-light border">Not built yet</span>
      </div>

      <div className="card">
        <div className="card-body">
          <p className="mb-0">{intent}</p>
          {api ? (
            <p className="mt-2 mb-0 small text-body-secondary">
              Will read <code>{api}</code>.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
