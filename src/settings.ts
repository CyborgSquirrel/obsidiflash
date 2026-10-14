export interface ObsidiflashSettings {
  /** Directory for the plugin's state, relative to the vault root. */
  stateDir: string;
  /** Add the state directory to the vault's Syncthing .stignore (when it can be found). */
  manageSyncthingIgnore: boolean;
  /** Folder where new flashcards are created, relative to the vault root. Empty means the root. */
  cardsFolder: string;
}

export const DEFAULT_SETTINGS: ObsidiflashSettings = {
  stateDir: ".obsidiflash",
  manageSyncthingIgnore: false,
  cardsFolder: "Flashcards",
};

/** Characters that cannot be used in file names on at least one supported platform. */
const INVALID_PATH_CHARS = /[<>:"|?*\u0000-\u001f]/;

function normalizeFolder(input: string, allowEmpty: boolean): string | null {
  const segments = input
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) return allowEmpty ? "" : null;
  if (segments.includes("..")) return null;
  if (segments.some((s) => INVALID_PATH_CHARS.test(s))) return null;
  return segments.join("/");
}

/**
 * Normalize a user-entered state directory to a vault-relative path with "/" separators,
 * or return null if it is not usable (empty, escapes the vault, or has invalid characters).
 */
export function normalizeStateDir(input: string): string | null {
  return normalizeFolder(input, false);
}

/** Like `normalizeStateDir`, but an empty input is valid and means the vault root (""). */
export function normalizeCardsFolder(input: string): string | null {
  return normalizeFolder(input, true);
}

/** Merge stored data over the defaults, dropping anything of the wrong type or invalid. */
export function loadSettings(raw: unknown): ObsidiflashSettings {
  const settings = { ...DEFAULT_SETTINGS };
  if (typeof raw !== "object" || raw === null) return settings;
  const o = raw as Record<string, unknown>;
  if (typeof o.stateDir === "string") {
    const dir = normalizeStateDir(o.stateDir);
    if (dir !== null) settings.stateDir = dir;
  }
  if (typeof o.cardsFolder === "string") {
    const folder = normalizeCardsFolder(o.cardsFolder);
    if (folder !== null) settings.cardsFolder = folder;
  }
  if (typeof o.manageSyncthingIgnore === "boolean") {
    settings.manageSyncthingIgnore = o.manageSyncthingIgnore;
  }
  return settings;
}
