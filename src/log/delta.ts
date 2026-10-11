import type { ReviewEvent } from "./event";

/** For one block: the largest timestamp held per device id. */
export type HeldMap = Record<string, number>;

/** What a client holds of a block, as the max `t` per device. */
export function heldMap(events: readonly ReviewEvent[]): HeldMap {
  const held: HeldMap = {};
  for (const e of events) {
    const cur = held[e.d];
    if (cur === undefined || e.t > cur) held[e.d] = e.t;
  }
  return held;
}

/**
 * The events of a block that a client is missing, given what it holds.
 *
 * This is valid because the server accepts each device's entries in increasing `t`:
 * a client holding a prefix of a block's arrival order holds, per device, every entry
 * up to some timestamp. A device absent from `held` means all its entries are missing.
 * The result does not depend on the order of `block`, so it works on sorted blocks.
 */
export function missingEvents(block: readonly ReviewEvent[], held: HeldMap): ReviewEvent[] {
  const out: ReviewEvent[] = [];
  for (const e of block) {
    const h = held[e.d];
    if (h === undefined || e.t > h) out.push(e);
  }
  return out;
}
