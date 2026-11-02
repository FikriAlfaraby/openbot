# Agent templates for the super agent team

| Agent | Persona | Model | Access | Browser |
|---|---|---|---|---|
| Router | `router.persona.yaml` | light Claude (Haiku or Sonnet) | Workspace only | none needed |
| Coder | `coder.persona.yaml` | strongest Claude | Workspace only, T3 Code on the VPS | own session |
| Researcher | `researcher.persona.yaml` | Sonnet | Workspace only | own session |

Setup, until phase 2 adds this to the app:

1. Create the three agents in OpenBot and choose the model of each.
2. Copy each file to `<OpenBot>/Agents/<agent id>/persona.yaml`.
3. Put the three agents in one sidebar section, so that the Router sees them as teammates.
4. Connect Telegram in Server settings and give the Telegram chat to the Router only.
5. Optional: write the rules for every agent in `<OpenBot>/global-instructions.md`.

The Router persona follows the "delegation-first" baseline of the DeepSeek Super-agent article
(section 7.1): a prompt alone gives most of the median speed-up. Phase 2 adds what a prompt cannot
hold: the host keeps the Router from doing the work, and tickets track each task.
