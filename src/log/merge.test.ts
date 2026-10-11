import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareEvents, type ReviewEvent } from "./event";
import { mergeToArray } from "./merge";
import { ev } from "./test-utils";

const keyOf = (e: ReviewEvent) => `${e.t}/${e.d}`;

describe("mergeSorted", () => {
  it("handles no sources and empty sources", () => {
    expect(mergeToArray([])).toEqual([]);
    expect(mergeToArray([[], []])).toEqual([]);
    expect(mergeToArray([[], [ev(1)]]).map((e) => e.t)).toEqual([1]);
  });

  it("breaks timestamp ties by device id", () => {
    const out = mergeToArray([[ev(5, "cccccccc")], [ev(5, "aaaaaaaa")], [ev(5, "bbbbbbbb")]]);
    expect(out.map((e) => e.d)).toEqual(["aaaaaaaa", "bbbbbbbb", "cccccccc"]);
  });

  it("drops events with an equal key, emitting them once", () => {
    const out = mergeToArray([[ev(1), ev(2)], [ev(2), ev(3)], [ev(2)]]);
    expect(out.map((e) => e.t)).toEqual([1, 2, 3]);
  });

  it("merges any split of a key universe into sorted order", () => {
    // Small t and device ranges force many ties.
    const universe = fc
      .uniqueArray(
        fc.record({
          t: fc.integer({ min: 0, max: 20 }),
          d: fc.constantFrom("aaaaaaaa", "bbbbbbbb", "cccccccc"),
        }),
        { selector: (e) => `${e.t}/${e.d}`, maxLength: 40 },
      )
      .map((keys) => keys.map((k) => ev(k.t, k.d)));

    fc.assert(
      fc.property(
        universe,
        fc.array(fc.nat({ max: 5 }), { maxLength: 40 }),
        fc.array(fc.nat({ max: 5 }), { maxLength: 40 }),
        (events, assign, dupAssign) => {
          const sources: ReviewEvent[][] = Array.from({ length: 6 }, () => []);
          events.forEach((e, i) => sources[assign[i] ?? 0]!.push(e));
          // Also put some events into a second source, to exercise cross-source duplicates.
          events.forEach((e, i) => {
            if (i % 3 === 0) sources[dupAssign[i] ?? 0]!.push(e);
          });
          const sorted = sources.map((s) => {
            const unique = new Map(s.map((e) => [keyOf(e), e]));
            return [...unique.values()].sort(compareEvents);
          });
          const expected = [...events].sort(compareEvents);
          expect(mergeToArray(sorted)).toEqual(expected);
        },
      ),
    );
  });
});
