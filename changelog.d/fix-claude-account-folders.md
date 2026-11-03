### Fixed

- Keep OpenBot's own Claude sign-in in its own folder when a Claude Code session opened the app. Before,
  agents ran in that session's profile and could be signed out.
- Continue a Claude chat that another account folder saved. Before, each message failed with a
  conversation that was not found, and the agent then started again with no context.
