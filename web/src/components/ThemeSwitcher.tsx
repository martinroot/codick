import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Palette, Check, Type } from "lucide-react";
import { Button } from "@/ui";
import { ListItem } from "@/ui";
import { BottomSheet } from "@/ui";
import { Typography } from "@/ui";
import { useBelowBreakpoint } from "@/ui";
import { BUILTIN_THEMES, THEME_DEFAULT_FONT_ID, useTheme } from "@/themes";
import type { DashboardTheme, FontChoice, ThemeListEntry } from "@/themes";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * Compact theme picker mounted next to the language switcher in the header.
 * Each dropdown row shows a 3-stop swatch (background / midground / warm
 * glow) so users can preview the palette before committing. User-defined
 * themes from `~/.hermes/dashboard-themes/*.yaml` use their API-provided
 * definitions so they show real palette swatches just like built-ins.
 *
 * When placed at the bottom of a container (e.g. the sidebar rail), pass
 * `dropUp` so the menu opens above the trigger instead of clipping below
 * the viewport. On viewports below the `sm` breakpoint, `dropUp` uses a
 * bottom sheet portaled to `document.body` so the picker is not clipped by
 * the sidebar (same idea as a responsive Drawer).
 */
export function ThemeSwitcher({ collapsed = false, dropUp = false }: ThemeSwitcherProps) {
  const { themeName, availableThemes, setTheme, fontId, fontChoices, setFont } = useTheme();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const narrowViewport = useBelowBreakpoint(640);
  const useMobileSheet = Boolean(dropUp && narrowViewport);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  useEffect(() => {
    if (!open || useMobileSheet) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapperRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open, close, useMobileSheet]);

  const current = availableThemes.find((th) => th.name === themeName);
  const label = current?.label ?? themeName;
  const sheetTitle = t.theme?.title ?? "Theme";

  return (
    <div ref={wrapperRef} className="position-relative">
      <Button
        ghost
        size={collapsed ? "icon" : undefined}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          collapsed
            ? "text-body-secondary hover:text-foreground hover:bg-transparent"
            : // `text-decoration-none` because this renders a link-coloured
              // label inside the rail, and the theme name is long enough
              // that the underline reads as noise at this size.
              "px-2 py-1 text-decoration-none text-lowercase ls-normal fw-normal fs-6 text-truncate text-body-secondary hover:text-foreground",
        )}
        title={`${t.theme?.switchTheme ?? "Switch theme"}: ${label}`}
        aria-label={t.theme?.switchTheme ?? "Switch theme"}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className="d-inline-flex align-items-center gap-2">
          <Palette className="icon-sm" />

          {!collapsed && (
            <Typography
              // `fs-6`, not `fs-4`. This is the theme name in the rail
              // footer, and 2.5rem rendered "Nous Research" as the
              // largest thing in the column — wide enough to spill past
              // the rail's edge. `ls-wide` was a Tailwind name with
              // no rule; Bootstrap calls it `ls-wide`.
              className="d-none sm:inline fs-6 fw-normal ls-normal text-truncate"
            >
              {label}
            </Typography>
          )}
        </span>
      </Button>

      {useMobileSheet && (
        <BottomSheet
          backdropDismissLabel={t.common.close}
          onClose={close}
          open={open}
          title={sheetTitle}
        >
          <div aria-label={sheetTitle} role="listbox">
            <ThemeSwitcherOptions
              availableThemes={availableThemes}
              close={close}
              setTheme={setTheme}
              themeName={themeName}
            />
            <FontSection
              fontChoices={fontChoices}
              fontId={fontId}
              setFont={setFont}
            />
          </div>
        </BottomSheet>
      )}

      {open && !useMobileSheet && (() => {
        const rect = wrapperRef.current?.getBoundingClientRect();
        const dropdown = (
          <div
            ref={dropdownRef}
            aria-label={sheetTitle}
            className={cn(
              "min-w-[240px] max-h-[70dvh] overflow-y-auto",
              "border border-secondary bg-body",
              "shadow-[0_12px_32px_-8px_rgba(0,0,0,0.6)]",
              dropUp ? "position-fixed z-[100]" : "position-absolute z-50 right-0 top-full mt-1",
            )}
            role="listbox"
            style={
              dropUp && rect
                ? { bottom: window.innerHeight - rect.top + 4, left: rect.left }
                : undefined
            }
          >
            <div className="border-bottom border-current/20 px-3 py-2">
              <Typography
                className="fw-semibold fs-6 tracking-[0.12em] text-body-tertiary"
              >
                {sheetTitle}
              </Typography>
            </div>

            <ThemeSwitcherOptions
              availableThemes={availableThemes}
              close={close}
              setTheme={setTheme}
              themeName={themeName}
            />
            <FontSection
              fontChoices={fontChoices}
              fontId={fontId}
              setFont={setFont}
            />
          </div>
        );
        return dropUp ? createPortal(dropdown, document.body) : dropdown;
      })()}
    </div>
  );
}

function ThemeSwitcherOptions({
  availableThemes,
  close,
  setTheme,
  themeName,
}: ThemeSwitcherOptionsProps) {
  return (
    <>
      {availableThemes.map((th) => {
        const isActive = th.name === themeName;
        const paletteTheme = BUILTIN_THEMES[th.name] ?? th.definition;

        return (
          <ListItem
            active={isActive}
            aria-selected={isActive}
            className="gap-3"
            key={th.name}
            onClick={() => {
              setTheme(th.name);
              close();
            }}
            role="option"
          >
            {paletteTheme ? (
              <ThemeSwatch theme={paletteTheme} />
            ) : (
              <PlaceholderSwatch />
            )}

            <div className="d-flex min-w-0 flex-grow-1 flex-column gap-0.5">
              <Typography
                className="text-truncate fw-semibold fs-6 ls-wide"
              >
                {th.label}
              </Typography>
              {th.description && (
                <Typography className="text-truncate fs-6 ls-normal text-body-tertiary">
                  {th.description}
                </Typography>
              )}
            </div>

            <Check
              className={cn(
                "icon-sm flex-shrink-0 text-body",
                isActive ? "opacity-100" : "opacity-0",
              )}
            />
          </ListItem>
        );
      })}
    </>
  );
}

const FONT_CATEGORY_LABEL_KEY: Record<FontChoice["category"], "fontSans" | "fontSerif" | "fontMono"> = {
  sans: "fontSans",
  serif: "fontSerif",
  mono: "fontMono",
};

/** Font-override section rendered below the theme list. Lets the user pick
 *  any catalog font independently of the active theme, or "Theme default"
 *  to clear the override. Each row previews itself in its own font. */
function FontSection({ fontChoices, fontId, setFont }: FontSectionProps) {
  const { t } = useI18n();
  const order: FontChoice["category"][] = ["sans", "serif", "mono"];
  return (
    <>
      <div className="mt-1 border-top border-current/20 px-3 pb-1 pt-2">
        <span className="d-inline-flex align-items-center gap-2">
          <Type className="icon-sm text-body-tertiary" />
          <Typography
            className="fw-semibold fs-6 tracking-[0.12em] text-body-tertiary"
          >
            {t.theme?.fontTitle ?? "Font"}
          </Typography>
        </span>
      </div>

      {/* Theme-default (clears the override). */}
      <ListItem
        active={fontId === THEME_DEFAULT_FONT_ID}
        aria-selected={fontId === THEME_DEFAULT_FONT_ID}
        className="gap-3"
        onClick={() => setFont(THEME_DEFAULT_FONT_ID)}
        role="option"
      >
        <span aria-hidden className="h-4 w-9 flex-shrink-0" />
        <div className="d-flex min-w-0 flex-grow-1 flex-column gap-0.5">
          <Typography className="text-truncate fs-6 ls-normal">
            {t.theme?.fontDefault ?? "Theme default"}
          </Typography>
          <Typography className="text-truncate fs-6 ls-normal text-body-tertiary">
            {t.theme?.fontDefaultHint ?? "Use the active theme's font"}
          </Typography>
        </div>
        <Check
          className={cn(
            "icon-sm flex-shrink-0 text-body",
            fontId === THEME_DEFAULT_FONT_ID ? "opacity-100" : "opacity-0",
          )}
        />
      </ListItem>

      {order.map((cat) => {
        const fonts = fontChoices.filter((f) => f.category === cat);
        if (fonts.length === 0) return null;
        const catLabel = t.theme?.[FONT_CATEGORY_LABEL_KEY[cat]] ?? cat;
        return (
          <div key={cat}>
            <div className="px-3 pb-0.5 pt-1.5">
              <Typography className="text-[0.65rem] text-uppercase tracking-[0.1em] text-body-tertiary">
                {catLabel}
              </Typography>
            </div>
            {fonts.map((f) => {
              const isActive = f.id === fontId;
              return (
                <ListItem
                  active={isActive}
                  aria-selected={isActive}
                  className="gap-3"
                  key={f.id}
                  onClick={() => setFont(f.id)}
                  role="option"
                >
                  <span aria-hidden className="h-4 w-9 flex-shrink-0" />
                  <div className="d-flex min-w-0 flex-grow-1 flex-column">
                    {/* Preview the font in its own stack. */}
                    <span
                      className="text-truncate fs-6"
                      style={{ fontFamily: f.stack }}
                    >
                      {f.label}
                    </span>
                  </div>
                  <Check
                    className={cn(
                      "icon-sm flex-shrink-0 text-body",
                      isActive ? "opacity-100" : "opacity-0",
                    )}
                  />
                </ListItem>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

function ThemeSwatch({ theme }: { theme: DashboardTheme }) {
  const [c1, c2, c3] = theme.swatchColors ?? [
    theme.palette.background.hex,
    theme.palette.midground.hex,
    theme.palette.warmGlow,
  ];
  return (
    <div
      aria-hidden
      className="d-flex h-4 w-9 flex-shrink-0 overflow-hidden border border-current/20"
    >
      <span className="flex-grow-1" style={{ background: c1 }} />
      <span className="flex-grow-1" style={{ background: c2 }} />
      <span className="flex-grow-1" style={{ background: c3 }} />
    </div>
  );
}

function PlaceholderSwatch() {
  return (
    <div
      aria-hidden
      className="h-4 w-9 flex-shrink-0 border border-dashed border-current/20"
    />
  );
}

interface ThemeSwitcherOptionsProps {
  availableThemes: ThemeListEntry[];
  close: () => void;
  setTheme: (name: string) => void;
  themeName: string;
}

interface FontSectionProps {
  fontChoices: FontChoice[];
  fontId: string;
  setFont: (id: string) => void;
}

interface ThemeSwitcherProps {
  collapsed?: boolean;
  dropUp?: boolean;
}
