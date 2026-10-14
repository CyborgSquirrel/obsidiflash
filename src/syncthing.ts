/**
 * Syncthing reads `.stignore` only from the root of a synced folder, and never syncs it.
 * A directory is ignored with a pattern anchored to that root, such as `/.obsidiflash`.
 */

/** Characters that mean something in a Syncthing pattern, so a directory using them is unsafe. */
const PATTERN_SPECIAL = /[*?[\]{}\\!#]/;

/** The root-anchored ignore pattern for a vault-relative directory. */
export function ignorePattern(stateDir: string): string {
  const dir = stateDir.replace(/^\/+|\/+$/g, "");
  if (dir === "") throw new Error("empty state directory");
  if (PATTERN_SPECIAL.test(dir)) {
    throw new Error(`the state directory "${dir}" contains characters that are special in .stignore`);
  }
  return "/" + dir;
}

const norm = (line: string): string => line.trim().replace(/\/+$/, "");

/**
 * Return the content of `.stignore` with the pattern added, or null if the file already
 * ignores it. `content` is null when the file does not exist yet.
 */
export function addIgnoreLine(content: string | null, pattern: string): string | null {
  const base = content ?? "";
  const wanted = norm(pattern);
  if (base.split(/\r?\n/).some((line) => norm(line) === wanted)) return null;

  const eol = base.includes("\r\n") ? "\r\n" : "\n";
  const lead = base === "" || base.endsWith("\n") ? "" : eol;
  return base + lead + "// Obsidiflash state: device-local, do not sync" + eol + pattern + eol;
}
