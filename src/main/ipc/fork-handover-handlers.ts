// Fork: travel handover on this computer (docs/fork/travel-handover.md). A server has nothing to show
// here: it keeps copies, and it sends none.

import type { ForkHandoverAgentState } from "@openbot/contracts/ipc";
import type { HandoverSync } from "../fork/handover/handover-sync";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { requireString } from "./validation";

export interface ForkHandoverIpcDependencies {
  handoverSync: HandoverSync | null;
}

/** The states as the renderer reads them. */
export function forkHandoverStates(handoverSync: HandoverSync | null): ForkHandoverAgentState[] {
  return (handoverSync?.states() ?? []).map(({ agentId, serverName, owner }) => ({ agentId, serverName, owner }));
}

export function forkHandoverIpcHandlers({
  handoverSync,
}: ForkHandoverIpcDependencies): Pick<IpcGroupHandlers, "forkHandover"> {
  return {
    forkHandover: {
      states: handler(() => forkHandoverStates(handoverSync)),
      bringBack: payloadHandler(
        (value) => requireString(value, "agentId"),
        async (agentId) => {
          await handoverSync?.bringBack(agentId);
        },
      ),
    },
  };
}
