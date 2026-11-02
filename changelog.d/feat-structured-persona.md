### Added

- Give each agent a structured persona in `persona.yaml` at its workspace root: role, goals, tone,
  boundaries, examples, a routing summary, and overrides for the style, remit and group-chat rules.
  Each text that a session reads becomes a version, and `bun scripts/persona.ts rollback` restores
  an earlier one.
- Give every agent of a server the text of `global-instructions.md` in the OpenBot folder.
