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
    const m = /^(#{1,6}) +(\S.*?)\s*$/.exec(line);
    if (m) {
      out.push({
        heading: m[2]!,
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
  it("takes the body under the H1 named Front and the one named Back, hiding the heading text", () => {
    const card = parse(
      "---\ntags: [flashcard]\n---\n# Front\nWhat is the capital of France?\n\n# Back\nParis, on the Seine.\n",
    );
    expect(card).toEqual({ front: "What is the capital of France?", back: "Paris, on the Seine." });
  });

  it("goes by name, not position: order does not matter and other H1s are skipped", () => {
    expect(parse("# Notes\nmine\n# Back\na\n# Front\nq\n# Extra\nignored")).toEqual({ front: "q", back: "a" });
  });

  it("matches names case-sensitively, ignoring surrounding spaces", () => {
    expect(parse("# Front \nq\n# Back\na")).toEqual({ front: "q", back: "a" });
    expect(parse("# front\nq\n# Back\na")).toBeNull();
    expect(parse("# Front\nq\n# BACK\na")).toBeNull();
  });

  it("works with CRLF line endings", () => {
    expect(parse("# Front\r\nquestion\r\n# Back\r\nanswer\r\n")).toEqual({ front: "question", back: "answer" });
  });

  it("keeps multi-line markdown, lists, and lower headings inside a side", () => {
    const card = parse("# Front\n## Hint\n- one\n- two\n\n# Back\n**bold** answer\n\n![[img.png]]");
    expect(card?.front).toBe("## Hint\n- one\n- two");
    expect(card?.back).toBe("**bold** answer\n\n![[img.png]]");
  });

  it("ignores text before the first H1", () => {
    expect(parse("notes to self\n\n# Front\nq\n# Back\na")).toEqual({ front: "q", back: "a" });
  });

  it("uses the first of two H1s with the same name", () => {
    expect(parse("# Front\nq1\n# Front\nq2\n# Back\na")).toEqual({ front: "q1", back: "a" });
  });

  it("ignores headings of other levels", () => {
    expect(parse("## Front\nnope\n# Front\nq\n### deeper\n# Back\na")).toEqual({
      front: "q\n### deeper",
      back: "a",
    });
  });

  it("returns null unless Front and Back both exist and are non-empty", () => {
    expect(parse("")).toBeNull();
    expect(parse("just text")).toBeNull();
    expect(parse("# Front\nq")).toBeNull();
    expect(parse("# Q\nq\n# A\na")).toBeNull();
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
        { heading: "Front", level: 1, position: { start: { offset: -1 }, end: { offset: 3 } } },
        { heading: "Back", level: 1, position: { start: { offset: 8 }, end: { offset: Number.NaN } } },
      ]),
    ).toBeNull();
  });
});
