import { Users } from "lucide-react";
import { useProfileScope } from "@/contexts/useProfileScope";
import { useI18n } from "@/i18n";

/**
 * App-wide amber banner shown while the global switcher targets a profile
 * OTHER than the dashboard's own — every management write (config, keys,
 * skills, MCPs, model) and new Chat sessions land in that profile.
 */
export function ProfileScopeBanner() {
  const { profile, currentProfile } = useProfileScope();
  const { t } = useI18n();

  if (!profile || profile === currentProfile) return null;

  return (
    <div className="d-flex align-items-center gap-2 border-bottom border-amber-500/40 bg-amber-500/10 px-4 py-2 fs-6 text-amber-300">
      <Users className="icon-sm flex-shrink-0" />
      <span>
        {(
          t.app.managingProfileBanner ??
          "Managing profile “{name}” — config, keys, skills, MCPs, model, and new chats apply to that profile."
        ).replace("{name}", profile)}
      </span>
    </div>
  );
}
