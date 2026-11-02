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

- [x] 2.1 Research notes (`docs/fork/notes/runtime.md`): how a Telegram message reaches an agent,
      how queued messages become turns (batching), how `start_task`, `send_message` and channel
      tasks run, where a provider's tool set is set (Claude, Codex), and where the host can refuse a
      tool. No code change.
- [x] 2.2 Host-side fork config `<OpenBot>/fork-config.yaml`, outside agent workspaces: agent roles
      (`router`, `worker`, `watchdog`) by agent id. Validated, with tests. Agents cannot change it.
- [x] 2.3 Router enforcement: a `router` agent gets no shell or file tools from its provider and
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

- [ ] 3.1 T3 Code executor, part 1: `scripts/fork/t3-exec.ts` wraps `t3 thread start/send/show
      --wait --json` (base branch → `--worktree`), with a fake `t3` for tests; exit 0 → `review` or
      `done`, 1 → `failed`, 2 → `awaiting_human`. Notes on the user that runs `t3` vs `openbot`.
- [ ] 3.1b T3 Code executor, part 2: the ticket keeps its T3 thread id; a follow-up on the ticket
      goes to the same T3 thread (`t3 thread send`); the Coder persona and a skill tell the Coder to
      use it for all coding work; T3 worktree cleanup and worktree location in `docs/fork/t3.md`.
- [ ] 3.1c T3 Code executor, part 3: the Watchdog reads T3 thread state (`t3 thread show`) for
      working tickets; a T3 question (exit 2) reaches the person through the Router.
- [ ] 3.1d T3 Code over MCP (owner's wish): connect T3's `/mcp` on `localhost` to the Coder only,
      and finish the OAuth approval in OpenBot's own browser on the VPS, where the `localhost`
      redirect works; document it in `docs/fork/t3.md`. The CLI path of 3.1 stays the fallback.
- [ ] 3.2 Stopped-task recovery (idea of charliedowler): the Router wakes when a ticket or task
      stops, and can resume or close it.
- [ ] 3.3 Gate for Telegram: per-source mode `off` / `observe` / `auto`, allow-list per Telegram
      user, bot messages as inferred candidates. Tests.
- [ ] 3.4 Mandate: scope and strength recorded on each ticket, checked by the host before risky
      actions and before a ticket resumes.

## Phase 2b: Persona backend v2

- [ ] P.1 `list_agents` and the delegation prompt use `routing_summary` when the persona has one,
      instead of the description cut at 300 characters. Tests.
- [ ] P.2 Channel output norms in the persona (article §4.2): `channels.chat` (short, at most N
      words, only decisions) and `channels.async` (GitHub, email, documents: structured, complete);
      the prompt names the rule for the channel of the turn. Tests.
- [ ] P.3 The agent reads and edits its persona through OpenBot tools (`persona_read`,
      `persona_update` with validation and a version), not only by editing the file; an invalid
      edit is refused with the field. Tests.
- [ ] P.4 Fresh persona on every turn: check that a persona change reaches running Claude, Codex
      and ACP sessions (fingerprint restart or a turn block like the memories); fix the gap. Tests.
- [ ] P.5 Agent templates and imports carry `persona.yaml` (`src/main/agent-template-service.ts`).
- [ ] P.6 "Default updated" reaches the owner: a notice when a built-in rule that a persona
      overrides changed after an upstream sync.
- [ ] P.7 Role defaults from `fork-config.yaml` (item 2.2): a `router` gets the Router persona
      template and a light model by default, a `worker` the strongest model.

## Phase 4: Watchdog, budget, resources

- [ ] 4.1 Watchdog agent template and a routine every N minutes, with read-only ticket tools and
      resume/close; it judges progress, not only liveness.
- [ ] 4.2 Token budget per agent and a loop guard for repeated failing tool calls.
- [ ] 4.3 Browser session per ticket (`openbot-browser-ticket-<id>`), removed when the ticket ends.
- [ ] 4.5 Router batching (article §2): Telegram messages that queue while the Router works start
      one Router turn together; today `startDelivery` runs each external message alone.
- [ ] 4.4 Storage: cleanup of ticket folders, archive to a bucket, daily backup script for
      `openbot.db` with the keyring (`docs/fork/storage.md`).

## Default decisions (taken while the owner was away; review them)

- The Router gets no external MCP servers, no Claude shell/file/web tools (`Bash`, `Read`, `Write`,
  `Edit`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Task`, `Agent`, `Skill`), and only the OpenBot
  tools in `ROUTER_OPENBOT_TOOLS` (`src/backend/fork/router-policy.ts`).
- Tickets live in `openbot.db` (migration v50), not in a separate file.

## Findings

- T3 Code MCP accepts only OAuth; `t3 thread` on the host needs no sign-in.
- The server updater accepts only `X.Y.Z` versions.
- A version bump needs a `CHANGELOG.md` section (pre-commit hook); use `bun run release:patch`.
- The Router is the existing Telegram Orchestrator agent; it already delegates with `send_message`
  and answers return to the same Telegram thread (`docs/fork/notes/runtime.md`).
- `start_task` works only for the calling agent; tickets need a host-side task for the worker.
- A Telegram private chat is one thread; follow-ups there match tickets by the reply chain.
- `fork-config.yaml` holds roles only for Workspace-only agents; a Full-access agent can edit any
  file. An invalid edit keeps the last valid roles (`src/backend/fork/fork-config.ts`).
- Tools of external MCP servers go from the provider to the server directly, not through
  `OpenBotToolRouter`; the Router is kept from them by giving it no MCP servers.
