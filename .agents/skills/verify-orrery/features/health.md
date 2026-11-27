# Health endpoints

Operators and orchestrators check Orrery with `/healthz` (the process is up) and `/readyz` (Postgres and object storage both answer). Both return JSON `{status, version}`.

## Sub-features

- `health-live` `/healthz` returns 200 `{"status":"ok","version":...}`.
- `health-ready` `/readyz` returns 200 `{"status":"ok",...}` while Postgres and object storage (`LOCAL_DATA_DIR/objects` or S3) are healthy.
- `health-degraded` `/readyz` returns 503 `{"status":"degraded",...}` when Postgres or object storage is unreachable, while `/healthz` stays 200.

## How to get to it (user POV)

- `curl $URL/healthz` and `curl $URL/readyz`.
- The container healthcheck in the Dockerfile calls `/healthz`.
- The home page reads `/readyz` (see [home-status](./home-status.md)).

## Driving it with curl

Preconditions: healthy instance, `doctor` exits 0.

- **Live and ready.** `curl -sS -w '\n%{http_code}\n' $URL/healthz $URL/readyz`. Two `200` lines with `"status":"ok"`.
- **Degraded.** `docker stop $CONTAINER`, then `curl -sS -m 40 -w '\n%{http_code}\n' $URL/readyz` returns `503` with `"status":"degraded"`, and `$URL/healthz` is still `200`. Run `docker start $CONTAINER` afterwards and poll `/readyz` back to 200 (recovery is usually immediate; the first degraded query can wait on the connection timeout, hence `-m 40`).
- **Proof.** Save the outputs to `$RUN_DIR/evidence/health-*.txt`, and note the `docker stop`/`start` commands.

## Gotchas

- Stop only `$CONTAINER` from `$RUN_DIR/env`, never another container.
- The recovery check can fail briefly right after `docker start`; retry for a few seconds before calling it broken.
- `curl` without `-f` is needed to see the 503 body.
