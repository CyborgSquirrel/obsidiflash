import type { ReviewEvent } from "./event";

/**
 * K-way merge of sources that are each sorted by `(t, d)`.
 *
 * Emits events in key order. Events with an equal key `(t, d)` are the same event
 * (for example one that is in both the local log and the mirror) and are emitted once.
 *
 * Binary heap of source indices in an Int32Array; each source's head timestamp is
 * cached in a Float64Array so comparisons rarely touch event objects. The device id
 * is only compared when timestamps are equal.
 */
export function mergeSorted(
  sources: readonly (readonly ReviewEvent[])[],
  onEvent: (e: ReviewEvent) => void,
): void {
  const k = sources.length;
  const pos = new Int32Array(k);
  const heap = new Int32Array(k);
  // Float64Array, not BigInt64Array: JS has no plain 64-bit integer type, and BigInt64Array
  // only takes and returns bigints (every cached `t` would need BigInt(t), and bigint
  // comparisons are slower). Event timestamps are millisecond integers, far below 2^53,
  // so a double stores them exactly and compares them like integers.
  const headT = new Float64Array(k);
  let n = 0;

  const headOf = (s: number): ReviewEvent => sources[s]![pos[s]!]!;

  const less = (x: number, y: number): boolean => {
    const tx = headT[x]!;
    const ty = headT[y]!;
    if (tx !== ty) return tx < ty;
    return headOf(x).d < headOf(y).d;
  };

  const siftDown = (start: number): void => {
    let i = start;
    const item = heap[i]!;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && less(heap[c + 1]!, heap[c]!)) c++;
      if (!less(heap[c]!, item)) break;
      heap[i] = heap[c]!;
      i = c;
    }
    heap[i] = item;
  };

  for (let s = 0; s < k; s++) {
    const src = sources[s]!;
    if (src.length > 0) {
      headT[s] = src[0]!.t;
      heap[n++] = s;
    }
  }
  for (let i = (n >> 1) - 1; i >= 0; i--) siftDown(i);

  let prev: ReviewEvent | null = null;
  while (n > 0) {
    const s = heap[0]!;
    const e = headOf(s);
    if (prev === null || e.t !== prev.t || e.d !== prev.d) onEvent(e);
    prev = e;

    const src = sources[s]!;
    const next = pos[s]! + 1;
    if (next >= src.length) {
      n--;
      heap[0] = heap[n]!;
    } else {
      pos[s] = next;
      headT[s] = src[next]!.t;
    }
    if (n > 0) siftDown(0);
  }
}

export function mergeToArray(sources: readonly (readonly ReviewEvent[])[]): ReviewEvent[] {
  const out: ReviewEvent[] = [];
  mergeSorted(sources, (e) => out.push(e));
  return out;
}
