import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, KeyRound, Plus, Shield, UserRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { grantOptions, describeLevels } from "@ytw/policy";
import {
  GRANTABLE_LEVELS,
  RESOURCE_LABELS,
  RESOURCES,
  type Level,
  type Resource,
  type ResourceLevels,
} from "@ytw/shared/constants";
import type { IssuedSettingsTokenResponse, SettingsUser } from "@ytw/shared/api/settings";
import { Badge } from "@/kit/Badge.tsx";
import { Button } from "@/kit/Button.tsx";
import { Card } from "@/kit/Card.tsx";
import { Dialog } from "@/kit/Dialog.tsx";
import { EmptyState, ErrorState, LoadingState } from "@/kit/states.tsx";
import { PageHeader } from "@/kit/PageHeader.tsx";
import { SelectField, TextField } from "@/kit/Field.tsx";
import { Alert } from "@/kit/Alert.tsx";
import { formatDate, formatDateTime } from "@/lib/format.ts";
import { useSession } from "@/lib/session.ts";
import {
  createSettingsToken,
  getSettingsProfile,
  getSettingsTokens,
  getSettingsUsers,
  setUserPermission,
  settingsKeys,
} from "./settings-api.ts";

const EMPTY_LEVELS: ResourceLevels = {
  ideas: "none",
  scripts: "none",
  experiments: "none",
  videos: "none",
  notes: "none",
  activity: "none",
};
const DAY_MS = 24 * 60 * 60 * 1000;

function LevelList({ levels }: { levels: ResourceLevels }) {
  return (
    <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
      {RESOURCES.map((resource) => (
        <div
          key={resource}
          className="flex items-center justify-between gap-3 border-b border-line py-2"
        >
          <dt className="text-sm text-ink-muted">{RESOURCE_LABELS[resource]}</dt>
          <dd className="text-sm font-medium capitalize">{levels[resource]}</dd>
        </div>
      ))}
    </dl>
  );
}

function TokenForm({
  profile,
  onIssued,
}: {
  profile: { is_admin: boolean; levels: ResourceLevels };
  onIssued: (issued: IssuedSettingsTokenResponse) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [neverExpires, setNeverExpires] = useState(false);
  const [permissions, setPermissions] = useState<ResourceLevels>(EMPTY_LEVELS);
  const allowed = grantOptions({ isAdmin: profile.is_admin, levels: profile.levels });
  const mutation = useMutation({
    mutationKey: ["settings", "createToken"],
    mutationFn: createSettingsToken,
    gcTime: 0,
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void mutation
      .mutateAsync({
        name,
        expires_at: neverExpires ? null : new Date(Date.now() + 90 * DAY_MS).toISOString(),
        permissions,
      })
      .then((issued) => {
        onIssued(issued);
        mutation.reset();
        setName("");
        setPermissions(EMPTY_LEVELS);
        return queryClient.invalidateQueries({ queryKey: settingsKeys.tokens });
      })
      .catch(() => undefined);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <TextField
        label="Token name"
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        required
        maxLength={100}
        autoComplete="off"
        hint="This name appears in the activity log when the token is used."
      />
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input
          type="checkbox"
          className="size-5 accent-brand"
          checked={neverExpires}
          onChange={(event) => setNeverExpires(event.currentTarget.checked)}
        />
        Never expires
      </label>
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 font-semibold">Permissions</legend>
        {RESOURCES.map((resource) => (
          <SelectField
            key={resource}
            label={`${RESOURCE_LABELS[resource]} permission`}
            value={permissions[resource]}
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
      </fieldset>
      {mutation.error ? (
        <Alert tone="danger" title="Token could not be created">
          {mutation.error.message}
        </Alert>
      ) : null}
      <Button type="submit" variant="primary" busy={mutation.isPending} disabled={!name.trim()}>
        Create token
      </Button>
    </form>
  );
}

function levelLabel(level: Level): string {
  return level === "none" ? "None" : level === "read" ? "Read" : "Write";
}

function AccessMatrix({ users }: { users: readonly SettingsUser[] }) {
  const queryClient = useQueryClient();
  const currentUserId = useSession().user.id;
  const mutation = useMutation({
    mutationFn: ({
      userId,
      resource,
      level,
    }: {
      userId: string;
      resource: Resource;
      level: Level;
    }) => setUserPermission(userId, resource, level),
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({ queryKey: settingsKeys.users });
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      if (variables.userId === currentUserId) {
        await queryClient.invalidateQueries({ queryKey: settingsKeys.profile });
      }
    },
  });
  const pendingCell = mutation.variables
    ? `${mutation.variables.userId}:${mutation.variables.resource}`
    : "";
  return (
    <>
      {mutation.error ? (
        <Alert tone="danger" title="Access could not be changed">
          {mutation.error.message}
        </Alert>
      ) : null}
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[900px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="p-3">
                User
              </th>
              {RESOURCES.map((resource) => (
                <th key={resource} scope="col" className="p-3">
                  {RESOURCE_LABELS[resource]}
                </th>
              ))}
              <th scope="col" className="p-3">
                Role
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-b border-line align-top">
                <th scope="row" className="p-3 font-medium">
                  <Link
                    className="text-link underline-offset-2 hover:underline"
                    to={`/settings/users/${user.id}`}
                  >
                    {user.display_name || user.username}
                  </Link>
                  <span className="mt-1 block text-xs font-normal text-ink-muted">
                    {user.username}
                  </span>
                  {user.access_revoked_at ? (
                    <span className="mt-1 block text-xs text-danger">Access revoked</span>
                  ) : null}
                </th>
                {RESOURCES.map((resource) => (
                  <td key={resource} className="p-2">
                    <label className="sr-only" htmlFor={`matrix-${user.id}-${resource}`}>
                      {user.username}: {RESOURCE_LABELS[resource]}
                    </label>
                    <select
                      id={`matrix-${user.id}-${resource}`}
                      className="min-h-11 w-full rounded-lg border border-line-strong bg-surface px-2 text-sm capitalize disabled:opacity-60"
                      value={user.levels[resource]}
                      disabled={
                        user.is_admin ||
                        (mutation.isPending && pendingCell === `${user.id}:${resource}`)
                      }
                      aria-label={`${user.username}: ${RESOURCE_LABELS[resource]}`}
                      onChange={(event) =>
                        mutation.mutate({
                          userId: user.id,
                          resource,
                          level: event.currentTarget.value as Level,
                        })
                      }
                    >
                      {GRANTABLE_LEVELS[resource].map((level) => (
                        <option key={level} value={level}>
                          {levelLabel(level)}
                        </option>
                      ))}
                    </select>
                  </td>
                ))}
                <td className="p-3">{user.is_admin ? <Badge tone="info">Admin</Badge> : "User"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="grid gap-3 sm:hidden">
        {users.map((user) => (
          <li key={user.id}>
            <Link
              to={`/settings/users/${user.id}`}
              className="flex min-h-14 items-center justify-between gap-4 rounded-xl border border-line bg-surface p-4"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {user.display_name || user.username}
                </span>
                <span className="block truncate text-sm text-ink-muted">{user.username}</span>
              </span>
              <span className="flex items-center gap-2">
                {user.is_admin ? <Badge tone="info">Admin</Badge> : null}
                <ChevronRight aria-hidden="true" className="size-5 shrink-0" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="text-sm text-ink-muted">
        Changes apply immediately. Admin permissions stay at Write on every object; demote an admin
        before changing individual levels.
      </p>
    </>
  );
}

export function Component() {
  const session = useSession();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [issued, setIssued] = useState<IssuedSettingsTokenResponse | null>(null);
  const profile = useQuery({
    queryKey: settingsKeys.profile,
    queryFn: ({ signal }) => getSettingsProfile(signal),
  });
  const tokens = useQuery({
    queryKey: settingsKeys.tokens,
    queryFn: ({ signal }) => getSettingsTokens(signal),
  });
  const users = useQuery({
    queryKey: settingsKeys.users,
    queryFn: ({ signal }) => getSettingsUsers(signal),
    enabled: session.user.isAdmin,
  });
  function closeSecret() {
    setIssued(null);
    void queryClient.invalidateQueries({ queryKey: settingsKeys.tokens });
  }

  if (profile.isPending) return <LoadingState label="Loading profile" />;
  if (profile.isError)
    return <ErrorState error={profile.error} onRetry={() => void profile.refetch()} />;
  const ownProfile = profile.data.profile;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <PageHeader
        title="Settings"
        description="Your profile, current access and API tokens."
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden="true" className="size-4" />
            Create token
          </Button>
        }
      />

      <section
        aria-labelledby="profile-heading"
        className="grid gap-4 lg:grid-cols-[minmax(16rem,0.8fr)_minmax(0,1.2fr)]"
      >
        <Card>
          <div className="mb-4 flex items-center gap-3">
            <UserRound aria-hidden="true" className="size-5 text-ink-muted" />
            <h2 id="profile-heading" className="text-lg font-semibold">
              Profile
            </h2>
          </div>
          <dl className="grid gap-3 text-sm">
            <div>
              <dt className="text-ink-muted">Name</dt>
              <dd className="font-medium">{ownProfile.display_name || ownProfile.username}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Username</dt>
              <dd className="font-medium">{ownProfile.username}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Email</dt>
              <dd className="break-words font-medium">{ownProfile.email || "Not provided"}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Keycloak identity</dt>
              <dd className="break-all font-mono text-xs">
                {ownProfile.issuer} / {ownProfile.subject}
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted">Account</dt>
              <dd>
                {ownProfile.is_admin ? <Badge tone="info">Admin</Badge> : <Badge>User</Badge>}
              </dd>
            </div>
          </dl>
        </Card>
        <Card>
          <h2 className="mb-3 text-lg font-semibold">Effective access</h2>
          <LevelList levels={profile.data.levels} />
          {ownProfile.access_revoked_at ? (
            <Alert className="mt-4" tone="warn" title="Access is currently revoked">
              An administrator or identity provider has disabled this account.
            </Alert>
          ) : null}
        </Card>
      </section>

      <section aria-labelledby="tokens-heading">
        <div className="mb-3 flex items-center gap-2">
          <KeyRound aria-hidden="true" className="size-5 text-ink-muted" />
          <h2 id="tokens-heading" className="text-xl font-semibold">
            API tokens
          </h2>
        </div>
        <p className="mb-4 text-sm text-ink-muted">
          Tokens work with the MCP service. A new secret is shown once after creation or rotation.
        </p>
        {tokens.isPending ? <LoadingState compact label="Loading tokens" /> : null}
        {tokens.isError ? (
          <ErrorState compact error={tokens.error} onRetry={() => void tokens.refetch()} />
        ) : null}
        {tokens.isSuccess && tokens.data.tokens.length === 0 ? (
          <EmptyState
            compact
            title="No API tokens"
            description="Create a token when an agent needs workspace access."
            icon={KeyRound}
          />
        ) : null}
        {tokens.isSuccess && tokens.data.tokens.length > 0 ? (
          <ul className="grid gap-3 md:grid-cols-2">
            {tokens.data.tokens.map((token) => (
              <li key={token.id}>
                <Card className="h-full">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        to={`/settings/tokens/${token.id}`}
                        className="inline-flex min-h-11 items-center gap-2 font-semibold text-link underline-offset-2 hover:underline"
                      >
                        {token.name}
                        <ChevronRight aria-hidden="true" className="size-4" />
                      </Link>
                      <p className="font-mono text-sm">{token.prefix}…</p>
                      <p className="mt-2 text-sm text-ink-muted">
                        {describeLevels(token.effective_levels)}
                      </p>
                    </div>
                    <Badge
                      tone={
                        token.status === "active"
                          ? "ok"
                          : token.status === "revoked"
                            ? "danger"
                            : "warn"
                      }
                    >
                      {token.status.replace("_", " ")}
                    </Badge>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-2 text-xs text-ink-muted">
                    <div>
                      <dt>Created</dt>
                      <dd>{formatDate(token.created_at)}</dd>
                    </div>
                    <div>
                      <dt>Expires</dt>
                      <dd>{token.expires_at ? formatDate(token.expires_at) : "Never"}</dd>
                    </div>
                    <div className="col-span-2">
                      <dt>Last used</dt>
                      <dd>{token.last_used_at ? formatDateTime(token.last_used_at) : "Never"}</dd>
                    </div>
                  </dl>
                </Card>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {session.user.isAdmin ? (
        <section aria-labelledby="access-heading">
          <div className="mb-3 flex items-center gap-2">
            <Shield aria-hidden="true" className="size-5 text-ink-muted" />
            <h2 id="access-heading" className="text-xl font-semibold">
              User access
            </h2>
          </div>
          {users.isPending ? <LoadingState compact label="Loading users" /> : null}
          {users.isError ? (
            <ErrorState compact error={users.error} onRetry={() => void users.refetch()} />
          ) : null}
          {users.isSuccess ? <AccessMatrix users={users.data.users} /> : null}
        </section>
      ) : null}

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create API token"
        description="Choose a name, expiry and permissions up to your current access."
        size="lg"
      >
        <TokenForm
          profile={{ is_admin: ownProfile.is_admin, levels: profile.data.levels }}
          onIssued={(value) => {
            setCreateOpen(false);
            setIssued(value);
          }}
        />
      </Dialog>
      <Dialog
        open={issued !== null}
        onClose={closeSecret}
        title="Copy your API token"
        description="This secret cannot be shown again. Copy it now and store it in your agent's secret manager."
        size="md"
      >
        {issued ? (
          <div className="flex flex-col gap-3">
            <Alert tone="warn" title="Shown once">
              Closing this window discards the secret. The server stores only its hash.
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
