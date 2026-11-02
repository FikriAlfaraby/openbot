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
