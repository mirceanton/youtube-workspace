import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { grantOptions, describeLevels } from "@ytw/policy";
import { RESOURCE_LABELS, RESOURCES, type Level, type ResourceLevels } from "@ytw/shared/constants";
import {
  issuedSettingsTokenResponseSchema,
  listSettingsTokensResponseSchema,
  SETTINGS_TOKENS_PATH,
  settingsTokenMutationResponseSchema,
  type IssuedSettingsTokenResponse,
  type SettingsToken,
} from "@ytw/shared/api/settings";
import { api } from "@/lib/api.ts";
import { formatDate, formatDateTime } from "@/lib/format.ts";
import { Alert } from "@/kit/Alert.tsx";
import { Badge } from "@/kit/Badge.tsx";
import { Button } from "@/kit/Button.tsx";
import { Card } from "@/kit/Card.tsx";
import { Dialog } from "@/kit/Dialog.tsx";
import { SelectField } from "@/kit/Field.tsx";
import { ErrorState, LoadingState } from "@/kit/states.tsx";
import { PageHeader } from "@/kit/PageHeader.tsx";
import { settingsKeys, getSettingsProfile } from "./settings-api.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function nextRotationExpiry(
  currentExpiry: string | null,
  status: SettingsToken["status"],
): string | null {
  const now = Date.now();
  if (currentExpiry === null && status !== "expired") return null;
  if (currentExpiry && new Date(currentExpiry).getTime() > now) return currentExpiry;
  return new Date(now + 90 * DAY_MS).toISOString();
}

function tokenList(signal?: AbortSignal) {
  return api.get(SETTINGS_TOKENS_PATH, {
    parse: listSettingsTokensResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

function levelLabel(level: string) {
  return level === "none" ? "None" : level === "read" ? "Read" : "Write";
}

export function Component() {
  const { tokenId = "" } = useParams();
  return <TokenDetail key={tokenId} tokenId={tokenId} />;
}

function TokenDetail({ tokenId }: { tokenId: string }) {
  const queryClient = useQueryClient();
  const [permissions, setPermissions] = useState<Partial<ResourceLevels>>({});
  const [issued, setIssued] = useState<IssuedSettingsTokenResponse | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const tokens = useQuery({
    queryKey: settingsKeys.tokens,
    queryFn: ({ signal }) => tokenList(signal),
  });
  const profile = useQuery({
    queryKey: settingsKeys.profile,
    queryFn: ({ signal }) => getSettingsProfile(signal),
  });
  const token = tokens.data?.tokens.find((item) => item.id === tokenId);
  const owner = profile.data?.profile;
  const allowed =
    owner && profile.data
      ? grantOptions({ isAdmin: owner.is_admin, levels: profile.data.levels })
      : null;
  const hasChanges = Object.keys(permissions).length > 0;

  const save = useMutation({
    mutationFn: (next: Partial<ResourceLevels>) =>
      api.patch<{ token: SettingsToken }>(
        `${SETTINGS_TOKENS_PATH}/${tokenId}`,
        { permissions: next },
        {
          parse: settingsTokenMutationResponseSchema,
        },
      ),
    onSuccess: async () => {
      setPermissions({});
      await queryClient.invalidateQueries({ queryKey: settingsKeys.tokens });
    },
  });

  const rotate = useMutation({
    mutationKey: ["settings", "rotateToken", tokenId],
    mutationFn: (expiry: string | null) =>
      api.post<IssuedSettingsTokenResponse>(
        `${SETTINGS_TOKENS_PATH}/${tokenId}/rotate`,
        {
          expires_at: expiry,
        },
        { parse: issuedSettingsTokenResponseSchema },
      ),
    gcTime: 0,
  });

  const revoke = useMutation({
    mutationFn: () => api.delete(`${SETTINGS_TOKENS_PATH}/${tokenId}`),
    onSuccess: async () => {
      setConfirmRevoke(false);
      await queryClient.invalidateQueries({ queryKey: settingsKeys.tokens });
    },
  });

  function openRevokeDialog() {
    revoke.reset();
    setConfirmRevoke(true);
  }

  function closeRevokeDialog() {
    setConfirmRevoke(false);
    revoke.reset();
  }

  if (tokens.isPending || profile.isPending) return <LoadingState label="Loading token" />;
  if (tokens.isError)
    return <ErrorState error={tokens.error} onRetry={() => void tokens.refetch()} />;
  if (profile.isError)
    return <ErrorState error={profile.error} onRetry={() => void profile.refetch()} />;
  if (!token || !owner || !allowed)
    return (
      <ErrorState
        title="Token not found"
        description="This token may have been removed from your account."
      />
    );

  const disabled = token.status === "revoked";
  const currentExpiry = token.expires_at;
  const currentStatus = token.status;

  function rotateSecret() {
    const expiry = nextRotationExpiry(currentExpiry, currentStatus);
    void rotate
      .mutateAsync(expiry)
      .then((result) => {
        setIssued(result);
        rotate.reset();
        return queryClient.invalidateQueries({ queryKey: settingsKeys.tokens });
      })
      .catch(() => undefined);
  }

  function closeSecret() {
    setIssued(null);
    void queryClient.invalidateQueries({ queryKey: settingsKeys.tokens });
  }

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <PageHeader
        title={token.name}
        back={{ to: "/settings", label: "Settings" }}
        description={`${token.prefix}… · ${describeLevels(token.effective_levels)}`}
      />
      {save.error || rotate.error || (revoke.error && !confirmRevoke) ? (
        <Alert tone="danger" title="Token action failed">
          {save.error?.message ?? rotate.error?.message ?? revoke.error?.message}
        </Alert>
      ) : null}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-ink-muted">Status</p>
            <Badge
              tone={
                token.status === "active" ? "ok" : token.status === "revoked" ? "danger" : "warn"
              }
            >
              {token.status.replace("_", " ")}
            </Badge>
          </div>
          <p className="font-mono text-sm">{token.prefix}…</p>
        </div>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-ink-muted">Created</dt>
            <dd>{formatDate(token.created_at)}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Expires</dt>
            <dd>{token.expires_at ? formatDate(token.expires_at) : "Never"}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Last used</dt>
            <dd>{token.last_used_at ? formatDateTime(token.last_used_at) : "Never"}</dd>
          </div>
        </dl>
      </Card>

      <Card>
        <h2 className="mb-1 text-lg font-semibold">Permissions</h2>
        <p className="mb-4 text-sm text-ink-muted">
          Options stop at your current access level. Lowering your access also lowers this token
          immediately.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {RESOURCES.map((resource) => (
            <SelectField
              key={resource}
              label={`${RESOURCE_LABELS[resource]} permission`}
              value={permissions[resource] ?? token.effective_levels[resource]}
              disabled={disabled || save.isPending}
              onChange={(event) => {
                const level = event.currentTarget.value as Level;
                setPermissions((current) => ({
                  ...current,
                  [resource]: level,
                }));
              }}
            >
              {allowed[resource].map((level) => (
                <option key={level} value={level}>
                  {levelLabel(level)}
                </option>
              ))}
            </SelectField>
          ))}
        </div>
        {disabled ? (
          <p className="mt-3 text-sm text-ink-muted">
            A revoked token cannot be edited or rotated.
          </p>
        ) : null}
        <Button
          className="mt-4"
          variant="primary"
          disabled={!hasChanges || disabled}
          busy={save.isPending}
          onClick={() => save.mutate(permissions)}
        >
          Save permissions
        </Button>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold">Token lifecycle</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Rotation replaces the secret immediately. Revocation cannot be undone.
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <Button disabled={disabled} busy={rotate.isPending} onClick={rotateSecret}>
            Rotate secret
          </Button>
          <Button
            variant="danger"
            disabled={disabled}
            busy={revoke.isPending}
            onClick={openRevokeDialog}
          >
            Revoke token
          </Button>
        </div>
      </Card>

      <Dialog
        open={confirmRevoke}
        onClose={closeRevokeDialog}
        title="Revoke this token?"
        description="It will stop working immediately and remain in your token history."
        footer={
          <>
            <Button onClick={closeRevokeDialog}>Keep token</Button>
            <Button variant="danger" busy={revoke.isPending} onClick={() => revoke.mutate()}>
              Revoke token
            </Button>
          </>
        }
      >
        {revoke.error ? (
          <Alert tone="danger" title="Token action failed">
            {revoke.error.message}
          </Alert>
        ) : null}
      </Dialog>
      <Dialog
        open={issued !== null}
        onClose={closeSecret}
        title="Copy your rotated token"
        description="The new secret is shown once. The old secret has stopped working."
      >
        {issued ? (
          <div className="flex flex-col gap-3">
            <Alert tone="warn" title="Shown once">
              Store this value now. Closing this window discards it.
            </Alert>
            <code className="block select-all break-all rounded-lg bg-subtle p-3 font-mono text-sm">
              {issued.secret}
            </code>
            <Button onClick={() => void navigator.clipboard?.writeText(issued.secret)}>
              Copy token
            </Button>
            <Button variant="primary" onClick={closeSecret}>
              I saved it
            </Button>
          </div>
        ) : null}
      </Dialog>
    </main>
  );
}
