/**
 * Bearer authentication for the agent endpoints. One call turns an `Authorization` header
 * into a principal or a typed failure:
 *
 * - the header is parsed (`missing`, `malformed`), the secret hashed and looked up in the database
 *   together with its owner's CURRENT levels, so revocation, expiry, rotation and a lowered owner
 *   apply on the very next call (nothing is cached);
 * - `unknown`, `revoked`, `expired` and `owner_removed` are told apart for the audit log and the
 *   metrics, but the HTTP layer must answer all of them with the same 401 and no detail;
 * - failures are counted per client address and per token prefix; over the limit the answer is
 *   `rate_limited` with `retryAfterSeconds`, before the database is touched;
 * - `last_used_at` is written at most once per minute and token, best effort: a failed write never
 *   fails the request.
 *
 * Secrets are never logged or put in an error; `reason` and the principal carry none.
 */
import { lookupTokenByHash, toTokenPrincipal, touchTokenLastUsed, type Queryable } from "@ytw/db";
import type { TokenPrincipal } from "@ytw/policy";
import { parseBearer } from "./bearer.js";
import { FailureLimiter } from "./rate-limiter.js";
import { hashToken, tokenPrefix } from "./secret.js";

export type AuthFailureReason =
  "missing" | "malformed" | "unknown" | "revoked" | "expired" | "owner_removed" | "rate_limited";

/** The authenticated caller, as `@ytw/policy` expects it, plus facts for logs and the audit trail. */
export interface AuthenticatedToken {
  readonly principal: TokenPrincipal;
  /** Name of the token's owner (also `principal.owner.username`). */
  readonly ownerUsername: string;
  /** The levels the token may use right now: per object the lower of its own and its owner's. */
  readonly effectiveLevels: TokenPrincipal["levels"];
}

export type AuthResult =
  | ({ readonly ok: true } & AuthenticatedToken)
  | {
      readonly ok: false;
      readonly reason: AuthFailureReason;
      /** Seconds for the `Retry-After` header; set only when `reason` is `rate_limited`. */
      readonly retryAfterSeconds?: number;
    };

export interface AuthenticatorOptions {
  /** Where tokens are looked up. */
  readonly db: Queryable;
  readonly limiter?: FailureLimiter;
  /** Minimum time between two `last_used_at` writes of one token (default 60 000 ms). */
  readonly touchIntervalMs?: number;
  /** Most tokens whose last write time is remembered (default 10 000). */
  readonly maxTouchEntries?: number;
  /** Clock, for tests (default `Date.now`). */
  readonly now?: () => number;
  /** Called when the best-effort `last_used_at` write fails; must not log secrets. */
  readonly onTouchError?: (error: unknown) => void;
}

export interface Authenticator {
  /**
   * @param header the raw `Authorization` header value(s).
   * @param clientKey the client's address (or any stable per-client string) for the failure limiter.
   */
  authenticate(
    header: string | readonly string[] | undefined,
    clientKey: string,
  ): Promise<AuthResult>;
}

const REASON_BY_STATUS = {
  revoked: "revoked",
  expired: "expired",
  owner_revoked: "owner_removed",
} as const;

export function createAuthenticator(options: AuthenticatorOptions): Authenticator {
  const limiter = options.limiter ?? new FailureLimiter();
  const touchIntervalMs = options.touchIntervalMs ?? 60_000;
  const maxTouchEntries = options.maxTouchEntries ?? 10_000;
  const now = options.now ?? Date.now;
  const lastTouch = new Map<string, number>();

  function fail(keys: readonly string[], reason: AuthFailureReason): AuthResult {
    limiter.recordFailure(keys);
    return { ok: false, reason };
  }

  async function touch(token: { id: string; name: string }): Promise<void> {
    const at = now();
    const previous = lastTouch.get(token.id);
    if (previous !== undefined && at - previous < touchIntervalMs) {
      return;
    }
    // Claim the slot first so concurrent requests of one token write once, not once each.
    lastTouch.delete(token.id);
    lastTouch.set(token.id, at);
    while (lastTouch.size > maxTouchEntries) {
      const oldest = lastTouch.keys().next();
      if (oldest.done === true) {
        break;
      }
      lastTouch.delete(oldest.value);
    }
    try {
      await touchTokenLastUsed(options.db, token);
    } catch (error) {
      lastTouch.delete(token.id);
      options.onTouchError?.(error);
    }
  }

  return {
    async authenticate(header, clientKey) {
      const clientLimitKey = `client:${clientKey}`;
      const parsed = parseBearer(header);
      if (!parsed.ok) {
        const blocked = limiter.check([clientLimitKey]);
        if (!blocked.allowed) {
          return {
            ok: false,
            reason: "rate_limited",
            retryAfterSeconds: blocked.retryAfterSeconds,
          };
        }
        return fail([clientLimitKey], parsed.reason);
      }

      const keys = [clientLimitKey, `prefix:${tokenPrefix(parsed.secret)}`];
      const blocked = limiter.check(keys);
      if (!blocked.allowed) {
        return { ok: false, reason: "rate_limited", retryAfterSeconds: blocked.retryAfterSeconds };
      }

      const found = await lookupTokenByHash(options.db, hashToken(parsed.secret));
      if (found.status === "unknown") {
        return fail(keys, "unknown");
      }
      if (found.status !== "active") {
        return fail(keys, REASON_BY_STATUS[found.status]);
      }

      await touch(found);
      return {
        ok: true,
        principal: toTokenPrincipal(found),
        ownerUsername: found.owner.username,
        effectiveLevels: found.effectiveLevels,
      };
    },
  };
}
