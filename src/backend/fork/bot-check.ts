// Fork: a page that only checks whether the visitor is a person, such as Cloudflare's "Just a moment...".
// Measured on 2026-11-03 from the fikri-cloud server: AP News held the agent's browser on that page for
// four minutes, while the agent thought for about six seconds per step. OpenBot does not try to pass the
// check. It tells the agent at once, so the agent uses another source or hands the tab to the person.

const BOT_CHECK_TITLES = [
  /^just a moment\.{0,3}$/iu,
  /^attention required!? \| cloudflare$/iu,
  /^checking (?:your|if the site connection is secure)/iu,
  /^verifying (?:you are human|your browser)/iu,
  /^one more step$/iu,
  /^ddos-guard$/iu,
];
const BOT_CHECK_PATHS = ["/cdn-cgi/challenge-platform/", "challenges.cloudflare.com"];

export const BOT_CHECK_MESSAGE =
  'This site showed OpenBot\'s browser a check for people, such as "Just a moment...". Do not wait for it, reload it or try to pass it: it can hold the tab for minutes. Get the same information from another source, or call request_takeover so the person can complete the check in this tab.';

/** True for a page whose title or address is a check for people. */
export function isBotCheckPage(title: string, url: string): boolean {
  const trimmed = title.trim();
  return (
    BOT_CHECK_TITLES.some((pattern) => pattern.test(trimmed)) || BOT_CHECK_PATHS.some((part) => url.includes(part))
  );
}
