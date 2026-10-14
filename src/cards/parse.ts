export interface CardSides {
  /** Markdown shown on the front: the body under the first H1. */
  front: string;
  /** Markdown shown on the back: the body under the second H1. */
  back: string;
}

/**
 * The part of Obsidian's `HeadingCache` we need. Obsidian's metadata cache does the actual
 * Markdown parsing (code fences, front matter, and so on); we only slice by its offsets.
 */
export interface HeadingLike {
  level: number;
  position: {
    start: { offset: number };
    end: { offset: number };
  };
}

/**
 * Build a card from a note's text and the heading positions Obsidian parsed for it.
 *
 * The H1s are labels: the first H1 starts the front and the second starts the back, and
 * the heading text itself is not part of the card. Each side is the text between its H1
 * and the next H1 (or the end of the note). Text before the first H1, including front
 * matter, and any H1 sections after the second are ignored.
 *
 * Returns null if there are fewer than two H1s, an offset does not fit the text (the
 * metadata is out of date for this text), or a side is empty.
 */
export function sidesFromHeadings(content: string, headings: readonly HeadingLike[]): CardSides | null {
  const h1s = headings.filter((h) => h.level === 1);
  const first = h1s[0];
  const second = h1s[1];
  if (!first || !second) return null;

  const third = h1s[2];
  const bounds = [first.position.start.offset, first.position.end.offset, second.position.start.offset, second.position.end.offset];
  if (third) bounds.push(third.position.start.offset);

  // Offsets must be inside the text and ascending, and each H1 must really start with "#".
  // If not, the cache was built from a different version of the text.
  for (let i = 0; i < bounds.length; i++) {
    const b = bounds[i]!;
    if (!Number.isInteger(b) || b < 0 || b > content.length) return null;
    if (i > 0 && b < bounds[i - 1]!) return null;
  }
  if (content[first.position.start.offset] !== "#" || content[second.position.start.offset] !== "#") return null;

  const front = content.slice(first.position.end.offset, second.position.start.offset).trim();
  const back = content.slice(second.position.end.offset, third ? third.position.start.offset : content.length).trim();
  if (front === "" || back === "") return null;
  return { front, back };
}
