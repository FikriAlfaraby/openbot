import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { routingSummaryOf } from "./persona-summary";

let workspace: string;
let tick = 1_960_000_000;
const write = (text: string) => {
  const path = join(workspace, "persona.yaml");
  writeFileSync(path, text);
  tick += 10;
  utimesSync(path, tick, tick);
};

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "openbot-persona-summary-"));
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

describe("routingSummaryOf", () => {
  it("gives null without a persona, without the field, or for an invalid file", () => {
    expect(routingSummaryOf(workspace)).toBeNull();
    write("role: Coder\n");
    expect(routingSummaryOf(workspace)).toBeNull();
    write("routing_summary: [\n");
    expect(routingSummaryOf(workspace)).toBeNull();
  });

  it("reads the summary and follows a change of the file", () => {
    write("routing_summary: Coding through T3 Code.\n");
    expect(routingSummaryOf(workspace)).toBe("Coding through T3 Code.");
    write("routing_summary: Research with sources.\n");
    expect(routingSummaryOf(workspace)).toBe("Research with sources.");
  });
});
