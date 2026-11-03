### Changed

- Stop agents from waiting on a site's check for people, such as Cloudflare's "Just a moment...". The
  browser tells the agent at once, and the agent uses another source or asks you to take over the tab.
  Before, a site such as AP News could hold the agent's browser for minutes.
