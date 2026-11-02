// Fork module (super-agent, roadmap item P.4). Tells ThreadLifecycle when an agent's fork inputs (persona,
// global instructions, role, allowed MCP servers) changed since its last turn, so that it loads the
// agent's sessions again and the next turn has the new instructions. The first sight of an agent
// is no change: its session was just started or resumed with the current inputs.

export class ForkSignatures {
  readonly #known = new Map<string, string>();

  /** Records the signature and says whether it differs from the one seen before. */
  changed(agentId: string, signature: string): boolean {
    const known = this.#known.get(agentId);
    this.#known.set(agentId, signature);
    return known !== undefined && known !== signature;
  }

  forget(agentId: string): void {
    this.#known.delete(agentId);
  }
}
