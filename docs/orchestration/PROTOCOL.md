# Worker protocol (read this first, every task)

You are one worker in a fleet building the YouTube Channel Workspace. An orchestrator
dispatches tasks; it does not write code. You implement (or review) exactly one task card
from `docs/orchestration/PLAN.md`, then report back. Other workers run in parallel in their
own git worktrees, so **stay inside the paths your card owns**.

## 1. Read order
1. `docs/orchestration/PLAN.md` sections 0-3 (decisions, package map, conventions) and **your card only**.
2. The PRD sections your card cites (`docs/PRD.md`). The PRD wins over the plan if they conflict on
   behaviour; raise the conflict in your report instead of silently choosing.
3. `CLAUDE.md` and `docs/adr/` once they exist (created by T00).

## 2. Sandbox facts (verified by the orchestrator, do not assume otherwise)
- Linux, 4 CPUs, 15 GB RAM, running as root. Node 22.22 and pnpm are on PATH. `mise` is NOT installed
  and cannot be installed (mise.run, nodejs.org, GitHub release downloads, quay.io are blocked).
  `mise.toml` tasks must be thin wrappers over `pnpm run <script>`; always run the pnpm script directly here.
- The npm registry works. Check real current versions with `npm view <pkg> version`. Do not assume versions
  from memory; the model-hub reference repo uses very recent majors (TypeScript 7, Vite 8, vitest 5, pnpm 12).
- Postgres 16 server binaries exist in `/usr/lib/postgresql/16/bin` (not on PATH) and `psql` is installed.
  Postgres refuses to run as root; `scripts/pg-local.sh` (from T00) runs it as the `postgres` OS user.
  A Docker CLI exists but do not rely on a daemon. Testcontainers are out.
- Keycloak cannot run here (image registry blocked). Anything Keycloak-specific is verified in GitHub Actions
  on the integration branch. Unit/integration tests use an in-process mock OIDC provider.
- Reference repo for conventions (read-only): `/home/user/mirceanton/model-hub`.
- Shared Postgres cluster: every test run creates its own uniquely named database and drops it.
  **Never stop/reset the shared cluster or drop databases you did not create.**
- CI is cost-gated on this private repo: a normal push runs only the light jobs; put `[ci full]` in your LAST commit message when you touched Docker/CI/lockfile/security-relevant code or when your card says to confirm the full CI (see docs/ci-cd.md). Docs-only pushes run nothing. Check results with the GitHub MCP actions tools (load via ToolSearch; owner mirceanton, repo youtube-workspace).
- Max ~6 workers run at once on 4 CPUs: keep test parallelism modest, kill every dev server / background
  process you start before you finish.

## 3. Git workflow (single integration branch, no PRs)
- Integration branch: `claude/ecstatic-knuth-vfy8uh`. You work in your own worktree/branch and publish by pushing
  to the integration branch. **Never push to any other branch. Never open a PR. Never force-push.**
- First step: `git fetch origin claude/ecstatic-knuth-vfy8uh && git rebase origin/claude/ecstatic-knuth-vfy8uh`.
- Commit early and often in Conventional Commit style (`feat(db): ...`, `test(mcp): ...`, `ci: ...`).
  **Commit locally at every green checkpoint, not only at the end.** An account usage limit (HTTP 429) can interrupt any
  worker at any moment; the orchestrator then resumes you from your transcript and worktree. Uncommitted work survives, but
  committed work is cheaper to resume. If you are resumed, run `git status` and `git log` first and continue; do not redo
  finished work. Before DB tests always run `scripts/pg-local.sh start` (idempotent): the shared cluster may have been
  stopped by an environment restart.
  End every commit message with these two trailer lines:
  ```
  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HL8xNRqJG7mNSuQKnSgeTP
  ```
  Never put a model name/version in commit messages, code comments or docs.
- To publish: fetch, rebase onto `origin/claude/ecstatic-knuth-vfy8uh`, re-run your task's checks, then
  `git push origin HEAD:claude/ecstatic-knuth-vfy8uh`. If rejected as non-fast-forward, fetch/rebase/retest and retry
  (up to 5 times, backing off 2s/4s/8s/16s).
- `pnpm-lock.yaml` conflicts: take the incoming (origin) version, then run `pnpm install` to regenerate. Never hand-merge a lockfile.
- Merged migrations are immutable (the runner checksums them). Fix forward with a new migration in your own number range.
- Only touch files your card owns. Extension points that exist precisely so you do not edit shared files are
  described in PLAN.md section 3. If you need a change in someone else's area, do NOT edit it: list it under
  "Cross-task requests" in your report (only if it is tiny and blocking may you make it, and then say so).

## 4. Quality bar (non-negotiable)
- Everything in your card's "Done when" list is implemented and **demonstrated by tests you ran**. Run, at minimum,
  the package-scoped `lint`, `test` and `build` scripts plus anything the card names, and paste real results.
  Never report "tests pass" without having run them. If something cannot be verified in this sandbox, say exactly that
  and say where it will be verified (usually GitHub Actions).
- No skipped/disabled/`.only` tests, no silent `TODO`/stub left in shipped paths. Real code, real tests.
- Security rules: parameterized SQL only; never log or echo secrets/tokens/cookies; no secrets in the repo; sanitize anything
  rendered from agent-written markdown; every mutating path goes through the SECURITY DEFINER functions (no direct DML).
- Match the surrounding code's style and the conventions in `CLAUDE.md`. Keep diffs minimal and focused on your card.
- Write a short doc fragment for your area under `docs/<area>.md` (what exists, how to run/extend it). Do not edit the
  root README (T62 assembles it).
- Deviations from the card or PRD need a one-paragraph justification in your report and in the relevant doc.

## 5. Final report (your last message, <= 45 lines, no preamble)
```
TASK: <id> <title>            STATUS: done | done-with-caveats | blocked
COMMITS: <first-sha>..<last-sha> on claude/ecstatic-knuth-vfy8uh (pushed: yes/no)
SHIPPED: <bullets, what exists now and where>
VERIFIED: <exact commands run + results; what was NOT verifiable here>
DEVIATIONS: <from card/PRD + why, or "none">
CROSS-TASK REQUESTS: <changes needed in other tasks' areas, or "none">
RISKS / OPEN ITEMS: <anything the orchestrator must know>
```

## 6. If you are a REVIEWER (cards marked "Review tier A", and all gate tasks)
You did not write this code; be adversarial but fair. You review the commit range you are given against the card's
"Done when" list and the cited PRD sections.
- Check out the range, run lint/test/build yourself, read the diff, try to break it (bypasses, races, missing authz,
  missing tests for a stated requirement, secrets in logs, scope creep outside owned paths).
- Do not rewrite the implementation. Report findings only, each tagged BLOCKING (violates the card/PRD, security, data loss,
  flaky/untested requirement) or NON-BLOCKING, each with file:line and a concrete failing scenario or missing test.
- Review report format: `VERDICT: approve | changes-requested`, then findings, then "what I ran". Max 40 lines.
- (Gate tasks T16/T35/T49/T63 are different: they are written as work cards, they may add tests and fix defects.)
