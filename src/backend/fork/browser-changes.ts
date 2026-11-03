// Fork: what an input action changed on the page, as mac-cua reports it. The agent gets the elements that
// came, went or changed and the new lines of text, with refs it can use, instead of a status that needs a
// second snapshot call. A node keeps its ref across snapshots of one document (`<revision>:<frame>:<node>`),
// so an element is matched by frame and node, and the agent's older refs keep working.
import type { BrowserElement, BrowserSnapshot } from "@openbot/contracts/ipc";

/** Lines of each kind in one result. More is a page that changed as a whole: take a snapshot. */
const CHANGE_LINE_LIMIT = 40;
const TEXT_LINE_LIMIT = 20;
const TEXT_LINE_CHARS = 200;

export interface BrowserPageChanges {
  added: string[];
  changed: string[];
  /** The refs of elements that left the page. */
  removed: string[];
  /** New lines of page text. */
  text: string[];
  /** True when a list was cut at its limit, or the page is another document. Take a snapshot then. */
  truncated: boolean;
}

function nodeKey(ref: string): string {
  const separator = ref.indexOf(":");
  return separator < 0 ? ref : ref.slice(separator + 1);
}

/** One element as the snapshot lists it: ref, role, "name", then <tag>, value= and states when present. */
function browserElementLine(element: BrowserElement): string {
  const parts = [element.ref, element.role ?? "generic", JSON.stringify(element.name), `<${element.tag}>`];
  if (element.value !== null && element.value !== "") parts.push(`value=${JSON.stringify(element.value)}`);
  if (element.description) parts.push(`description=${JSON.stringify(element.description)}`);
  if (element.states.length > 0) parts.push(element.states.join(" "));
  return parts.join(" ");
}

/** The content of a line without its ref, so a new revision of an unchanged element compares equal. */
function elementContent(element: BrowserElement): string {
  return browserElementLine({ ...element, ref: "" });
}

function textLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function limited<T>(values: T[], limit: number): { values: T[]; cut: boolean } {
  return values.length > limit ? { values: values.slice(0, limit), cut: true } : { values, cut: false };
}

/** The changes from `before` to `after`. A different document is reported as truncated, with its elements. */
export function browserPageChanges(before: BrowserSnapshot, after: BrowserSnapshot): BrowserPageChanges {
  const sameDocument = before.url === after.url;
  const previous = new Map(before.elements.map((element) => [nodeKey(element.ref), element]));
  const added: string[] = [];
  const changed: string[] = [];
  const seen = new Set<string>();
  for (const element of after.elements) {
    const key = nodeKey(element.ref);
    seen.add(key);
    const old = sameDocument ? previous.get(key) : undefined;
    if (!old) added.push(browserElementLine(element));
    else if (elementContent(old) !== elementContent(element)) changed.push(browserElementLine(element));
  }
  const removed = sameDocument
    ? before.elements.filter((element) => !seen.has(nodeKey(element.ref))).map((element) => element.ref)
    : [];
  const oldText = new Set(textLines(before.text));
  const text = textLines(after.text)
    .filter((line) => !oldText.has(line))
    .map((line) => (line.length > TEXT_LINE_CHARS ? `${line.slice(0, TEXT_LINE_CHARS)}…` : line));
  const parts = [
    limited(added, CHANGE_LINE_LIMIT),
    limited(changed, CHANGE_LINE_LIMIT),
    limited(removed, CHANGE_LINE_LIMIT),
    limited(text, TEXT_LINE_LIMIT),
  ] as const;
  return {
    added: parts[0].values,
    changed: parts[1].values,
    removed: parts[2].values,
    text: parts[3].values,
    truncated: !sameDocument || after.truncated || parts.some((part) => part.cut),
  };
}
