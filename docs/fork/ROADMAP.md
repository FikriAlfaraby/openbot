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

- [x] P.1 `list_agents` and the delegation prompt use `routing_summary` when the persona has one,
      instead of the description cut at 300 characters. Tests.
- [x] P.2 Channel output norms in the persona (article §4.2): `channels.chat` (short, at most N
      words, only decisions) and `channels.async` (GitHub, email, documents: structured, complete);
      the prompt names the rule for the channel of the turn. Tests.
- [x] P.3 The agent reads and edits its persona through OpenBot tools (`persona_read`,
      `persona_update` with validation and a version), not only by editing the file; an invalid
      edit is refused with the field. Tests.
- [x] P.4 Fresh persona on every turn: check that a persona change reaches running Claude, Codex
      and ACP sessions (fingerprint restart or a turn block like the memories); fix the gap. Tests.
- [x] P.5 Agent imports carry `persona.yaml`: an instance transfer exports every workspace file
      outside `.openbot` and the managed skill folders, so `persona.yaml` and `.openbot-persona/`
      travel; a test guards it. Link-only templates do not: their snapshot is a contract that the
      account service on openbot.run checks, which the fork cannot change (see Findings).
- [x] P.6 "Default updated" reaches the owner: a notice when a built-in rule that a persona
      overrides changed after an upstream sync.
- [x] P.8 A new agent gets a starter `persona.yaml` (role from its title, goals from its
      description, tone "follow the person's language") when it is created, so every bot has a
      persona to edit; an existing `persona.yaml` is never replaced. Tests.
- [x] P.7 Role defaults from `fork-config.yaml` (item 2.2): a `router` gets the Router persona
      template and a light model by default, a `worker` the strongest model.

## Phase 4: Watchdog, budget, resources

- [x] 4.1 Watchdog agent template and a routine every N minutes, with read-only ticket tools and
      resume/close; it judges progress, not only liveness.
- [x] 4.2 Token budget per agent and a loop guard for repeated failing tool calls
      (`src/backend/fork/budget.ts`, `loop-guard.ts`, `docs/fork/fork-config.md`).
- [x] 4.3 Browser session per ticket, removed when the ticket ends (`src/backend/fork/browser-ticket.ts`,
      `docs/fork/tickets.md`).
- [x] 4.5 Router batching (article §2): Telegram messages that queue while the Router works start
      one Router turn together (`src/backend/fork/router-batch.ts`, `MessagingThreads.companions`).
- [x] 4.4 Storage: cleanup of ticket folders, archive to a bucket, daily backup script for
      `openbot.db` with the keyring (`docs/fork/storage.md`, `scripts/fork/openbot-backup`,
      `src/backend/fork/storage/ticket-archive.ts`).

## Phase 5: research-driven

Each item comes from a comparison of the fork with the DeepSeek Super-agent article, other OpenBot
forks, T3 Code and the product needs (a Telegram team that does not use the OpenBot app).

- [x] 5.1 Inline & Spill for chat answers (article §3.3: inline what fits, spill the rest with a
      pointer). A cut Router answer used to point to the OpenBot app, which a Telegram-only team
      never opens; now the full answer comes as `full-answer.md` in the same conversation
      (`src/backend/fork/spill.ts`).
- [x] 5.2 `/tiket` chat command on the fast path (article §3: code decides what needs no model). A
      Telegram team asks "how far is my work?" often; the host now answers from the ticket store
      with no Router turn and no tokens (`src/backend/fork/chat-commands.ts`).
- [x] 5.3 Setup check `bun scripts/fork-doctor.ts` (product need: an owner runs the server for a
      non-IT team; a bad `fork-config.yaml` edit or a missing persona showed only as a bot that
      misbehaves). Checks roles, folders, personas, T3, gate, budget and backup, with a fix each
      (`src/backend/fork/doctor.ts`).
- [x] 5.4 `openbot doctor` on an installed server (follow-up of 5.3: the server has no `bun`). The
      control socket answers `GET /v1/fork/doctor` from inside OpenBot (`src/main/server-mode.ts`,
      `src/backend/fork/doctor-node.ts`, `scripts/hosting/openbot`).
- [x] 5.5 The Watchdog checks recent failures again (article §6: transient external failures are
      rechecked until resolved). It used to see live tickets only, so a T3 run that failed on an API
      error stayed failed; now it sees failures of the last 24 hours and may resume each at most
      twice (`src/backend/fork/tickets/watchdog.ts`).
- [x] 5.6 Spending in `openbot doctor` (product need: a nonprofit runs all bots on one API key; the
      budget of item 4.2 held a queue with no sign before). Each agent with a budget shows its
      24-hour tokens and dollars against the limit, a warning from 80% (`budgetFinding` in
      `src/backend/fork/budget.ts`).
- [x] 5.7 `/tiket <number>` (follow-up of 5.2): the list told the state, but the result or the
      reason still needed a Router turn. The host now shows one ticket's question, summary and last
      steps, only for tickets of the same conversation (`ticketDetailReply`).
- [x] 5.8 `/bantuan` and `/help` in the Router's chat (product need: a non-IT team cannot guess the
      commands, and the host cannot set the Telegram bot's command menu, which the account service
      owns). The host lists what a person can do (`helpReply`).
- [x] 5.9 `/selesai <number>` sign-off (article §4.2: a person is asked only for decisions and
      sign-offs). A ticket in `review` waited for a Router turn to close; now its requester closes
      it as `done` from the chat (`signOffReply`).

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
  bytes of searchable schema; the two persona tools (item P.3) by 46 visible bytes and about 0.8 KB; `ticket_note` (item 4.1) by 21 visible bytes and about 0.5 KB.
- An agent may add persona boundaries but not remove or reword one through `persona_update`; only
  the owner lifts a boundary by editing `persona.yaml`.

- Item P.7: roles bring persona templates (router, watchdog) but not models. A model id depends on
  the provider, and a silent switch would differ from the model that the app shows. Recommended:
  Router and Watchdog on a light model (Claude Haiku or Sonnet), workers on the strongest
  (`docs/fork/agents/README.md`). Set them in each agent's settings.

- Item 4.2: the daily budget is a rolling 24 hours, counts tokens without cached input reads, holds
  the queue (nothing fails), and lets the owner's own app message through. No budget is set by
  default; set `budget` in `fork-config.yaml`. The loop guard refuses after 3 identical failures in
  10 minutes; these numbers are fixed, not settings.

- Item 4.3: the ticket session is an agent-kind partition `openbot-browser-agent-<hash>` with the
  hash of `fork-ticket:<ticket id>`, not a new `openbot-browser-ticket-<id>` kind: a new kind would
  change the saved browser state that upstream owns. A named profile of the agent wins over it.

- Item 4.5: batching is for the Router only, one conversation and one author, at most 10 messages,
  with one answer as a reply to the first message. Other agents keep upstream's one turn per message.

- Item 4.4: ended tickets move to `fork-archive/` after 30 days by default (`storage.archiveAfterDays`).
  A backup always contains the keyring, so an upload to a bucket is refused unless it is encrypted
  with age or gpg, or `OPENBOT_BACKUP_ALLOW_PLAIN_UPLOAD=1`. The timer runs daily at about 03:17
  server time and keeps 7 archives locally.

- Item 5.1: a cut Router answer always spills to a file in chat (no setting); when the file cannot
  be written, the post points to the app as before. Spill files stay 7 days.

- Item 5.2: the command replies in Indonesian by default (`chat.commandLanguage: en` for English),
  because the host has no model to follow the sender's language. Only the Router's conversation
  has the command.

- Item 5.3: the doctor warns (does not fail) for no gate, no budget, no Watchdog and no backup:
  they are advice for a team server, not errors. An invalid config, a missing agent folder and an
  invalid persona fail it.

- Item 5.5: the cap of 2 counts every resume by the Watchdog on that ticket, also resumes of a stuck
  ticket, so a ticket cannot cycle between failed and working on the Watchdog alone. Fixed numbers:
  24 hours, 2 resumes.

- Item 5.6: the spending lines are only in `openbot doctor` on a server (they need the running
  OpenBot's database), not in `bun scripts/fork-doctor.ts`. The warning share is fixed at 80%.

- Item 5.7: `/tiket <n>` leaves out ticket notes (the Router's and Watchdog's working log) and
  shows tickets of the same conversation only. Times are in UTC, since the host does not know the
  reader's time zone.

- Item 5.9: only the requester in the ticket's mandate signs off, and only from `review`; a ticket
  without a person in its mandate (opened by an agent) is closed by the Router as before. The
  Router hears of the sign-off through the ticket context of its next message, not at once.

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
- `list_agents` now shows the persona's `routing_summary` in place of the cut description, and the
  agent's fork role. The section-teammates block keeps name and title only, to keep its prompt cache.
- Item P.4: Codex already replaced a loaded session when its fingerprint (which holds the persona
  hash, the global text and the role) changed, at each turn. Claude, ACP, Pi and Muse resume a session
  only when it is not loaded, so a persona change waited for the next load. ThreadLifecycle now hashes
  the fork inputs at each turn and, on a change, unloads the agent's sessions, as upstream does for a
  profile change; the next turn resumes with the new instructions.
- Agent templates (`agent-template-service.ts`) go through the account service as an
  `AgentTemplateSnapshot` that the server validates; a persona field would need that service. A
  fork-only path would be to publish the persona as an embedded skill and turn it back into
  `persona.yaml` on install. Not done: for a personal fork, an instance transfer carries it.
- Item 4.2: OpenBot sees only its own tools, so the loop guard cannot see a provider's `Bash` loop;
  the budget and the Watchdog cover those. A budget is checked when a turn starts, so one long turn
  can go past it.
- Item 4.3: BrowserHost has no unit tests in upstream (it needs Electron); the fork tests the
  session choice and the sweep, and the BrowserHost wiring is checked by the type checker only.
- Item 4.5: one messaging turn posts one answer, to the origin of the first running delivery; the
  other deliveries of the turn are settled without a second post (`#finishedTurns`). Upstream has no
  unit tests for the mailbox, the drain or `MessagingThreads`; the fork tests the selection and the
  prompt text, and the wiring is checked by the type checker only.
- Item 4.4: the "ticket folders" are T3 Code's worktrees, which T3 owns; the `t3` command has no
  command to remove a thread's worktree, so their cleanup is T3's **Worktrees → Cleanup** setting.
  The fork cleans what it owns: ticket rows (archive), browser sessions (4.3) and its observation log.
- Item 5.1: the Telegram, Slack and Discord drivers already upload answer files; the spill rides
  on that path, after the cut post. A platform that refuses the file shows the usual "files
  skipped" note.
- Item 5.3: the doctor runs with `bun` from a clone of the repo; the installed server
  (`/opt/OpenBot`) has no `bun`. Fixed in item 5.4 with `openbot doctor`.
- Item 5.4: upstream has no tests for `ServerMode`; the route's answer format and the doctor on a
  real folder are tested, and the CLI was run against a fake control socket.
- Item 5.8: the OpenBot Telegram bot's token is in the account service (`telegramApp`), so the host
  cannot call `setMyCommands`; `/start` is the account service's link code and stays upstream's.

