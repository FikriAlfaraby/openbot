// Fork module (super-agent, roadmap item 2.7). The host's reply rule for the Router in chat
// channels (DeepSeek Super-agent article, section 4.2): a chat reply is short, at most 100 words by
// default. The prompt asks for it; the host holds it, because a model sometimes writes a report.
//
// A longer answer is cut at the end of the last sentence that fits, and the post says that the full
// answer is in the OpenBot app, where the Router's conversation keeps it. Code blocks count as
// words like any text.

export const DEFAULT_CHAT_MAX_WORDS = 100;
export const CHAT_MAX_WORDS_RANGE = { min: 20, max: 1_000 } as const;

const MORE_NOTE = "… (The full answer is in the OpenBot app.)";

/** The answer within `maxWords` words, and whether it was cut. */
export function limitWords(text: string, maxWords: number): { text: string; cut: boolean } {
  const words = [...text.matchAll(/\S+/gu)];
  if (words.length <= maxWords) return { text, cut: false };
  // The end of the last word that fits.
  const last = words[maxWords - 1];
  const limit = last ? (last.index ?? 0) + last[0].length : 0;
  const head = text.slice(0, limit);
  // Cut at the end of the last sentence or line in the part that fits, when it keeps at least half.
  let cut = -1;
  for (const match of head.matchAll(/[.!?…。](?=\s|$)|\n/gu)) cut = (match.index ?? 0) + match[0].length;
  const kept = cut >= limit / 2 ? head.slice(0, cut) : head;
  return { text: `${kept.trimEnd()}\n\n${MORE_NOTE}`, cut: true };
}
