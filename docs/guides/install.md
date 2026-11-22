# Install and upgrade Orrery

Orrery is one self-hosted server backed by Postgres. The supplied `compose.yaml` runs the app on
port 8080 and the database on a private volume. You need Docker Engine with the Compose plugin, a
host with port 8080 free (plus 80 and 443 if you enable HTTPS), and, for a public installation, a
domain name you control.

## 1. Get the files

Clone this repository on the host and work from its root:

```sh
git clone https://github.com/forge-orbit/orrery.git
cd orrery
cp .env.example .env
```

The published image is `ghcr.io/forge-orbit/orrery`; GHCR is the only published registry. Note that
`compose.yaml` declares both `image:` and `build: .` without a `pull_policy`, so on a fresh host
`docker compose up -d` builds from the checked-out source rather than pulling the published image.
Pull first to run the released image:

```sh
docker compose pull
docker compose up -d
```

If you want a source build instead, skip the `pull` and run `docker compose up -d --build`.

## 2. Configure `.env`

Open `.env` and set at least these values:

| Variable | What it does |
| --- | --- |
| `POSTGRES_PASSWORD` | Required. Letters and digits only, because it is embedded in `DATABASE_URL`. |
| `BOOTSTRAP_SECRET` | One-time secret, at least 32 characters, used once at `/setup` to create the first administrator. Remove it from `.env` after setup; setup then stays closed. Generate one with `openssl rand -hex 32`. |
| `ORRERY_ENCRYPTION_KEY` | Base64 for exactly 32 bytes (`openssl rand -base64 32`). Encrypts instance secrets at rest ([ADR-0004](../adr/0004-encrypt-instance-secrets-at-rest.md)). Without it you cannot save an SMTP password in the app. **Back this key up separately** — see [Backup and restore](./backup-and-restore.md). |
| `PUBLIC_URL` | The exact URL people and agents use to reach Orrery, for example `http://localhost:8080` or `https://orrery.example.com`. The MCP endpoint only accepts requests for this host. |

```sh
openssl rand -base64 32   # ORRERY_ENCRYPTION_KEY
openssl rand -hex 32      # BOOTSTRAP_SECRET
```

Optional but common:

| Variable | What it does |
| --- | --- |
| `ORRERY_DOMAIN` | Your public domain. Required for the `tls` profile (Caddy's automatic certificate). |
| `ORRERY_VERSION` | Pin a specific image tag instead of `latest`, for example `0.1.0`. See [Upgrading](#upgrading). |
| `LOG_LEVEL` | `debug`, `info` (default), `warn` or `error`. Logs are JSON lines on stdout. |

## 3. Start the stack

```sh
docker compose pull      # fetch the published GHCR image
docker compose up -d
```

Compose starts `orrery` and `postgres` and waits for Postgres to become healthy. Open
<http://localhost:8080/setup>, create the first administrator with `BOOTSTRAP_SECRET`, then remove
`BOOTSTRAP_SECRET` from `.env` and re-create the app container so the change takes effect:

```sh
docker compose up -d --force-recreate orrery
```

The app is now at `PUBLIC_URL`. Check it with:

```sh
curl -fsS http://localhost:8080/healthz
curl -fsS http://localhost:8080/readyz
```

To see logs: `docker compose logs -f orrery`.

## 4. HTTPS with Caddy (`--profile tls`)

Agents on teammates' machines need Orrery over HTTPS. Set `ORRERY_DOMAIN=orrery.example.com` and
`PUBLIC_URL=https://orrery.example.com` in `.env`, point DNS for that domain at this host, make sure
ports 80 and 443 are reachable, then start the optional Caddy profile:

```sh
docker compose --profile tls pull
docker compose --profile tls up -d
```

Caddy obtains and renews a Let's Encrypt certificate automatically using `deploy/Caddyfile`,
proxies to `orrery:8080`, and stores certificate state in the `caddy-data` and `caddy-config`
volumes. Plain `docker compose up -d` does not start Caddy. If you already run a reverse proxy, skip
this profile and point it at port 8080 instead.

## S3-compatible object storage (`--profile storage`)

By default uploaded blobs (profile photos) stay on the `orrery-data` volume and
`docker compose up -d` runs only Orrery and Postgres. For RustFS or another S3 provider, set
`ORRERY_STORAGE_DRIVER=s3` plus `ORRERY_S3_ENDPOINT`, `ORRERY_S3_BUCKET`, `ORRERY_S3_REGION`,
`ORRERY_S3_ACCESS_KEY_ID`, `ORRERY_S3_SECRET_ACCESS_KEY` and `ORRERY_S3_FORCE_PATH_STYLE` in `.env`,
then start with `docker compose --profile storage up -d` to run the included RustFS service (create
the bucket once, as described in the guide). Missing variables or an unreachable bucket stop startup,
and `/readyz` reports `503` if the bucket becomes unreachable later. See
[Object storage: local disk and S3/RustFS](./object-storage.md) for the full variable reference,
RustFS setup, and the `rclone sync` / `aws s3 sync` migration runbook.

## `ORRERY_WEBHOOK_ALLOW_PRIVATE_URLS`

Outgoing webhooks (see [ADR-0007](../adr/0007-outgoing-webhooks-outbox-and-security.md)) are
delivered only to public `https://` addresses by default. The delivery worker resolves DNS and
rejects loopback, private, link-local, cloud-metadata and IPv6 local addresses, and it pins the
validated IP at connect time so a DNS rebind cannot redirect a delivery.

Set `ORRERY_WEBHOOK_ALLOW_PRIVATE_URLS=true` in `.env` only when the receiver is an internal LAN
service. This is an explicit, installation-wide opt-in: it permits private IPs and also allows
`http://` URLs. Restart Orrery after changing it. Webhook management itself is limited to
workspace owners and needs `ORRERY_ENCRYPTION_KEY` to generate signing secrets.

## Upgrading

`ORRERY_VERSION` selects the image tag. The published tags are the full version (`0.1.0`), the
major/minor version (`0.1`) and `latest`, all from `ghcr.io/forge-orbit/orrery`. Pin a version in
`.env` for reproducible upgrades:

```dotenv
ORRERY_VERSION=0.1.0
```

Then pull the new image and re-create the app container. The database volume is untouched, so no
data migration command is needed — the server applies migrations from `db/migrations/` at startup:

```sh
docker compose pull orrery
docker compose up -d orrery
```

Before any upgrade, take a backup and note the currently running tag so you can roll back — see
the [upgrade and rollback checklist](./backup-and-restore.md#upgrade-and-rollback-checklist). To run
a local build instead of a published tag, add `--build` to the `up` command.

## Where next

- [Backup and restore](./backup-and-restore.md) — verified `pg_dump` / `pg_restore` runbook and
  preservation of `ORRERY_ENCRYPTION_KEY`.
- [Connect an agent](./connect-agent.md) — Claude Code, Codex and Cursor in one page.
- [Claude Code run reporting](./claude-code-runs.md) and
  [Codex CLI run reporting](./codex-run-reporting.md) — lifecycle hooks and verification records.
