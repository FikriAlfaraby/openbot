// Fork: travel handover (docs/fork/travel-handover.md). The agents of this computer whose chat a person
// continued on a server. One list for the window, read once and then kept by main's change event.

import type { ForkHandoverAgentState } from "@openbot/contracts/ipc";
import { createRoot, createSignal } from "solid-js";

let states: (() => readonly ForkHandoverAgentState[]) | null = null;

function handoverStates(): readonly ForkHandoverAgentState[] {
  states ??= createRoot(() => {
    const [value, setValue] = createSignal<readonly ForkHandoverAgentState[]>([]);
    // A test or a story can give a desktop API without this fork group.
    const api = window.openbot?.forkHandover;
    if (!api) return value;
    api.onChanged((next) => setValue(next));
    // An answer that fails leaves no chat locked here; the server still refuses a push to the copy.
    void api.states().then(
      (next) => setValue(next),
      () => setValue([]),
    );
    return value;
  });
  return states();
}

/** The lock of the agent's own chat, or null while this computer owns it. */
export function handoverLockOf(agentId: string): ForkHandoverAgentState | null {
  return handoverStates().find((state) => state.agentId === agentId && state.owner === "copy") ?? null;
}
