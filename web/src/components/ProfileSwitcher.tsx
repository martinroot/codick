import { useMemo } from "react";
import { Users } from "lucide-react";
import { useProfileScope } from "@/contexts/useProfileScope";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * The machine dashboard's single write-target selector.
 *
 * Rendered in the sidebar above the nav. Every management page (Config,
 * Keys, Skills, MCP, Models) reads/writes the selected profile via the
 * fetchJSON ?profile= injection. Hidden when only one profile exists.
 */
export function ProfileSwitcher({ collapsed }: ProfileSwitcherProps) {
  const { profile, currentProfile, profiles, setProfile } = useProfileScope();
  const { t } = useI18n();

  const currentDashboardLabel = useMemo(
    () =>
      (t.app.currentProfileOption ?? "this dashboard ({name})").replace(
        "{name}",
        currentProfile || "default",
      ),
    [currentProfile, t.app.currentProfileOption],
  );

  if (profiles.length < 2) return null;

  const managed = profile || currentProfile || "default";
  const isOther = !!profile && profile !== currentProfile;
  const managingLabel = t.app.managingProfile ?? "Managing profile";

  return (
    <div
      className={cn(
        "d-flex align-items-center gap-2 border-bottom border-current/10 px-3 py-2",
        collapsed && "lg:justify-center lg:px-0",
      )}
      title={managingLabel}
    >
      <Users
        className={cn(
          "flex-shrink-0",
          isOther ? "text-warning" : "text-body-secondary",
        )}
      />

      {/* A native <select> styled by Bootstrap's form-select. The old
          design-system Select needed a dozen arbitrary-variant classes to
          be tamed inside the 256px rail, and it still overflowed the
          sidebar edge; a native control truncates itself. */}
      <select
        aria-label={managingLabel}
        className={cn(
          "form-select form-select-sm flex-grow-1 min-w-0",
          collapsed && "lg:d-none",
          isOther && "border-warning text-warning",
        )}
        id="hermes-profile-switcher"
        onChange={(event) => setProfile(event.target.value)}
        value={profile}
      >
        <option value="">{currentDashboardLabel}</option>

        {profiles
          .filter((name) => name !== currentProfile)
          .map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
      </select>

      {collapsed && <span className="visually-hidden">{managed}</span>}
    </div>
  );
}

interface ProfileSwitcherProps {
  collapsed?: boolean;
}
