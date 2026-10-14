import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { heldMap, missingEvents } from "./delta";
import { compareEvents, type ReviewEvent } from "./event";
import { ev } from "./test-utils";

const keyOf = (e: ReviewEvent) => `${e.t}/${e.d}`;
const DEVICES = ["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd"];

/**
 * A block in arrival order: each device's entries arrive in strictly increasing t,
 * interleaved arbitrarily across devices.
 */
const arrivalOrder = fc
  .tuple(
    fc.array(fc.nat({ max: DEVICES.length - 1 }), { maxLength: 60 }),
    fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 60, maxLength: 60 }),
  )
  .map(([who, steps]) => {
    const last = new Map<string, number>();
    return who.map((w, i) => {
      const d = DEVICES[w]!;
      const t = (last.get(d) ?? 0) + steps[i]!;
      last.set(d, t);
      return ev(t, d);
    });
  });

describe("heldMap / missingEvents", () => {
  it("returns everything for an empty held map", () => {
    const block = [ev(1), ev(2, "bbbbbbbb")];
    expect(missingEvents(block, {})).toEqual(block);
  });

  it("returns exactly the missing suffix for any prefix of arrival order, sorted or not", () => {
    fc.assert(
      fc.property(arrivalOrder, fc.nat({ max: 60 }), (block, cut) => {
        const prefix = block.slice(0, cut);
        const suffix = block.slice(cut);
        const held = heldMap(prefix);

        const fromArrival = missingEvents(block, held);
        const fromSorted = missingEvents([...block].sort(compareEvents), held);

        const expected = suffix.map(keyOf).sort();
        expect(fromArrival.map(keyOf).sort()).toEqual(expected);
        expect(fromSorted.map(keyOf).sort()).toEqual(expected);
      }),
    );
  });

  it("returns nothing once the whole block is held", () => {
    fc.assert(
      fc.property(arrivalOrder, (block) => {
        expect(missingEvents(block, heldMap(block))).toEqual([]);
      }),
    );
  });
});
