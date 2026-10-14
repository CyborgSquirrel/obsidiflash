import { describe, expect, it } from "vitest";
import { sidesFromHeadings, type HeadingLike } from "./parse";

/**
 * Stand-in for Obsidian's metadata cache: finds ATX headings line by line. Good enough for
 * these tests, which are about slicing by offsets, not about what counts as a heading.
 */
function headingsOf(content: string): HeadingLike[] {
  const out: HeadingLike[] = [];
  let offset = 0;
  for (const line of content.split("\n")) {
    const m = /^(#{1,6}) +\S/.exec(line);
    if (m) {
      out.push({
        level: m[1]!.length,
        position: { start: { offset }, end: { offset: offset + line.replace(/\r$/, "").length } },
      });
    }
    offset += line.length + 1;
  }
  return out;
}

const parse = (content: string) => sidesFromHeadings(content, headingsOf(content));

describe("sidesFromHeadings", () => {
  it("takes the body under the first and second H1 and hides the heading text", () => {
    const card = parse(
      "---\ntags: [flashcard]\n---\n# Front\nWhat is the capital of France?\n\n# Back\nParis, on the Seine.\n",
    );
    expect(card).toEqual({ front: "What is the capital of France?", back: "Paris, on the Seine." });
  });

  it("works without front matter and with CRLF line endings", () => {
    expect(parse("# Q\r\nquestion\r\n# A\r\nanswer\r\n")).toEqual({ front: "question", back: "answer" });
  });

  it("keeps multi-line markdown, lists, and lower headings inside a side", () => {
    const card = parse("# Front\n## Hint\n- one\n- two\n\n# Back\n**bold** answer\n\n![[img.png]]");
    expect(card?.front).toBe("## Hint\n- one\n- two");
    expect(card?.back).toBe("**bold** answer\n\n![[img.png]]");
  });

  it("ignores text before the first H1 and any H1 sections after the second", () => {
    expect(parse("notes to self\n\n# Front\nq\n# Back\na\n# Extra\nignored")).toEqual({ front: "q", back: "a" });
  });

  it("ignores headings of other levels when picking the H1s", () => {
    expect(parse("## not h1\n# Front\nq\n### deeper\n# Back\na")).toEqual({
      front: "q\n### deeper",
      back: "a",
    });
  });

  it("returns null unless there are two non-empty sides", () => {
    expect(parse("")).toBeNull();
    expect(parse("just text")).toBeNull();
    expect(parse("# Only front\nq")).toBeNull();
    expect(parse("# Front\n\n# Back\nanswer")).toBeNull();
    expect(parse("# Front\nq\n# Back\n   \n")).toBeNull();
  });

  it("returns null when the metadata does not match the text", () => {
    const text = "# Front\nq\n# Back\na";
    const good = headingsOf(text);
    // Offsets beyond the text.
    expect(sidesFromHeadings("# F\nq", good)).toBeNull();
    // Offsets that land on something other than a "#".
    expect(sidesFromHeadings("xx Front\nq\nxx Back\na", good)).toBeNull();
    // Offsets out of order.
    expect(sidesFromHeadings(text, [...good].reverse())).toBeNull();
    // Garbage offsets.
    expect(
      sidesFromHeadings(text, [
        { level: 1, position: { start: { offset: -1 }, end: { offset: 3 } } },
        { level: 1, position: { start: { offset: 8 }, end: { offset: Number.NaN } } },
      ]),
    ).toBeNull();
  });
});
