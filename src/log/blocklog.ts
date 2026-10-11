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

export interface BlockInfo {
  number: number;
  count: number;
  minT: number;
  maxT: number;
  hash: string;
}

export interface Manifest {
  version: 1;
  blockSize: number;
  /** Next block number to hand out. */
  nextBlock: number;
  /** Number of the in-progress block. Not necessarily the highest block number. */
  openBlock: number;
  /** Sealed blocks, ascending by number. */
  sealed: BlockInfo[];
}

export interface BlockLogOptions {
  /** Entries per block for a new log. An existing log keeps the size in its manifest. */
  blockSize?: number;
}

const pad = (n: number): string => String(n).padStart(6, "0");
const BLOCK_FILE_RE = /^(\d+)\.jsonl$/;

function parseBlockNumber(name: string): number | null {
  const m = BLOCK_FILE_RE.exec(name);
  return m ? Number(m[1]) : null;
}

function isManifest(value: unknown): value is Manifest {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    o.version === 1 &&
    Number.isInteger(o.blockSize) &&
    Number.isInteger(o.nextBlock) &&
    Number.isInteger(o.openBlock) &&
    Array.isArray(o.sealed)
  );
}

/**
 * An append-only log of review events, stored as numbered blocks in a directory.
 *
 * Sealed blocks are immutable and sorted by `(t, d)`. One in-progress block holds
 * entries in arrival order and is sealed when it reaches `blockSize` entries.
 *
 * Layout under `dir`:
 *   manifest.json
 *   open/NNNNNN.jsonl     the in-progress block (arrival order)
 *   sealed/NNNNNN.jsonl   sealed blocks (sorted)
 */
export class BlockLog {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly storage: Storage,
    private readonly dir: string,
    private manifest: Manifest,
    private open: ReviewEvent[],
  ) {}

  static async open(
    storage: Storage,
    dir: string,
    options: BlockLogOptions = {},
  ): Promise<BlockLog> {
    await storage.mkdir(`${dir}/sealed`);
    await storage.mkdir(`${dir}/open`);

    const manifestPath = `${dir}/manifest.json`;
    const raw = await storage.read(manifestPath);
    let manifest: Manifest;
    if (raw === null) {
      manifest = {
        version: 1,
        blockSize: options.blockSize ?? DEFAULT_BLOCK_SIZE,
        nextBlock: 2,
        openBlock: 1,
        sealed: [],
      };
      await writeAtomic(storage, manifestPath, JSON.stringify(manifest));
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`corrupt manifest: ${manifestPath}`);
      }
      if (!isManifest(parsed)) throw new Error(`unsupported manifest: ${manifestPath}`);
      manifest = parsed;
    }

    await BlockLog.recover(storage, dir, manifest);

    const openPath = `${dir}/open/${pad(manifest.openBlock)}.jsonl`;
    const text = (await storage.read(openPath)) ?? "";
    if (text !== "" && !text.endsWith("\n")) {
      // Torn last line: rewrite the open block trimmed to its last newline.
      await writeAtomic(storage, openPath, trimToLastNewline(text));
    }
    const open = parseEvents((await storage.read(openPath)) ?? "");

    const log = new BlockLog(storage, dir, manifest, open);
    if (open.length >= manifest.blockSize) await log.run(() => log.sealOpen());
    return log;
  }

  /** Remove leftovers of interrupted operations. */
  private static async recover(storage: Storage, dir: string, manifest: Manifest): Promise<void> {
    for (const name of await storage.list(dir)) {
      if (name.endsWith(".tmp")) await storage.remove(`${dir}/${name}`);
    }
    const sealedNumbers = new Set(manifest.sealed.map((b) => b.number));
    for (const name of await storage.list(`${dir}/sealed`)) {
      const n = parseBlockNumber(name);
      // A sealed file the manifest does not list never committed; its data is still
      // in the open block (seal) or will be re-sent (adopt).
      if (n === null || !sealedNumbers.has(n)) await storage.remove(`${dir}/sealed/${name}`);
    }
    for (const name of await storage.list(`${dir}/open`)) {
      const n = parseBlockNumber(name);
      // Stale open file of a block that was sealed, or a leftover temp file.
      if (n === null || n !== manifest.openBlock) await storage.remove(`${dir}/open/${name}`);
    }
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private openPath(): string {
    return `${this.dir}/open/${pad(this.manifest.openBlock)}.jsonl`;
  }

  private sealedPath(n: number): string {
    return `${this.dir}/sealed/${pad(n)}.jsonl`;
  }

  private async writeManifest(next: Manifest): Promise<void> {
    await writeAtomic(this.storage, `${this.dir}/manifest.json`, JSON.stringify(next));
    this.manifest = next;
  }

  private async sealOpen(): Promise<void> {
    const n = this.manifest.openBlock;
    const sorted = [...this.open].sort(compareEvents);
    const text = encodeEvents(sorted);
    await writeAtomic(this.storage, this.sealedPath(n), text);
    const info: BlockInfo = {
      number: n,
      count: sorted.length,
      minT: sorted[0]!.t,
      maxT: sorted[sorted.length - 1]!.t,
      hash: hashText(text),
    };
    const oldOpenPath = this.openPath();
    await this.writeManifest({
      ...this.manifest,
      sealed: [...this.manifest.sealed, info].sort((a, b) => a.number - b.number),
      openBlock: this.manifest.nextBlock,
      nextBlock: this.manifest.nextBlock + 1,
    });
    this.open = [];
    await this.storage.remove(oldOpenPath);
  }

  /** Append one event. Durable once the returned promise resolves. */
  append(event: ReviewEvent): Promise<void> {
    return this.appendMany([event]);
  }

  appendMany(events: readonly ReviewEvent[]): Promise<void> {
    return this.run(async () => {
      for (const e of events) {
        if (!isReviewEvent(e)) throw new Error("invalid review event");
        await this.storage.append(this.openPath(), encodeEvent(e) + "\n");
        this.open.push(e);
        if (this.open.length >= this.manifest.blockSize) await this.sealOpen();
      }
    });
  }

  /**
   * Add a whole, already sealed block, giving it the next free block number.
   * The events must be strictly ascending by `(t, d)`. The in-progress block keeps
   * its number. Returns the new block's manifest entry.
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
      const n = this.manifest.nextBlock;
      const text = encodeEvents(events);
      await writeAtomic(this.storage, this.sealedPath(n), text);
      const info: BlockInfo = {
        number: n,
        count: events.length,
        minT: events[0]!.t,
        maxT: events[events.length - 1]!.t,
        hash: hashText(text),
      };
      await this.writeManifest({
        ...this.manifest,
        sealed: [...this.manifest.sealed, info].sort((a, b) => a.number - b.number),
        nextBlock: n + 1,
      });
      return info;
    });
  }

  getManifest(): Manifest {
    return { ...this.manifest, sealed: this.manifest.sealed.map((b) => ({ ...b })) };
  }

  /** Events of the in-progress block, in arrival order. */
  openEvents(): ReviewEvent[] {
    return [...this.open];
  }

  /** Events of a sealed block, sorted by `(t, d)`. */
  async readSealed(number: number): Promise<ReviewEvent[]> {
    const text = await this.storage.read(this.sealedPath(number));
    if (text === null) throw new Error(`no sealed block ${number}`);
    return parseEvents(text);
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
    for (const b of this.manifest.sealed) sources.push(await this.readSealed(b.number));
    if (this.open.length > 0) sources.push([...this.open].sort(compareEvents));
    return sources;
  }

  /** The largest timestamp in the log, or 0 if it is empty. */
  maxT(): number {
    let max = 0;
    for (const b of this.manifest.sealed) if (b.maxT > max) max = b.maxT;
    for (const e of this.open) if (e.t > max) max = e.t;
    return max;
  }

  /** Wait for all queued operations. */
  idle(): Promise<void> {
    return this.queue.then(() => undefined);
  }
}
