import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  BrowserBounds,
  BrowserChromeLinkInput,
  BrowserChromeSignInInput,
  BrowserChromeSyncInput,
  BrowserLocalSignInFinish,
  BrowserLocalSignInInput,
  BrowserNavigateInput,
  BrowserOpenInput,
  BrowserVisibilityInput,
} from "@openbot/contracts/ipc";
import { isBoolean, isNumber } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { isObject, requireString } from "./validation";

export function parseBrowserOpen(value: unknown): BrowserOpenInput {
  if (!isObject(value)) throw new Error("Invalid browser open request.");
  if (value.focus !== undefined && !isBoolean(value.focus)) throw new Error("Invalid browser focus request.");
  return {
    url: requireString(value.url, "url", INPUT_LIMITS.browserUrl),
    ownerThreadId:
      value.ownerThreadId === null || value.ownerThreadId === undefined
        ? null
        : requireString(value.ownerThreadId, "ownerThreadId"),
    ownerAgentId:
      value.ownerAgentId === null || value.ownerAgentId === undefined
        ? null
        : requireString(value.ownerAgentId, "ownerAgentId"),
    focus: value.focus ?? false,
  };
}

export function parseBrowserNavigate(value: unknown): BrowserNavigateInput {
  if (isObject(value) && value.direction !== undefined && value.url !== undefined) {
    throw new Error("Invalid browser navigation request.");
  }
  if (isObject(value) && value.direction === undefined && value.url !== undefined) {
    const url = requireString(value.url, "url", INPUT_LIMITS.browserUrl);
    if (!/^https?:\/\//i.test(url)) throw new Error(sourceText("error.backend.browserUrlProtocol"));
    return { tabId: requireString(value.tabId, "tabId"), url };
  }
  if (!isObject(value) || (value.direction !== "back" && value.direction !== "forward")) {
    throw new Error("Invalid browser navigation request.");
  }
  return {
    tabId: requireString(value.tabId, "tabId"),
    direction: value.direction,
  };
}

export function parseVisibility(value: unknown): BrowserVisibilityInput {
  if (!isObject(value) || !isBoolean(value.visible)) {
    throw new Error("Invalid browser visibility request.");
  }
  return {
    visible: value.visible,
    ...(value.bounds === undefined ? {} : { bounds: parseBounds(value.bounds) }),
    ...(value.target === undefined ? {} : { target: parseBrowserViewTarget(value.target) }),
  };
}

export function parseBrowserBounds(value: unknown): BrowserBounds {
  return parseBounds(value);
}

function parseBrowserViewTarget(value: unknown): "main" | "picture-in-picture" {
  if (value === "main" || value === "picture-in-picture") return value;
  throw new Error("Invalid browser view target.");
}

function parseBounds(value: unknown): BrowserBounds {
  if (!isObject(value)) throw new Error("Invalid browser bounds.");
  return {
    x: finiteBound(value.x, "x"),
    y: finiteBound(value.y, "y"),
    width: finiteBound(value.width, "width"),
    height: finiteBound(value.height, "height"),
  };
}

function finiteBound(value: unknown, field: string): number {
  if (!isNumber(value) || !Number.isFinite(value)) {
    throw new Error(`Invalid browser bound: ${field}.`);
  }
  return value;
}

export function parseLocalSignIn(value: unknown): BrowserLocalSignInInput {
  if (!isObject(value)) throw new Error("Invalid browser sign-in request.");
  const url = requireString(value.url, "url", INPUT_LIMITS.browserUrl);
  if (!/^https?:\/\//i.test(url)) throw new Error(sourceText("error.backend.browserUrlProtocol"));
  return { tabId: requireString(value.tabId, "tabId"), url };
}

/** Fork: a Chrome profile folder name only, so the main side never reads another path. */
export function parseChromeSignIn(value: unknown): BrowserChromeSignInInput {
  if (!isObject(value)) throw new Error("Invalid Chrome sign-in request.");
  const profileId = requireString(value.profileId, "profileId", 64);
  if (!/^(?:Default|Profile \d+)$/u.test(profileId)) throw new Error("Invalid Chrome sign-in request.");
  return { tabId: requireString(value.tabId, "tabId"), profileId };
}

const CHROME_PROFILE_ID = /^(?:Default|Profile \d+)$/u;

function browserProfileIdOrShared(value: unknown): string | null {
  return value === null ? null : requireString(value, "profileId", INPUT_LIMITS.identifier);
}

/** Fork: a browser profile id, null for the shared one, and a Chrome profile folder name or null. */
export function parseChromeLink(value: unknown): BrowserChromeLinkInput {
  if (!isObject(value)) throw new Error("Invalid Chrome link request.");
  const chromeProfileId =
    value.chromeProfileId === null ? null : requireString(value.chromeProfileId, "chromeProfileId", 64);
  if (chromeProfileId !== null && !CHROME_PROFILE_ID.test(chromeProfileId))
    throw new Error("Invalid Chrome link request.");
  return { profileId: browserProfileIdOrShared(value.profileId), chromeProfileId };
}

export function parseChromeSync(value: unknown): BrowserChromeSyncInput {
  if (!isObject(value)) throw new Error("Invalid Chrome sync request.");
  return { profileId: browserProfileIdOrShared(value.profileId) };
}

export function parseLocalSignInFinish(value: unknown): BrowserLocalSignInFinish {
  if (!isObject(value) || !isBoolean(value.send)) throw new Error("Invalid browser sign-in request.");
  if (value.check !== undefined && !isBoolean(value.check)) throw new Error("Invalid browser sign-in request.");
  return { send: value.send, check: value.check === true };
}
