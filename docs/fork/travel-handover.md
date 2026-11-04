# Travel handover

A self-hosted server (for the owner: fikri-cloud) keeps a copy of the Mac's chats, so the owner can
read them from the phone while the laptop is closed, and continue one there. One agent works in one
place at a time, so a chat never splits in two.

Decided with the owner on 2026-11-04:

- The server is a slim second home, not a mirror of the Mac's disk. Workspace files are not copied;
  agents on the server get code from git.
- The official phone app is not changed. To continue a chat from the phone, the owner replies in the
  copy on the server. To bring it back, the owner presses "Bring back" on the Mac.

## Turn it on

On the computer, in `~/OpenBot/fork-config.yaml`:

```yaml
version: 1
handover:
  server: fikri-cloud   # the joined server, by its name in the server list or its id
  agents: [a1b2c3]      # optional: the agents to copy; omit for every agent
  everyMinutes: 3       # optional: 1 to 120, 3 by default
```

- Both sides need this fork build, and the computer must be an owner or admin of the server.
- The first round makes a copy of each agent on the server: the profile, memories, skills and
  routines. Files and server settings do not go, and the copy's routines are turned off.
- Then a round runs every few minutes, and a few seconds after each finished turn.
- The server must be signed in to the provider of each copied agent.

## Flow

```
Mac (owner = mac)            server copy (mirror)
  chat grows   ──push──►      same messages, read on the phone
                              owner replies on the phone
                              ──► owner = cloud (takeover), the copy answers with the chat's context
  Mac sees owner = cloud
  ──► the Mac thread is locked: "Continued on fikri-cloud" + Bring back
  Bring back ◄──pull──        messages written on the server
  owner = mac, the copy is a mirror again
```

## Pieces

- **Storage.** `fork-handover.db` beside `openbot.db` on each side, with its own
  `PRAGMA user_version`, like `fork-tickets.db`.
  - On the Mac it stores: server, local agent → remote agent, local thread → remote thread, push
    cursor, owner.
  - On the server it stores: source server, source agent → agent, source thread → thread, owner,
    takeover sequence.
- **Route.** One Team API capability, `fork-travel-handover-v1`, for admins only.
  - It has five calls: `mirror-agent`, `push`, `status`, `pull` and `release`.
  - The server owns the owner state of its copy. While the owner is `cloud`, it refuses `push`.
- **Agent copy.** It is made once with instance transfer: profile, memories, skills and routines,
  without files. The copy's routines are turned off, so that the Mac's routines do not also run on
  the server.
- **Messages.** They are written through the conversation's own transaction, so the snapshot cache
  stays right and connected clients (the phone) see the new messages.
  - They keep the same message ids on both sides.
  - Attachments become a "[file: name]" line.
  - A message that is still streaming waits for the next push.
- **Context on the server.** A copied thread has no provider session. The DB handoff, which only ran
  for branches, now also runs for a mirror thread. So the first reply on the phone sees the chat.
- **Takeover and lock.** There is one hook before a user message is queued.
  - On the server, a message in a mirror thread makes the server the owner.
  - On the Mac, a message in a locked thread is refused, and the composer shows the lock notice.
- **Bring back.**
  1. The Mac pulls the messages written on the server after the takeover.
  2. It writes them into the local thread.
  3. Both sides drop the thread's provider sessions, so the next turn starts from the DB history.
  4. The server copy is a mirror again.

  Bring back is refused while a turn runs on the server.

## Not in the first version

- Only the agent's own chat is copied. Tasks (side threads) stay on the computer.
- On the computer, the lock refuses messages from the app. A Telegram or routine message that reaches
  the computer's agent during a takeover is still written there.
- Deleting a message on the computer does not delete it in the copy.
- A profile change after the first copy is not sent again.
- Folder sync for files outside git.
