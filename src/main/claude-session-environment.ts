/**
 * Variables that a Claude Code session sets for the commands it runs. When an agent starts OpenBot
 * with `open -a OpenBot` from such a command, the app gets them, and every agent and tool inherits
 * them from this process. A Claude agent then runs as a child of that other session: the SDK keeps
 * an inherited `CLAUDE_CODE_ENTRYPOINT`, so each new session writes its prompt cache again (#3415).
 * User settings such as `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CONFIG_DIR` or
 * `CLAUDE_CODE_SESSION_LOG` stay.
 */
const CLAUDE_CODE_SESSION_VARIABLES = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_CHROME_MCP_ORG_DENIED",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EVAL_INTERVIEW_SESSION",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_KIND",
  "CLAUDE_CODE_SESSION_NAME",
  "CLAUDE_CODE_SESSION_ORIGIN",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
]);
/** The desktop host and background sessions of Claude Code set these for the session they start. */
const CLAUDE_CODE_SESSION_PREFIXES = ["CLAUDE_CODE_HOST_", "CLAUDE_BG_"];
/** Provider sign-in that a host gives to Claude. The CLI keeps these for a new session too. */
const CLAUDE_CODE_HOST_AUTH_VARIABLES = new Set([
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  "CLAUDE_CODE_HOST_AUTH_REFRESH_TIMEOUT_MS",
  "CLAUDE_CODE_HOST_CREDS_FILE",
]);

/**
 * Fork: the Claude desktop app sets these for the sessions it hosts. With them, OpenBot's own Claude
 * sign-in ran in the Claude Code profile of that session (`CLAUDE_CONFIG_DIR`), its chats went to that
 * profile's folder and were "not found" after a clean start, and the CLI left the token refresh to a
 * host that is not there (`CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH`). Measured on 2026-11-04.
 */
const CLAUDE_DESKTOP_SESSION_VARIABLES = new Set([
  "CLAUDE_AGENT_SDK_MCP_NO_PREFIX",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_ACCOUNT_UUID",
  "CLAUDE_CODE_DESKTOP_APP_VERSION",
  "CLAUDE_CODE_DISABLE_CRON",
  "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
  "CLAUDE_CODE_EAGER_FLUSH",
  "CLAUDE_CODE_EMIT_STARTUP_TIMING",
  "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES",
  "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL",
  "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_ORGANIZATION_UUID",
  "CLAUDE_CODE_REPORT_FINDINGS",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_STARTUP_FAILURE_RESULTS",
  "CLAUDE_CODE_TERMINAL_MCP_TOOLS",
  "CLAUDE_CODE_USER_EMAIL",
  "CLAUDE_PREVIEW_CLASSIFIER_FLOOR",
]);

/** Removes the variables of a Claude Code session that started this process. */
export function removeClaudeCodeSessionEnvironment(environment: NodeJS.ProcessEnv): void {
  // Fork: only a Claude Code session sets these two. Then its profile folder is that session's, not
  // a choice of the user, and OpenBot keeps its own sign-in folder.
  const startedBySession = environment.CLAUDECODE === "1" || environment.CLAUDE_CODE_ENTRYPOINT !== undefined;
  for (const name of Object.keys(environment)) {
    if (CLAUDE_CODE_HOST_AUTH_VARIABLES.has(name)) continue;
    if (
      CLAUDE_CODE_SESSION_VARIABLES.has(name) ||
      CLAUDE_CODE_SESSION_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
      (name === "AI_AGENT" && environment.AI_AGENT?.startsWith("claude-code")) ||
      (startedBySession && (CLAUDE_DESKTOP_SESSION_VARIABLES.has(name) || name === "CLAUDE_CONFIG_DIR"))
    ) {
      delete environment[name];
    }
  }
}
