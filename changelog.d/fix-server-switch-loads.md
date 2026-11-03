### Fixed

- Open a remote server faster. A server switch read the conversation, the queue, routines, waits and tasks
  again on each status update, several times in a few seconds, and the answers queued behind each other.
  Now each is read again only when the agent, its status or the connection changes.
- Show the conversation of a remote server first. The agents, their status and the open conversation now
  go before the background reads, which run a few at a time, and two identical reads share one answer.
