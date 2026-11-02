# Tickets (roadmap items 2.4–2.6)

A ticket is one unit of authorized work (DeepSeek prototype, `docs/001-domain.md`). The Router
creates one for each piece of work, a worker runs it in a side thread of its own, and every change
is an event in an append-only log.

Storage: `fork-tickets.db` beside `openbot.db` (`src/backend/fork/tickets/ticket-store.ts`), with
its own `PRAGMA user_version`. It is a separate file so that upstream's `openbot.db` migrations stay
untouched and a later upstream sync cannot collide with a fork migration. Back it up with
`openbot.db` (`docs/fork/storage.md`, item 4.4).

## States

```
open ─► working ─► review ─► done
          │  ▲        │
          │  └────────┘
          ├─► awaiting_human ─► working
          ├─► blocked ─► working
          ├─► failed ─► working
          └─► cancelled (final: a person stopped the work)
done ─► working   (a person's message resumes it)
```

- `awaiting_human` needs `humanAction`: what the person must decide. Leaving it clears it.
- `done`, `failed` and `cancelled` set `endedAt`; a resume clears it.
- The same state again keeps the newest summary and adds no event, so a retried report is safe.
- A ticket made from the same source message (`sourceKey`) is returned, not made twice.
- A mandate is recorded once; a wider scope needs a new ticket (item 3.4).

## Subscriptions

A ticket subscribes to threads (a Telegram thread, a pull request). `subscribers(threadKey)` gives
the live tickets of a thread, so that a follow-up reaches the ticket's worker (item 2.6).

## Tools (item 2.5)

| Tool | Who | What |
|---|---|---|
| `ticket_create` | Router | Opens a ticket from the current request; `assignTo` assigns at once. Subscribes it to the request's messaging thread. |
| `ticket_assign` | Router | Starts a side thread of the worker with the ticket brief; the answer returns to the Router. Again for the same worker: a follow-up in the same thread. |
| `ticket_list` | Router, Watchdog (all); worker (own) | Newest first, with state, assignee, summary. |
| `ticket_read` | Router, Watchdog; the assignee | One ticket with its last 20 events and threads. |
| `ticket_report` | the assignee | `working`, `review`, `done`, `blocked`, `failed`, or `awaiting_human` with `humanAction`. |
| `ticket_close` | Router | `done`, `failed` or `cancelled`, with a reason. |

## Pass-through (item 2.6)

A follow-up in a conversation that a live ticket owns goes straight to the ticket's worker, in the
ticket's side thread, with no Router turn (`src/backend/fork/tickets/pass-through.ts`, hook
`passThrough` in `messaging-threads.ts`). The worker's answer still returns through the Router.

It applies only when all hold:

- the conversation belongs to the agent with the role `router`;
- it is not a private chat: Telegram makes a whole private chat one thread, so there a follow-up and
  a new request look the same and the Router decides (it can use `ticket_assign` for a follow-up);
- exactly one ticket of the conversation is live (`working`, `awaiting_human`, `review`, `blocked`)
  with a worker and an open side thread.

A person's message to a ticket in `awaiting_human` moves it back to `working`. Any failure leaves
the message to the Router, as before.

## Ticket context for the Router (item 2.6b)

In every messaging turn of the Router, the prompt lists the tickets of that conversation (live, or
ended in the last 24 hours; at most 10) with their worker and open question, just before the
message (`src/backend/fork/tickets/ticket-context.ts`). In a private chat, where pass-through does
not apply, the Router sends a follow-up to the ticket's worker with `ticket_assign`.

## Stopped tickets (item 3.2)

When a worker's side-thread turn for a `working` ticket ends as failed or interrupted, the host
moves the ticket to `blocked` and queues one note for the Router in the ticket's conversation
(`src/backend/fork/tickets/stop-recovery.ts`, hook `turnEnded` of `AgentTasks`). The Router resumes
it with `ticket_assign` or ends it with `ticket_close`, and tells the person only when the work
cannot go on. One note per stopped turn; a completed turn needs none, because its answer already
returns to the Router.

## Mandate (item 3.4)

When `ticket_create` opens a ticket, the host records its mandate (`src/backend/fork/tickets/mandate.ts`),
never the model, and it cannot change afterwards (a wider scope needs a new ticket):

| Field | Value |
|---|---|
| `strength` | `explicit`: the sender is on the gate's allow-list; `open`: the platform has no allow-list; `agent`: no person's message started it |
| `scope` | the Router's `scope` sentence, or the title |
| `sender` | platform and sender id |
| `policyVersion` | a hash of the platform's gate at that time |

Before `ticket_assign` resumes or follows up a ticket, and before `t3_run`, the host checks the
mandate against the gate now: when the gate is off or the sender left the allow-list, the work is
refused and the ticket's log says why. Agent mandates and tickets made before item 3.4 hold.

## Watchdog (item 4.1)

The agent with the role `watchdog` wakes on a schedule (`src/backend/fork/tickets/watchdog.ts`). The
host checks every 5 minutes; when the interval has passed, a ticket is live, and no earlier wake waits
in the Watchdog's queue, it queues one message with the tickets that look stuck:

| Flag | When |
|---|---|
| `blocked` | the ticket is blocked |
| `no_progress` | `working` and unchanged for `staleMinutes` |
| `waits_long` | `awaiting_human` for `staleMinutes` |
| `review_waits` | `review` for `staleMinutes` |

```yaml
watchdog:
  everyMinutes: 30    # 5 to 1440; default 30
  staleMinutes: 60    # 10 to 10080; default 60
```

With no live ticket nothing is sent, so a quiet team costs no tokens. The Watchdog runs `t3_sweep`,
reads tickets, resumes a stuck ticket with its own worker (`ticket_assign` to the same agent),
logs findings with `ticket_note`, and tells the Router only what needs its decision. It cannot give a
ticket to another worker or close one.

## Browser session per ticket (item 4.3)

- A tab that a worker opens from the side thread of a live ticket opens in that ticket's own
  browser session: two tickets share no cookies, sign-ins or storage, also on one worker.
- A named browser profile that the owner set for the agent comes first; its tabs stay in it.
- The session folder is `Partitions/openbot-browser-agent-<hash of the ticket id>`. It is an
  agent-kind session, so saved tabs come back in it after a restart and no new state field exists.
- When the ticket ends (done, failed, cancelled), the host closes its tabs and deletes the session's
  cookies, storage and cache within 5 minutes (the Watchdog tick). A failed delete is tried again.
