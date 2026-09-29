import { Link, NavLink } from "react-router";
import { ChevronDown, Settings } from "lucide-react";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import type { StatusResponse } from "@/lib/api";
import { gatewayLine } from "./SidebarStatusStrip";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { LanguageSwitcher } from "./LanguageSwitcher";

/**
 * The top strip: the app's identity on the left, the things you might want
 * at any moment on the right.
 *
 * Gateway status used to sit at the foot of the rail, where it read as
 * part of the navigation rather than as something global. Status, theme
 * and language are not destinations — none of them belongs in a nav — so
 * they belong in the chrome. The gear is the one item here that *is* a
 * destination, and it points at the System page the rail's own System
 * section already lists.
 */
export function TopBar({ status }: TopBarProps) {
  return (
    <div className="z-1 flex-shrink-0 bg-body-tertiary border-bottom px-3 py-2">
      <div className="d-flex align-items-center gap-3">
        {/*
          The mark, as the artwork rather than as letters set in the
          interface font. The wordmark spelled it out, but the fox is what
          the README and the favicon carry, and a header that names the
          product differently from every other place it appears is the one
          that looks borrowed.

          Two files, because the artwork is drawn for a light ground: its
          lettering is near-black, and near-black on a dark header is not a
          dark-mode logo, it is no logo. The light variant is the same
          image with the navy lifted to near-white and the crimson raised
          to hold against a dark surface. They are swapped in CSS on
          `data-bs-theme`, so the switch costs no render and needs no
          JavaScript to stay in step with the mode.
        */}
        <Link
          className="d-inline-flex align-items-center text-decoration-none"
          to="/"
        >
          <img
            alt="CoDick"
            className="codick-logo"
            height={26}
            src="/codick-logo.png"
            width={106}
          />
          <img
            alt="CoDick"
            aria-hidden
            className="codick-logo codick-logo-invert"
            height={26}
            src="/codick-logo-light.png"
            width={106}
          />
        </Link>

        <div className="ms-auto d-flex align-items-center gap-2">
          <StatusDropdown status={status} />
          <ThemeSwitcher />
          <LanguageSwitcher />
          <GearLink />
        </div>
      </div>
    </div>
  );
}

/**
 * Gateway status, folded into one control.
 *
 * `dropdown` rather than a nav pill: this is a disclosure, not a link, and
 * Bootstrap's dropdown already carries the open/close behaviour and the
 * outside-click dismissal.
 */
function StatusDropdown({ status }: { status: StatusResponse | null }) {
  const { t } = useI18n();

  if (status === null) {
    return <div aria-hidden className="placeholder-glow col-6" />;
  }

  // The gateway's state is not a boolean, and the reasons it is degraded
  // or stale are exactly the ones worth surfacing — so the existing
  // resolver is reused rather than re-derived here.
  const { label, tone } = gatewayLine(status, t);
  const live = tone === "text-success";

  return (
    <div className="dropdown">
      <button
        aria-expanded="false"
        className={cn(
          "btn btn-sm d-flex align-items-center gap-2 border",
          tone,
        )}
        data-bs-toggle="dropdown"
        type="button"
      >
        <span
          aria-hidden
          className={cn(
            "d-inline-block rounded-circle",
            live ? "bg-success" : "bg-secondary",
          )}
          style={{ width: "0.5rem", height: "0.5rem" }}
        />
        <span className="text-nowrap">{label}</span>
        <ChevronDown aria-hidden className="icon-sm" />
      </button>

      <ul className="dropdown-menu dropdown-menu-end">
        <li>
          <span className="dropdown-item-text text-secondary">
            {t.app.gatewayStatusLabel} <strong>{label}</strong>
          </span>
        </li>
        <li>
          <span className="dropdown-item-text text-secondary">
            {t.app.activeSessionsLabel} <strong>{status.active_sessions}</strong>
          </span>
        </li>
        <li>
          <hr className="dropdown-divider" />
        </li>
        <li>
          <NavLink className="dropdown-item" to="/system">
            System
          </NavLink>
        </li>
      </ul>
    </div>
  );
}

/** The gear. A link to the System page, not a button. */
function GearLink() {
  return (
    <NavLink
      aria-label="System"
      className={({ isActive }) =>
        cn(
          "btn btn-sm d-flex align-items-center justify-content-center p-0",
          isActive ? "btn-secondary" : "btn-outline-secondary",
        )
      }
      style={{ width: "2rem", height: "2rem" }}
      to="/system"
    >
      <Settings aria-hidden className="icon-sm" />
    </NavLink>
  );
}

interface TopBarProps {
  status: StatusResponse | null;
}
