# Connect an agent

An agent connects to Orrery over one static `/mcp` endpoint using a workspace-scoped API key. Create
the agent in the Orrery web UI, issue it an API key, and export the server URL and key in the
environment your harness inherits:

```sh
export ORRERY_URL="https://orrery.example.com"
export ORRERY_API_KEY="<API key>"
```

Use the exact `PUBLIC_URL` of your installation as `ORRERY_URL` — the MCP endpoint only accepts
requests for that host. The key identifies the agent and scopes it to one workspace; never commit
it. For HTTPS setup, see [Install and upgrade](./install.md).

> Want to delegate issues directly from the Orrery board into isolated `git worktree`s with
> **Live Session Studio** and no long-lived workspace API key on your laptop? Use the
> [Local agent runner (`orrery-runner`)](./local-runner.md) instead.

## Claude Code and Codex

Start with the installable plugin from
[`forge-orbit/orrery-integrations`](https://github.com/forge-orbit/orrery-integrations). It wires
both the static `/mcp` endpoint and the automatic run-lifecycle hooks in one step.

**Claude Code:**

```text
/plugin marketplace add forge-orbit/orrery-integrations
/plugin install orrery@forge-orbit
```

**Codex CLI:**

```sh
codex plugin marketplace add forge-orbit/orrery-integrations
codex plugin add orrery@forge-orbit
```

Review and trust the plugin hooks in `/hooks`.

### Raw `/mcp` fallback

If you only want the MCP tools, without the plugin or the run-reporting hooks, point the harness
directly at the static endpoint.

Claude Code (`claude mcp add`):

```sh
claude mcp add --transport http orrery "$ORRERY_URL/mcp" \
  --header "Authorization: Bearer $ORRERY_API_KEY"
```

Codex CLI (`$CODEX_HOME/config.toml`):

```toml
[mcp_servers.orrery]
url = "https://orrery.example.com/mcp"
bearer_token_env_var = "ORRERY_API_KEY"
```

For the full setup, manual hook scripts, privacy notes and the verified gates, see
[Claude Code run reporting](./claude-code-runs.md) and
[Codex CLI run reporting](./codex-run-reporting.md).

## Cursor

Cursor connects to the same static `/mcp` endpoint over Streamable HTTP. Add `.cursor/mcp.json` to
your project (or the equivalent in your Cursor MCP settings):

```json
{
  "mcpServers": {
    "orrery": {
      "url": "https://orrery.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <API key>"
      }
    }
  }
}
```

Replace the URL with your installation's `/mcp` URL. Cursor infers Streamable HTTP from the `url`,
so no `type` field is needed (and strict schema parsers reject one). Keep the key in your environment
or secret manager rather than committing this file with a real value.

> **Automatic run-lifecycle hooks are Claude Code and Codex only.** Cursor uses the static `/mcp`
> tools shown above, but it does not report run start/heartbeat/end events automatically. The
> lifecycle hook scripts and their verification records are documented in
> [Claude Code run reporting](./claude-code-runs.md) and
> [Codex CLI run reporting](./codex-run-reporting.md).
