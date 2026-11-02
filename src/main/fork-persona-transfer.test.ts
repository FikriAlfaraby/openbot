import { describe, expect, it } from "vitest";
import { isWorkspaceSkipped } from "./instance-transfer-service";

// Fork (roadmap item P.5): an instance transfer carries an agent's persona and its version history,
// because both are workspace files outside OpenBot's own folders.
describe("instance transfer and the persona", () => {
  it("carries persona.yaml and .openbot-persona, and still skips .openbot", () => {
    expect(isWorkspaceSkipped("persona.yaml")).toBe(false);
    expect(isWorkspaceSkipped(".openbot-persona")).toBe(false);
    expect(isWorkspaceSkipped(".openbot-persona/versions/000001-abcdef012345.yaml")).toBe(false);
    expect(isWorkspaceSkipped(".openbot")).toBe(true);
    expect(isWorkspaceSkipped(".OpenBot/state.json")).toBe(true);
  });
});
