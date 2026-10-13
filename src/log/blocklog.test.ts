import { describe, expect, it } from "vitest";
import { BlockLog } from "./blocklog";
import { compareEvents, encodeEvent, encodeEvents, type ReviewEvent } from "./event";
import { mergeToArray } from "./merge";
import { MemoryStorage } from "./storage";
import { CrashingStorage, ev } from "./test-utils";

async function all(log: BlockLog): Promise<ReviewEvent[]> {
  return mergeToArray(await log.sortedSources());
}

describe("BlockLog", () => {
  it("starts empty", async () => {
    const log = await BlockLog.open(new MemoryStorage(), "log", { blockSize: 4 });
    expect(log.blocks()).toEqual([]);
    expect(log.openBlockNumber()).toBe(1);
    expect(log.openEvents()).toEqual([]);
    expect(await log.lastT()).toBe(0);
    expect(await all(log)).toEqual([]);
  });

  it("keeps entries in the open block until it fills, then seals it sorted", async () => {
    const log = await BlockLog.open(new MemoryStorage(), "log", { blockSize: 4 });
    // Arrival order differs from key order (two devices interleaved).
    const inputs = [ev(10, "bbbbbbbb"), ev(5, "aaaaaaaa"), ev(11, "bbbbbbbb"), ev(7, "aaaaaaaa")];
    for (const e of inputs.slice(0, 3)) await log.append(e);
    expect(log.blocks()).toEqual([]);
    expect(log.openBlockNumber()).toBe(1);
    expect(log.openEvents()).toEqual(inputs.slice(0, 3));

    await log.append(inputs[3]!);
    expect(log.blocks()).toEqual([1]);
    expect(log.openBlockNumber()).toBe(2);
    expect(log.openEvents()).toEqual([]);
    expect(await log.readSealed(1)).toEqual([...inputs].sort(compareEvents));

    // The next append starts block 2.
    await log.append(ev(20));
    expect(log.openBlockNumber()).toBe(2);
  });

  it("removes the open file when its block seals", async () => {
    const storage = new MemoryStorage();
    const log = await BlockLog.open(storage, "log", { blockSize: 2 });
    await log.appendMany([ev(1), ev(2)]);
    expect([...storage.files.keys()].filter((k) => k.includes("/open/"))).toEqual([]);
    expect(storage.files.has("log/sealed/000001.jsonl")).toBe(true);
  });

  it("reports the last timestamp, reading a sealed block only if the open block is empty", async () => {
    const log = await BlockLog.open(new MemoryStorage(), "log", { blockSize: 2 });
    await log.appendMany([ev(1), ev(2), ev(3)]); // block 1 sealed, open holds 3
    expect(await log.lastT()).toBe(3);
    await log.append(ev(4)); // block 2 sealed, open empty
    expect(log.openEvents()).toEqual([]);
    expect(await log.lastT()).toBe(4);
  });

  it("rejects invalid events without writing them", async () => {
    const storage = new MemoryStorage();
    const log = await BlockLog.open(storage, "log", { blockSize: 4 });
    await expect(log.append({ ...ev(1), d: "nope" })).rejects.toThrow();
    expect(log.openEvents()).toEqual([]);
    expect(await storage.read("log/open/000001.jsonl")).toBeNull();
  });

  it("reopens with the same state", async () => {
    const storage = new MemoryStorage();
    const a = await BlockLog.open(storage, "log", { blockSize: 3 });
    await a.appendMany([ev(1), ev(2), ev(3), ev(4)]);
    const b = await BlockLog.open(storage, "log", { blockSize: 3 });
    expect(b.blocks()).toEqual(a.blocks());
    expect(b.openBlockNumber()).toBe(a.openBlockNumber());
    expect(b.openEvents()).toEqual([ev(4)]);
    expect(await all(b)).toEqual([ev(1), ev(2), ev(3), ev(4)]);
  });

  it("repairs a torn last line in the open block", async () => {
    const storage = new MemoryStorage();
    const a = await BlockLog.open(storage, "log", { blockSize: 10 });
    await a.appendMany([ev(1), ev(2)]);
    storage.files.set("log/open/000001.jsonl", encodeEvents([ev(1), ev(2)]) + '{"t":3,"d":"aaaa');

    const b = await BlockLog.open(storage, "log", { blockSize: 10 });
    expect(b.openEvents().map((e) => e.t)).toEqual([1, 2]);
    // The file itself was trimmed, so the next append is not glued onto the fragment.
    await b.append(ev(4));
    const c = await BlockLog.open(storage, "log", { blockSize: 10 });
    expect(c.openEvents().map((e) => e.t)).toEqual([1, 2, 4]);
  });

  it("seals on open if the open block is already full", async () => {
    const storage = new MemoryStorage();
    const a = await BlockLog.open(storage, "log", { blockSize: 2 });
    await a.append(ev(1));
    storage.files.set("log/open/000001.jsonl", encodeEvents([ev(2), ev(1)]));
    const b = await BlockLog.open(storage, "log", { blockSize: 2 });
    expect(b.blocks()).toEqual([1]);
    expect(await b.readSealed(1)).toEqual([ev(1), ev(2)]);
  });

  describe("recovery", () => {
    it("removes a stale open file whose block is already sealed, and temp files", async () => {
      const storage = new MemoryStorage();
      const a = await BlockLog.open(storage, "log", { blockSize: 2 });
      await a.appendMany([ev(1), ev(2)]); // sealed block 1
      storage.files.set("log/open/000001.jsonl", encodeEvents([ev(1), ev(2)])); // stale
      storage.files.set("log/VERSION.tmp", "garbage");
      storage.files.set("log/sealed/000002.jsonl.tmp", "garbage");

      const b = await BlockLog.open(storage, "log", { blockSize: 2 });
      expect(b.openBlockNumber()).toBe(2);
      expect([...storage.files.keys()].sort()).toEqual(["log/VERSION", "log/sealed/000001.jsonl"]);
      expect(await all(b)).toEqual([ev(1), ev(2)]);
    });

    it("treats a sealed file as committed once it is in place, and never reuses numbers", async () => {
      const storage = new MemoryStorage();
      storage.files.set("log/sealed/000003.jsonl", encodeEvents([ev(5), ev(6)]));
      const log = await BlockLog.open(storage, "log", { blockSize: 2 });
      expect(log.blocks()).toEqual([3]);
      await log.append(ev(7));
      expect(log.openBlockNumber()).toBe(4);
    });

    it("refuses an unsupported format version", async () => {
      const storage = new MemoryStorage();
      storage.files.set("log/VERSION", "99\n");
      await expect(BlockLog.open(storage, "log")).rejects.toThrow(/unsupported log format/);
    });

    it("refuses more than one in-progress block", async () => {
      const storage = new MemoryStorage();
      storage.files.set("log/open/000001.jsonl", encodeEvents([ev(1)]));
      storage.files.set("log/open/000002.jsonl", encodeEvents([ev(2)]));
      await expect(BlockLog.open(storage, "log")).rejects.toThrow(/more than one in-progress/);
    });
  });

  it("serializes concurrent appends", async () => {
    const log = await BlockLog.open(new MemoryStorage(), "log", { blockSize: 5 });
    const events = Array.from({ length: 23 }, (_, i) => ev(i + 1));
    await Promise.all(events.map((e) => log.append(e)));
    expect(await all(log)).toEqual(events);
    expect(log.blocks()).toHaveLength(4);
  });
});

describe("crash recovery", () => {
  it("never loses acknowledged events nor duplicates any, whatever op the crash hits", async () => {
    const events = Array.from({ length: 11 }, (_, i) => ev(i + 1));

    // Learn how many mutating operations a clean run takes.
    const probe = new CrashingStorage();
    const clean = await BlockLog.open(probe, "log", { blockSize: 3 });
    for (const e of events) await clean.append(e);
    const total = probe.ops;
    expect(total).toBeGreaterThan(events.length);

    for (let crashAt = 0; crashAt <= total; crashAt++) {
      const storage = new CrashingStorage();
      storage.crashAt = crashAt;
      let acked = 0;
      let attempted = 0;
      try {
        const log = await BlockLog.open(storage, "log", { blockSize: 3 });
        for (const e of events) {
          attempted++;
          await log.append(e);
          acked++;
        }
      } catch {
        // simulated crash
      }

      const reopened = await BlockLog.open(storage.survivor(), "log", { blockSize: 3 });
      const got = await all(reopened);
      // Events are appended in increasing t, so the log must be a prefix of the input.
      expect(got, `crashAt=${crashAt}`).toEqual(events.slice(0, got.length));
      expect(got.length, `crashAt=${crashAt}`).toBeGreaterThanOrEqual(acked);
      expect(got.length, `crashAt=${crashAt}`).toBeLessThanOrEqual(attempted);

      // And it keeps working after recovery.
      await reopened.append(ev(1000));
      const after = await all(reopened);
      expect(after[after.length - 1]).toEqual(ev(1000));
    }
  });
});

describe("line format", () => {
  it("writes one JSON line per event to the open block", async () => {
    const storage = new MemoryStorage();
    const log = await BlockLog.open(storage, "log", { blockSize: 10 });
    await log.appendMany([ev(1), ev(2)]);
    expect(await storage.read("log/open/000001.jsonl")).toBe(
      encodeEvent(ev(1)) + "\n" + encodeEvent(ev(2)) + "\n",
    );
  });
});
