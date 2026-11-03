// Fork: reads the sign-in of one site from a Chrome profile on this Mac, so a person can give an agent's
// browser tab the session that their own Chrome already has. The cookies go to the tab through the same
// path as a sign-in on this computer (`browser-sign-in`), so the host keeps only the tab's site.
//
// Chrome keeps cookie values encrypted with a key in the login keychain ("Chrome Safe Storage"). macOS
// asks the person once before it gives the key out, and it may also ask before OpenBot reads Chrome's
// folder. The values are never logged.
import { execFile } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { access, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import {
  type BrowserSignInCookie,
  browserSignInCookieFitsHost,
} from "@openbot/contracts/team-protocol/browser-sign-in-v1";
import { sourceText } from "@openbot/i18n/source";

export interface ChromeProfile {
  /** The profile's folder in Chrome's data folder, such as `Default` or `Profile 1`. */
  id: string;
  /** The name that Chrome shows for the profile. */
  name: string;
}

export interface ChromeCookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array;
  path: string;
  expires_utc: number | bigint;
  has_expires: number | bigint;
  is_secure: number | bigint;
  is_httponly: number | bigint;
  samesite: number | bigint;
}

/** The `browser-sign-in` wire takes at most 150 cookies. */
const CHROME_SIGN_IN_COOKIE_LIMIT = 150;
/** Chromium keeps at most 4096 bytes of a cookie's name and value together. */
const CHROME_COOKIE_BYTES = 4096;
/** Seconds between 1601-01-01, Chrome's epoch, and the Unix epoch. */
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600;
/** From this cookie database version, Chrome puts the SHA-256 of the host before the value. */
const CHROME_HOST_DIGEST_VERSION = 24;
const CHROME_KEYCHAIN_SERVICE = "Chrome Safe Storage";
const KEYCHAIN_TIMEOUT_MS = 60_000;
const PROFILE_ID = /^(?:Default|Profile \d+|Guest Profile)$/u;
const SAME_SITE: Record<string, BrowserSignInCookie["sameSite"]> = {
  "0": "no_restriction",
  "1": "lax",
  "2": "strict",
};

export function chromeUserDataDirectory(home = homedir()): string {
  return join(home, "Library", "Application Support", "Google", "Chrome");
}

/** The profiles in Chrome's `Local State`, in the order Chrome shows them. */
export function chromeProfilesFromLocalState(localState: unknown): ChromeProfile[] {
  const profile = isDynamicRecord(localState) ? localState.profile : undefined;
  const cache = isDynamicRecord(profile) ? profile.info_cache : undefined;
  if (!isDynamicRecord(profile) || !isDynamicRecord(cache)) return [];
  const order = Array.isArray(profile.profiles_order) ? profile.profiles_order : [];
  const ids = Object.keys(cache).filter((id) => PROFILE_ID.test(id) && id !== "Guest Profile");
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : ids.length);
  return ids
    .sort((left, right) => rank(left) - rank(right))
    .map((id) => {
      const entry = cache[id];
      const name = isDynamicRecord(entry) && isString(entry.name) ? entry.name.trim() : "";
      return { id, name: name || id };
    });
}

/** The AES key that Chrome on macOS derives from the keychain password. */
export function chromeCookieKey(password: string): Buffer {
  return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

/**
 * The value of one cookie, or null when it is not one this Mac's Chrome encrypted with `v10`. A
 * database from version 24 puts the SHA-256 of the cookie's host before the value; it must match.
 */
export function decryptChromeCookie(
  encrypted: Uint8Array,
  key: Buffer,
  hostKey: string,
  databaseVersion: number,
): string | null {
  const bytes = Buffer.from(encrypted);
  if (bytes.length <= 3 || bytes.subarray(0, 3).toString("latin1") !== "v10") return null;
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    plain = Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()]);
  } catch {
    return null;
  }
  if (databaseVersion >= CHROME_HOST_DIGEST_VERSION) {
    const digest = createHash("sha256").update(hostKey).digest();
    if (plain.length < digest.length || !plain.subarray(0, digest.length).equals(digest)) return null;
    plain = plain.subarray(digest.length);
  }
  return plain.toString("utf8");
}

/** A Chrome row as a `browser-sign-in` cookie, or null for an ended cookie or one the wire refuses. */
export function chromeRowToCookie(row: ChromeCookieRow, value: string, nowSeconds: number): BrowserSignInCookie | null {
  const domain = row.host_key.toLowerCase();
  if (!domain || Buffer.byteLength(row.name) + Buffer.byteLength(value) > CHROME_COOKIE_BYTES) return null;
  let expirationDate: number | null = null;
  if (Number(row.has_expires) !== 0 && Number(row.expires_utc) > 0) {
    expirationDate = Math.floor(Number(row.expires_utc) / 1_000_000) - CHROME_EPOCH_OFFSET_SECONDS;
    if (expirationDate <= nowSeconds) return null;
  }
  return {
    name: row.name,
    value,
    domain,
    path: row.path || "/",
    secure: Number(row.is_secure) !== 0,
    httpOnly: Number(row.is_httponly) !== 0,
    sameSite: SAME_SITE[String(row.samesite)] ?? "unspecified",
    expirationDate,
  };
}

function isMissingFile(cause: unknown): boolean {
  return isDynamicRecord(cause) && cause.code === "ENOENT";
}

function chromeDataBlocked(): Error {
  return new Error(sourceText("error.backend.chromeDataBlocked"));
}

function requireMac(): void {
  if (process.platform !== "darwin") throw new Error(sourceText("error.backend.chromeSignInMacOnly"));
}

/** The Chrome profiles of this Mac. None when Chrome is not installed. */
export async function listChromeProfiles(home = homedir()): Promise<ChromeProfile[]> {
  requireMac();
  let text: string;
  try {
    text = await readFile(join(chromeUserDataDirectory(home), "Local State"), "utf8");
  } catch (cause) {
    if (isMissingFile(cause)) return [];
    throw chromeDataBlocked();
  }
  try {
    return chromeProfilesFromLocalState(JSON.parse(text));
  } catch {
    return [];
  }
}

/** Asks the keychain for Chrome's password. macOS shows its own Allow dialog the first time. */
function chromeKeychainPassword(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", CHROME_KEYCHAIN_SERVICE],
      { encoding: "utf8", timeout: KEYCHAIN_TIMEOUT_MS },
      (error, stdout) => {
        const password = stdout.trim();
        if (error || !password) reject(new Error(sourceText("error.backend.chromeKeyDenied")));
        else resolve(password);
      },
    );
  });
}

/** A row of Chrome's `cookies` table, or null for one of another shape. */
function chromeCookieRow(row: unknown): ChromeCookieRow | null {
  if (!isDynamicRecord(row)) return null;
  const { host_key, name, value, encrypted_value, path } = row;
  if (!isString(host_key) || !isString(name) || !isString(value) || !isString(path)) return null;
  if (!(encrypted_value instanceof Uint8Array)) return null;
  const flag = (field: unknown) => (typeof field === "number" || typeof field === "bigint" ? field : 0);
  return {
    host_key,
    name,
    value,
    encrypted_value,
    path,
    expires_utc: flag(row.expires_utc),
    has_expires: flag(row.has_expires),
    is_secure: flag(row.is_secure),
    is_httponly: flag(row.is_httponly),
    samesite: flag(row.samesite),
  };
}

/** Chrome from version 96 keeps the database in `Network`; an older profile keeps it at its root. */
async function chromeCookiesPath(profileFolder: string): Promise<string> {
  const current = join(profileFolder, "Network", "Cookies");
  try {
    await access(current);
    return current;
  } catch {
    return join(profileFolder, "Cookies");
  }
}

/** Chrome holds its database open, so OpenBot reads a copy in a folder of its own. */
async function readChromeRows(cookiesPath: string): Promise<{ rows: ChromeCookieRow[]; version: number }> {
  const folder = await mkdtemp(join(tmpdir(), "openbot-chrome-"));
  try {
    const copy = join(folder, "Cookies");
    try {
      await copyFile(cookiesPath, copy);
    } catch (cause) {
      if (isMissingFile(cause)) throw new Error(sourceText("error.backend.chromeProfileMissing"));
      throw chromeDataBlocked();
    }
    await copyFile(`${cookiesPath}-journal`, `${copy}-journal`).catch(() => undefined);
    const database = new DatabaseSync(copy, { readOnly: true });
    try {
      const meta = database.prepare("SELECT value FROM meta WHERE key = 'version'").get();
      const version = Number(meta?.value ?? 0);
      // A partitioned cookie belongs to a site embedded in another one, which a tab of its own never is.
      const rows = database
        .prepare(
          `SELECT host_key, name, value, encrypted_value, path, expires_utc, has_expires, is_secure,
                  is_httponly, samesite
           FROM cookies WHERE top_frame_site_key = '' OR top_frame_site_key IS NULL`,
        )
        .all()
        .flatMap((row) => {
          const decoded = chromeCookieRow(row);
          return decoded ? [decoded] : [];
        });
      return { rows, version };
    } finally {
      database.close();
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/**
 * The cookies of `host`'s site in a Chrome profile: the host, its parent domains, and its
 * subdomains, as the host side keeps them. Ended cookies are left out.
 */
export async function readChromeSignIn(
  profileId: string,
  host: string,
  home = homedir(),
): Promise<BrowserSignInCookie[]> {
  requireMac();
  if (!PROFILE_ID.test(profileId)) throw new Error(sourceText("error.backend.chromeProfileMissing"));
  const { rows, version } = await readChromeRows(
    await chromeCookiesPath(join(chromeUserDataDirectory(home), profileId)),
  );
  const siteRows = rows.filter((row) => browserSignInCookieFitsHost(row.host_key, host));
  if (siteRows.length === 0) return [];
  const key = chromeCookieKey(await chromeKeychainPassword());
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cookies: BrowserSignInCookie[] = [];
  for (const row of siteRows) {
    const value = row.value || decryptChromeCookie(row.encrypted_value, key, row.host_key, version);
    if (value === null) continue;
    const cookie = chromeRowToCookie(row, value, nowSeconds);
    if (cookie) cookies.push(cookie);
  }
  // The host's own cookies first, then the longest paths: the ones a sign-in needs most.
  return cookies
    .sort(
      (left, right) =>
        Number(right.domain.replace(/^\./u, "") === host) - Number(left.domain.replace(/^\./u, "") === host) ||
        right.path.length - left.path.length,
    )
    .slice(0, CHROME_SIGN_IN_COOKIE_LIMIT);
}
