/** Tag that marks a note as a flashcard. */
export const FLASHCARD_TAG = "flashcard";

/** Whether a note's tags (as Obsidian lists them, with or without "#") include the flashcard tag. Case-insensitive. */
export function hasFlashcardTag(tags: readonly string[]): boolean {
  return tags.some((t) => t.replace(/^#/, "").toLowerCase() === FLASHCARD_TAG);
}

/** Version 4 UUID text from 16 random bytes. Sets the version and variant bits. */
export function uuidFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error("a UUID needs 16 bytes");
  const b = Uint8Array.from(bytes);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function generateUuid(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === "function") return c.randomUUID();
  return uuidFromBytes(c.getRandomValues(new Uint8Array(16)));
}

/** Vault path of a new card: the note is named by its UUID. */
export function newCardPath(folder: string, uuid: string): string {
  const dir = folder.replace(/^\/+|\/+$/g, "");
  return dir === "" ? `${uuid}.md` : `${dir}/${uuid}.md`;
}

/**
 * Text of a new, empty card, and the 0-based line where the cursor should go: the first
 * line under "# Front". The H1s are labels; the text under them is the card.
 */
export function newCardTemplate(): { content: string; frontLine: number } {
  const lines = ["---", "tags:", `  - ${FLASHCARD_TAG}`, "---", "# Front", "", "", "# Back", ""];
  return { content: lines.join("\n"), frontLine: lines.indexOf("# Front") + 1 };
}
