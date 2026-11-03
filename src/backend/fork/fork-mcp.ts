// Fork module (super-agent, items 2.3 and 3.1d). Claude, ACP, Pi and Muse read the MCP servers
// themselves, not from the list that ThreadLifecycle builds. So when the fork changes an agent's
// servers (the Router gets none; `fork-config.yaml` limits a server to some agents), ThreadLifecycle
// sends the allowed names as the thread param `forkMcpServers`, and each client keeps only those.

import { isDynamicRecord } from "@openbot/contracts/runtime-values";

const FORK_MCP_PARAM = "forkMcpServers";

/** The allowed server names of a thread's params, or null when the fork changes nothing. */
export function forkMcpNames(params: unknown): string[] | null {
  if (!isDynamicRecord(params)) return null;
  const names = params[FORK_MCP_PARAM];
  return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : null;
}

/** The servers that the fork allows; all of them when `names` is null. */
export function withForkMcp<T extends { name: string }>(
  servers: readonly T[],
  names: readonly string[] | null,
): readonly T[] {
  if (names === null) return servers;
  const allowed = new Set(names);
  return servers.filter((server) => allowed.has(server.name));
}
