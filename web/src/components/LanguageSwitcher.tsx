import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { Button } from "@/ui";
import { BottomSheet } from "@/ui";
import { Typography } from "@/ui";
import { useBelowBreakpoint } from "@/ui";
import { useI18n } from "@/i18n/context";
import { LOCALE_META } from "@/i18n";
import type { Locale } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * Language picker — shows the current language's endonym, opens a dropdown
 * of all supported locales when clicked.  Persists choice to localStorage via
 * the I18n context.
 *
 * Replaces the older two-state EN↔ZH toggle now that we ship 16 locales
 * (en, zh, zh-hant, ja, de, es, fr, tr, uk, af, ko, it, ga, pt, ru, hu).
 *
 * No country flags by design — languages aren't countries, and flag pairings
 * inevitably create political mismappings (e.g. Mandarin variants ≠ any single
 * jurisdiction, English ≠ GB, Portuguese ≠ PT). Endonyms are unambiguous.
 *
 * When placed at the bottom of the sidebar (next to ThemeSwitcher), pass
 * `dropUp` so the list opens above the trigger and avoids clipping below the
 * viewport / overflow ancestors. Below the `sm` breakpoint, `dropUp` uses a
 * bottom sheet portaled to `document.body` instead of an anchored dropdown.
 */
export function LanguageSwitcher({ collapsed = false, dropUp = false }: LanguageSwitcherProps) {
  const { locale, setLocale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const narrowViewport = useBelowBreakpoint(640);
  const useMobileSheet = Boolean(dropUp && narrowViewport);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!open || useMobileSheet) return;

    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, useMobileSheet]);

  const current = LOCALE_META[locale];
  const allLocales = Object.entries(LOCALE_META) as Array<[Locale, typeof current]>;
  const sheetTitle = t.language.switchTo;

  return (
    <div ref={containerRef} className="position-relative d-inline-flex">
      <Button
        ghost
        onClick={() => setOpen((v) => !v)}
        title={t.language.switchTo}
        aria-label={t.language.switchTo}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "px-2 py-1 text-lowercase ls-normal fw-normal fs-6 text-body-secondary hover:text-foreground",
          collapsed && "hover:bg-transparent",
        )}
      >
        <span className="d-inline-flex align-items-center gap-2">
          <Typography
            className="d-none sm:inline fs-4 fw-semibold tracking-wide fs-6"
          >
            {locale === "en" ? "EN" : current.name}
          </Typography>
        </span>
      </Button>

      {useMobileSheet && (
        <BottomSheet
          backdropDismissLabel={t.common.close}
          onClose={() => setOpen(false)}
          open={open}
          title={sheetTitle}
        >
          <div aria-label={sheetTitle} role="listbox">
            <LanguageSwitcherOptions
              allLocales={allLocales}
              locale={locale}
              setLocale={setLocale}
              setOpen={setOpen}
            />
          </div>
        </BottomSheet>
      )}

      {open && !useMobileSheet && (() => {
        const rect = containerRef.current?.getBoundingClientRect();
        const dropdown = (
          <div
            ref={dropdownRef}
            aria-label={sheetTitle}
            className={cn(
              "min-w-[10rem] border border-secondary bg-popover shadow-md py-1 max-h-80 overflow-y-auto",
              dropUp ? "position-fixed z-[100]" : "position-absolute z-50 right-0 top-full mt-1",
            )}
            role="listbox"
            style={
              dropUp && rect
                ? { bottom: window.innerHeight - rect.top + 4, left: rect.left }
                : undefined
            }
          >
            <LanguageSwitcherOptions
              allLocales={allLocales}
              locale={locale}
              setLocale={setLocale}
              setOpen={setOpen}
            />
          </div>
        );
        return dropUp ? createPortal(dropdown, document.body) : dropdown;
      })()}
    </div>
  );
}

function LanguageSwitcherOptions({
  allLocales,
  locale,
  setLocale,
  setOpen,
}: LanguageSwitcherOptionsProps) {
  return (
    <>
      {allLocales.map(([code, meta]) => {
        const selected = code === locale;

        return (
          <button
            aria-selected={selected}
            className={cn(
              "w-100 text-start px-3 py-2 d-flex align-items-center gap-2 cursor-pointer",
              "font-sans fs-4 fw-semibold fs-6 tracking-[0.08em]",
              "hover:bg-accent hover:text-accent-foreground transition-colors",
              selected ? "fw-semibold text-body-emphasis" : "text-body-secondary",
            )}
            key={code}
            onClick={() => {
              setLocale(code);
              setOpen(false);
            }}
            role="option"
            type="button"
          >
            <span className="text-truncate">{meta.name}</span>

            {selected && <Check className="ml-auto icon-sm flex-shrink-0 text-body" />}
          </button>
        );
      })}
    </>
  );
}

interface LanguageSwitcherOptionsProps {
  allLocales: Array<[Locale, (typeof LOCALE_META)[Locale]]>;
  locale: Locale;
  setLocale: (code: Locale) => void;
  setOpen: (open: boolean) => void;
}

interface LanguageSwitcherProps {
  collapsed?: boolean;
  dropUp?: boolean;
}
