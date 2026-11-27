# Local Runners, device enrollment, and Live Session Studio

Outbound-only local Runner hosts (`orrery-runner`) enroll via an 8-character device code at `/device`, appear in the workspace `Runners` fleet tab (`/workspaces/$workspaceId`), accept owner-only issue dispatches from `Delegate to Runner` on `/issues/$issueId`, and stream structured ACP activity into **Live Session Studio** (`/live/$runnerId/$dispatchId`).

## Sub-features

- `device-enrollment` `POST /api/runners/device-codes` (`hostDisplayName`, `platform`, `verifierHash`) → signed-in human approves at `/device?code=XXXX-XXXX` (`POST /api/runners/device-codes/{userCode}/approve`) → runner exchanges credential (`POST /api/runners/device-codes/token`).
- `runner-fleet` `POST /api/runners/register`, `PUT /api/runners/{runnerId}/catalog`, `GET /api/workspaces/{workspaceId}/runners`, and one-click host revocation (`POST /api/runner-hosts/{hostId}/revoke`) in the workspace `Runners` tab.
- `dispatch-and-stream` `POST /api/issues/{issueId}/dispatches` (owner-only, with optional `harness`, `model`, `effort`, `prompt`), `POST /api/runners/{runnerId}/dispatches/{dispatchId}/accept`, `POST /api/runners/{runnerId}/dispatches/{dispatchId}/stream`, and `GET /api/runners/{runnerId}/dispatches/{dispatchId}/stream`.
- `live-studio` `/live/$runnerId/$dispatchId?issueId=&workspaceId=` renders a steady connection badge (`Live` / `Connected` / `Connecting` / `Reconnecting` / `Replay` — never toggling on 1s background polls), `[data-studio-options]` (harness, agent, model, effort), `[data-studio-branch]`, `[data-studio-lease]`, stream category filters, owner-only `Raw output` toggle, context rail (`Dispatch prompt`, `Agent Plan`, `Worktree Changed Files`, `Child Workers`, `Host Health`), inline `Needs input` / `Stop Agent`, and uncertain-dispatch resolution.

## Preconditions

- Bootstrapped instance with a workspace, project, and registered agent; `doctor $RUN_DIR` exits 0.

## Recipe

1. Mint a device code (`POST /api/runners/device-codes` with a 64-hex SHA-256 `verifierHash`), approve it as a signed-in human (`POST /api/runners/device-codes/$USER_CODE/approve` or `/device?code=…`), and exchange `POST /api/runners/device-codes/token` for the host credential.
2. Register a Runner (`POST /api/runners/register`), dispatch an issue (`POST /api/issues/$IID/dispatches`), accept it (`POST /api/runners/$RID/dispatches/$DID/accept`), and post a stream chunk (`POST /api/runners/$RID/dispatches/$DID/stream`).
3. Sign in with Playwright and verify:
   - `/workspaces/$WS` `Runners` tab displays the enrolled host.
   - `/live/$RID/$DID?issueId=$IID&workspaceId=$WS` renders `heading:Live Session Studio`, steady `[data-studio-connection]` (`Live` across >2s of polling), `[data-studio-options]`, and `[data-studio-branch]`.

## Gotchas

- `POST /api/runners/device-codes` requires `hostDisplayName` (not `displayName`) and a 64-hex lowercase `verifierHash` (`sha256(verifier)`).
- Raw stream chunks (`visibility: "owner_only"`) are filtered server-side for every non-owner, including system administrators.
