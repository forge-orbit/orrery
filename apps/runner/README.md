# @forge-orbit/orrery-runner

Local agent runner for [Orrery](https://github.com/forge-orbit/orrery): dispatch board
issues to an ACP-compatible coding agent on your own machine — behind NAT, with no inbound
ports and no long-lived workspace API key on disk.

Each accepted dispatch runs in an isolated `git worktree` with a short-lived, single-issue
dispatch token, streams structured ACP events to **Live Session Studio**, and parks cleanly
when the agent asks a **Needs input** question so you can answer inline and resume the same
local session.

## Install

Requires **Node.js 26+**.

```sh
npm install -g @forge-orbit/orrery-runner
```

Or run it without installing:

```sh
npx @forge-orbit/orrery-runner --help
npx @forge-orbit/orrery-runner --version
```

## Quick start

Enroll your machine once with browser device-code login:

```sh
orrery-runner login --server https://orrery.example.com
```

Then, from any git checkout, resolve and remember a workspace/project binding:

```sh
cd /path/to/repo
orrery-runner init
```

And start a persistent project runner with zero flags:

```sh
orrery-runner start
```

Or run a single issue end-to-end from the terminal:

```sh
orrery-runner work PROJ-42
```

`orrery-runner start` with no `--workspace` or `--project` flags in an unbound repository
opens a numbered interactive picker (workspace → project → default agent), saves the binding
outside the repo in `~/.config/orrery/repos.json`, and starts immediately. Later runs reuse
the saved binding with no prompts and no extra network round-trip. Pass
`orrery-runner start --reconfigure` (or `orrery-runner init`) to change the binding;
explicit `--workspace` / `--project` / `--agent` flags override the saved binding for one
run without modifying it.

## Commands

| Command | What it does |
| --- | --- |
| `login [--server URL]` | Enroll this machine as a Runner host via the browser |
| `init [--workspace W] [--project P] [--agent A]` | Resolve and save a checkout binding, then exit |
| `start [options]` | Register a project-bound Runner and heartbeat until stopped |
| `work <ISSUE>` | Run one issue in an ephemeral Runner and exit |
| `status` | Show the locally stored host credential (offline, no network) |

Useful flags: `--reconfigure`, `--version` / `-v`, `--harness ID`, `--model ID`,
`--effort LEVEL`, `--concurrency N`, `--auto-claim`, `--repo PATH`,
`--acp-command` / `--acp-arg`, `--worktree-root PATH`. Run `orrery-runner --help`
for the full list.

Built-in `--harness` presets (`opencode`, `codex`, `claude`, `omp`, `grok`, `hermes`,
`cursor`) invoke each vendor's real ACP stdio command. The default dispatch harness is
`opencode` (`opencode acp`); point at any ACP-compatible stdio harness with
`--acp-command` / `--acp-arg` (or `ORRERY_ACP_COMMAND` / `ORRERY_ACP_ARGS`).

## Enrollment and bindings

- **Single enrollment per machine.** The host credential lives at
  `~/.config/orrery/runner-credential.json` (`0600`, override the directory with
  `ORRERY_RUNNER_CONFIG_DIR`). Only one Orrery installation is active at a time; logging in
  to a different server replaces the stored credential.
- The enrolled installation URL is authoritative: `start`, `work`, and `init` fail fast if
  `--server` or `ORRERY_URL` points anywhere else, so the host credential can never leak to
  the wrong origin.
- Checkout bindings live in `~/.config/orrery/repos.json` (`0600`), keyed by checkout, and
  are never stored inside the repository.

## Local ACP permission policy

`orrery-runner` evaluates ACP `session/request_permission` and `fs/*` requests locally:
paths and shell redirects are confined to the slot's worktree, and destructive commands
(`sudo`, `rm -rf`, `git push --force`, `git reset --hard`, …) are rejected.

> **Not an OS sandbox.** This permission policy is an application-layer gate, not an OS or
> process sandbox. Any allowed command (such as `pnpm`, `git`, or `make`) runs with your OS
> user's privileges. If you need hard OS confinement, run `orrery-runner` inside a
> container, VM, or OS sandbox wrapper (`bwrap`, `sandbox-exec`).

## Full guide

See [docs/guides/local-runner.md](https://github.com/forge-orbit/orrery/blob/main/docs/guides/local-runner.md)
for delegation, Live Session Studio, Needs-input round-trips, worktrees, scoped dispatch
tokens, revocation, and the full CLI/environment reference.

## License

GNU Affero General Public License v3.0 (`AGPL-3.0-only`).
