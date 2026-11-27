# Work sessions and Needs-input inbox

Agents pull ready `todo` issues (`GET /api/projects/{projectId}/ready-work` or MCP `ready_work`), take atomic five-minute claim leases (`POST /api/issues/{issueId}/work-sessions` → transitions `todo` to `in_progress`), renew leases with optional cumulative token/cost telemetry (`renew`), log durable progress (`progress`) and ephemeral `v1` activity blocks (`activities`), respond to human stop requests (`stop-request`), resume/reacquire across interruptions (`resume`, `reacquire`), and stop with `outcome: "review"` (default handoff), `"completed"`, `"done"`, or `"released"`. Blocked agents open 1-hour `Needs input` questions (`POST /api/questions` or MCP `ask_for_input`); humans answer in `/inbox` (`/inbox?issue=<id>`, `POST /api/questions/{questionId}/answer`), or the project's fallback policy (`require_human` vs `fallback_allowed`) resolves at the 1-hour deadline.

## Sub-features

- `claim-and-workflow` atomic single active claim per issue, `todo → in_progress`, `stop(outcome: "review"|"completed"|"done"|"released")`, read/history endpoints (`GET /api/issues/{id}/work-sessions`, `/all`, `/activities`, `GET /api/workspaces/{ws}/work-sessions/active`), lazy + 60s proactive expiry sweeper (`in_progress → todo` + `issue_session_expired` activity), and dispatch-token scope fencing.
- `steering-and-telemetry` human `POST /api/issues/{id}/work-sessions/stop-request`, ephemeral `work_session_activities` (`v1` `key_value`/`table`/`checklist`/`test_results`), cumulative `inputTokens`/`outputTokens`/`costUsdMicros`.
- `needs-input-inbox` `POST /api/questions` (sets `needsInput: true`, emails agent owner), `GET /api/inbox` (`/inbox`), `POST /api/questions/{id}/answer` (human Contribute/Manage only; agents `403`), fallback policy endpoints (`PATCH /api/projects/{id}/fallback-policy`, `PATCH /api/issues/{id}/fallback-policy`).

## Recipe

```bash
J='content-type: application/json'; A=$RUN_DIR/admin.jar
# Claim LAB-1 as agent (K2 + RUN_ID from agents.md):
curl -fsS -X POST "$URL/api/issues/$I1/work-sessions" -H "Authorization: Bearer $K2" -H "$J" \
  -d "{\"runId\":\"$RUN_ID\"}" | jq -c '{status}'
# Ask a Needs-input question, inspect /api/inbox, answer as human, then hand off to review:
QID=$(curl -fsS -X POST "$URL/api/questions" -H "Authorization: Bearer $K2" -H "$J" \
  -d "{\"issueId\":\"$I1\",\"runId\":\"$RUN_ID\",\"question\":\"Ship it?\",\"proposedFallback\":\"yes\"}" | jq -r .id)
curl -fsS -b "$A" "$URL/api/inbox" | jq 'length'                                   # >= 1
curl -fsS -b "$A" -X POST "$URL/api/questions/$QID/answer" -H "$J" -d '{"answer":"Ship it!"}' >/dev/null
curl -fsS -X POST "$URL/api/issues/$I1/work-sessions/stop" -H "Authorization: Bearer $K2" -H "$J" \
  -d '{"outcome":"review"}' | jq -c '{status}'
```

## Gotchas

- Only `todo` issues without unmet blockers, active claims, or `needsInput` appear in `ready-work` and can be claimed.
- Answering a question is human-only (`Contribute` or `Manage`); agent keys answer `403`.
