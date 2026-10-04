import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { Badge } from "@/kit/Badge.tsx";
import { Alert } from "@/kit/Alert.tsx";
import { Button } from "@/kit/Button.tsx";
import { Card } from "@/kit/Card.tsx";
import { Dialog } from "@/kit/Dialog.tsx";
import { SelectField } from "@/kit/Field.tsx";
import { ErrorState, LoadingState } from "@/kit/states.tsx";
import { PageHeader } from "@/kit/PageHeader.tsx";
import {
  GRANTABLE_LEVELS,
  RESOURCE_LABELS,
  RESOURCES,
  type Level,
  type Resource,
} from "@ytw/shared/constants";
import { getSettingsUsers, setUserAdmin, setUserPermission, settingsKeys } from "./settings-api.ts";
import { useSession } from "@/lib/session.ts";

function label(level: Level) {
  return level === "none" ? "None" : level === "read" ? "Read" : "Write";
}

export function Component() {
  const { userId = "" } = useParams();
  const session = useSession();
  const queryClient = useQueryClient();
  const [confirmDemote, setConfirmDemote] = useState(false);
  const [keepLevels, setKeepLevels] = useState(false);
  const users = useQuery({
    queryKey: settingsKeys.users,
    queryFn: ({ signal }) => getSettingsUsers(signal),
    enabled: session.user.isAdmin,
  });
  const user = users.data?.users.find((item) => item.id === userId);
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: settingsKeys.users }),
      queryClient.invalidateQueries({ queryKey: settingsKeys.profile }),
      queryClient.invalidateQueries({ queryKey: ["session"] }),
    ]);
  };
  const permission = useMutation({
    mutationFn: ({ resource, level }: { resource: Resource; level: Level }) =>
      setUserPermission(userId, resource, level),
    onSuccess: invalidate,
  });
  const admin = useMutation({
    mutationFn: ({ isAdmin, preserve }: { isAdmin: boolean; preserve: boolean }) =>
      setUserAdmin(userId, isAdmin, preserve),
    onSuccess: async () => {
      setConfirmDemote(false);
      await invalidate();
    },
  });

  if (!session.user.isAdmin) {
    return (
      <ErrorState title="Admin access required" description="Only admins can manage user access." />
    );
  }
  if (users.isPending) return <LoadingState label="Loading user access" />;
  if (users.isError) return <ErrorState error={users.error} onRetry={() => void users.refetch()} />;
  if (!user)
    return (
      <ErrorState title="User not found" description="This user may not have signed in yet." />
    );

  const mutationError = permission.error ?? admin.error;
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <PageHeader
        title={user.display_name || user.username}
        back={{ to: "/settings", label: "Settings" }}
        description={user.email ? `${user.username} · ${user.email}` : user.username}
        actions={
          user.is_admin ? (
            <Button variant="danger" onClick={() => setConfirmDemote(true)}>
              Demote admin
            </Button>
          ) : (
            <Button
              variant="primary"
              busy={admin.isPending}
              onClick={() => admin.mutate({ isAdmin: true, preserve: false })}
            >
              Make admin
            </Button>
          )
        }
      />
      {user.access_revoked_at ? (
        <Alert tone="warn" title="Access is revoked">
          Levels below are currently effective as None until the account is restored.
        </Alert>
      ) : null}
      {mutationError ? (
        <Alert tone="danger" title="Access change failed">
          {mutationError.message}
        </Alert>
      ) : null}
      {user.is_admin ? (
        <Alert tone="info" title="Admin access">
          Admins have Write on every object. Demote this person before changing individual levels.
        </Alert>
      ) : null}
      <Card>
        <h2 className="mb-1 text-lg font-semibold">Object access</h2>
        <p className="mb-4 text-sm text-ink-muted">
          Changes take effect immediately and are recorded in the activity log.
        </p>
        <div className="grid gap-3">
          {RESOURCES.map((resource) => (
            <SelectField
              key={resource}
              label={RESOURCE_LABELS[resource]}
              value={user.levels[resource]}
              disabled={user.is_admin || permission.isPending}
              onChange={(event) =>
                permission.mutate({ resource, level: event.currentTarget.value as Level })
              }
            >
              {GRANTABLE_LEVELS[resource].map((level) => (
                <option key={level} value={level}>
                  {label(level)}
                </option>
              ))}
            </SelectField>
          ))}
        </div>
        <p className="mt-4 text-sm text-ink-muted">
          Write includes Read. The activity log can be None or Read.
        </p>
      </Card>
      <Card>
        <h2 className="text-lg font-semibold">Account</h2>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-ink-muted">Role</dt>
            <dd>{user.is_admin ? <Badge tone="info">Admin</Badge> : "User"}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Created</dt>
            <dd>
              {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
                new Date(user.created_at),
              )}
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">Last login</dt>
            <dd>
              {user.last_login_at
                ? new Intl.DateTimeFormat(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(user.last_login_at))
                : "Not available"}
            </dd>
          </div>
        </dl>
      </Card>
      <Dialog
        open={confirmDemote}
        onClose={() => setConfirmDemote(false)}
        title="Demote this admin?"
        description="The database prevents demoting the last active admin. By default, this person loses all access and their tokens become ineffective."
        footer={
          <>
            <Button onClick={() => setConfirmDemote(false)}>Cancel</Button>
            <Button
              variant="danger"
              busy={admin.isPending}
              onClick={() => admin.mutate({ isAdmin: false, preserve: keepLevels })}
            >
              Demote admin
            </Button>
          </>
        }
      >
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input
            type="checkbox"
            className="size-5 accent-brand"
            checked={keepLevels}
            onChange={(event) => setKeepLevels(event.currentTarget.checked)}
          />
          Keep this person's existing access levels after demotion
        </label>
      </Dialog>
    </main>
  );
}
