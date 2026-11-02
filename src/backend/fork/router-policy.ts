// Fork module (super-agent, roadmap item 2.3). What the host lets an agent with the role `router`
// do. The Router talks with people and routes work; it never does the work itself (DeepSeek
// Super-agent article, section 2). A prompt alone cannot hold this: a model sometimes judges a task
// "small" and does it. So the host refuses the tools of work, and the provider gets no shell, file
// or web tools.

import { dirname } from "node:path";
import { ForkConfigReader, type ForkRole, type ForkT3Settings } from "./fork-config";
import type { PlatformGate } from "./gate";
import { DEFAULT_CHAT_MAX_WORDS } from "./reply-rules";

/** The OpenBot tools that a Router may call, by `namespace.tool`. Everything else is refused. */
export const ROUTER_OPENBOT_TOOLS: ReadonlySet<string> = new Set([
  // Discovery: the bridge tools themselves. `tool_call` is checked again for the tool it calls.
  "openbot.tool_search",
  "openbot.tool_describe",
  "openbot.tool_call",
  // Talk with people.
  "openbot.ask_user",
  "openbot.ask_ui",
  "openbot.react_to_user_message",
  "openbot.attach_files_to_response",
  // Route and follow work.
  "openbot.list_agents",
  "openbot.read_agent",
  "openbot.list_sections",
  "openbot.list_models",
  "openbot.send_message",
  "openbot.interrupt_agent",
  "openbot.await_event",
  // Global memory (article: the Router keeps global memory in sync).
  "openbot.search_memories",
  "openbot.remember",
  "openbot.forget_memory",
  "openbot.history_search",
  "openbot.history_read",
  // Routine reports, so that a routine run of the Router can end.
  "openbot.routine_no_update",
  "openbot.routine_report_failure",
]);

/** Tool name prefixes that a Router may call: the ticket tools of item 2.5. */
const ROUTER_TOOL_PREFIXES = ["openbot.ticket_"];

/**
 * Claude Code tools that a Router does not get. A deny rule takes them out of the model's context.
 * `AskUserQuestion` is already refused for every agent (OpenBot's `ask_user` replaces it).
 */
export const ROUTER_CLAUDE_DISALLOWED_TOOLS = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "Skill",
];

/** Codex settings that turn off its shell, patch and web tools for a Router (as profile generation does). */
export const ROUTER_CODEX_CONFIG = {
  web_search: "disabled",
  "features.shell_tool": false,
  "features.unified_exec": false,
  "features.apply_patch_freeform": false,
  "features.js_repl": false,
  "features.code_mode": false,
  "features.multi_agent": false,
  "features.web_search": false,
  "features.standalone_web_search": false,
  "features.browser_use": false,
  "features.computer_use": false,
  "features.view_image": false,
} as const;

/** The host rule in the Router's developer instructions. The persona sets the voice; this sets the limits. */
export const ROUTER_ROLE_RULE =
  "The owner made you the Router of this OpenBot server. You are the only agent that talks with people. You route work and do not do it: you have no shell, file, web, browser or MCP tools, and OpenBot refuses work tools. For each request, choose the teammate that fits, send the work with openbot.send_message (or a ticket tool), confirm to the person once in one short line, and then stay quiet until a result or a decision that the person must make. Give results in plain words, in the person's language.";

/** Whether a Router may call `namespace.tool`. */
export function routerMayUse(namespace: string, tool: string): boolean {
  const name = `${namespace}.${tool}`;
  return ROUTER_OPENBOT_TOOLS.has(name) || ROUTER_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** The text a refused call returns to the model. It says what to do instead. */
export function routerRefusal(namespace: string, tool: string): string {
  return `You are the Router: you talk with people and route work, and you do not do the work yourself. ${namespace}.${tool} is not available to you. Send the work to the teammate that fits with openbot.send_message (or a ticket tool), and tell the person in one short line who works on it.`;
}

/** Drops the tools that a Router may not call from a `tool_search` or `tool_describe` result. */
export function filterDiscoveryForRouter<T extends { tools: readonly { name: string }[] }>(result: T): T {
  return {
    ...result,
    tools: result.tools.filter((entry) => {
      const dot = entry.name.indexOf(".");
      return dot > 0 && routerMayUse(entry.name.slice(0, dot), entry.name.slice(dot + 1));
    }),
  };
}

const readers = new Map<string, ForkConfigReader>();

/** One reader per OpenBot folder (the parent of the shared directory), so a change is read once. */
function readerFor(sharedRoot: string): ForkConfigReader {
  const root = dirname(sharedRoot);
  let reader = readers.get(root);
  if (!reader) {
    reader = new ForkConfigReader(root);
    readers.set(root, reader);
  }
  return reader;
}

/** The role of an agent from `fork-config.yaml` in the OpenBot folder. */
export function forkRoleOf(sharedRoot: string, agentId: string): ForkRole | null {
  return readerFor(sharedRoot).roleOf(agentId);
}

/**
 * The MCP servers that an agent gets: a server that `fork-config.yaml` limits goes only to the
 * agents it names (item 3.1d), such as T3 Code's MCP server to the Coder. Others go to every agent.
 */
export function forkMcpServersFor<T extends { name: string }>(
  sharedRoot: string,
  agentId: string,
  servers: readonly T[],
): readonly T[] {
  const limits = readerFor(sharedRoot).current().config.mcpAgents;
  if (limits.size === 0) return servers;
  return servers.filter((server) => limits.get(server.name)?.has(agentId) ?? true);
}

/** The gate of a chat platform from `fork-config.yaml`, or null for upstream's behavior (item 3.3). */
export function forkGateOf(sharedRoot: string, platform: string): PlatformGate | null {
  return readerFor(sharedRoot).current().config.gates.get(platform) ?? null;
}

/** The T3 Code settings of `fork-config.yaml`, or null (item 3.1b). */
export function forkT3Settings(sharedRoot: string): ForkT3Settings | null {
  return readerFor(sharedRoot).current().config.t3;
}

/** The most words of a Router reply in a chat channel (item 2.7). */
export function forkChatMaxWords(sharedRoot: string): number {
  return readerFor(sharedRoot).current().config.chatMaxWords ?? DEFAULT_CHAT_MAX_WORDS;
}
