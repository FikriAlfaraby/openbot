### Fixed

- Open a remote server faster. A server switch read the conversation, the queue, routines, waits and tasks
  again on each status update, several times in a few seconds, and the answers queued behind each other.
  Now each is read again only when the agent, its status or the connection changes.
