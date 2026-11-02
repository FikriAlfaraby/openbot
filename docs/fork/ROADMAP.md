# Super agent roadmap (loop checklist)

Each loop pass takes the first open item, finishes it with tests, commits, pushes to
`FikriAlfaraby/claude-skills` branch `openbot`, ticks the item, and adds new findings here.
Stop and ask the owner when an item needs a decision that only the owner can make.

Sources: DeepSeek "Exploring Super-agent Design" (2026-11-01), `deepseek-ai/dsh-superagent-prototype`
(`docs/001-domain.md`, `src/policy.ts`), the fork scan of 166 OpenBot forks, and T3 Code
(`docs/user/outside-agents.md`, `project-settings.md`).

Owner choices: chat channel Telegram, provider Claude with a nonprofit API key, reply in the
sender's language, hard fork (upstream merge compatibility is nice to have, not required).

## Done

- [x] Phase 1: `persona.yaml`, versions and rollback, `global-instructions.md`, overridable rules.
- [x] Phase 0: fork release workflow and release URLs (`docs/fork/release.md`).
- [x] Persona templates for Router, Coder and Researcher (`docs/fork/agents/`).

## Phase 2: Router and tickets

- [ ] 2.1 Research notes (`docs/fork/notes/runtime.md`): how a Telegram message reaches an agent,
      how queued messages become turns (batching), how `start_task`, `send_message` and channel
      tasks run, where a provider's tool set is set (Claude, Codex), and where the host can refuse a
      tool. No code change.
- [ ] 2.2 Host-side fork config `<OpenBot>/fork-config.yaml`, outside agent workspaces: agent roles
      (`router`, `worker`, `watchdog`) by agent id. Validated, with tests. Agents cannot change it.
- [ ] 2.3 Router enforcement: a `router` agent gets no shell or file tools from its provider and
      only routing tools from OpenBot; the host refuses other tools. Tests.
- [ ] 2.4 Ticket store (`src/backend/tickets/`): tickets with states `open`, `working`,
      `awaiting_human`, `review`, `blocked`, `done`, `failed`, `cancelled`; an append-only event log;
      idempotent creation per source message. Storage choice in the notes of 2.1 (own SQLite file or
      a migration). Tests.
- [ ] 2.5 Router tools: `ticket_create`, `ticket_assign`, `ticket_list`, `ticket_close`; worker
      tools: `ticket_report` (state + summary + `human_action`). Tests.
- [ ] 2.6 Thread subscription: a follow-up in the same Telegram thread or reply chain goes straight
      to the subscribed worker's ticket (pass-through); the Router still sees it. Tests.
- [ ] 2.7 Reply rules held by the host for the Router in chat channels: one confirmation, then
      quiet; at most 100 words. Tests.

## Phase 3: Executor, recovery, gate

- [ ] 3.1 Coder executor through T3 Code: a skill and a wrapper for `t3 thread start/send --wait
      --json`, one T3 thread and worktree per ticket; exit 0 → `review`/`done`, 1 → `failed`,
      2 → `awaiting_human`. Check the user that runs `t3`.
- [ ] 3.2 Stopped-task recovery (idea of charliedowler): the Router wakes when a ticket or task
      stops, and can resume or close it.
- [ ] 3.3 Gate for Telegram: per-source mode `off` / `observe` / `auto`, allow-list per Telegram
      user, bot messages as inferred candidates. Tests.
- [ ] 3.4 Mandate: scope and strength recorded on each ticket, checked by the host before risky
      actions and before a ticket resumes.

## Phase 4: Watchdog, budget, resources

- [ ] 4.1 Watchdog agent template and a routine every N minutes, with read-only ticket tools and
      resume/close; it judges progress, not only liveness.
- [ ] 4.2 Token budget per agent and a loop guard for repeated failing tool calls.
- [ ] 4.3 Browser session per ticket (`openbot-browser-ticket-<id>`), removed when the ticket ends.
- [ ] 4.4 Storage: cleanup of ticket folders, archive to a bucket, daily backup script for
      `openbot.db` with the keyring (`docs/fork/storage.md`).

## Findings

- T3 Code MCP accepts only OAuth; `t3 thread` on the host needs no sign-in.
- The server updater accepts only `X.Y.Z` versions.
- A version bump needs a `CHANGELOG.md` section (pre-commit hook); use `bun run release:patch`.
