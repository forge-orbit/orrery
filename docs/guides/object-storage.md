# Object storage: local disk and S3/RustFS

Orrery stores uploaded blobs (today: Human profile photos) through one backend chosen at
**deployment** time, never in the in-app settings ([ADR-0008](../adr/0008-pluggable-object-storage.md)).
The default `local` driver needs no extra containers. `s3` works with RustFS, MinIO, Garage, AWS S3
and Cloudflare R2.

Both backends use the **same 1:1 relative key layout**, with no sidecar metadata:

| Driver | Where a key like `avatars/<humanId>/<objectId>.webp` lives |
| --- | --- |
| `local` | `<ORRERY_DATA_DIR>/objects/avatars/<humanId>/<objectId>.webp` (Compose: `orrery-data:/app/data`) |
| `s3` | `s3://<ORRERY_S3_BUCKET>/avatars/<humanId>/<objectId>.webp` |

Content type, size and sha256 live in the Postgres `stored_objects` table, so copying the bytes alone
is a complete migration — no database rows are rewritten.

## Configuration

Set these in `.env` (see [`.env.example`](../../.env.example)). Missing S3 values, a malformed
endpoint, or an unreachable bucket make the server **exit at startup**; `/readyz` reports `503` if the
bucket later becomes unreachable.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORRERY_STORAGE_DRIVER` | `local` | `local` or `s3`. |
| `ORRERY_DATA_DIR` | `data` | Local data root; blobs go in its `objects/` child. Compose fixes this to `/app/data`. |
| `ORRERY_MAX_ATTACHMENT_BYTES` | `26214400` | Maximum size of a downloadable attachment in bytes (25 MB). Inline images are always capped at 10 MB. |
| `ORRERY_S3_ENDPOINT` | — | Required for `s3`: `http(s)://host:port`. Use `http://rustfs:9000` in Compose, `http://localhost:9000` for `pnpm dev`. |
| `ORRERY_S3_BUCKET` | — | Required for `s3`: bucket that already exists. |
| `ORRERY_S3_REGION` | `us-east-1` | Signing region (`auto` works for Cloudflare R2). |
| `ORRERY_S3_ACCESS_KEY_ID` | — | Required for `s3`. |
| `ORRERY_S3_SECRET_ACCESS_KEY` | — | Required for `s3`. |
| `ORRERY_S3_FORCE_PATH_STYLE` | `false` | Set `true` for RustFS, MinIO and Garage; usually `false` for AWS S3. |
| `RUSTFS_PORT` / `RUSTFS_CONSOLE_PORT` | `9000` / `9001` | Host-side ports for the optional Compose RustFS service. |

## Optional RustFS service (`--profile storage`)

A plain `docker compose up -d` starts only Orrery and Postgres. To try or deploy S3 storage:

1. In `.env`, set `ORRERY_STORAGE_DRIVER=s3`, `ORRERY_S3_BUCKET=orrery`, and choose credentials (or
   keep the Compose defaults `orreryaccesskey` / `orrerysecretkey` for local testing).
2. Start the stack with the profile:
   ```sh
   docker compose --profile storage up -d
   ```
3. Create the bucket once. Either sign in to the RustFS console at <http://localhost:9001> with the
   same access/secret key and create a bucket named `orrery`, or run:
   ```sh
   docker run --rm --network orrery_default \
     -e AWS_ACCESS_KEY_ID="${ORRERY_S3_ACCESS_KEY_ID:-orreryaccesskey}" \
     -e AWS_SECRET_ACCESS_KEY="${ORRERY_S3_SECRET_ACCESS_KEY:-orrerysecretkey}" \
     amazon/aws-cli s3 --endpoint-url http://rustfs:9000 mb s3://orrery
   ```
   (`orrery_default` is the Compose network name; adjust if your project name differs.)
4. Check `curl -fsS http://localhost:8080/readyz` returns `200`. To run the server on your machine
   against the profile, set `ORRERY_S3_ENDPOINT=http://localhost:9000` and `pnpm dev`.

The bucket's bytes live in the `rustfs-data` volume. Do not use `docker compose down -v` unless you
intend to destroy them.

## Migrating between backends

Keep the app **stopped** during the copy so no upload writes to the old backend after the sync began.
The database needs no changes. Run `rclone sync --dry-run` (or add `--dry-run` to the AWS command)
first and check the file list: `sync` makes the destination an exact mirror and **deletes** extra keys.
Use a bucket dedicated to Orrery.

### rclone

Add two remotes with `rclone config` (local path and S3 provider `Other`, `force_path_style = true`
for RustFS). Then:

```sh
# Local -> S3
rclone sync orrery-local:objects orrery-s3:orrery --progress

# S3 -> local (restore or move back)
rclone sync orrery-s3:orrery orrery-local:objects --progress

# S3 provider -> another S3 provider
rclone sync orrery-s3-old:old-bucket orrery-s3-new:new-bucket --progress
```

`orrery-local:objects` points at the `orrery-data` volume's `objects/` directory; for a local
`pnpm dev` install it is `data/objects`.

### AWS CLI

```sh
# Local -> S3 (from a shell that can see data/objects)
aws --endpoint-url http://localhost:9000 s3 sync data/objects/ s3://orrery/ --delete

# S3 -> local
aws --endpoint-url http://localhost:9000 s3 sync s3://orrery/ data/objects/ --delete

# S3 provider -> another S3 provider
aws s3 sync s3://old-bucket/ s3://new-bucket/ --delete
```

Omit `--endpoint-url` for AWS S3 itself; for Cloudflare R2 use the account-specific endpoint.

### Cut over

1. Stop Orrery: `docker compose stop orrery`.
2. Run the sync in the direction you need; confirm object counts match.
3. Edit `.env`: set `ORRERY_STORAGE_DRIVER` to the new driver and its variables (or unset the S3
   variables when returning to `local`). Keep `ORRERY_ENCRYPTION_KEY` unchanged; see
   [Backup and restore](./backup-and-restore.md).
4. Restart: `docker compose up -d orrery`, then check `curl -fsS http://localhost:8080/readyz`.
5. Sign in and view a known profile photo at its existing `avatarUrl`. The `?v=<objectId>` URL is
   unchanged and cache-friendly, so the same bytes under the same key are all that is needed.
6. To roll back, stop the app, point `.env` back at the old driver (whose files you left in place)
   and restart. Do not run another sync until you have decided which backend is authoritative.

## Backing up blobs

Blobs are write-once and immutable per key (replacement writes a *new* key), so a copy taken while the
app runs is safe; stopping the app gives an exact point-in-time mirror.

With the `local` driver, back up the named volume's `objects/` tree alongside your `pg_dump` and
`.env` copy:

```sh
docker compose exec -T orrery tar -czf - -C /app/data objects > orrery-objects.tgz
```

Restore it while the app is stopped, using a throwaway container that mounts the same volume
(`exec` cannot run in a stopped container):

```sh
docker compose stop orrery
docker compose run --rm -T --no-deps --entrypoint "" orrery tar -xzf - -C /app/data < orrery-objects.tgz
docker compose up -d orrery
```

The `pg_dump` alone does **not** include blobs, and the blob copy alone does not include the
`stored_objects` rows: keep both and the encryption key together. With the `s3` driver, back up the
bucket instead (enable versioning where available, or `rclone sync` / `aws s3 sync` it to backup
storage) and verify a restore with `/readyz` plus a spot-check of a profile photo.
