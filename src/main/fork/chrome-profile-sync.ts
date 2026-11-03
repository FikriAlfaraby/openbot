// Fork: a browser profile of this Mac can follow a Chrome profile. OpenBot copies every cookie of that
// Chrome profile into the browser profile when OpenBot starts and when the person selects Sync now, so
// the agents of the profile are signed in where Chrome is. The copy goes one way: OpenBot never writes
// to Chrome, and a cookie that Chrome removes stays in OpenBot until the next sign-out there.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import type { BrowserSignInCookie } from "@openbot/contracts/team-protocol/browser-sign-in-v1";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import { type Session, session } from "electron";
import { browserTabPartition } from "../../backend/browser-state";
import { readAllChromeCookies } from "./chrome-sign-in";

const logger = createOpenBotLogger("chrome-sign-in");

/** The key of the shared browser profile in the links file; a named profile uses its id. */
const SHARED_PROFILE_KEY = "shared";
/** The partition of the shared browser profile, as `BrowserHost` opens it. */
const SHARED_PARTITION = "persist:openbot-browser";
/** Cookies set at once. A Chrome profile can hold thousands. */
const SET_BATCH = 50;

export type ChromeProfileLinks = Record<string, string>;

function profileKey(profileId: string | null): string {
  return profileId ?? SHARED_PROFILE_KEY;
}

function profileSession(key: string): Session {
  const partition =
    key === SHARED_PROFILE_KEY
      ? SHARED_PARTITION
      : `persist:${browserTabPartition({ kind: "profile", profileId: key })}`;
  return session.fromPartition(partition, { cache: true });
}

/** Sets cookies as `BrowserHost.importSignIn` does. The answer is the count that Chromium set. */
async function setCookies(target: Session, cookies: readonly BrowserSignInCookie[]): Promise<number> {
  let count = 0;
  for (let start = 0; start < cookies.length; start += SET_BATCH) {
    const results = await Promise.allSettled(
      cookies.slice(start, start + SET_BATCH).map((cookie) =>
        target.cookies.set({
          url: `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./u, "")}${cookie.path}`,
          name: cookie.name,
          value: cookie.value,
          // A cookie with no leading dot is for one host only, so it has no domain attribute.
          ...(cookie.domain.startsWith(".") ? { domain: cookie.domain } : {}),
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
          ...(cookie.expirationDate === null ? {} : { expirationDate: cookie.expirationDate }),
        }),
      ),
    );
    count += results.filter((result) => result.status === "fulfilled").length;
  }
  await target.cookies.flushStore();
  return count;
}

export class ChromeProfileSync {
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
  }

  /** Browser profile key → Chrome profile id. A missing or broken file is no links. */
  async links(): Promise<ChromeProfileLinks> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.#file, "utf8"));
    } catch {
      return {};
    }
    if (!isDynamicRecord(parsed)) return {};
    const links: ChromeProfileLinks = {};
    for (const [key, value] of Object.entries(parsed)) if (isString(value)) links[key] = value;
    return links;
  }

  /** Links a browser profile to a Chrome profile, or unlinks it with null, then copies the cookies. */
  async setLink(profileId: string | null, chromeProfileId: string | null): Promise<number> {
    const links = await this.links();
    const key = profileKey(profileId);
    if (chromeProfileId === null) delete links[key];
    else links[key] = chromeProfileId;
    await mkdir(dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(links, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.#file);
    return chromeProfileId === null ? 0 : this.sync(profileId);
  }

  /** Copies the cookies of the linked Chrome profile. Zero when the profile follows none. */
  async sync(profileId: string | null): Promise<number> {
    const key = profileKey(profileId);
    const chromeProfileId = (await this.links())[key];
    if (!chromeProfileId) return 0;
    return setCookies(profileSession(key), await readAllChromeCookies(chromeProfileId));
  }

  /** Copies every link, one at a time. A failure is logged and the others still run. */
  async syncAll(): Promise<void> {
    if (process.platform !== "darwin") return;
    for (const key of Object.keys(await this.links())) {
      const profileId = key === SHARED_PROFILE_KEY ? null : key;
      try {
        const count = await this.sync(profileId);
        logger.info("A browser profile copied its cookies from Chrome.", { profile: key, cookies: count });
      } catch (cause) {
        logger.warn("A browser profile could not copy its cookies from Chrome.", {
          profile: key,
          cause: toLogValue(cause),
        });
      }
    }
  }
}
