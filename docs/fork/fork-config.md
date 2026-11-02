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
