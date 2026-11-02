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
- [x] 2.4 Ticket store (`src/backend/tickets/`): tickets with states `open`, `working`,
      `awaiting_human`, `review`, `blocked`, `done`, `failed`, `cancelled`; an append-only event log;
      idempotent creation per source message. Storage choice in the notes of 2.1 (own SQLite file or
      a migration). Tests.
- [x] 2.5 Router tools: `ticket_create`, `ticket_assign`, `ticket_list`, `ticket_close`; worker
      tools: `ticket_report` (state + summary + `human_action`). Tests.
- [x] 2.6 Thread subscription: a follow-up in the same Telegram thread or reply chain goes straight
      to the subscribed worker's ticket (pass-through); the Router still sees it. Tests.
- [x] 2.6b Private-chat follow-ups: the Router's prompt for each message lists the tickets of the
      conversation (live, or ended in the last day) with worker and open question, and tells it to
      send a follow-up with `ticket_assign` instead of a new ticket. (Chosen over mapping Telegram
      message ids to tickets: no change to the Telegram parser, and it works on every platform.)
- [x] 2.7 Reply rules held by the host for the Router in chat channels: one confirmation, then
      quiet; at most 100 words. Tests.

## Phase 3: Executor, recovery, gate

- [x] 3.1 T3 Code executor, part 1: `scripts/fork/t3-exec.ts` wraps `t3 thread start/send/show
      --wait --json` (base branch → `--worktree`), with a fake `t3` for tests; exit 0 → `review` or
      `done`, 1 → `failed`, 2 → `awaiting_human`. Notes on the user that runs `t3` vs `openbot`.
- [x] 3.1b T3 Code executor, part 2: the ticket keeps its T3 thread id; a follow-up on the ticket
      goes to the same T3 thread (`t3 thread send`); the Coder persona and a skill tell the Coder to
      use it for all coding work; T3 worktree cleanup and worktree location in `docs/fork/t3.md`.
- [x] 3.1c T3 Code executor, part 3: the Watchdog reads T3 thread state (`t3 thread show`) for
      working tickets; a T3 question (exit 2) reaches the person through the Router.
- [x] 3.1d T3 Code over MCP (owner's wish): connect T3's `/mcp` on `localhost` to the Coder only,
      and finish the OAuth approval in OpenBot's own browser on the VPS, where the `localhost`
      redirect works; document it in `docs/fork/t3.md`. The CLI path of 3.1 stays the fallback.
- [x] 3.2 Stopped-task recovery (idea of charliedowler): the Router wakes when a ticket or task
      stops, and can resume or close it.
- [x] 3.3 Gate for Telegram: per-source mode `off` / `observe` / `auto`, allow-list per Telegram
      user, bot messages as inferred candidates. Tests.
- [x] 3.4 Mandate: scope and strength recorded on each ticket, checked by the host before risky
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
- [ ] P.8 A new agent gets a starter `persona.yaml` (role from its title, goals from its
      description, tone "follow the person's language") when it is created, so every bot has a
      persona to edit; an existing `persona.yaml` is never replaced. Tests.
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
- Tickets live in their own `fork-tickets.db`, not in a migration of `openbot.db`: upstream owns that
  migration sequence, and a fork v50 would collide with upstream's v50 at the next sync. (Changed
  from the first plan in item 2.4.)

- The six ticket tools raise the agent context baseline (`tools/agent-context/budget.json`) by 133
  bytes of always-visible text (tool names in `tool_search`) and about 3.3 KB of searchable catalog.
  Upstream's rule is "do not raise the baseline"; the fork raises it once for this feature. The two
  T3 tools (item 3.1b) raise it again by 33 visible bytes and about 1.3 KB of catalog; `t3_sweep`
  (item 3.1c) by 18 visible bytes and about 0.3 KB; the mandate's `scope` field (item 3.4) by 172
  bytes of searchable schema.

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
- Fixed in item 3.1d: Claude, ACP, Pi and Muse read the MCP servers themselves, so the Router's
  "no MCP servers" of item 2.3 held only for Codex. ThreadLifecycle now sends the allowed names as
  `forkMcpServers` (not to Codex, which gets them in its config), and each client keeps only those.
- `ticket_assign` creates the worker's side thread on the host and queues the brief there with
  `expectsReply`, so the worker's answer returns to the Router and, through `messagingReturn`, to
  the same Telegram thread.
- Pass-through skips private chats: Telegram makes a whole private chat one thread, so only a reply
  to a ticket's message can tell a follow-up from a new request (item 2.6b).
- "One confirmation, then quiet" needs no extra host code: each Router turn posts one final answer,
  and a turn that only delegates posts the fixed "delegated" status. The host holds the word limit.
- T3's CLI: exit 0 completed, 2 waits for a person, 1 failed; `--wait --json` always prints
  `{ threadId, runId, status, reply, error }`; `--` ends the flags (`docs/fork/t3.md`).
- The packaged app has no `scripts/` folder, so the T3 executor is backend code
  (`src/backend/fork/t3/t3-cli.ts`), called by OpenBot tools in item 3.1b, not a script.
- A `t3_run` that outlasts its wait (`t3.waitSeconds`, default 600 s) leaves the ticket in `working`:
  the run goes on in T3 Code; only the CLI call ends.
- A T3 thread that waits for a person has a pending user question; the CLI cannot answer it.
  `t3 thread send` only queues a next turn. The answer goes in the T3 Code app or web, or through
  T3's MCP tool `t3_pending_request` (item 3.1d). Permission requests can only be answered in T3.
- Telegram never delivers another bot's messages to a bot, and OpenBot drops bot senders in
  `telegram-updates.ts`, so the prototype's "bots as inferred candidates" does not arise there.
- The gate's `observe` records only; the prototype's observe also runs the assessment and records
  its decision. A model assessment of observed messages could come later, at a token cost.
