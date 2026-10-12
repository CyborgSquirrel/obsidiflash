import {
  compareEvents,
  encodeEvent,
  encodeEvents,
  isReviewEvent,
  parseEvents,
  trimToLastNewline,
  type ReviewEvent,
} from "./event";
import { hashText } from "./hash";
import { writeAtomic, type Storage } from "./storage";

export const DEFAULT_BLOCK_SIZE = 1000;
const FORMAT_VERSION = "1";

/** Derived facts about a sealed block. Rebuildable from the block file. */
export interface BlockInfo {
  number: number;
  count: number;
  minT: number;
  maxT: number;
  hash: string;
}

export interface BlockLogOptions {
  /** Entries per block. Not stored: sealed blocks stay valid if this changes. */
  blockSize?: number;
}

const pad = (n: number): string => String(n).padStart(6, "0");
const BLOCK_FILE_RE = /^(\d+)\.jsonl$/;

function parseBlockNumber(name: string): number | null {
  const m = BLOCK_FILE_RE.exec(name);
  return m ? Number(m[1]) : null;
}

/** `sorted` must be sorted by `(t, d)`; `text` is its encoded form. */
function infoOf(number: number, sorted: readonly ReviewEvent[], text: string): BlockInfo {
  return {
    number,
    count: sorted.length,
    minT: sorted.length > 0 ? sorted[0]!.t : 0,
    maxT: sorted.length > 0 ? sorted[sorted.length - 1]!.t : 0,
    hash: hashText(text),
  };
}

function isBlockInfo(value: unknown, number: number): value is BlockInfo {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    o.number === number &&
    Number.isSafeInteger(o.count) &&
    Number.isSafeInteger(o.minT) &&
    Number.isSafeInteger(o.maxT) &&
    typeof o.hash === "string"
  );
}

/**
 * An append-only log of review events, stored as numbered blocks in a directory.
 *
 * The directory is the source of truth. A sealed block exists once its file has been
 * renamed into place, which is atomic. Sealed blocks are immutable and sorted by `(t, d)`.
 * At most one in-progress block holds entries in arrival order; it is sealed when it
 * reaches `blockSize` entries. Block numbers are never reused, and the in-progress block
 * keeps its number even if whole blocks are adopted after it.
 *
 * Layout under `dir`:
 *   VERSION               format version
 *   index.json            optional cache of per-block info; safe to delete
 *   open/NNNNNN.jsonl     the in-progress block (arrival order)
 *   sealed/NNNNNN.jsonl   sealed blocks (sorted)
 */
export class BlockLog {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly storage: Storage,
    private readonly dir: string,
    private readonly blockSize: number,
    private readonly sealed: Map<number, BlockInfo>,
    private openNumber: number | null,
    private open: ReviewEvent[],
  ) {}

  static async open(
    storage: Storage,
    dir: string,
    options: BlockLogOptions = {},
  ): Promise<BlockLog> {
    const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
    await storage.mkdir(`${dir}/sealed`);
    await storage.mkdir(`${dir}/open`);

    // Leftovers of interrupted atomic writes.
    for (const d of [dir, `${dir}/sealed`, `${dir}/open`]) {
      for (const name of await storage.list(d)) {
        if (name.endsWith(".tmp")) await storage.remove(`${d}/${name}`);
      }
    }

    const versionPath = `${dir}/VERSION`;
    const version = await storage.read(versionPath);
    if (version === null) await writeAtomic(storage, versionPath, FORMAT_VERSION + "\n");
    else if (version.trim() !== FORMAT_VERSION) {
      throw new Error(`unsupported log format version "${version.trim()}" in ${dir}`);
    }

    const sealedNumbers: number[] = [];
    for (const name of await storage.list(`${dir}/sealed`)) {
      const n = parseBlockNumber(name);
      if (n !== null) sealedNumbers.push(n);
    }
    sealedNumbers.sort((a, b) => a - b);
    const sealedSet = new Set(sealedNumbers);

    // An open file whose block is already sealed is stale (a seal was interrupted
    // after the rename but before the open file was removed).
    const openNumbers: number[] = [];
    for (const name of await storage.list(`${dir}/open`)) {
      const n = parseBlockNumber(name);
      if (n === null) continue;
      if (sealedSet.has(n)) await storage.remove(`${dir}/open/${name}`);
      else openNumbers.push(n);
    }
    if (openNumbers.length > 1) {
      throw new Error(`more than one in-progress block in ${dir}: ${openNumbers.join(", ")}`);
    }
    const openNumber = openNumbers[0] ?? null;

    let open: ReviewEvent[] = [];
    if (openNumber !== null) {
      const path = `${dir}/open/${pad(openNumber)}.jsonl`;
      let text = (await storage.read(path)) ?? "";
      if (text !== "" && !text.endsWith("\n")) {
        // Torn last line: rewrite the open block trimmed to its last newline.
        text = trimToLastNewline(text)
        await writeAtomic(storage, path, text);
      }
      open = parseEvents(text);
    }

    const sealed = await BlockLog.loadInfos(storage, dir, sealedNumbers);
    const log = new BlockLog(storage, dir, blockSize, sealed, openNumber, open);
    if (open.length >= blockSize) await log.run(() => log.sealOpen());
    return log;
  }

  /** Per-block info from the cache where valid, recomputed from the block files otherwise. */
  private static async loadInfos(
    storage: Storage,
    dir: string,
    numbers: readonly number[],
  ): Promise<Map<number, BlockInfo>> {
    const cached = await BlockLog.readIndex(storage, dir);
    const infos = new Map<number, BlockInfo>();
    let changed = false;
    for (const n of numbers) {
      const hit = cached.get(n);
      if (hit) {
        infos.set(n, hit);
        continue;
      }
      const text = await storage.read(`${dir}/sealed/${pad(n)}.jsonl`);
      if (text === null) continue;
      infos.set(n, infoOf(n, parseEvents(text), text));
      changed = true;
    }
    for (const n of cached.keys()) if (!infos.has(n)) changed = true;
    if (changed) await BlockLog.writeIndex(storage, dir, infos);
    return infos;
  }

  private static async readIndex(storage: Storage, dir: string): Promise<Map<number, BlockInfo>> {
    const out = new Map<number, BlockInfo>();
    const raw = await storage.read(`${dir}/index.json`);
    if (raw === null) return out;
    try {
      const parsed = JSON.parse(raw) as { version?: unknown; blocks?: unknown };
      if (parsed.version !== 1 || typeof parsed.blocks !== "object" || parsed.blocks === null) {
        return out;
      }
      for (const [key, value] of Object.entries(parsed.blocks)) {
        const n = Number(key);
        if (Number.isSafeInteger(n) && isBlockInfo(value, n)) out.set(n, value);
      }
    } catch {
      // A bad cache is just a missing cache.
    }
    return out;
  }

  private static async writeIndex(
    storage: Storage,
    dir: string,
    infos: ReadonlyMap<number, BlockInfo>,
  ): Promise<void> {
    const blocks: Record<string, BlockInfo> = {};
    for (const [n, info] of infos) blocks[String(n)] = info;
    await writeAtomic(storage, `${dir}/index.json`, JSON.stringify({ version: 1, blocks }));
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private nextNumber(): number {
    let max = this.openNumber ?? 0;
    for (const n of this.sealed.keys()) if (n > max) max = n;
    return max + 1;
  }

  private openPath(n: number): string {
    return `${this.dir}/open/${pad(n)}.jsonl`;
  }

  private sealedPath(n: number): string {
    return `${this.dir}/sealed/${pad(n)}.jsonl`;
  }

  private async sealOpen(): Promise<void> {
    const n = this.openNumber;
    if (n === null) return;
    const sorted = [...this.open].sort(compareEvents);
    const text = encodeEvents(sorted);
    // Renaming the file into place is the commit.
    await writeAtomic(this.storage, this.sealedPath(n), text);
    this.sealed.set(n, infoOf(n, sorted, text));
    this.open = [];
    this.openNumber = null;
    await this.storage.remove(this.openPath(n));
    await BlockLog.writeIndex(this.storage, this.dir, this.sealed);
  }

  /** Append one event. Durable once the returned promise resolves. */
  append(event: ReviewEvent): Promise<void> {
    return this.appendMany([event]);
  }

  appendMany(events: readonly ReviewEvent[]): Promise<void> {
    return this.run(async () => {
      for (const e of events) {
        if (!isReviewEvent(e)) throw new Error("invalid review event");
        if (this.openNumber === null) this.openNumber = this.nextNumber();
        await this.storage.append(this.openPath(this.openNumber), encodeEvent(e) + "\n");
        this.open.push(e);
        if (this.open.length >= this.blockSize) await this.sealOpen();
      }
    });
  }

  /**
   * Add a whole, already sealed block, giving it the next free block number.
   * The events must be strictly ascending by `(t, d)`. The in-progress block keeps
   * its number. Returns the new block's info.
   */
  adoptSealedBlock(events: readonly ReviewEvent[]): Promise<BlockInfo> {
    return this.run(async () => {
      if (events.length === 0) throw new Error("cannot adopt an empty block");
      for (let i = 0; i < events.length; i++) {
        const e = events[i]!;
        if (!isReviewEvent(e)) throw new Error("invalid review event");
        if (i > 0 && compareEvents(events[i - 1]!, e) >= 0) {
          throw new Error("block is not strictly ascending by (t, d)");
        }
      }
      const n = this.nextNumber();
      const text = encodeEvents(events);
      await writeAtomic(this.storage, this.sealedPath(n), text);
      const info = infoOf(n, events, text);
      this.sealed.set(n, info);
      await BlockLog.writeIndex(this.storage, this.dir, this.sealed);
      return info;
    });
  }

  /** Sealed blocks, ascending by number. */
  blocks(): BlockInfo[] {
    return [...this.sealed.values()].sort((a, b) => a.number - b.number).map((b) => ({ ...b }));
  }

  /** Number of the in-progress block, or null if there is none yet. */
  openBlockNumber(): number | null {
    return this.openNumber;
  }

  /** Events of the in-progress block, in arrival order. */
  openEvents(): ReviewEvent[] {
    return [...this.open];
  }

  /** Events of a sealed block, sorted by `(t, d)`. */
  async readSealed(number: number): Promise<ReviewEvent[]> {
    return parseEvents(await this.readSealedText(number));
  }

  /** The raw text of a sealed block, as stored. */
  async readSealedText(number: number): Promise<string> {
    const text = await this.storage.read(this.sealedPath(number));
    if (text === null) throw new Error(`no sealed block ${number}`);
    return text;
  }

  /** Every block as an array sorted by `(t, d)`, ready for `mergeSorted`. */
  async sortedSources(): Promise<ReviewEvent[][]> {
    const sources: ReviewEvent[][] = [];
    for (const b of this.blocks()) sources.push(await this.readSealed(b.number));
    if (this.open.length > 0) sources.push([...this.open].sort(compareEvents));
    return sources;
  }

  /** The largest timestamp in the log, or 0 if it is empty. */
  maxT(): number {
    let max = 0;
    for (const b of this.sealed.values()) if (b.maxT > max) max = b.maxT;
    for (const e of this.open) if (e.t > max) max = e.t;
    return max;
  }

  /** Wait for all queued operations. */
  idle(): Promise<void> {
    return this.queue.then(() => undefined);
  }
}
