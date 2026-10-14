export interface CardSides {
  /** Markdown shown on the front: the body under the H1 named "Front". */
  front: string;
  /** Markdown shown on the back: the body under the H1 named "Back". */
  back: string;
}

/**
 * The part of Obsidian's `HeadingCache` we need. Obsidian's metadata cache does the actual
 * Markdown parsing (code fences, front matter, and so on); we only slice by its offsets.
 */
export interface HeadingLike {
  heading: string;
  level: number;
  position: {
    start: { offset: number };
    end: { offset: number };
  };
}

/**
 * Build a card from a note's text and the heading positions Obsidian parsed for it.
 *
 * Each H1 names a field: the body under "Front" is the front and the body under "Back" is
 * the back (names are case-sensitive; surrounding spaces are ignored). The heading text itself
 * is not part of the card. A field's body runs from its H1 to the next H1 of any name (or the
 * end of the note), so the fields may come in any order. Text before the first H1, including
 * front matter, and H1 sections with other names are ignored. If a name is used twice, the
 * first one wins.
 *
 * Returns null if Front or Back is missing or empty, or an offset does not fit the text (the
 * metadata is out of date for this text).
 */
export function sidesFromHeadings(content: string, headings: readonly HeadingLike[]): CardSides | null {
  const h1s = headings.filter((h) => h.level === 1);

  // Offsets must be inside the text and ascending, and each H1 must really start with "#".
  // If not, the cache was built from a different version of the text.
  let previous = 0;
  for (const h of h1s) {
    const { start, end } = h.position;
    for (const b of [start.offset, end.offset]) {
      if (!Number.isInteger(b) || b < previous || b > content.length) return null;
      previous = b;
    }
    if (content[start.offset] !== "#") return null;
  }

  const body = (name: string): string => {
    const i = h1s.findIndex((h) => h.heading.trim() === name);
    if (i < 0) return "";
    const next = h1s[i + 1];
    return content.slice(h1s[i]!.position.end.offset, next ? next.position.start.offset : content.length).trim();
  };
  const front = body("Front");
  const back = body("Back");
  if (front === "" || back === "") return null;
  return { front, back };
}
