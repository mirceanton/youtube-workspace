import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useParams } from "react-router";
import {
  SCRIPT_BODY_MAX_BYTES,
  SCRIPT_KINDS,
  SCRIPT_STATUSES,
  type ScriptKind,
  type ScriptStatus,
} from "@ytw/shared/constants";
import {
  getScriptResponseSchema,
  listScriptHistoryResponseSchema,
  saveScriptResponseSchema,
  setScriptStatusResponseSchema,
  SCRIPTS_HISTORY_PATH,
  SCRIPTS_PATH,
  SCRIPTS_UPLOAD_PATH,
  type ScriptVersion,
} from "@ytw/shared/api/scripts";
import { Alert } from "@/kit/Alert.tsx";
import { Badge } from "@/kit/Badge.tsx";
import { Button } from "@/kit/Button.tsx";
import { ConflictDialog } from "@/kit/ConflictDialog.tsx";
import { buttonClasses } from "@/kit/button-styles.ts";
import { SelectField } from "@/kit/Field.tsx";
import { LastChangedBy } from "@/kit/LastChangedBy.tsx";
import { MarkdownView } from "@/kit/MarkdownView.tsx";
import { NotesPanel } from "@/kit/NotesPanel.tsx";
import { PageHeader } from "@/kit/PageHeader.tsx";
import { ScriptDiff } from "./ScriptDiff.tsx";
import { ScriptEditor } from "./ScriptEditor.tsx";
import { ScriptReader } from "./ScriptReader.tsx";
import { mergeScriptBodies } from "./script-diff.ts";
import { EmptyState, ErrorState, LoadingState } from "@/kit/states.tsx";
import { WriteGuard } from "@/kit/WriteGuard.tsx";
import { api } from "@/lib/api.ts";
import { ConflictError, describeError, isConflictError } from "@/lib/errors.ts";
import { formatDateTime } from "@/lib/format.ts";

function revisionPath(id: string): string {
  return `${SCRIPTS_PATH}/${encodeURIComponent(id)}`;
}

function revisionQueryKey(id: string | undefined) {
  return ["scripts", "revision", id ?? "none"] as const;
}

function versionLabel(version: ScriptVersion): string {
  return `Version ${version.version} · ${version.status} · ${version.updated_by}`;
}

export function Component() {
  const { ideaId = "", kind: kindParam = "" } = useParams();
  const kind = SCRIPT_KINDS.find((value) => value === kindParam);
  const validIdeaId =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ideaId);
  const validRoute = validIdeaId && kind !== undefined;
  const queryClient = useQueryClient();
  const historyKey = ["scripts", "history", ideaId, kind] as const;
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [diffFromVersion, setDiffFromVersion] = useState<number | null>(null);
  const [diffToVersion, setDiffToVersion] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState("");
  const draftBodyRef = useRef("");
  const [editBaseBody, setEditBaseBody] = useState("");
  const [editBaseVersion, setEditBaseVersion] = useState(0);
  const [conflict, setConflict] = useState<ConflictError | null>(null);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);

  const historyQuery = useQuery({
    queryKey: historyKey,
    enabled: validRoute,
    queryFn: ({ signal }) =>
      api.get(SCRIPTS_HISTORY_PATH, {
        query: { idea_id: ideaId, kind: kind as ScriptKind },
        parse: listScriptHistoryResponseSchema,
        signal,
      }),
  });
  const versions = historyQuery.data?.versions ?? [];
  const latestMeta = versions[0];
  const activeVersion = selectedVersion ?? latestMeta?.version ?? null;
  const activeDiffFrom = diffFromVersion ?? versions[1]?.version ?? null;
  const activeDiffTo = diffToVersion ?? latestMeta?.version ?? null;
  const selectedMeta = versions.find((version) => version.version === activeVersion);
  const diffFromMeta = versions.find((version) => version.version === activeDiffFrom);
  const diffToMeta = versions.find((version) => version.version === activeDiffTo);

  const latestQuery = useQuery({
    queryKey: revisionQueryKey(latestMeta?.id),
    enabled: latestMeta !== undefined,
    queryFn: ({ signal }) =>
      api.get(revisionPath(latestMeta?.id ?? ""), {
        parse: getScriptResponseSchema,
        signal,
      }),
  });
  const selectedQuery = useQuery({
    queryKey: revisionQueryKey(selectedMeta?.id),
    enabled: selectedMeta !== undefined,
    queryFn: ({ signal }) =>
      api.get(revisionPath(selectedMeta?.id ?? ""), {
        parse: getScriptResponseSchema,
        signal,
      }),
  });
  const diffFromQuery = useQuery({
    queryKey: revisionQueryKey(diffFromMeta?.id),
    enabled: showDiff && diffFromMeta !== undefined,
    queryFn: ({ signal }) =>
      api.get(revisionPath(diffFromMeta?.id ?? ""), {
        parse: getScriptResponseSchema,
        signal,
      }),
  });
  const diffToQuery = useQuery({
    queryKey: revisionQueryKey(diffToMeta?.id),
    enabled: showDiff && diffToMeta !== undefined,
    queryFn: ({ signal }) =>
      api.get(revisionPath(diffToMeta?.id ?? ""), {
        parse: getScriptResponseSchema,
        signal,
      }),
  });

  const saveMutation = useMutation({
    mutationFn: (input: { body: string; baseVersion: number }) =>
      api.post(
        SCRIPTS_PATH,
        {
          idea_id: ideaId,
          kind,
          base_version: input.baseVersion,
          body_md: input.body,
        },
        { parse: saveScriptResponseSchema },
      ),
    onSuccess: async ({ script }, input) => {
      const savedBody = input.body.replace(/\r\n?/g, "\n");
      queryClient.setQueryData(revisionQueryKey(script.id), {
        script: { ...script, body_md: savedBody },
      });
      setSelectedVersion(script.version);
      setSavedVersion(script.version);
      setEditBaseBody(savedBody);
      setEditBaseVersion(script.version);
      if (draftBodyRef.current === input.body) setEditing(false);
      setConflict(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: historyKey }),
        queryClient.invalidateQueries({ queryKey: ["scripts", "latest"] }),
      ]);
    },
    onError: (error) => {
      if (isConflictError(error)) {
        setConflict(error);
        void queryClient.invalidateQueries({ queryKey: historyKey });
      }
    },
  });

  const statusMutation = useMutation({
    mutationFn: (status: ScriptStatus) =>
      api.patch(
        `${revisionPath(selectedMeta?.id ?? "")}/status`,
        { status },
        { parse: setScriptStatusResponseSchema },
      ),
    onSuccess: async ({ script }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: historyKey }),
        queryClient.invalidateQueries({ queryKey: revisionQueryKey(script.id) }),
        queryClient.invalidateQueries({ queryKey: ["scripts", "latest"] }),
      ]);
    },
  });

  const uploadMutation = useMutation({
    mutationFn: (input: { file: File; baseVersion: number }) =>
      api.post(SCRIPTS_UPLOAD_PATH, undefined, {
        query: { idea_id: ideaId, kind, base_version: input.baseVersion },
        rawBody: input.file,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
        parse: saveScriptResponseSchema,
      }),
    onSuccess: async ({ script }) => {
      setSelectedVersion(script.version);
      setSavedVersion(script.version);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: historyKey }),
        queryClient.invalidateQueries({ queryKey: ["scripts", "latest"] }),
      ]);
    },
  });

  function startEditing() {
    const latest = latestQuery.data?.script;
    const baseVersion = latest?.version ?? 0;
    const body = latest?.body_md ?? "";
    setEditBaseVersion(baseVersion);
    setEditBaseBody(body);
    draftBodyRef.current = body;
    setDraftBody(body);
    setSavedVersion(null);
    setEditing(true);
  }

  function submitEdit(event: FormEvent) {
    event.preventDefault();
    saveMutation.mutate({ body: draftBody, baseVersion: editBaseVersion });
  }

  function reloadConflict() {
    const latest = latestQuery.data?.script;
    if (latest) setSelectedVersion(latest.version);
    setConflict(null);
    setEditing(false);
  }

  function mergeConflict() {
    const latest = latestQuery.data?.script;
    if (!latest) return;
    const merged = mergeScriptBodies(editBaseBody, latest.body_md, draftBody);
    draftBodyRef.current = merged;
    setDraftBody(merged);
    setEditBaseBody(latest.body_md);
    setEditBaseVersion(latest.version);
    setConflict(null);
  }

  function changeDraftBody(body: string) {
    draftBodyRef.current = body;
    setDraftBody(body);
  }

  function uploadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) uploadMutation.mutate({ file, baseVersion: activeVersion ?? 0 });
  }

  if (!validRoute) {
    return (
      <>
        <PageHeader title="Script" back={{ to: "/scripts", label: "Scripts" }} />
        <ErrorState title="Script not found" description="Choose a valid idea and script kind." />
      </>
    );
  }

  const pageTitle = kind === "script" ? "Script" : "Packaging";
  if (historyQuery.isPending) {
    return (
      <>
        <PageHeader title={pageTitle} back={{ to: "/scripts", label: "Scripts" }} />
        <LoadingState label="Loading script history" lines={5} />
      </>
    );
  }
  if (historyQuery.isError || !historyQuery.data) {
    return (
      <>
        <PageHeader title={pageTitle} back={{ to: "/scripts", label: "Scripts" }} />
        <ErrorState
          error={historyQuery.error}
          onRetry={() => void historyQuery.refetch()}
          retrying={historyQuery.isFetching}
        />
      </>
    );
  }

  const selectedScript = selectedQuery.data?.script;
  const latestScript = latestQuery.data?.script;
  const hasNewerVersion = latestMeta !== undefined && activeVersion !== latestMeta.version;
  const bodyBytes = new TextEncoder().encode(draftBody).byteLength;
  const latestVersionFromConflict =
    conflict?.latest &&
    typeof conflict.latest === "object" &&
    "version" in conflict.latest &&
    typeof conflict.latest.version === "number"
      ? conflict.latest.version
      : undefined;
  const mergeReady =
    latestScript !== undefined &&
    latestScript.version >= (latestVersionFromConflict ?? 0) &&
    editing;

  return (
    <>
      <PageHeader
        title={historyQuery.data.idea_title}
        description={`${pageTitle} · Idea ${ideaId}`}
        back={{ to: "/scripts", label: "All scripts" }}
        actions={
          selectedScript ? (
            <>
              <Button onClick={() => setShowDiff((open) => !open)}>
                {showDiff ? "Hide diff" : "Compare versions"}
              </Button>
              <a
                href={`${revisionPath(selectedScript.id)}/file`}
                download
                className={buttonClasses("secondary")}
              >
                Download .md
              </a>
            </>
          ) : null
        }
      />

      {savedVersion !== null ? (
        <Alert tone="ok" className="mb-4">
          Saved as version {savedVersion}.
        </Alert>
      ) : null}
      {hasNewerVersion && !editing ? (
        <Alert tone="info" className="mb-4">
          Version {latestMeta?.version} is newer than the version you are reading.{" "}
          <Button className="ms-2" onClick={() => setSelectedVersion(latestMeta?.version ?? null)}>
            View latest
          </Button>
        </Alert>
      ) : null}

      {versions.length > 0 ? (
        <section
          aria-label="Version history"
          className="mb-5 grid gap-3 rounded-xl border border-line bg-surface p-4 sm:grid-cols-[minmax(12rem,1fr)_auto_auto] sm:items-end"
        >
          <SelectField
            label="Read version"
            value={activeVersion ?? ""}
            onChange={(event) => setSelectedVersion(Number(event.target.value))}
          >
            {versions.map((version) => (
              <option key={version.id} value={version.version}>
                {versionLabel(version)}
              </option>
            ))}
          </SelectField>
          {selectedScript ? (
            <LastChangedBy
              actor={selectedScript.updated_by}
              at={selectedScript.updated_at}
              label="Last changed by"
              className="sm:pb-3"
            />
          ) : (
            <span />
          )}
          <WriteGuard resource="scripts" explain={false}>
            <Button variant="primary" disabled={!latestScript || editing} onClick={startEditing}>
              Edit latest version
            </Button>
          </WriteGuard>
        </section>
      ) : (
        <EmptyState
          title={`No ${kind === "script" ? "script" : "packaging document"} yet`}
          description="The first save creates version 1 as a draft."
          action={
            <WriteGuard resource="scripts">
              <Button variant="primary" onClick={startEditing}>
                Write first version
              </Button>
            </WriteGuard>
          }
        />
      )}

      {showDiff && versions.length >= 2 ? (
        <section aria-label="Compare script versions" className="mb-6 grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label="Compare from"
              value={activeDiffFrom ?? ""}
              onChange={(event) => setDiffFromVersion(Number(event.target.value))}
            >
              {versions.map((version) => (
                <option key={version.id} value={version.version}>
                  {versionLabel(version)}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="Compare to"
              value={activeDiffTo ?? ""}
              onChange={(event) => setDiffToVersion(Number(event.target.value))}
            >
              {versions.map((version) => (
                <option key={version.id} value={version.version}>
                  {versionLabel(version)}
                </option>
              ))}
            </SelectField>
          </div>
          {diffFromQuery.isError || diffToQuery.isError ? (
            <ErrorState
              compact
              error={diffFromQuery.error ?? diffToQuery.error}
              onRetry={() => void Promise.all([diffFromQuery.refetch(), diffToQuery.refetch()])}
              retrying={diffFromQuery.isFetching || diffToQuery.isFetching}
            />
          ) : diffFromQuery.isPending || diffToQuery.isPending ? (
            <LoadingState compact label="Comparing versions" lines={4} />
          ) : diffFromQuery.data && diffToQuery.data ? (
            <ScriptDiff
              before={diffFromQuery.data.script.body_md}
              after={diffToQuery.data.script.body_md}
              beforeLabel={`Version ${diffFromQuery.data.script.version}`}
              afterLabel={`Version ${diffToQuery.data.script.version}`}
            />
          ) : null}
        </section>
      ) : null}

      {editing ? (
        <section aria-labelledby="edit-script-heading" className="mb-6">
          <h2 id="edit-script-heading" className="mb-3 text-lg font-semibold">
            {editBaseVersion === 0 ? "New script" : `Edit from version ${editBaseVersion}`}
          </h2>
          <WriteGuard resource="scripts">
            <form onSubmit={submitEdit} className="grid gap-3" noValidate>
              <ScriptEditor value={draftBody} onChange={changeDraftBody} />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-ink-muted">
                  {bodyBytes.toLocaleString()} of {SCRIPT_BODY_MAX_BYTES.toLocaleString()} UTF-8
                  bytes
                </p>
                <div className="flex gap-2">
                  <Button onClick={() => setEditing(false)}>Cancel</Button>
                  <Button
                    type="submit"
                    variant="primary"
                    busy={saveMutation.isPending}
                    disabled={bodyBytes > SCRIPT_BODY_MAX_BYTES}
                  >
                    Save new version
                  </Button>
                </div>
              </div>
              {saveMutation.isError && !isConflictError(saveMutation.error) ? (
                <Alert tone="danger" title="The script was not saved">
                  {describeError(saveMutation.error)}
                </Alert>
              ) : null}
            </form>
          </WriteGuard>
        </section>
      ) : selectedMeta ? (
        <section className="mb-6">
          {selectedScript ? (
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Badge tone="info">Version {selectedScript.version}</Badge>
              <WriteGuard resource="scripts" explain={false}>
                <SelectField
                  label="Status"
                  hideLabel
                  value={selectedScript.status}
                  onChange={(event) => statusMutation.mutate(event.target.value as ScriptStatus)}
                >
                  {SCRIPT_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </SelectField>
              </WriteGuard>
              {statusMutation.isError ? (
                <Alert tone="danger">{describeError(statusMutation.error)}</Alert>
              ) : null}
            </div>
          ) : null}
          {selectedQuery.isPending ? (
            <LoadingState label="Loading script version" lines={8} />
          ) : selectedQuery.isError ? (
            <ErrorState
              error={selectedQuery.error}
              onRetry={() => void selectedQuery.refetch()}
              retrying={selectedQuery.isFetching}
            />
          ) : selectedScript ? (
            <ScriptReader markdown={selectedScript.body_md} />
          ) : null}
          {selectedScript ? (
            <div className="mt-3">
              <LastChangedBy actor={selectedScript.updated_by} at={selectedScript.updated_at} />
              <p className="mt-1 text-xs text-ink-muted">
                Created {formatDateTime(selectedScript.created_at)} by {selectedScript.created_by}
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      <section aria-label="Script file actions" className="mb-8 flex flex-wrap items-center gap-2">
        <WriteGuard resource="scripts" explain={false}>
          <label className={buttonClasses("secondary", "md", "cursor-pointer")}>
            Upload Markdown revision
            <input
              type="file"
              accept=".md,text/markdown,text/plain"
              className="sr-only"
              aria-label="Upload Markdown revision"
              onChange={uploadFile}
            />
          </label>
        </WriteGuard>
        {uploadMutation.isPending ? <output>Uploading revision…</output> : null}
        {uploadMutation.isError ? (
          <Alert tone="danger" title="The file was not uploaded">
            {describeError(uploadMutation.error)}
          </Alert>
        ) : null}
      </section>

      {selectedScript ? (
        <NotesPanel
          entityType="script"
          entityId={selectedScript.id}
          title="Comments"
          headingLevel={2}
        />
      ) : null}

      <ConflictDialog
        open={conflict !== null}
        entity="script"
        error={conflict}
        changedBy={
          latestScript ? (
            <LastChangedBy actor={latestScript.updated_by} at={latestScript.updated_at} />
          ) : undefined
        }
        latest={
          latestScript ? (
            <ScriptDiff
              before={editBaseBody}
              after={latestScript.body_md}
              beforeLabel={`Your base · version ${editBaseVersion}`}
              afterLabel={`Latest · version ${latestScript.version}`}
            />
          ) : undefined
        }
        yours={<MarkdownView markdown={draftBody} />}
        onReload={reloadConflict}
        onMerge={mergeReady ? mergeConflict : undefined}
        onKeepEditing={() => setConflict(null)}
      />
    </>
  );
}
