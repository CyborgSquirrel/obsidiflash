import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  compareEvents,
  decodeEvent,
  encodeEvent,
  encodeEvents,
  generateDeviceId,
  isDeviceId,
  nextTimestamp,
  parseEvents,
  trimToLastNewline,
} from "./event";
import { ev, eventArb } from "./test-utils";

describe("event codec", () => {
  it("round-trips any valid event", () => {
    fc.assert(
      fc.property(eventArb, (e) => {
        expect(decodeEvent(encodeEvent(e))).toEqual(e);
      }),
    );
  });

  it("never emits a raw newline inside a line", () => {
    fc.assert(
      fc.property(eventArb, (e) => {
        expect(encodeEvent(e)).not.toContain("\n");
      }),
    );
  });

  it("rejects malformed events", () => {
    const bad = [
      "",
      "not json",
      "[]",
      "null",
      '{"t":1,"d":"aaaaaaaa","card":"c"}',
      '{"t":1,"d":"aaaaaaaa","card":"c","rating":5}',
      '{"t":-1,"d":"aaaaaaaa","card":"c","rating":3}',
      '{"t":1.5,"d":"aaaaaaaa","card":"c","rating":3}',
      '{"t":1,"d":"AAAAAAAA","card":"c","rating":3}',
      '{"t":1,"d":"aaaa","card":"c","rating":3}',
      '{"t":1,"d":"aaaaaaaa","card":"","rating":3}',
    ];
    for (const line of bad) expect(decodeEvent(line)).toBeNull();
  });

  it("generates valid device ids", () => {
    for (let i = 0; i < 50; i++) expect(isDeviceId(generateDeviceId())).toBe(true);
  });
});

describe("parseEvents", () => {
  it("drops an unterminated last line", () => {
    const text = encodeEvents([ev(1), ev(2)]) + encodeEvent(ev(3));
    expect(parseEvents(text).map((e) => e.t)).toEqual([1, 2]);
  });

  it("drops a torn last line even if it happens to parse", () => {
    const text = encodeEvent(ev(1)) + "\n" + '{"t":2,"d":"aaaaaaaa","card":"c","rating":3}';
    expect(parseEvents(text).map((e) => e.t)).toEqual([1]);
  });

  it("skips invalid terminated lines", () => {
    const text = encodeEvent(ev(1)) + "\ngarbage\n\n" + encodeEvent(ev(2)) + "\n";
    expect(parseEvents(text).map((e) => e.t)).toEqual([1, 2]);
  });

  it("trims to the last newline", () => {
    expect(trimToLastNewline("a\nb\nc")).toBe("a\nb\n");
    expect(trimToLastNewline("abc")).toBe("");
    expect(trimToLastNewline("a\n")).toBe("a\n");
  });
});

describe("ordering", () => {
  it("orders by t, then by device id", () => {
    expect(compareEvents(ev(1, "bbbbbbbb"), ev(2, "aaaaaaaa"))).toBeLessThan(0);
    expect(compareEvents(ev(5, "aaaaaaaa"), ev(5, "bbbbbbbb"))).toBeLessThan(0);
    expect(compareEvents(ev(5, "bbbbbbbb"), ev(5, "aaaaaaaa"))).toBeGreaterThan(0);
    expect(compareEvents(ev(5), ev(5))).toBe(0);
  });

  it("issues strictly increasing timestamps even if the clock goes back", () => {
    expect(nextTimestamp(100, 50)).toBe(100);
    expect(nextTimestamp(100, 100)).toBe(101);
    expect(nextTimestamp(90, 100)).toBe(101);
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 1000 })), (clock) => {
        let last = 0;
        for (const now of clock) {
          const t = nextTimestamp(now, last);
          expect(t).toBeGreaterThan(last);
          last = t;
        }
      }),
    );
  });
});
