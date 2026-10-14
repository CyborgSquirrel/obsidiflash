export type Rating = 1 | 2 | 3 | 4;

export interface ReviewEvent {
  /** Review time, milliseconds since the epoch (UTC). */
  t: number;
  /** Device id: 8 lowercase hex characters, random per install. */
  d: string;
  /** Stable card id. */
  card: string;
  rating: Rating;
}

const DEVICE_ID_RE = /^[0-9a-f]{8}$/;

export function isDeviceId(value: unknown): value is string {
  return typeof value === "string" && DEVICE_ID_RE.test(value);
}

export function generateDeviceId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Total order on events: timestamp, then device id. Keys `(t, d)` are unique per event. */
export function compareEvents(a: ReviewEvent, b: ReviewEvent): number {
  if (a.t !== b.t) return a.t < b.t ? -1 : 1;
  if (a.d !== b.d) return a.d < b.d ? -1 : 1;
  return 0;
}

/** Strictly increasing per-device timestamps: never issue `t` at or below one already used. */
export function nextTimestamp(now: number, last: number): number {
  return Math.max(now, last + 1);
}

export function isReviewEvent(value: unknown): value is ReviewEvent {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
       typeof o.t === "number"
    && Number.isSafeInteger(o.t)
    && o.t >= 0
    && isDeviceId(o.d)
    && typeof o.card === "string"
    && o.card.length > 0
    && (o.rating === 1 || o.rating === 2 || o.rating === 3 || o.rating === 4)
  );
}

export function encodeEvent(e: ReviewEvent): string {
  return JSON.stringify({ t: e.t, d: e.d, card: e.card, rating: e.rating });
}

export function decodeEvent(line: string): ReviewEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isReviewEvent(value)) return null;
  return { t: value.t, d: value.d, card: value.card, rating: value.rating };
}

/** One JSON line per event, each terminated by a newline. */
export function encodeEvents(events: readonly ReviewEvent[]): string {
  let out = "";
  for (const e of events) out += encodeEvent(e) + "\n";
  return out;
}

/**
 * Parse JSONL text. A line counts only if it is newline-terminated and valid;
 * an unterminated tail (a torn write) and invalid lines are dropped.
 */
export function parseEvents(text: string): ReviewEvent[] {
  const out: ReviewEvent[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl < 0) break;
    const line = text.slice(start, nl);
    start = nl + 1;
    if (line === "") continue;
    const e = decodeEvent(line);
    if (e) out.push(e);
  }
  return out;
}

export function trimToLastNewline(text: string): string {
  const i = text.lastIndexOf("\n");
  return i < 0 ? "" : text.slice(0, i + 1);
}
