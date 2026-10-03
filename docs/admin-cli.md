# Admin CLI (`@ytw/admin-cli`)

`ytw-admin` is the operator CLI that provides the administrative settings functions of the workspace
without requiring the Web UI. It is used during deployment and local development to bootstrap the first
administrator, manage collaborator access levels, and issue API tokens for AI agents (PRD 5, 7, 9).

Database rules and invariants are in [database.md](database.md); permission logic is in
[policy.md](policy.md); token generation and bearer auth rules are in [tokens.md](tokens.md).

## Architecture & Security

- **Connects as `ytw_web` (`DATABASE_URL`):** The CLI connects using the web application's role. It
  has SELECT privileges on `public.users` and `public.user_permissions`, but **no direct table DML
  privileges**.
- **Every mutation runs through SECURITY DEFINER database functions:** `upsert_user_on_login`,
  `set_user_permission`, `set_user_admin`, `set_user_access_revoked`, and the `@ytw/tokens` service.
- **Why `--as <admin-username>` is required:** The database enforces that access matrix changes and user
  management can only be performed by an active administrator. The audit trail (`events` table) records
  the acting admin's username for every permission modification.
- **Secret hygiene:** API token secrets exist in memory only at generation time (`token create`,
  `token rotate`). Only the prefix (12 characters) and SHA-256 hash are stored in the database.
  The CLI prints the secret **once** to stdout and never echoes it in listings, updates, or logs.

## Empty Database to Working MCP Token (Quickstart)

Follow these steps on a newly migrated database:

### 1. Bootstrap the first administrator

In any fresh database, the very first user created automatically becomes an administrator with full write
access to all workspace objects (PRD 7):

```bash
DATABASE_URL="postgres://ytw_web:ytw-web-dev-password@localhost:5432/youtube_workspace" \
  pnpm ytw-admin user create --username owner --email owner@channel.local --display-name "Channel Owner"
```

Output:
```text
User "owner" (01a10214-cee3-74c2-9922-aa65ca267bfa):
  Issuer:       local
  Subject:      owner
  Email:        owner@channel.local
  Display Name: Channel Owner
  Admin:        true (first user in database: granted full admin write access)
  Levels:       ideas=write scripts=write experiments=write videos=write notes=write activity=read
```

### 2. Create a collaborator user

Subsequent users start with `none` on all resources until explicitly granted access by an administrator:

```bash
DATABASE_URL="postgres://ytw_web:ytw-web-dev-password@localhost:5432/youtube_workspace" \
  pnpm ytw-admin user create --username bot-operator
```

### 3. Grant access levels to the collaborator

The administrator grants access levels on specific resources. For example, to allow writing ideas and
reading scripts:

```bash
DATABASE_URL="postgres://ytw_web:ytw-web-dev-password@localhost:5432/youtube_workspace" \
  pnpm ytw-admin user set-level --as owner bot-operator ideas=write scripts=read
```

### 4. Create an API token for an AI agent

Tokens are owned by a user and can only hold permissions up to what the owner currently holds. The CLI
outputs the token secret once:

```bash
DATABASE_URL="postgres://ytw_web:ytw-web-dev-password@localhost:5432/youtube_workspace" \
  pnpm ytw-admin token create \
    --owner bot-operator \
    --name "research-agent" \
    --grant ideas=write,scripts=read \
    --expires-in 90d
```

Output:
```text
Created API token "research-agent" (01a10214-cee3-74c2-9922-aa65ca267bfa):
  Owner:            bot-operator
  Prefix:           ytw_K9j2L1m...
  Expires At:       2026-07-02T12:00:00.000Z
  Effective Levels: ideas=write scripts=read experiments=none videos=none notes=none activity=none

Token Secret (show once):
  ytw_K9j2L1mNxPqRsTuVwXyZ0123456789abc

Store this secret securely now. It will never be displayed again.
```

### 5. Configure an agent with the MCP server

Use the generated secret in the `Authorization: Bearer <secret>` header when connecting an MCP client to
`http://localhost:3001/mcp`.

---

## Command Reference

### User Commands

#### `user create`
Creates or signs in a user via `upsertUserOnLogin`.
```bash
pnpm ytw-admin user create --username <username> [--issuer <iss>] [--sub <sub>] [--email <email>] [--display-name <name>]
```
- `--username`: Required username (`preferred_username`).
- `--issuer`: Optional OIDC issuer URL (default: `local`).
- `--sub`: Optional OIDC subject claim (default: `<username>`).
- `--email`: Optional email address.
- `--display-name`: Optional display name.

#### `user list`
Lists all users and their effective access levels across all objects.
```bash
pnpm ytw-admin user list [--as <admin-username>]
```
- `--as`: Optional if an active administrator exists in the database.

#### `user set-level`
Sets access levels on one or more resources for a user.
```bash
pnpm ytw-admin user set-level --as <admin-username> <user> <resource>=<level>...
```
- `<user>`: Target username or UUID.
- `<resource>=<level>`: e.g. `ideas=write scripts=read notes=write`.
  Valid resources: `ideas`, `scripts`, `experiments`, `videos`, `notes`, `activity`.
  Valid levels: `none`, `read`, `write` (`activity` allows only `none` or `read`).

#### `user set-admin`
Promotes a user to admin, or demotes an existing admin.
```bash
# Promote to admin
pnpm ytw-admin user set-admin --as <admin-username> <user>

# Demote from admin (resets levels to none unless --keep-levels)
pnpm ytw-admin user set-admin --as <admin-username> <user> --demote [--keep-levels]
```
- Demoting the last active administrator is blocked by the database.

#### `user revoke-access` & `user restore-access`
Offboarding for someone who should lose access immediately without deleting their account.
```bash
# Lock out user and terminate all active sessions
pnpm ytw-admin user revoke-access --as <admin-username> <user>

# Restore user access
pnpm ytw-admin user restore-access --as <admin-username> <user>
```

---

### Token Commands

#### `token create`
Generates a new API token owned by `<user>`.
```bash
pnpm ytw-admin token create --owner <user> --name <token-name> [--grant <resource>=<level>...] [--expires-in 90d|never]
```
- `--owner`: Token owner username or UUID.
- `--name`: 1-100 character token name (used in audit trail as actor name).
- `--grant`: Comma-separated or space-separated list of resource levels (e.g. `--grant ideas=write,scripts=read`).
  Must not exceed the owner's current permissions.
- `--expires-in`: Expiration duration (e.g. `90d`, `30d`, `24h`, `1y`) or `never`. Default: `90d`.

#### `token list`
Lists all API tokens owned by `<user>`.
```bash
pnpm ytw-admin token list --owner <user>
```

#### `token update`
Modifies permissions on an existing active token.
```bash
pnpm ytw-admin token update --owner <user> --token <token-id> --grant <resource>=<level>...
```

#### `token rotate`
Rotates the secret of an existing token. The previous secret is immediately invalidated.
```bash
pnpm ytw-admin token rotate --owner <user> --token <token-id> [--expires-in 90d|never]
```

#### `token revoke`
Permanently revokes an API token.
```bash
pnpm ytw-admin token revoke --owner <user> --token <token-id>
```

---

## Common Flags & Exit Codes

- `--json`: Formats all outputs as JSON to stdout.
- `--database-url <url>`: Overrides the `DATABASE_URL` environment variable.

Exit codes:
- `0`: Success.
- `1`: Operation failed (validation error, forbidden, not found, or constraint violation).
- `2`: Configuration error (missing `DATABASE_URL`).
