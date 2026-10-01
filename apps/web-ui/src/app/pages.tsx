import { Lock, RefreshCw, ShieldAlert, Compass } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useRouteError } from "react-router";
import { Button } from "@/kit/Button.tsx";
import { buttonClasses } from "@/kit/button-styles.ts";
import { Card } from "@/kit/Card.tsx";
import { EmptyState, ErrorState } from "@/kit/states.tsx";
import { LOGOUT_PATH } from "@/lib/contract.ts";
import { browser } from "@/lib/navigation.ts";
import { useDocumentTitle } from "@/lib/useDocumentTitle.ts";
import type { MeResponse } from "@/lib/session.ts";

// Full-page states that are not part of a feature: no navigation, no data.

function CenteredPage({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg items-center px-4 py-10">
      <Card className="w-full p-6 text-center">{children}</Card>
    </main>
  );
}

function SignOutLink({ label = "Sign out" }: { label?: string }) {
  // A plain link: the browser leaves the SPA and the web server ends the session.
  return (
    <a href={LOGOUT_PATH} className={buttonClasses("secondary")}>
      {label}
    </a>
  );
}

/**
 * Signed in, but an admin has not granted any access yet (PRD 7: None everywhere). The page checks
 * again by itself (the session query polls every 15 s) and offers a manual check.
 */
export function AccessNotGrantedPage({
  me,
  onCheckAgain,
  checking,
}: {
  me: MeResponse;
  onCheckAgain: () => void;
  checking: boolean;
}) {
  useDocumentTitle("Access not granted");
  return (
    <CenteredPage>
      <Lock aria-hidden="true" className="mx-auto size-10 text-ink-muted" />
      <h1 className="mt-3 text-2xl font-semibold">Access not granted yet</h1>
      <p className="mt-2 text-ink-muted">
        You are signed in as{" "}
        <strong className="text-ink">{me.user.displayName || me.user.username}</strong>
        {me.user.email ? ` (${me.user.email})` : ""}, but nobody has given your account access to
        anything yet. Ask the workspace owner to set your access levels. This page checks again
        automatically.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button variant="primary" onClick={onCheckAgain} busy={checking}>
          <RefreshCw aria-hidden="true" className="size-4" />
          Check again
        </Button>
        <SignOutLink />
      </div>
    </CenteredPage>
  );
}

/**
 * The OIDC group gate refused the login (PRD 7): no account was created. The web server may send
 * the browser here, or render its own page; this one exists so the wording is shared.
 */
export function AccessDeniedPage() {
  useDocumentTitle("Access denied");
  return (
    <CenteredPage>
      <ShieldAlert aria-hidden="true" className="mx-auto size-10 text-danger" />
      <h1 className="mt-3 text-2xl font-semibold">Access denied</h1>
      <p className="mt-2 text-ink-muted">
        This account is not a member of the group that may use this workspace, so no account was
        created. If you should have access, ask the workspace owner to add you to the group, then
        sign in again.
      </p>
      <div className="mt-5 flex justify-center">
        <SignOutLink label="Sign in with a different account" />
      </div>
    </CenteredPage>
  );
}

/**
 * `GET /api/me` came back in a shape this build does not understand, typically because the server
 * was updated (a new kind of object, say) while an older copy of the app is still cached on this
 * device. The app fails closed: nothing is rendered that could offer actions this build cannot
 * judge. Reloading fetches the current build.
 */
export function VersionMismatchPage() {
  useDocumentTitle("New version available");
  return (
    <CenteredPage>
      <RefreshCw aria-hidden="true" className="mx-auto size-10 text-ink-muted" />
      <h1 className="mt-3 text-2xl font-semibold">A new version is available</h1>
      <p className="mt-2 text-ink-muted">
        The server has been updated and this copy of the app no longer matches it. Reload to get the
        latest version. Nothing you have saved is lost.
      </p>
      <div className="mt-5 flex justify-center">
        <Button variant="primary" onClick={() => browser.reload()}>
          Reload
        </Button>
      </div>
    </CenteredPage>
  );
}

/** Route for addresses nothing handles. */
export function NotFoundPage() {
  useDocumentTitle("Page not found");
  return (
    <EmptyState
      icon={Compass}
      title="Page not found"
      description="This address does not exist, or you do not have access to it."
      action={
        <Link to="/" className={buttonClasses("secondary")}>
          Go to the start page
        </Link>
      }
    />
  );
}

/** React Router `errorElement`: a page crashed or its code failed to load. */
export function RouteErrorPage() {
  const error = useRouteError();
  return (
    <ErrorState
      error={error}
      title="This page could not be shown"
      onRetry={() => browser.reload()}
    />
  );
}
