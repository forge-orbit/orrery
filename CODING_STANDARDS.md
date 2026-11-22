# Coding Standards (Review Guide)

Judgement-call standards enforced during `/code-review`. Mechanical rules live in `.oxlintrc.json`, `.oxfmtrc.json`, and CI (`pnpm check`) and are not repeated here.

## Server

- **Keep `rest.ts` and `mcp.ts` thin:** Auth checks, size/rate guards, domain validation, and Problem titles belong in `service.ts`. Transport handlers validate input shape, call `service`, and map `ServiceError` kinds to RFC 9457 Problem Details through one shared mapper.
- **Keep `packages/contract/` as the single schema home:** Declare REST request/response schemas and MCP tool contracts in `packages/contract/src/<feature>.ts`, never inline in `rest.ts`.
- **Single-site response builders:** Use shared builders such as `toSessionResponse` (`features/accounts/index.ts`) instead of hand-assembling `SessionResponse` literals across features, so new fields cannot be silently hardcoded to `null`.
- **Crash-safe external side effects:** When coordinating Postgres with an external resource (object storage, SMTP, webhooks), guard cleanup paths against ambiguous post-commit failures (e.g., claim `status = 'pending'` in Postgres before deleting a blob) and never leave untracked orphans.
- **Strict non-enumeration & actor separation:** Keep `human` and `agent` authorization branches explicit (never let a human self-read short-circuit bypass an agent key's workspace/suspension check), and return `404` when a caller lacks visibility into a resource or Human.

## Web

- **Match actor identity to avatar component:** Render `AgentAvatar` when `actor.agentId !== null` and `HumanAvatar` for human actors (do not render `HumanAvatar` unconditionally on mixed `Actor` unions).
- **Invalidate all affected queries on cross-cutting profile mutations:** Mutations that change identity fields shown across pages (display name, avatar upload/removal) must invalidate cached queries so member lists, boards, comments, and activity feeds update immediately.

## Tests & Infrastructure

- **Assert external behavior at the highest seam:** Test HTTP status codes, RFC 9457 Problem codes, response headers, persisted DB/storage state, and rendered UI — not private helpers.
- **No vacuous adapter contract checks:** Shared contract suites (such as `platform/storage.contract.ts`) must assert real storage behavior on every backend (no `null === null` fallback branches).
- **Verify Docker & operator commands:** Any change touching `Dockerfile`, `compose.yaml`, or operator runbooks must work under the container's runtime `USER node` permissions and valid Compose lifecycle commands.
