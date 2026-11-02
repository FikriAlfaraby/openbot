import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { limitWords, SPILL_NOTE } from "./reply-rules";
import { pruneSpills, SPILL_DIR, writeSpill } from "./spill";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openbot-spill-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("writeSpill", () => {
  it("keeps the full answer in a private file named for the chat", () => {
    const text = "word ".repeat(300).trim();
    const file = writeSpill(root, "orchestrator", text);
    expect(file.name).toBe("full-answer.md");
    expect(file.mimeType).toBe("text/markdown");
    expect(file.path.startsWith(join(root, SPILL_DIR, "orchestrator"))).toBe(true);
    expect(readFileSync(file.path, "utf8")).toBe(`${text}\n`);
    expect(statSync(file.path).mode & 0o777).toBe(0o600);
    expect(writeSpill(root, "orchestrator", text).path).not.toBe(file.path);
  });

  it("refuses an agent id that is not a folder name", () => {
    expect(() => writeSpill(root, "../etc", "x")).toThrow();
  });
});

describe("pruneSpills", () => {
  it("deletes files older than the days kept", () => {
    const old = writeSpill(root, "orchestrator", "old");
    writeSpill(root, "orchestrator", "new");
    const tenDaysAgo = (Date.now() - 10 * 86_400_000) / 1_000;
    utimesSync(old.path, tenDaysAgo, tenDaysAgo);
    expect(pruneSpills(root, 7)).toBe(1);
    expect(readdirSync(join(root, SPILL_DIR, "orchestrator"))).toHaveLength(1);
    expect(pruneSpills(join(root, "missing"))).toBe(0);
  });
});

describe("the spill note", () => {
  it("points to the attached file in place of the app", () => {
    const cut = limitWords("Satu. ".repeat(150), 100, SPILL_NOTE);
    expect(cut.cut).toBe(true);
    expect(cut.text.endsWith(SPILL_NOTE)).toBe(true);
    expect(limitWords("Satu. ".repeat(150), 100).text).toContain("OpenBot app");
  });
});
