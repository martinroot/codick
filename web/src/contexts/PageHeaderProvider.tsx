import { useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { PageHeaderContext } from "./page-header-context";
import { resolvePageTitle } from "@/lib/resolve-page-title";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

export function PageHeaderProvider({
  children,
  pluginTabs,
}: {
  children: ReactNode;
  pluginTabs: { path: string; label: string }[];
}) {
  const { pathname } = useLocation();
  const { t } = useI18n();
  const [titleOverride, setTitleOverride] = useState<string | null>(null);
  const [afterTitle, setAfterTitle] = useState<ReactNode>(null);
  const [end, setEnd] = useState<ReactNode>(null);

  // Clear any per-page title / toolbar slots when the path changes. Child routes
  // re-fill these on mount via usePageHeader.
  /* eslint-disable react-hooks/set-state-in-effect */
  useLayoutEffect(() => {
    setTitleOverride(null);
    setAfterTitle(null);
    setEnd(null);
  }, [pathname]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const defaultTitle = useMemo(
    () => resolvePageTitle(pathname, t, pluginTabs),
    [pathname, t, pluginTabs],
  );
  const displayTitle = titleOverride ?? defaultTitle;

  const isChatRoute = pathname === "/chat" || pathname === "/chat/";
  /** Env jump-nav is wide — stack below title on small screens so KEYS stays readable. */
  const isEnvRoute =
    pathname === "/env" || pathname.startsWith("/env/");

  const value = useMemo(
    () => ({
      setAfterTitle,
      setEnd,
      setTitle: setTitleOverride,
    }),
    [],
  );

  return (
    <PageHeaderContext.Provider value={value}>
      <div className="d-flex flex-column flex-grow-1 min-h-0 w-100 min-w-0 overflow-hidden">
        {/*
          Reference template: the page header is a `bg-body-tertiary` band
          with `p-3`, matching the rail's surface so the two read as one
          piece of chrome. It previously reused the page canvas and a
          `border-current/20` hairline, which made the header blend into
          the content below it.
        */}
        <header
          className={cn(
            "z-1 w-100 flex-shrink-0 bg-body-tertiary border-bottom",
            // Mobile stacks title + toolbar — a fixed height clips content;
            // desktop stays one row.
            "min-h-0 overflow-x-hidden overflow-y-visible p-3 sm:py-2",
          )}
          role="banner"
        >
          <div
            className={cn(
              "d-flex w-100 min-w-0 flex-grow-1 gap-2",
              isChatRoute
                ? "flex-row align-items-center"
                : "flex-column justify-content-center sm:flex-row sm:align-items-center",
            )}
          >
            <div
              className={cn(
                "d-flex min-w-0 flex-grow-1 gap-2 sm:gap-3",
                afterTitle && isEnvRoute
                  ? "flex-column align-items-start sm:flex-row sm:items-center"
                  : afterTitle
                    ? "flex-row flex-wrap align-items-center"
                    : "flex-row align-items-center",
              )}
            >
              <h1
                className={cn(
                  "font-expanded min-w-0 fs-6 fw-bold tracking-[0.08em] text-body",
                  afterTitle && isEnvRoute
                    ? "max-w-full sm:min-w-0 sm:shrink sm:truncate"
                    : afterTitle
                      ? "flex-shrink-1 text-truncate"
                      : "text-truncate",
                )}
              >
                {displayTitle}
              </h1>
              {afterTitle ? (
                <div
                  className={cn(
                    "min-w-0 scrollbar-none",
                    isEnvRoute
                      ? "w-100 overflow-x-auto sm:flex-1 sm:overflow-x-auto"
                      : "flex-shrink-0 overflow-visible",
                  )}
                >
                  {afterTitle}
                </div>
              ) : null}
            </div>

            {end ? (
              <div
                className={cn(
                  "d-flex min-w-0 sm:max-w-md sm:flex-1",
                  isChatRoute
                    ? "w-auto flex-shrink-0 justify-content-end"
                    : "w-100 justify-content-start sm:justify-end",
                )}
              >
                {end}
              </div>
            ) : null}
          </div>
        </header>

        <main
          className={cn(
            "min-h-0 w-100 min-w-0 flex-grow-1 d-flex flex-column",
            // Bottom inset for scrolled pages lives on the route outlet wrapper in
            // `App.tsx` (`w-100 min-w-0`) so it pads scrollable content, not flex chrome.
            isChatRoute
              ? "overflow-hidden"
              : "overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]",
          )}
        >
          {children}
        </main>
      </div>
    </PageHeaderContext.Provider>
  );
}
