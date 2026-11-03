// @vitest-environment node

// Fork: the Claude Code profiles that main lists for an account. Only a path, a name and a flag cross.
import { describe, expect, it } from "vitest";
import { decodeProviderProfileFolders } from "./agent-decoding";

describe("provider profile decoding", () => {
  it("keeps the path, the name and whether an account uses the profile", () => {
    expect(
      decodeProviderProfileFolders([
        { path: "/Users/x/Profiles/Kantor", name: "Kantor", added: false, token: "secret" },
      ]),
    ).toEqual([{ path: "/Users/x/Profiles/Kantor", name: "Kantor", added: false }]);
  });

  it.each([
    ["a value that is not a list", { path: "/x", name: "x", added: false }],
    ["a profile without a name", [{ path: "/x", added: false }]],
    ["a flag that is not a boolean", [{ path: "/x", name: "x", added: "yes" }]],
  ])("rejects %s", (_name, value) => {
    expect(() => decodeProviderProfileFolders(value)).toThrow("Invalid provider profile list.");
  });
});
