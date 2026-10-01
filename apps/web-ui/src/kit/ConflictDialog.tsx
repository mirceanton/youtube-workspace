import { useId, useRef, type ReactNode } from "react";
import { ConflictError } from "@/lib/errors.ts";
import { Button } from "./Button.tsx";
import { Dialog } from "./Dialog.tsx";

export interface ConflictDialogProps {
  open: boolean;
  /** What was edited, as a lower-case noun for the copy: "idea", "script", "video". */
  entity: string;
  /** The 409 the save returned; its message (what the server says is stale) is shown. */
  error?: ConflictError | null;
  /** Who changed it meanwhile, typically `<LastChangedBy ... />` for the latest version. */
  changedBy?: ReactNode;
  /** The version that is saved now (a preview or summary). */
  latest?: ReactNode;
  /** The user's unsaved changes (a preview or summary), so they can see what is at stake. */
  yours?: ReactNode;
  /** Drop my changes and load the latest version. */
  onReload: () => void;
  /**
   * Keep my changes and apply them on top of the latest version; what "merge" means is up to the
   * screen (re-open the editor on the latest text with my edit kept, show a diff, ...). Omit when
   * the screen cannot merge: then only reload or keep editing are offered.
   */
  onMerge?: () => void;
  /** Close the dialog and keep editing. Nothing is saved or overwritten. */
  onKeepEditing: () => void;
}

/**
 * Shown when a save fails with a version conflict (409, PRD 6: "never silently overwrite"). The
 * user chooses between reloading the latest version, merging their changes, or going back to the
 * editor. There is deliberately no "save anyway".
 */
export function ConflictDialog({
  open,
  entity,
  error,
  changedBy,
  latest,
  yours,
  onReload,
  onMerge,
  onKeepEditing,
}: ConflictDialogProps) {
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const yoursId = useId();
  const latestId = useId();
  return (
    <Dialog
      open={open}
      onClose={onKeepEditing}
      title={`This ${entity} changed while you were editing`}
      description={
        error?.message ??
        `Someone else saved a newer version of this ${entity}. Your changes were not saved.`
      }
      initialFocus={keepEditingRef}
      size="lg"
      footer={
        <>
          <Button ref={keepEditingRef} onClick={onKeepEditing}>
            Keep editing
          </Button>
          <Button variant="danger" onClick={onReload}>
            Discard mine and reload
          </Button>
          {onMerge ? (
            <Button variant="primary" onClick={onMerge}>
              Merge my changes
            </Button>
          ) : null}
        </>
      }
    >
      <div className="grid gap-4">
        {changedBy ? <div>{changedBy}</div> : null}
        {latest || yours ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {yours ? (
              <section aria-labelledby={yoursId} className="min-w-0">
                <h3 id={yoursId} className="mb-1 text-sm font-semibold">
                  Your changes
                </h3>
                <div className="rounded-lg border border-line bg-subtle p-3 text-sm">{yours}</div>
              </section>
            ) : null}
            {latest ? (
              <section aria-labelledby={latestId} className="min-w-0">
                <h3 id={latestId} className="mb-1 text-sm font-semibold">
                  Latest version
                </h3>
                <div className="rounded-lg border border-line bg-subtle p-3 text-sm">{latest}</div>
              </section>
            ) : null}
          </div>
        ) : null}
        <p className="text-sm text-ink-muted">
          Nothing is overwritten unless you choose to. Reloading discards your unsaved changes.
        </p>
      </div>
    </Dialog>
  );
}
