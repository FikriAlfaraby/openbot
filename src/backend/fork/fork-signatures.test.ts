import { describe, expect, it } from "vitest";
import { ForkSignatures } from "./fork-signatures";

describe("ForkSignatures", () => {
  it("sees no change at first sight or for the same signature, and a change after", () => {
    const signatures = new ForkSignatures();
    expect(signatures.changed("coder", "a")).toBe(false);
    expect(signatures.changed("coder", "a")).toBe(false);
    expect(signatures.changed("coder", "b")).toBe(true);
    expect(signatures.changed("coder", "b")).toBe(false);
    expect(signatures.changed("router", "b")).toBe(false);
  });

  it("starts again after forget", () => {
    const signatures = new ForkSignatures();
    signatures.changed("coder", "a");
    signatures.forget("coder");
    expect(signatures.changed("coder", "b")).toBe(false);
  });
});
