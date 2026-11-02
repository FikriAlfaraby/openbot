### Changed

- Build the Linux server release in the fork, and point the installer, the server update timer,
  the app update feed and the Server settings update check at the fork's releases.
- Hold an agent's queue when it spends its daily token or dollar budget from `fork-config.yaml`,
  and refuse an OpenBot tool call that keeps failing with the same input.
