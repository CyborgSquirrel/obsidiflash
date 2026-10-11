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
    expect(log.getManifest().sealed).toEqual([]);
    expect(log.openEvents()).toEqual([]);
    expect(log.maxT()).toBe(0);
    expect(await all(log)).toEqual([]);
  });

  it("keeps entries in the open block until it fills, then seals it sorted", async () => {
    const log = await BlockLog.open(new MemoryStorage(), "log", { blockSize: 4 });
    // Arrival order differs from key order (two devices interleaved).
    const inputs = [ev(10, "bbbbbbbb"), ev(5, "aaaaaaaa"), ev(11, "bbbbbbbb"), ev(7, "aaaaaaaa")];
    for (const e of inputs.slice(0, 3)) await log.append(e);
    expect(log.getManifest().sealed).toEqual([]);
    expect(log.openEvents()).toEqual(inputs.slice(0, 3));

    await log.append(inputs[3]!);
    const m = log.getManifest();
    expect(m.sealed).toHaveLength(1);
    expect(m.sealed[0]).toMatchObject({ number: 1, count: 4, minT: 5, maxT: 11 });
    expect(m.openBlock).toBe(2);
    expect(log.openEvents()).toEqual([]);
    expect(await log.readSealed(1)).toEqual([...inputs].sort(compareEvents));
  });

  it("reports the largest timestamp across sealed and open blocks", async () => {
    const log = await BlockLog.open(new MemoryStorage(), "log", { blockSize: 2 });
    await log.appendMany([ev(1), ev(2), ev(3)]);
    expect(log.maxT()).toBe(3);
    await log.append(ev(4));
    expect(log.maxT()).toBe(4);
  });

  it("rejects invalid events without writing them", async () => {
    const storage = new MemoryStorage();
    const log = await BlockLog.open(storage, "log", { blockSize: 4 });
    await expect(log.append({ ...ev(1), d: "nope" })).rejects.toThrow();
    expect(log.openEvents()).toEqual([]);
    expect(await storage.read("log/open/000001.jsonl")).toBeNull();
  });

  it("reopens with the same state, using the stored block size", async () => {
    const storage = new MemoryStorage();
    const a = await BlockLog.open(storage, "log", { blockSize: 3 });
    await a.appendMany([ev(1), ev(2), ev(3), ev(4)]);
    const b = await BlockLog.open(storage, "log", { blockSize: 999 });
    expect(b.getManifest()).toEqual(a.getManifest());
    expect(b.openEvents()).toEqual([ev(4)]);
    expect(await all(b)).toEqual([ev(1), ev(2), ev(3), ev(4)]);
  });

  it("repairs a torn last line in the open block", async () => {
    const storage = new MemoryStorage();
    const a = await BlockLog.open(storage, "log", { blockSize: 10 });
    await a.appendMany([ev(1), ev(2)]);
    storage.files.set("log/open/000001.jsonl", encodeEvents([ev(1), ev(2)]) + '{"t":3,"d":"aaaa');

    const b = await BlockLog.open(storage, "log");
    expect(b.openEvents().map((e) => e.t)).toEqual([1, 2]);
    // The file itself was trimmed, so the next append is not glued onto the fragment.
    await b.append(ev(4));
    const c = await BlockLog.open(storage, "log");
    expect(c.openEvents().map((e) => e.t)).toEqual([1, 2, 4]);
  });

  it("removes orphaned sealed files and stale open files on open", async () => {
    const storage = new MemoryStorage();
    const a = await BlockLog.open(storage, "log", { blockSize: 2 });
    await a.appendMany([ev(1), ev(2)]); // sealed block 1, open block is now 2
    storage.files.set("log/sealed/000007.jsonl", encodeEvents([ev(9)])); // never committed
    storage.files.set("log/open/000001.jsonl", encodeEvents([ev(1), ev(2)])); // stale
    storage.files.set("log/manifest.json.tmp", "garbage");

    const b = await BlockLog.open(storage, "log");
    expect([...storage.files.keys()].sort()).toEqual([
      "log/manifest.json",
      "log/sealed/000001.jsonl",
    ]);
    expect(await all(b)).toEqual([ev(1), ev(2)]);
  });

  it("seals on open if the open block is already full", async () => {
    const storage = new MemoryStorage();
    const a = await BlockLog.open(storage, "log", { blockSize: 2 });
    await a.append(ev(1));
    storage.files.set("log/open/000001.jsonl", encodeEvents([ev(2), ev(1)]));
    const b = await BlockLog.open(storage, "log");
    expect(b.getManifest().sealed).toHaveLength(1);
    expect(await b.readSealed(1)).toEqual([ev(1), ev(2)]);
  });

  it("refuses a corrupt manifest instead of starting over", async () => {
    const storage = new MemoryStorage();
    storage.files.set("log/manifest.json", "{ nope");
    await expect(BlockLog.open(storage, "log")).rejects.toThrow(/corrupt manifest/);
  });

  describe("adoptSealedBlock", () => {
    it("gives the block the next number and leaves the open block's number alone", async () => {
      const log = await BlockLog.open(new MemoryStorage(), "log", { blockSize: 3 });
      await log.appendMany([ev(1, "bbbbbbbb"), ev(2, "bbbbbbbb")]); // open block 1, partly filled
      const info = await log.adoptSealedBlock([ev(10), ev(11), ev(12)]);
      expect(info).toMatchObject({ number: 2, count: 3, minT: 10, maxT: 12 });
      expect(log.getManifest().openBlock).toBe(1);

      // The open block fills and seals afterwards; numbers stay unique and ordered.
      await log.append(ev(3, "bbbbbbbb"));
      const m = log.getManifest();
      expect(m.sealed.map((b) => b.number)).toEqual([1, 2]);
      expect(m.openBlock).toBe(3);
      expect((await all(log)).map((e) => e.t)).toEqual([1, 2, 3, 10, 11, 12]);
    });

    it("rejects empty, unsorted, or duplicate-key blocks", async () => {
      const log = await BlockLog.open(new MemoryStorage(), "log", { blockSize: 3 });
      await expect(log.adoptSealedBlock([])).rejects.toThrow();
      await expect(log.adoptSealedBlock([ev(2), ev(1)])).rejects.toThrow(/ascending/);
      await expect(log.adoptSealedBlock([ev(1), ev(1)])).rejects.toThrow(/ascending/);
      expect(log.getManifest().sealed).toEqual([]);
    });

    it("stores the exact bytes it was given", async () => {
      const log = await BlockLog.open(new MemoryStorage(), "log", { blockSize: 3 });
      const events = [ev(10), ev(11), ev(12)];
      await log.adoptSealedBlock(events);
      expect(await log.readSealedText(2)).toBe(encodeEvents(events));
    });
  });

  it("serializes concurrent appends", async () => {
    const log = await BlockLog.open(new MemoryStorage(), "log", { blockSize: 5 });
    const events = Array.from({ length: 23 }, (_, i) => ev(i + 1));
    await Promise.all(events.map((e) => log.append(e)));
    expect(await all(log)).toEqual(events);
    expect(log.getManifest().sealed).toHaveLength(4);
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
