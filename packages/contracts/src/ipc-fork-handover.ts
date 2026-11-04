// Fork: travel handover on this computer (docs/fork/travel-handover.md). The renderer reads which of
// this computer's agents a server keeps a copy of, and brings a chat back that a person continued there.
import { isDynamicRecord, isString } from "./runtime-values";

/** One agent whose copy a server keeps. `copy`: a person continued the chat on the server. */
export interface ForkHandoverAgentState {
  agentId: string;
  serverName: string;
  owner: "source" | "copy";
}

export function decodeForkHandoverStatesFromMain(value: unknown): ForkHandoverAgentState[] {
  if (!Array.isArray(value)) throw new Error("Invalid travel handover states.");
  return value.map((entry) => {
    if (
      !isDynamicRecord(entry) ||
      !isString(entry.agentId) ||
      !isString(entry.serverName) ||
      (entry.owner !== "source" && entry.owner !== "copy")
    )
      throw new Error("Invalid travel handover state.");
    return { agentId: entry.agentId, serverName: entry.serverName, owner: entry.owner };
  });
}
