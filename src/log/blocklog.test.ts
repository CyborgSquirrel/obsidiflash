import { describe, expect, it } from "vitest";
import { BlockLog } from "./blocklog";
import { compareEvents, encodeEvent, encodeEvents, type ReviewEvent } from "./event";
import { mergeToArray } from "./merge";
import { MemoryStorage } from "./storage";
import { CrashingStorage, ev } from "./test-utils";

async function all(log: BlockLog): Promise<ReviewEvent[]> {
  return mergeToArray(await log.sortedSources());
}

const keyOf = (e: ReviewEvent) => `${e.t}/${e.d}`;

describe("BlockLog", () => {
  it("starts empty", async () => {
    const log = await BlockLog.open(new MemoryStorage(), "log", { blockSize: 4 });
    expect(log.blocks()).toEqual([]);
    expect(log.openBlockNumber()).toBeNull();
    expect(log.openEvents()).toEqual([]);
    expect(log.maxT()).toBe(0);
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
    expect(log.blocks()).toHaveLength(1);
    expect(log.blocks()[0]).toMatchObject({ number: 1, count: 4, minT: 5, maxT: 11 });
    expect(log.openBlockNumber()).toBeNull();
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
    expect(b.blocks()).toHaveLength(1);
    expect(await b.readSealed(1)).toEqual([ev(1), ev(2)]);
  });

  describe("recovery", () => {
    it("removes a stale open file whose block is already sealed, and temp files", async () => {
      const storage = new MemoryStorage();
      const a = await BlockLog.open(storage, "log", { blockSize: 2 });
      await a.appendMany([ev(1), ev(2)]); // sealed block 1
      storage.files.set("log/open/000001.jsonl", encodeEvents([ev(1), ev(2)])); // stale
      storage.files.set("log/index.json.tmp", "garbage");
      storage.files.set("log/sealed/000002.jsonl.tmp", "garbage");

      const b = await BlockLog.open(storage, "log", { blockSize: 2 });
      expect(b.openBlockNumber()).toBeNull();
      expect([...storage.files.keys()].sort()).toEqual([
        "log/VERSION",
        "log/index.json",
        "log/sealed/000001.jsonl",
      ]);
      expect(await all(b)).toEqual([ev(1), ev(2)]);
    });

    it("treats a sealed file as committed once it is in place", async () => {
      // An adopted block whose caller never heard back: the file exists, so it counts.
      const storage = new MemoryStorage();
      storage.files.set("log/sealed/000003.jsonl", encodeEvents([ev(5), ev(6)]));
      const log = await BlockLog.open(storage, "log", { blockSize: 2 });
      expect(log.blocks().map((b) => b.number)).toEqual([3]);
      // Numbers are never reused.
      await log.append(ev(7));
      expect(log.openBlockNumber()).toBe(4);
    });

    it("rebuilds the index when it is missing, bad, or stale", async () => {
      const storage = new MemoryStorage();
      const a = await BlockLog.open(storage, "log", { blockSize: 2 });
      await a.appendMany([ev(1), ev(2), ev(3), ev(4)]);
      const expected = a.blocks();
      const good = storage.files.get("log/index.json")!;
      expect(expected).toHaveLength(2);

      storage.files.delete("log/index.json");
      expect((await BlockLog.open(storage, "log", { blockSize: 2 })).blocks()).toEqual(expected);
      expect(storage.files.get("log/index.json")).toBe(good);

      storage.files.set("log/index.json", "{ nope");
      expect((await BlockLog.open(storage, "log", { blockSize: 2 })).blocks()).toEqual(expected);

      // An entry for a block that no longer exists is dropped.
      const withExtra = JSON.parse(good) as { blocks: Record<string, unknown> };
      withExtra.blocks["9"] = { number: 9, count: 1, minT: 1, maxT: 1, hash: "x" };
      storage.files.set("log/index.json", JSON.stringify(withExtra));
      expect((await BlockLog.open(storage, "log", { blockSize: 2 })).blocks()).toEqual(expected);
      expect(storage.files.get("log/index.json")).toBe(good);
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

  describe("adoptSealedBlock", () => {
    it("gives the block the next number and leaves the open block's number alone", async () => {
      const log = await BlockLog.open(new MemoryStorage(), "log", { blockSize: 3 });
      await log.appendMany([ev(1, "bbbbbbbb"), ev(2, "bbbbbbbb")]); // open block 1, partly filled
      const info = await log.adoptSealedBlock([ev(10), ev(11), ev(12)]);
      expect(info).toMatchObject({ number: 2, count: 3, minT: 10, maxT: 12 });
      expect(log.openBlockNumber()).toBe(1);

      // The open block fills and seals afterwards; numbers stay unique and ascending.
      await log.append(ev(3, "bbbbbbbb"));
      expect(log.blocks().map((b) => b.number)).toEqual([1, 2]);
      expect(log.openBlockNumber()).toBeNull();
      await log.append(ev(4, "bbbbbbbb"));
      expect(log.openBlockNumber()).toBe(3);
      expect((await all(log)).map((e) => e.t)).toEqual([1, 2, 3, 4, 10, 11, 12]);
    });

    it("rejects empty, unsorted, or duplicate-key blocks", async () => {
      const log = await BlockLog.open(new MemoryStorage(), "log", { blockSize: 3 });
      await expect(log.adoptSealedBlock([])).rejects.toThrow();
      await expect(log.adoptSealedBlock([ev(2), ev(1)])).rejects.toThrow(/ascending/);
      await expect(log.adoptSealedBlock([ev(1), ev(1)])).rejects.toThrow(/ascending/);
      expect(log.blocks()).toEqual([]);
    });

    it("stores the exact bytes it was given", async () => {
      const log = await BlockLog.open(new MemoryStorage(), "log", { blockSize: 3 });
      const events = [ev(10), ev(11), ev(12)];
      const info = await log.adoptSealedBlock(events);
      expect(await log.readSealedText(info.number)).toBe(encodeEvents(events));
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

  it("adopts a whole block or none of it, at every crash point", async () => {
    const A = [ev(1), ev(2), ev(3), ev(4)];
    const B = [ev(100, "bbbbbbbb"), ev(101, "bbbbbbbb"), ev(102, "bbbbbbbb")];
    const C = [ev(5), ev(6), ev(7), ev(8)];

    const run = async (storage: CrashingStorage, progress: { acked: ReviewEvent[]; adopted: boolean }) => {
      const log = await BlockLog.open(storage, "log", { blockSize: 3 });
      for (const e of A) {
        await log.append(e);
        progress.acked.push(e);
      }
      await log.adoptSealedBlock(B);
      progress.adopted = true;
      for (const e of C) {
        await log.append(e);
        progress.acked.push(e);
      }
    };

    const probe = new CrashingStorage();
    await run(probe, { acked: [], adopted: false });
    const total = probe.ops;

    for (let crashAt = 0; crashAt <= total; crashAt++) {
      const storage = new CrashingStorage();
      storage.crashAt = crashAt;
      const progress = { acked: [] as ReviewEvent[], adopted: false };
      try {
        await run(storage, progress);
      } catch {
        // simulated crash
      }

      const reopened = await BlockLog.open(storage.survivor(), "log", { blockSize: 3 });
      const got = await all(reopened);
      const where = `crashAt=${crashAt}`;

      expect(new Set(got.map(keyOf)).size, where).toBe(got.length); // no duplicates
      for (const e of progress.acked) expect(got.map(keyOf), where).toContain(keyOf(e));

      const gotB = got.filter((e) => e.d === "bbbbbbbb");
      expect([0, B.length], where).toContain(gotB.length); // all or nothing
      if (progress.adopted) expect(gotB.length, where).toBe(B.length);

      const gotAC = got.filter((e) => e.d === "aaaaaaaa");
      expect(gotAC, where).toEqual([...A, ...C].slice(0, gotAC.length));
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
