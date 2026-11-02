# Runtime notes for the super agent (roadmap item 2.1)

Read from the code at upstream `0d55771bb` plus the fork commits. Every claim was checked in the
file named. Paths are under `src/`.

## Telegram → agent

- Chain: `main/signal-ingress.ts` (Signal `telegram-delivery`) → `backend/messaging/messaging-service.ts`
  `deliver` / `#deliverTelegram` → `telegram/telegram-transport.ts` → `telegram/telegram-updates.ts`
  `messageEvent` → `messaging-service.ts` `#receive` → `messaging-threads.ts` `receive` / `#admit` →
  `mailbox.enqueue` + `drain.scheduleDrain`.
- A new conversation goes to the connection's orchestrator agent; a known one keeps its agent
  (`messaging-service.ts:1224`). One **Telegram Orchestrator** serves every chat. It delegates with
  `send_message`, and `messagingReturn` brings the teammate's answer back to the same Telegram
  thread (`agent/openbot-tool-router.ts` `send_message`, `mailbox-store.ts`).
- **Thread mapping exists**: `threadKeyOf` (`telegram-updates.ts:210`) — private chat: one thread
  `dm` for the whole chat; forum: the topic; supergroup: the chain root; basic group: the reply map
  (in memory, lost at restart). A link `(connection, chat, threadKey)` owns one OpenBot thread.
- Kept per message: chat id, thread key, message id, author id (`from.id`), author name, files.
  `is_bot` senders are dropped at `telegram-updates.ts:108`; edits, `/start` and service messages too.
  In groups, a message counts only with a mention, a reply to the bot, or in a known chain.
- **No Telegram user allow-list.** `#authorAllowed` (`messaging-service.ts:1334`) checks roles, and
  only Discord fills role ids. Rate limits: 20 open requests per agent, 2 per author.

## Queue and batching

- A message that arrives during a turn is queued, never steered (`mailbox-store.ts` `steersChatTurn`).
- **No batching for external messages**: `DrainScheduler.startDelivery` runs a messaging delivery
  from a person alone (`agent/drain-scheduler.ts:626-636`). Teammate answers to one request are
  merged into one turn. One lane per agent: the orchestrator answers conversations one after
  another.

## Delegation primitives

- `start_task` makes a side thread with its own provider session, for the **caller only**, from the
  agent's own chat only; tasks share the workspace; limits 8 started / 50 open / 2–4 running;
  the result stays in the task (`agent-tasks/agent-tasks.ts:439-461`).
- `send_message` queues a delivery; an answer is an agent message with `replyToMessageId` and
  `expectsReply false`; when the recipient does not answer, `#relayAgentResult` sends its final
  text back (`agent/turn-lifecycle.ts`). Answers of several recipients arrive in one turn.
- Channel tasks: states `queued | running | waiting | paused | completed | failed | cancelled`;
  the lead routes with one structured-output call (`channel-service.ts:1030-1308`); only a person
  resumes or cancels a stopped task; no agent tool for it.

## Tools

- One dispatch point: `OpenBotToolRouter.handle`, `case "item/tool/call"`; `tool_call` is resolved by
  `resolveDeferredTool`; generic tools go to `#handleOpenBotTool` (`senderAgentId` at line 742).
  Some tools branch off before it (history, browser, ask_user, MCP, …).
- Every agent sees the same `VISIBLE_DYNAMIC_TOOLS` (`agent/tool-catalog.ts`); no role field exists.
- Claude: `disallowedTools` is global (`claude-client.ts:915-917`); `tools: []` only for profile
  generation. Per-agent switches travel as thread params read in `readThreadConfig`; a change in
  `threadConfigKey` restarts the query. Codex: profile generation shows the `features.*` keys that
  turn off shell and apply_patch (`agent/profile-generation.ts`).

## Storage

- `openbot.db` uses `node:sqlite` `DatabaseSync`; the latest migration is **v49**. New tables follow
  the `browser_profiles` pattern: a schema module, a migration, `LATEST_SCHEMA_SQL`, the history
  JSON entry, and a migration test. The agent data host is not involved.

## Decisions for the next items

| Item | Decision |
|---|---|
| 2.2 | `fork-config.yaml` in the OpenBot folder names roles by agent id. The Router is the Telegram Orchestrator agent. |
| 2.3 | Host check in `handle` after `resolveDeferredTool`, and a filter on `discoverTools`. Claude: a `toolProfile` thread param → no built-in tools; Codex: the profile-generation `features.*` keys; both in the session fingerprint. To verify: that `tools: []` keeps the OpenBot MCP tools. |
| 2.4 | Tables `tickets` and `ticket_events` by migration **v50** in `openbot.db`; ticket states borrow the channel task states plus `awaiting_human` and `review`. |
| 2.5 | `ticket_assign` creates a **task of the worker agent on the host** (not through `start_task`, which is caller-only), so each ticket has its own Worker session; the result comes back like a `send_message` answer, with `messagingReturn` for Telegram. |
| 2.6 | In a DM the whole chat is one thread, so a follow-up is matched to a ticket by the reply chain (the bot's ticket messages), else the Router decides. |
| 3.3 | Telegram allow-list in `#authorAllowed` by `authorId`; bot messages are dropped before the model today. |
| later | Router batching needs a change in `startDelivery`; new roadmap item 4.5. |
