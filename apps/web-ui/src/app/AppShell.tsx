import { LogOut, MoreHorizontal, WifiOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { NavLink, Outlet, useLocation, useNavigation } from "react-router";
import { Badge } from "@/kit/Badge.tsx";
import { buttonClasses } from "@/kit/button-styles.ts";
import { Dialog } from "@/kit/Dialog.tsx";
import { useOnlineStatus } from "@/kit/useOnlineStatus.ts";
import { cx } from "@/lib/cx.ts";
import { LOGOUT_PATH } from "@/lib/contract.ts";
import { useSession } from "@/lib/session.ts";
import { APP_NAME } from "@/lib/useDocumentTitle.ts";
import { navEntriesFor, type FeatureDefinition, type NavEntry } from "./features.ts";
import { WideLayoutContext } from "@/kit/layout.ts";

/** Items in the phone bottom bar before "More" (PRD 8: bottom navigation on phones). */
export const BOTTOM_BAR_ITEMS = 4;

function SideLink({ entry, onNavigate }: { entry: NavEntry; onNavigate?: () => void }) {
  const Icon = entry.icon;
  return (
    <NavLink
      to={entry.to}
      onClick={onNavigate}
      className={({ isActive }) =>
        cx(
          "flex min-h-11 items-center gap-3 rounded-lg px-3 text-base",
          isActive
            ? "bg-subtle font-semibold text-ink"
            : "font-medium text-ink-muted hover:bg-subtle hover:text-ink",
        )
      }
    >
      <Icon aria-hidden="true" className="size-5 shrink-0" />
      {entry.label}
    </NavLink>
  );
}

function BottomLink({ entry }: { entry: NavEntry }) {
  const Icon = entry.icon;
  return (
    <NavLink
      to={entry.to}
      className={({ isActive }) =>
        cx(
          "flex min-h-14 min-w-11 flex-col items-center justify-center gap-0.5 px-1 text-xs",
          isActive ? "font-semibold text-ink" : "font-medium text-ink-muted",
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={cx(
              "flex h-7 w-12 items-center justify-center rounded-full",
              isActive && "bg-subtle",
            )}
          >
            <Icon aria-hidden="true" className="size-5" />
          </span>
          {entry.label}
        </>
      )}
    </NavLink>
  );
}

function AccountBlock({ bordered = true }: { bordered?: boolean }) {
  const { user } = useSession();
  return (
    <div className={cx("grid gap-3 p-3", bordered && "border-t border-line")}>
      <div className="min-w-0 px-1">
        <p className="truncate font-medium">{user.displayName || user.username}</p>
        <p className="truncate text-sm text-ink-muted">{user.email || user.username}</p>
        {user.isAdmin ? <Badge className="mt-1">Admin</Badge> : null}
      </div>
      {/* A plain link: the browser leaves the SPA and the web server ends the session. */}
      <a href={LOGOUT_PATH} className={buttonClasses("secondary")}>
        <LogOut aria-hidden="true" className="size-4" />
        Sign out
      </a>
    </div>
  );
}

function Sidebar({ entries }: { entries: NavEntry[] }) {
  return (
    <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-e border-line bg-surface md:flex">
      <p className="px-5 py-5 text-lg font-semibold tracking-tight">{APP_NAME}</p>
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-2">
        <ul className="grid gap-1">
          {entries.map((entry) => (
            <li key={entry.id}>
              <SideLink entry={entry} />
            </li>
          ))}
        </ul>
      </nav>
      <AccountBlock />
    </aside>
  );
}

function BottomBar({ entries }: { entries: NavEntry[] }) {
  // The sheet is open for one location: navigating (from a link inside it) closes it.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const { pathname } = useLocation();
  const moreOpen = openAt === pathname;
  const setMoreOpen = (open: boolean) => setOpenAt(open ? pathname : null);
  const primary = entries.slice(0, BOTTOM_BAR_ITEMS);
  const rest = entries.slice(BOTTOM_BAR_ITEMS);

  return (
    <>
      <nav
        aria-label="Main (bottom bar)"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <ul
          className="grid"
          style={{ gridTemplateColumns: `repeat(${primary.length + 1}, minmax(0, 1fr))` }}
        >
          {primary.map((entry) => (
            <li key={entry.id} className="flex justify-center">
              <BottomLink entry={entry} />
            </li>
          ))}
          <li className="flex justify-center">
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-haspopup="dialog"
              className="flex min-h-14 min-w-11 flex-col items-center justify-center gap-0.5 px-1 text-xs font-medium text-ink-muted"
            >
              <span className="flex h-7 w-12 items-center justify-center">
                <MoreHorizontal aria-hidden="true" className="size-5" />
              </span>
              More
            </button>
          </li>
        </ul>
      </nav>
      <Dialog open={moreOpen} onClose={() => setMoreOpen(false)} title="More" size="sm">
        {rest.length > 0 ? (
          <nav aria-label="More sections">
            <ul className="mb-3 grid gap-1">
              {rest.map((entry) => (
                <li key={entry.id}>
                  <SideLink entry={entry} onNavigate={() => setMoreOpen(false)} />
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        <AccountBlock bordered={rest.length > 0} />
      </Dialog>
    </>
  );
}

function OfflineBanner() {
  const online = useOnlineStatus();
  if (online) return null;
  return (
    <output className="flex items-center gap-2 border-b border-warn bg-warn-soft px-4 py-2 text-sm text-warn">
      <WifiOff aria-hidden="true" className="size-4 shrink-0" />
      <span>
        You are offline. What is already loaded stays readable; saving changes is turned off until
        you reconnect.
      </span>
    </output>
  );
}

/** Moves focus to the content after each navigation, so keyboard and screen-reader users start there. */
function useFocusMainOnNavigation(ref: RefObject<HTMLElement | null>): void {
  const { pathname } = useLocation();
  const previous = useRef(pathname);
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    ref.current?.focus({ preventScroll: true });
  }, [pathname, ref]);
}

function ShellFrame({ entries, children }: { entries: NavEntry[]; children: ReactNode }) {
  const [wide, setWide] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const navigation = useNavigation();
  useFocusMainOnNavigation(mainRef);
  const loading = navigation.state === "loading";

  return (
    <div className="min-h-dvh md:flex">
      <a
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          mainRef.current?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:start-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-3 focus:shadow-lg"
      >
        Skip to content
      </a>
      <Sidebar entries={entries} />
      <div className="flex min-w-0 flex-1 flex-col">
        <OfflineBanner />
        {loading ? (
          <div
            aria-hidden="true"
            className="h-0.5 w-full animate-pulse bg-brand motion-reduce:animate-none"
          />
        ) : null}
        <WideLayoutContext value={setWide}>
          <main
            id="main"
            ref={mainRef}
            tabIndex={-1}
            aria-busy={loading || undefined}
            className={cx(
              "mx-auto w-full px-4 pt-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] outline-none md:px-8 md:pt-6 md:pb-10",
              wide ? "max-w-none" : "max-w-5xl",
            )}
          >
            {children}
          </main>
        </WideLayoutContext>
      </div>
      <BottomBar entries={entries} />
    </div>
  );
}

/**
 * Sidebar on desktop (md and up), bottom bar on phones, an offline banner, a skip link and focus
 * handling. The navigation lists the features the user's levels allow (see features.ts).
 */
export function AppShell({ features }: { features: readonly FeatureDefinition[] }) {
  const me = useSession();
  const entries = useMemo(() => navEntriesFor(features, me), [features, me]);
  return (
    <ShellFrame entries={entries}>
      <Outlet />
    </ShellFrame>
  );
}
