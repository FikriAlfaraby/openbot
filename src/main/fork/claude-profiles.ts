// Fork: the Claude Code profiles of this Mac, each a CLAUDE_CONFIG_DIR folder that is already signed in.
// The person keeps several accounts this way (for example Kantor, Pribadi and Startup), and OpenBot can use
// each one as an account of its own without a second sign-in. The list is read here, so the renderer can
// only pick one of these folders, never name another path.
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeProfileFolder {
  path: string;
  name: string;
}

/** The folder that a Claude Code profile switcher keeps one folder per profile in. */
function profilesRoot(home: string): string {
  return join(home, "Library", "Application Support", "Claude-Code-Profiles");
}

async function isProfile(folder: string): Promise<boolean> {
  try {
    return (await stat(folder)).isDirectory() && (await stat(join(folder, ".claude.json"))).isFile();
  } catch {
    return false;
  }
}

/** The signed-in Claude profile folders of this Mac, by name. None on another platform. */
export async function listClaudeProfiles(home = homedir()): Promise<ClaudeProfileFolder[]> {
  if (process.platform !== "darwin") return [];
  const root = profilesRoot(home);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const profiles: ClaudeProfileFolder[] = [];
  for (const name of names.sort((left, right) => left.localeCompare(right))) {
    const path = join(root, name);
    if (!name.startsWith(".") && (await isProfile(path))) profiles.push({ path, name });
  }
  return profiles;
}
