<!-- intent-skills:start -->
## Skill Loading

Use the repository’s installed Intent. If it is unavailable, report the missing dependency instead of downloading a replacement.
Before editing files for a substantial task:
- Run `pnpm exec intent list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `pnpm exec intent load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

# Orrery: notes for agents and contributors

Self-hosted project management for teams of humans and AI agents. Plans and decisions live in GitHub
issues labeled `need discussion` (#1 stack, #8 MVP overview). Don't build a feature before its
issue is agreed.

## Commands

Run from the repo root. Node 26 (`.node-version`) and pnpm 12 (`packageManager`).

| Command | Does |
| --- | --- |
| `pnpm install` | Install everything, and the git hooks (lefthook). Never use npm, yarn or bun to install. |
| `docker compose up -d postgres` | Start Postgres for development (needs `.env`, see `.env.example`). |
| `pnpm dev` | Server on :8080 (reloads on change) and web on :5173. |
| `pnpm check` | Format check, lint (type-aware), typecheck. Must pass before a commit. |
| `pnpm fix` | Format and apply lint fixes. |
| `pnpm test` | Unit tests and Postgres tests (Docker required, via Testcontainers). |
| `pnpm gen` | Regenerate `contract/*.json`. Run after changing a route or tool, and commit the result. |
| `pnpm db:generate` | Generate a migration in `db/migrations/` from the Drizzle schema. Run after changing the schema, and commit the result. |
| `docker compose --profile mail-test up -d --build --wait` then `ORRERY_URL=http://localhost:8080 pnpm test:e2e` | Black-box tests against the real image, with the Mailpit catcher for email delivery. |

## Stack

Use these. Don't add an alternative; the lint bans the common ones (`.oxlintrc.json`).

| Concern | Use | Not |
| --- | --- | --- |
| HTTP server | Hono with `@hono/zod-openapi`, served by `@hono/node-server` | Express, Fastify, Koa |
| REST routes | `createRoute` plus `app.openapi`, and add the route to the feature's exported `routes` (listed in `features/index.ts`). A test fails if a mounted route is missing from the contract. | plain `app.get` or `app.post` |
| Database | Drizzle (`drizzle-orm`, `drizzle-kit`) on postgres.js, from `platform/db.ts` | `pg`, Knex, Kysely, Prisma |
| Migrations | `pnpm db:generate` from `apps/server/src/db/schema.ts` | hand-written `.sql` |
| Validation and schemas | Zod 4, shared through `packages/contract/` | Zod 3 APIs, `zod/v3` |
| Error responses | RFC 9457 Problem Details (`application/problem+json`) with a stable `code`, built only through `platform/problem.ts`; successes return the resource itself ([ADR-0003](docs/adr/0003-problem-details-for-errors.md)). A test fails if an API route declares an error that isn't a Problem. | JSend or other envelopes, ad-hoc `{ message }` bodies, `c.json` for errors |
| Email | nodemailer, sent only through the settings feature's exported sender (`apps/server/src/features/settings/`). Secrets in instance settings are encrypted at rest with `ORRERY_ENCRYPTION_KEY` ([ADR-0004](docs/adr/0004-encrypt-instance-secrets-at-rest.md)). | other mail libraries |
| MCP | `@modelcontextprotocol/server` (server), `@modelcontextprotocol/client` (e2e). Tool contracts in `packages/contract/src/mcp-tools.ts`. | |
| Logging | `platform/log.ts` (JSON lines). `console` is a lint error in `apps/server/src/`. | pino, winston |
| Web app | React, Vite, TanStack Router (file-based; `routeTree.gen.ts` is generated, don't edit it) | React Router |
| Web UI | `@astryxdesign/core`: inspect components with `pnpm astryx search <query>` and `pnpm astryx component <Name> --dense` before writing JSX. Read [apps/web/AGENTS.md](apps/web/AGENTS.md) and [docs/design/web-ui.md](docs/design/web-ui.md). | other UI kits |
| Web data | TanStack Query with `fetch`. No `useEffect` (lint error): load data with a query, derive values during render, react to events in handlers. | axios, SWR, fetching in `useEffect` |
| Tests | Vitest in `apps/`, `packages/` and `tests/`; Testcontainers for Postgres. `node:test` only in root `scripts/`. | Jest, Mocha |
| Browser tests | Playwright (`@playwright/test`), only in `tests/e2e/*.spec.ts`, against a running server like the other e2e tests | Cypress, Puppeteer, Selenium |
| Format and lint | oxfmt and Oxlint (`pnpm check`, `pnpm fix`) | Prettier, ESLint, Biome |

## Layout

Code is organized by feature. One feature lives in one folder, on the server and in the web app.

| Path | What |
| --- | --- |
| `apps/server/src/features/<name>/` | One feature: `service.ts` (the only file that decides anything), `rest.ts` and `mcp.ts` (thin: validate, call the service, map the result), `*.test.ts`, and `index.ts`, its public interface. |
| `apps/server/src/features/index.ts` | The feature registry. Add every new feature here. |
| `apps/server/src/platform/` | Shared infrastructure: config, logging, database, migrations, HTTP app, MCP endpoint, OpenAPI. Knows nothing about features. |
| `apps/web/src/routes/` | Pages, one file per route (TanStack Router, file-based). |
| `apps/web/src/features/<name>/` | Queries and components a feature's pages share, with an `index.ts`. |
| `apps/web/src/lib/` | Shared, feature-agnostic web code. It imports no feature. |
| `packages/contract/` | zod schemas shared by REST, MCP and web. MCP tool contracts live in `mcp-tools.ts`. |
| `contract/` | Generated OpenAPI 3.1 and MCP tool JSON Schemas. Don't edit by hand. |
| `apps/server/src/db/schema.ts` | The Drizzle schema: the source of truth for tables, indexes and constraints. |
| `db/migrations/` | `.sql` files generated by drizzle-kit (plus its `meta/` journal), applied in name order at startup. Don't write them by hand. Never edit an applied file. |
| `tests/e2e/` | Tests against a running server. They never import server code. |

**Adding a feature:** copy the structure of an existing feature in `apps/server/src/features/`, then
register it in `features/index.ts`. Put its schemas in `packages/contract/src/<name>.ts`.

## Rules

- **Git hooks** (`lefthook.yml`): pre-commit formats and lints the staged files and re-stages the fixes;
  pre-push runs `pnpm check`. Don't skip them with `--no-verify`. If a hook fails, fix the cause.
- **Feature boundaries** (enforced by Oxlint): import another feature only through its `index.ts`,
  never its internal files. `platform/` never imports a feature. Routes import features through
  `index.ts` too.
- **Portability.** The server may be rewritten in Go or Rust later. Keep these language-neutral:
  the generated contract, SQL migrations, data rules as Postgres constraints, env var names, port 8080,
  `/healthz` and `/readyz`, and the e2e tests.
- **Runtime contract.** Deployment configuration uses env vars (`apps/server/src/platform/config.ts`).
  System administrators manage persistent instance settings, including SMTP, through the app.
  For bootstrap or instance settings, read [ADR-0001](docs/adr/0001-bootstrap-and-instance-settings.md).
  Logs are JSON lines on stdout.
- **TypeScript runs directly in Node** (type stripping). Only erasable syntax: no `enum`, no
  `namespace`, no parameter properties. Import local files with their `.ts` extension.
- **No Bun-only or framework magic:** no decorators, no DI containers. Use Web-standard APIs where possible.
- **Await every promise.** `no-floating-promises` is an error, because a dropped database call is a
  silent race.
- **Database through Drizzle** (`drizzle-orm`, `drizzle-kit`). Change tables in `schema.ts`, then run
  `pnpm db:generate`; never hand-write a migration file. For what Drizzle can't express (triggers,
  functions, backfills), run `pnpm db:generate --custom --name <what>` and fill in the empty file it creates,
  so the journal stays consistent. Query with `db` (Drizzle); use the raw `sql` client only where
  Drizzle can't, and say why in a comment. CI fails if `db:generate` would change `db/migrations/`, or if a `.sql` file is missing from drizzle-kit's journal.
- **Test against real Postgres** for anything touching claims, leases or migrations. No database mocks.

## Agent skills

### Issue tracker

GitHub Issues on forge-orbit/orrery, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default roles, each label named after its role: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
