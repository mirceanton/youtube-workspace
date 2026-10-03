# API tokens (`@ytw/tokens`)

The token service behind the MCP server and the admin CLI (PRD 5, 7, 9). Database rules are in
[database.md](database.md#identity-permissions-tokens-sessions); the permission logic is in
[policy.md](policy.md).

## Secrets

`generateToken()` returns `{ secret, prefix, hash }`. The secret is `ytw_` plus 32 random bytes as
base64url (47 characters). The database stores only `hash` (SHA-256, 64 lower-case hex digits) and
`prefix` (the first 12 characters, shown in settings). The secret exists only in the result of
`createToken` and `rotateToken`: show it once and drop it. `redactTokens(text)` removes anything
shaped like a secret from text that might be logged.

## Managing tokens (web role)

`createToken`, `updateToken`, `rotateToken`, `revokeToken` take the `ytw_web` pool and the owner
(`{ id, username }`). Tokens are managed by their owner only. Before writing, the requested levels
are checked against the owner's current levels with `@ytw/policy` (`TokenGrantError` lists every
violation and the values that would be accepted); the database function enforces the same ceiling
again, so the check only improves the message.

## Authenticating a call (MCP role)

```ts
const auth = createAuthenticator({ db: mcpPool, onTouchError: (e) => log.warn({ err: e }) });
const result = await auth.authenticate(request.headers.authorization, request.ip);
if (!result.ok) {
  // answer 401 for every reason but rate_limited (429 with Retry-After: result.retryAfterSeconds)
}
// result.principal is a @ytw/policy TokenPrincipal; result.effectiveLevels what it may do now
```

- Nothing is cached: each call looks the token up with its owner's current levels, so revocation,
  expiry, rotation and a lowered owner apply on the next call.
- Failure reasons: `missing`, `malformed`, `unknown`, `revoked`, `expired`, `owner_removed`,
  `rate_limited`. They are for audit logs and metrics. The HTTP answer must be the same 401 for all
  of them, with no detail, so a client cannot learn which tokens exist.
- `last_used_at` is written at most once per minute and token, best effort (a failed write calls
  `onTouchError` and never fails the request).
- Failed attempts are counted per client address and per token prefix (10 per minute by default,
  `FailureLimiter`). A blocked client gets `rate_limited` before the database is touched. The limiter
  is per process and bounded in memory. Someone who knows a token's prefix (it is visible in
  settings) can block that prefix for a minute by guessing; the token's owner can rotate it.
