// Fork: Claude Code keeps each chat in the folder of the account that wrote it
// (`<config dir>/projects/<cwd>/<session>.jsonl`). An agent whose chat was written under another
// folder (an account change, or OpenBot's own sign-in that ran in the Claude Code profile of the
// session that started it) failed each turn with "No conversation found" and then lost its context.
// Measured on 2026-11-04: ten agents had their chat only in the "Pribadi" profile. Before a resume, a
// chat that is not in the account's folder is copied in from another known folder. The original stays.
import { cp, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";

const logger = createOpenBotLogger("claude-session-recovery");

/** The Claude Code profiles of this Mac, as `claude-profiles.ts` lists them. */
const CLAUDE_PROFILES_ROOT = join(homedir(), "Library", "Application Support", "Claude-Code-Profiles");

function projectName(cwd: string): string {
  return resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function folders(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

/** The folders that can hold a chat of this Mac: Claude's own, the profiles, and the target's siblings. */
async function candidateRoots(target: string): Promise<string[]> {
  const roots = [join(homedir(), ".claude"), ...(await folders(CLAUDE_PROFILES_ROOT))];
  // OpenBot's own accounts are folders side by side in `provider-accounts`.
  if (basename(dirname(target)) === "provider-accounts") roots.push(...(await folders(dirname(target))));
  return [...new Set(roots.map((root) => resolve(root)))].filter((root) => root !== resolve(target));
}

/**
 * Copies the chat `sessionId` of `cwd` into `configDirectory` when only another folder has it.
 * Returns the folder it came from, or null when nothing was copied.
 */
export async function recoverClaudeSession(
  sessionId: string,
  cwd: string,
  configDirectory: string,
): Promise<string | null> {
  const project = projectName(cwd);
  const target = join(configDirectory, "projects", project);
  if (await exists(join(target, `${sessionId}.jsonl`))) return null;
  for (const root of await candidateRoots(configDirectory)) {
    const source = join(root, "projects", project);
    if (!(await exists(join(source, `${sessionId}.jsonl`)))) continue;
    try {
      await cp(join(source, `${sessionId}.jsonl`), join(target, `${sessionId}.jsonl`), {
        errorOnExist: true,
        force: false,
      });
      // Subagent transcripts and tool results of the chat live in a folder of the same name.
      if (await exists(join(source, sessionId)))
        await cp(join(source, sessionId), join(target, sessionId), { recursive: true, force: false });
      logger.info("Copied a Claude chat from another account folder.", { from: root, to: configDirectory });
      return root;
    } catch (error) {
      logger.warn("Could not copy a Claude chat from another account folder.", {
        from: root,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
  return null;
}
