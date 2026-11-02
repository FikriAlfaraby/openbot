### Changed

- Build the Linux server release in the fork, and point the installer, the server update timer,
  the app update feed and the Server settings update check at the fork's releases.
- Hold an agent's queue when it spends its daily token or dollar budget from `fork-config.yaml`,
  and refuse an OpenBot tool call that keeps failing with the same input.
- Open a ticket worker's browser tabs in a session of that ticket, and delete it when the ticket ends.
- Start one Router turn for a person's chat messages that queued together, with one answer.
- Move old ended tickets to a monthly archive file, and add a daily server backup with the keyring
  that refuses an unencrypted upload to a bucket.
- Send the full text of a cut Router chat answer as `full-answer.md` in the same conversation.
- Answer `/tiket` in the Router's chat with the conversation's tickets, without a Router turn.
- Add `bun scripts/fork-doctor.ts`, a read-only check of the fork setup with a fix for each issue.
- Add `openbot doctor` on a self-hosted server, which runs the fork setup check inside OpenBot.
