import type { DataAdapter } from "obsidian";
import { describe, expect, it } from "vitest";
import { BlockLog } from "../log/blocklog";
import { mergeToArray } from "../log/merge";
import { ev } from "../log/test-utils";
import { ObsidianStorage } from "./storage";

/**
 * A fake vault adapter. The flags reproduce platform behaviors we cannot rely on:
 * rename that refuses to replace an existing file, and append that needs an existing file.
 */
class FakeAdapter {
  files = new Map<string, string>();
  folders = new Set<string>();
  renameRefusesExisting = false;
  appendNeedsFile = true;
  renameCalls = 0;

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }
  async read(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  }
  async write(path: string, data: string): Promise<void> {
    this.requireParent(path);
    this.files.set(path, data);
  }
  async append(path: string, data: string): Promise<void> {
    const cur = this.files.get(path);
    if (cur === undefined) {
      if (this.appendNeedsFile) throw new Error(`ENOENT: ${path}`);
      this.requireParent(path);
      this.files.set(path, data);
      return;
    }
    this.files.set(path, cur + data);
  }
  async remove(path: string): Promise<void> {
    if (!this.files.delete(path)) throw new Error(`ENOENT: ${path}`);
  }
  async rename(from: string, to: string): Promise<void> {
    this.renameCalls++;
    const v = this.files.get(from);
    if (v === undefined) throw new Error(`ENOENT: ${from}`);
    if (this.renameRefusesExisting && this.files.has(to)) throw new Error("Destination file already exists!");
    this.files.delete(from);
    this.files.set(to, v);
  }
  async mkdir(path: string): Promise<void> {
    this.requireParent(path);
    this.folders.add(path);
  }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = path + "/";
    const direct = (p: string) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/");
    return {
      files: [...this.files.keys()].filter(direct),
      folders: [...this.folders].filter(direct),
    };
  }

  private requireParent(path: string): void {
    const i = path.lastIndexOf("/");
    if (i > 0 && !this.folders.has(path.slice(0, i))) throw new Error(`ENOENT (parent): ${path}`);
  }
}

const make = () => {
  const adapter = new FakeAdapter();
  return { adapter, storage: new ObsidianStorage(adapter as unknown as DataAdapter) };
};

describe("ObsidianStorage", () => {
  it("returns null for a missing file and reports existence", async () => {
    const { storage } = make();
    expect(await storage.read("a.txt")).toBeNull();
    expect(await storage.exists("a.txt")).toBe(false);
    await storage.write("a.txt", "x");
    expect(await storage.read("a.txt")).toBe("x");
    expect(await storage.exists("a.txt")).toBe(true);
  });

  it("creates parent directories one level at a time and is idempotent", async () => {
    const { adapter, storage } = make();
    await storage.mkdir(".obsidiflash/log/sealed");
    expect([...adapter.folders].sort()).toEqual([".obsidiflash", ".obsidiflash/log", ".obsidiflash/log/sealed"]);
    await storage.mkdir(".obsidiflash/log/sealed"); // no error the second time
  });

  it("append creates a missing file even when the adapter's append would fail", async () => {
    const { adapter, storage } = make();
    adapter.appendNeedsFile = true;
    await storage.append("f.txt", "one\n");
    await storage.append("f.txt", "two\n");
    expect(await storage.read("f.txt")).toBe("one\ntwo\n");
  });

  it("append works after the file is removed behind its back", async () => {
    const { adapter, storage } = make();
    await storage.append("f.txt", "one\n");
    adapter.files.delete("f.txt"); // removed externally while the cache still lists it
    await expect(storage.append("f.txt", "two\n")).rejects.toThrow(); // surfaced, not silently wrong
    await storage.remove("f.txt"); // clears the cache entry
    await storage.append("f.txt", "three\n");
    expect(await storage.read("f.txt")).toBe("three\n");
  });

  it("removing a missing file is not an error", async () => {
    const { storage } = make();
    await expect(storage.remove("nope")).resolves.toBeUndefined();
  });

  it("renames onto an existing file even if the adapter refuses to", async () => {
    const { adapter, storage } = make();
    adapter.renameRefusesExisting = true;
    await storage.write("target", "old");
    await storage.write("target.tmp", "new");
    await storage.rename("target.tmp", "target");
    expect(await storage.read("target")).toBe("new");
    expect(await storage.exists("target.tmp")).toBe(false);
  });

  it("uses the plain rename when the destination is free", async () => {
    const { adapter, storage } = make();
    adapter.renameRefusesExisting = true;
    await storage.write("a", "x");
    await storage.rename("a", "b");
    expect(adapter.renameCalls).toBe(1);
    expect(await storage.read("b")).toBe("x");
  });

  it("surfaces a rename whose source is missing", async () => {
    const { storage } = make();
    await expect(storage.rename("missing", "b")).rejects.toThrow();
  });

  it("lists only the file names directly inside a directory", async () => {
    const { storage } = make();
    await storage.mkdir("d/sub");
    await storage.write("d/a.jsonl", "");
    await storage.write("d/b.jsonl", "");
    await storage.write("d/sub/c.jsonl", "");
    expect((await storage.list("d")).sort()).toEqual(["a.jsonl", "b.jsonl"]);
    expect(await storage.list("missing")).toEqual([]);
  });

  it("runs a BlockLog end to end, including a reopen, on the platform quirks", async () => {
    const { adapter, storage } = make();
    adapter.renameRefusesExisting = true;
    adapter.appendNeedsFile = true;
    const events = Array.from({ length: 7 }, (_, i) => ev(i + 1));

    const log = await BlockLog.open(storage, ".obsidiflash/local", { blockSize: 3 });
    await log.appendMany(events);
    expect(log.openBlockNumber()).toBe(3); // blocks 1 and 2 sealed

    const reopened = await BlockLog.open(new ObsidianStorage(adapter as unknown as DataAdapter), ".obsidiflash/local", {
      blockSize: 3,
    });
    expect(mergeToArray(await reopened.sortedSources())).toEqual(events);
  });
});
