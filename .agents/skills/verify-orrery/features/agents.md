# Agents, API keys, rotation, and runs

Humans register agents (`POST/GET /api/agents`) and issue workspace- and project-scoped bearer keys (`orr_ak_…`, SHA-256 hashed, validity `7`/`14`/`30`/`60`/`90`/`never`, effective access capped by the human owner's live access). Keys expose a non-secret `keyHint` preview (`secret.slice(0, 19)…`), support overlapping rotation (`POST /api/agents/keys/{keyId}/rotate`), and can be self-revoked or workspace-owner-revoked without disclosing secrets. Agent runs check in via `POST /api/runs/hook` or MCP `orrery_run_checkin` and list under `GET /api/workspaces/{workspaceId}/runs`.

## Sub-features

- `agents-and-keys` `POST/GET /api/agents`, `POST/GET /api/agents/keys` (returns secret once + `key.keyHint` formatted with ASCII `...`), `GET /api/agents/me` (bearer-only, resolves both `orr_ak_…` API keys and single-issue `orr_dt_…` dispatch tokens; `401` on invalid/revoked/expired/`human_deactivated`/`dispatch_token_invalid`, `403` on wrong `workspaceId`/`projectId`/`dispatch_forbidden`).
- `key-rotation` `POST /api/agents/keys/{keyId}/rotate` creates a replacement (`replacesKeyId`, `agent_key_rotated` event); both keys work during overlap and revoke independently; rotating a revoked/expired key returns `409`.
- `key-revocation` `DELETE /api/agents/keys/{keyId}` (self) and `GET/DELETE /api/workspaces/{workspaceId}/agent-keys[/{keyId}]` (owner-only, secret-free).
- `runs` `POST /api/runs/hook` (Bearer key) and `GET /api/workspaces/{workspaceId}/runs` (also rendered on the workspace `Runs` tab).
- `agents-ui` on `/workspaces/$WS`, clicking the `Agents` tab shows `Registered agents`, `Keys in this workspace` (defaulting to the `Active` filter — switch to `All` to see revoked/expired keys; own keys show `Revoke`, other members' keys show `Revoke (owner)` with an `AlertDialog` confirmation), and `Active work sessions`.

## Recipe

```bash
J='content-type: application/json'; A=$RUN_DIR/admin.jar
AGENT=$(curl -fsS -b "$A" -X POST "$URL/api/agents" -H "$J" -d '{"name":"verify-bot"}' | jq -r .id)
curl -fsS -b "$A" -X POST "$URL/api/agents/keys" -H "$J" \
  -d "{\"agentId\":\"$AGENT\",\"workspaceId\":\"$WS\",\"projects\":[{\"projectId\":\"$PID\",\"level\":\"contribute\"}]}" > "$RUN_DIR/k1.json"
K1=$(jq -r .secret "$RUN_DIR/k1.json"); K1_ID=$(jq -r .key.id "$RUN_DIR/k1.json")
jq -r '.key.keyHint' "$RUN_DIR/k1.json"
curl -fsS -b "$A" -X POST "$URL/api/agents/keys/$K1_ID/rotate" -H "$J" -d '{}' > "$RUN_DIR/k2.json"
K2=$(jq -r .secret "$RUN_DIR/k2.json")
test "$(jq -r .key.replacesKeyId "$RUN_DIR/k2.json")" = "$K1_ID"
curl -fsS -b "$A" -X DELETE "$URL/api/workspaces/$WS/agent-keys/$K1_ID" -o /dev/null -w '%{http_code}\n'   # 204
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $K1" "$URL/api/agents/me"              # 401
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $K2" "$URL/api/agents/me"              # 200
RUN_ID=$(curl -fsS -X POST "$URL/api/runs/hook" -H "Authorization: Bearer $K2" -H "$J" \
  -d '{"schema":"orrery.run.hook.v1","event":"run_started","runKey":{"harness":"verify","nativeSessionId":"s-1"}}' | jq -r .runId)
curl -fsS -b "$A" "$URL/api/workspaces/$WS/runs" | jq 'length'
```

Confirm in Postgres that `agent_key_events` recorded `agent_key_created`, `agent_key_rotated`, and `agent_key_revoked`, and `token_hash <> secret`.

## Gotchas

- `/workspaces/$WS` defaults to the `Projects` tab; click the `Agents` tab before asserting `Registered agents` or `Keys in this workspace`.
- Keep `$RUN_DIR/k1.json` and `$RUN_DIR/k2.json` outside `$RUN_DIR/evidence/` and never echo secrets into evidence files.
