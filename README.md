# @draftboard/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for the **Draftboard
Integration API**. It lets any MCP-capable agent (Claude, Codex, etc.) work with your Draftboard
warm-introduction data — targets, connection paths, ranks, and tags — to answer questions like
"who are my best intro opportunities right now?" or "am I already connected to these people?".

[Draftboard](https://draftboard.com) maps how your team is really connected to your prospects; this
server exposes that data over MCP. API reference: <https://intros.draftboard.com/api>.

> **Just want to get intros (not build on the API)?** Also install the companion
> **[`draftboard-intros` skill](https://github.com/draftboardco/draftboard-skill)** — it teaches your
> assistant which tool to reach for and how to read the results. This server is only the engine.

## Requirements

- Node.js **20+**
- A Draftboard Integration API key (Pro/Team plan with API access). Find it in the
  [Draftboard app](https://intros.draftboard.com) under **Settings → API keys**.

## Quick start

The server speaks MCP over stdio. Point your client at it and pass the key via env.

### Claude Code / Claude Desktop (`.mcp.json` or `claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "draftboard": {
      "command": "npx",
      "args": ["-y", "github:draftboardco/mcp"],
      "env": {
        "DRAFTBOARD_API_KEY": "db-api_xxxxxxxx"
      }
    }
  }
}
```

### Codex CLI

```bash
codex mcp add draftboard --env DRAFTBOARD_API_KEY=db-api_xxxx -- npx -y github:draftboardco/mcp
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.draftboard]
command = "npx"
args = ["-y", "github:draftboardco/mcp"]
startup_timeout_sec = 60   # first `npx github:` launch clones + builds the server

[mcp_servers.draftboard.env]
DRAFTBOARD_API_KEY = "db-api_xxxxxxxx"
```

### Run from source

```bash
npm install
npm run build
DRAFTBOARD_API_KEY=db-api_xxxx node dist/index.js
```

### Verify your key

```bash
DRAFTBOARD_API_KEY=db-api_xxxx npm run smoke         # checks get_me
DRAFTBOARD_API_KEY=db-api_xxxx npm run smoke -- --full  # also runs a status overview
```

## Configuration

| Env var                 | Required | Default                                              | Purpose                       |
|-------------------------|----------|------------------------------------------------------|-------------------------------|
| `DRAFTBOARD_API_KEY`    | yes      | —                                                    | Bearer token for the API.     |
| `DRAFTBOARD_BASE_URL`   | no       | `https://intros.draftboard.com/api/v1/integration`   | Override for self-host/dev.   |
| `DRAFTBOARD_TIMEOUT_MS` | no       | `20000`                                              | Per-request timeout.          |

The key is used only to call Draftboard's API from your machine — it is never sent to the model
provider (OpenAI / Anthropic) or any third party, and the server never logs the `Authorization` header.

## Tools

**Thin tools** (1:1 with the API, raw JSON):

| Tool                     | What it does                                              |
|--------------------------|----------------------------------------------------------|
| `get_me`                 | Authenticated customer + team members.                   |
| `list_tags`              | Tags — `manual` (you created) or `automatic` (system batch/date marker), paginated. |
| `list_targets`           | Saved targets with `maxRank`, `pathsCount`, tags.        |
| `import_targets`         | Import people as targets by LinkedIn URL.                |
| `get_target_connections` | Connection paths for a target (`rank`, `rankDetails`).   |
| `list_accounts`          | Companies with saved targets + per-account reach counts. |

**Extended tools** (rest of the API; ⚠ = changes data, host-approved at runtime):

| Tool                       | What it does                                                       |
|----------------------------|-------------------------------------------------------------------|
| `list_supporters`          | Closest / preferred connectors (`preferred: true/false/omit`; `tiers: [1..5]`, tier 1 = closest). |
| `get_connector_intros`     | "Who can this connector introduce me to?" (connector-first view). |
| `set_connector_preferred` ⚠| Star/unstar a connector as a preferred supporter.                 |
| `set_connector_excluded` ⚠ | Exclude/un-exclude a connector from warm-path results.            |
| `set_connector_tier` ⚠     | Rate a connector (personal cadence tier 0–5; 1 = closest / "ask anytime" ★★★★, 5 = do-not-ask, 0 = clear). |
| `import_supporters` ⚠      | Add supporters by LinkedIn URL.                                   |
| `attach_tags_to_targets` ⚠ | Tag one or many targets (by id/name).                            |
| `set_intro_status` ⚠       | Move an intro to requested / completed / declined.               |
| `archive_target` ⚠        | Soft-delete a target (**not reversible** via the API).           |

**Prospecting tools** (company-first discovery — ⚠ BETA · Team/Enterprise · async):

| Tool                | What it does                                                             |
|---------------------|-------------------------------------------------------------------------|
| `search_accounts` ⚠ | Find NEW people by job title at named companies (domains / LinkedIn company URLs). Returns a `campaignId`; people surface in the pool asynchronously. |
| `list_pool`         | Read the pool — prospects a search found, awaiting confirm/reject (filter by `campaignId`). |
| `confirm_pool` ⚠    | Promote pool prospects into saved targets (capacity-checked).           |
| `reject_pool` ⚠     | Discard pending pool prospects.                                         |

**Outcome tools** (composed, mapped to real jobs):

| Tool                    | What it answers                                                        |
|-------------------------|-----------------------------------------------------------------------|
| `find_top_paths`        | "What are my best warm-intro opportunities right now?"                |
| `check_if_connected`    | "Am I already connected to these LinkedIn profiles?"                  |
| `intro_status_overview` | "How are my intros progressing (new / completed / stopped)?"          |

Outcome tools that walk connections are bounded and return a `telemetry` block
(`targetsMatched`, `targetsScanned`, `connectionsFetched`, `truncated`, `nextSuggestedFilter`) so
you always know the coverage of an answer. Scope them with filters before running on large lists.

## Setup (for your assistant)

*If you're an AI assistant that a user asked to set up Draftboard from this repo, do this, then tell
the user it's ready:*

0. Check `npx --version` (needs Node.js 20+). If it's missing, point the user to <https://nodejs.org>
   to install Node and stop until they have.
1. Configure a stdio MCP server named `draftboard` in the user's client: command `npx`, args
   `["-y", "github:draftboardco/mcp"]`, env `DRAFTBOARD_API_KEY` = the key the user gave you. On Claude,
   use your MCP-add command or edit `.mcp.json` / the Claude Desktop config; on Codex CLI, run
   `codex mcp add draftboard --env DRAFTBOARD_API_KEY=<key> -- npx -y github:draftboardco/mcp`. Never
   print the key back.
2. Also install the companion skill so the assistant uses these tools well: copy the
   `draftboard-intros/` folder from
   [`draftboardco/draftboard-skill`](https://github.com/draftboardco/draftboard-skill) into the
   user's skills directory — `~/.claude/skills/` for Claude Code, `~/.codex/skills/` for Codex CLI.
3. Verify with the `get_me` tool — a returned name means it works. Missing tools → restart the
   client; `401` → the key is wrong or expired.

## Feedback & support

Early beta — please report issues at
**[github.com/draftboardco/mcp/issues](https://github.com/draftboardco/mcp/issues)**. The server
never logs your API key, so pasting the full error output is safe and speeds up a fix.

## License

MIT
