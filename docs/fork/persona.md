# Structured persona (fork, phase 1)

This fork adds a structured persona for each agent and server-wide global instructions. It is for
personal use under PolyForm Noncommercial 1.0.0; the `Required Notice` in `LICENSE` and `NOTICE`
stays unchanged.

## Files

| File | Place | Purpose |
|---|---|---|
| `persona.yaml` | `<OpenBot>/Agents/<agent id>/` (agent workspace root) | role, goals, tone, boundaries, examples, routing summary, rule overrides |
| `global-instructions.md` | `<OpenBot>/` (the folder that holds `Agents` and `Shared`) | text for every agent of this server, at most 8 000 characters |
| `.openbot-persona/versions/` | agent workspace | immutable persona versions: `<number>-<hash>.yaml` and `.json` |

`<OpenBot>` is `~/OpenBot` on a desktop. See [`persona.example.yaml`](persona.example.yaml).

A new agent (created in the app or by `create_agent`) gets a starter `persona.yaml` from its profile:
role from the title (or the name), the first sentence of the description as goal and routing
summary, and a tone that follows the person's language (item P.8). An existing file is never
replaced.

## `persona.yaml` fields

All fields are optional. An unknown field or override key makes the file invalid; the prompt then
tells the agent that the file is ignored and why (a field name or a limit, never a value).

| Field | Type | Limit |
|---|---|---|
| `version` | `1` | — |
| `role` | text | 600 characters |
| `goals` | list of lines | 12 × 300 |
| `tone` | text | 600 |
| `boundaries` | list of lines | 24 × 300 |
| `examples` | list of `{user, agent}` | 6 × 1 200 each |
| `routing_summary` | text | 300 (for the Router in phase 2) |
| `channels.chat` | text: how to write in Slack, Discord and Telegram | 600 |
| `channels.async` | text: how to write in GitHub, email and documents | 600 |
| `overrides` | map of rule key → text | 1 500 each |

Override keys: `style`, `remit`, `group_chat`. Their default texts are in
`src/backend/agent/persona/overridable-rules.ts`. Rules for tools, approvals, sends, payments,
secrets, memory, waits, the browser, and untrusted content cannot be overridden. A boundary adds a
limit; it never removes a fixed rule.

## Prompt order

1. Fixed behavior rules (with `style`, `remit`, `group_chat` replaced when the persona overrides them)
2. `<openbot_global_instructions>`
3. `<agent_profile>`
4. `<agent_persona>` (new)
5. `<agent_instructions>` (AGENTS.md / CLAUDE.md)
6. Section teammates, folders, skills, Computer Use, memory

Without `persona.yaml` and `global-instructions.md`, the prompt is byte-for-byte the upstream prompt.

## Versions and rollback

Each session start reads `persona.yaml` and records a new version when the text changed. At each
turn OpenBot hashes the persona, the global text, the role and the allowed MCP servers; after a
change it loads the agent's sessions again, so the next turn already has the new persona, for every
provider (item P.4).

```sh
bun scripts/persona.ts validate ~/OpenBot/Agents/<id>/persona.yaml
bun scripts/persona.ts status   ~/OpenBot/Agents/<id>
bun scripts/persona.ts history  ~/OpenBot/Agents/<id>
bun scripts/persona.ts show     ~/OpenBot/Agents/<id> 2
bun scripts/persona.ts rollback ~/OpenBot/Agents/<id> 2
```

A rollback first records the current file, then writes the old version back as a new version. The
history only grows. `status` shows `Default updated` when upstream changed a built-in rule after
the persona overrode it; then compare the new default with your override.

The agent also hears it (item P.6): when a built-in rule that its persona overrides changed after
the persona's version was saved, its instructions ask it to tell the user once in its next answer,
and `persona_read` lists the rules in `defaultUpdated`. Saving the persona again (a new version)
records the new defaults and ends the notice.

## Not in phase 1

- No settings UI or IPC; edit the files directly. Agents use `persona_read` and `persona_update`
  (item P.3): validated, versioned, and they can add boundaries but never remove or reword one.
- `list_agents` shows `routing_summary` in place of the description when the persona has one (item P.1).
- An instance transfer (export and import) carries `persona.yaml` and its history. Link-only agent
  templates do not: they go through the account service on openbot.run.
