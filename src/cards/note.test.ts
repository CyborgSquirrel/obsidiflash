import { describe, expect, it } from "vitest";
import { FLASHCARD_TAG, hasFlashcardTag, generateUuid, newCardPath, newCardTemplate, uuidFromBytes } from "./note";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuids", () => {
  it("builds a v4 UUID from bytes, setting version and variant bits", () => {
    expect(uuidFromBytes(new Uint8Array(16))).toBe("00000000-0000-4000-8000-000000000000");
    expect(uuidFromBytes(new Uint8Array(16).fill(0xff))).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  });

  it("does not modify its input and rejects the wrong length", () => {
    const bytes = new Uint8Array(16);
    uuidFromBytes(bytes);
    expect(Array.from(bytes)).toEqual(new Array(16).fill(0));
    expect(() => uuidFromBytes(new Uint8Array(15))).toThrow();
  });

  it("generates well-formed, distinct ids", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateUuid()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });
});

describe("newCardPath", () => {
  it("names the note by its uuid inside the folder", () => {
    expect(newCardPath("Flashcards", "abc")).toBe("Flashcards/abc.md");
    expect(newCardPath("a/b/", "abc")).toBe("a/b/abc.md");
    expect(newCardPath("", "abc")).toBe("abc.md");
  });
});

describe("newCardTemplate", () => {
  it("tags the note and has a Front and a Back H1, with the cursor line under Front", () => {
    const { content, frontLine } = newCardTemplate();
    const lines = content.split("\n");
    expect(lines.slice(0, 4)).toEqual(["---", "tags:", `  - ${FLASHCARD_TAG}`, "---"]);
    expect(lines.filter((l) => l.startsWith("# "))).toEqual(["# Front", "# Back"]);
    expect(lines[frontLine - 1]).toBe("# Front");
    expect(lines[frontLine]).toBe("");
  });
});

describe("hasFlashcardTag", () => {
  it("matches the exact tag, with or without #, ignoring case", () => {
    expect(hasFlashcardTag(["#flashcard"])).toBe(true);
    expect(hasFlashcardTag(["other", "Flashcard"])).toBe(true);
  });

  it("does not match other or nested tags", () => {
    expect(hasFlashcardTag([])).toBe(false);
    expect(hasFlashcardTag(["#flashcards", "#flashcard/deck", "#my-flashcard"])).toBe(false);
  });
});
