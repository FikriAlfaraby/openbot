# fork-config.yaml (roadmap item 2.2)

The owner's host configuration, in the OpenBot folder: `<OpenBot>/fork-config.yaml`, beside
`Agents` and `Shared` (`~/OpenBot` on a desktop, `/var/lib/openbot/OpenBot` on a self-hosted server).

```yaml
version: 1
agents:
  <agent id>:
    role: router     # the Telegram Orchestrator: talks with people, routes, does no work
  <agent id>:
    role: worker     # Coder, Researcher: does the work of a ticket
  <agent id>:
    role: watchdog   # checks progress on a schedule
```

- The key is the agent id: the name of the agent's folder in `<OpenBot>/Agents/`.
- One agent at most has the role `router`. Unknown fields and roles make the file invalid.
- OpenBot reads the file again when it changes. An invalid edit keeps the last valid roles and
  reports the issue; removing the file removes all roles.
- Agents with **Workspace only** cannot change the file: they write only in their workspace,
  `Shared` and temporary folders. Keep the Router and the workers on Workspace only.
- What each role changes comes with the next items: the Router's tool limits (2.3), ticket tools
  (2.5), and the Watchdog's tools (4.1).

## What the role `router` changes (item 2.3)

- OpenBot refuses every OpenBot tool outside `ROUTER_OPENBOT_TOOLS`, also through `tool_call`,
  and `tool_search` shows only allowed tools.
- Claude gets no `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Task`,
  `Agent` or `Skill`; Codex gets no shell, patch or web tools.
- The Router gets no MCP servers (no T3 Code, no Computer Use).
- Its developer instructions carry the Router rule after its profile.
- A role change replaces a loaded provider session, so the new tools apply at once.

## Chat reply rule (item 2.7)

```yaml
chat:
  maxWords: 100   # 20 to 1000; the default is 100
```

A Router answer in Slack, Discord or Telegram longer than `maxWords` words is cut at the end of the
last sentence that fits, and the post adds "The full answer is in the OpenBot app." The Router's
conversation in the app keeps the full answer. Other agents' answers are not changed.

## Gate for chat platforms (item 3.3)

```yaml
gate:
  telegram:
    mode: observe          # off | observe | auto
    allow: ["123456789"]   # Telegram user ids that may give work; omit for everyone
```

| Mode | A sender in `allow` | Any other sender |
|---|---|---|
| `auto` | reaches the Router | dropped, with no reaction |
| `observe` | reaches the Router | recorded in `<OpenBot>/fork-observations.jsonl`, no agent acts |
| `off` | dropped | dropped |

No `gate` block for a platform keeps upstream's behavior (everyone in a linked chat). The check
runs before any agent sees the message and before OpenBot reacts to it. The observation file keeps
the time, chat, sender id and the first 500 characters, redacted; it moves to `.1` at 2 MiB.
Find your Telegram user id in the prompt of any message ("Telegram user <id>") or with a bot such
as @userinfobot. Slack and Discord take the same block.

## Daily budget and loop guard (item 4.2)

```yaml
budget:              # every agent without its own budget
  dailyTokens: 2000000
  dailyUsd: 5
agents:
  <agent id>:
    role: worker
    dailyTokens: 500000   # the agent's own budget, over the default
```

- The window is the last 24 hours, not a calendar day. Tokens are new input, cache writes and
  output; cached input reads are left out (they cost a tenth of new input and would fill any
  budget alone). Dollars are OpenBot's own estimate, as in the usage view.
- A spent budget holds the agent's queue like a plan limit: messages, teammate requests,
  Telegram messages and routine runs wait, and none fails. A turn that already runs ends normally.
- The owner's own message in the OpenBot app still starts a turn.
- The host checks the held agents every 5 minutes; the queue starts again when older spending
  leaves the window or the owner raises the budget. The log says once when an agent is held.
- Loop guard (no settings): an OpenBot tool call that failed 3 times in a row with the same input
  within 10 minutes is refused, and the agent is told to change its approach or report the ticket
  blocked. Another input or a success starts the count again. It sees OpenBot tools only, not the
  provider's own tools such as `Bash`; the Watchdog's progress check covers those.

## Router batching (item 4.5)

No setting. When a person sends several chat messages while the agent with the role `router`
works, the queued ones start one Router turn together, and the Router answers once, as a reply to
the first. Only messages of one conversation and one author join, in queue order, at most 10; the
run stops at the first other author, teammate answer or usage-limit resume. Other agents keep one
turn per chat message.
