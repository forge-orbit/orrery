# Coding Standards (Review Guide)

Judgement-call standards enforced during `/code-review`. Mechanical rules live in `.oxlintrc.json`, `.oxfmtrc.json`, and CI (`pnpm check`) and are not repeated here.

## Server

- **Keep `rest.ts` and `mcp.ts` thin:** Auth checks, size/rate guards, domain validation, and Problem titles belong in `service.ts`. Transport handlers validate input shape, call `service`, and map `ServiceError` kinds to RFC 9457 Problem Details through one shared mapper.
- **Keep `packages/contract/` as the single schema home:** Declare REST request/response schemas and MCP tool contracts in `packages/contract/src/<feature>.ts`, never inline in `rest.ts`.
- **Single-site response builders:** Use shared builders such as `toSessionResponse` (`features/accounts/index.ts`) instead of hand-assembling `SessionResponse` literals across features, so new fields cannot be silently hardcoded to `null`.
- **Crash-safe external side effects:** When coordinating Postgres with an external resource (object storage, SMTP, webhooks), guard cleanup paths against ambiguous post-commit failures (e.g., claim `status = 'pending'` in Postgres before deleting a blob) and never leave untracked orphans.
- **`stored_objects` lifecycle is claim-first, never delete-first:** A `pending` row is an in-flight claim. A sweep must `UPDATE ... SET status = 'deleted'` on stale `pending` rows in Postgres *before* calling `store.delete()`, then discard them in one `SELECT ... WHERE status = 'deleted' ORDER BY id` pass so each row is handled exactly once. Activation must `UPDATE ... WHERE status = 'pending' ... RETURNING` and throw a clean Problem Details error when 0 rows return — never un-delete a claimed row or let a deleted row surface as a Postgres 23503 FK 500. Discard helpers return `deleted.length > 0` instead of assuming a delete matched a row, and background sweep `setInterval` loops guard against overlapping ticks. This applies to every consumer (e.g. ADR-0009 markdown attachments).
- **Strict non-enumeration & actor separation:** Keep `human` and `agent` authorization branches explicit (never let a human self-read short-circuit bypass an agent key's workspace/suspension check), and return `404` when a caller lacks visibility into a resource or Human.
- **Global lock order for `FOR UPDATE`:** When a transaction locks and mutates multiple rows (such as attachment reference sync or multi-issue Trash purge), lock the sorted union of all affected/checked rows in a single `FOR UPDATE` pass (ascending `id`) before issuing `UPDATE`/`DELETE` — never lock inside a per-item loop or leave dropped rows unlocked until a trailing update, or concurrent writers can AB-BA deadlock.
- **Authorize before buffering or decoding binary uploads, and encode download filenames with RFC 5987:** Check project/resource permissions before reading request bodies, sniffing bytes, or running `sharp`. In `Content-Disposition: attachment` headers, always provide an ASCII fallback plus `filename*=UTF-8''<encoded>` so non-ASCII filenames never throw `ByteString` 500s.

## Web

- **Match actor identity to avatar component:** Render `AgentAvatar` when `actor.agentId !== null` and `HumanAvatar` for human actors (do not render `HumanAvatar` unconditionally on mixed `Actor` unions).
- **Invalidate all affected queries on cross-cutting profile mutations:** Mutations that change identity fields shown across pages (display name, avatar upload/removal) must invalidate cached queries so member lists, boards, comments, and activity feeds update immediately.

## Tests & Infrastructure

- **Assert external behavior at the highest seam:** Test HTTP status codes, RFC 9457 Problem codes, response headers, persisted DB/storage state, and rendered UI — not private helpers.
- **No vacuous adapter contract checks:** Shared contract suites (such as `platform/storage.contract.ts`) must assert real storage behavior on every backend (no `null === null` fallback branches).
- **Verify Docker & operator commands:** Any change touching `Dockerfile`, `compose.yaml`, or operator runbooks must work under the container's runtime `USER node` permissions and valid Compose lifecycle commands.
