import { describe, expect, it } from "vitest";
import { parseForkConfig } from "./fork-config";
import { limitWords } from "./reply-rules";

const words = (count: number, word = "kata") => Array.from({ length: count }, () => word).join(" ");

describe("limitWords", () => {
  it("keeps a short answer as it is", () => {
    expect(limitWords("Siap, Coder yang mengerjakan.", 100)).toEqual({
      text: "Siap, Coder yang mengerjakan.",
      cut: false,
    });
    expect(limitWords(words(100), 100).cut).toBe(false);
  });

  it("cuts a long answer at the end of the last sentence that fits", () => {
    const text = `${words(60)}. ${words(30)}. ${words(40)}.`;
    const result = limitWords(text, 100);
    expect(result.cut).toBe(true);
    expect(result.text.startsWith(`${words(60)}. ${words(30)}.`)).toBe(true);
    expect(result.text).toContain("The full answer is in the OpenBot app.");
    expect(result.text.split(/\s+/u).filter((word) => word.startsWith("kata"))).toHaveLength(90);
  });

  it("cuts at a word when no sentence end keeps half of the limit", () => {
    const text = `${words(10)}. ${words(200)}`;
    const result = limitWords(text, 100);
    expect(result.text.split(/\s+/u).filter((word) => word.startsWith("kata"))).toHaveLength(100);
  });

  it("counts words, not characters, in any language", () => {
    expect(limitWords("一二三 四五六 七八九", 2).text.startsWith("一二三 四五六")).toBe(true);
  });
});

describe("fork-config chat.maxWords", () => {
  it("reads the limit and refuses one out of range", () => {
    const parsed = parseForkConfig("version: 1\nchat:\n  maxWords: 60\n");
    expect(parsed.ok && parsed.config.chatMaxWords).toBe(60);
    expect(parseForkConfig("version: 1\nchat:\n  maxWords: 5\n").ok).toBe(false);
    expect(parseForkConfig("version: 1\n").ok && parseForkConfig("version: 1\n")).toMatchObject({
      config: { chatMaxWords: null },
    });
  });
});
