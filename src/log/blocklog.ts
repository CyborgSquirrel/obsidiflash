import {
  compareEvents,
  encodeEvent,
  encodeEvents,
  isReviewEvent,
  parseEvents,
  trimToLastNewline,
  type ReviewEvent,
} from "./event";
import { writeAtomic, type Storage } from "./storage";

export const DEFAULT_BLOCK_SIZE = 1000;
const FORMAT_VERSION = "1";

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

/**
 * An append-only log of review events, stored as numbered blocks in a directory.
 *
 * The directory is the source of truth. A sealed block exists once its file has been
 * renamed into place, which is atomic. Sealed blocks are immutable and sorted by `(t, d)`.
 * At most one in-progress block holds entries in arrival order; it is sealed when it
 * reaches `blockSize` entries. Block numbers are never reused.
 *
 * Layout under `dir`:
 *   VERSION               format version
 *   open/NNNNNN.jsonl     the in-progress block (arrival order)
 *   sealed/NNNNNN.jsonl   sealed blocks (sorted)
 */
export class BlockLog {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly storage: Storage,
    private readonly dir: string,
    private readonly blockSize: number,
    private readonly sealed: Set<number>,
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
        text = trimToLastNewline(text);
        await writeAtomic(storage, path, text);
      }
      open = parseEvents(text);
    }

    const log = new BlockLog(storage, dir, blockSize, sealedSet, openNumber, open);
    if (open.length >= blockSize) await log.run(() => log.sealOpen());
    return log;
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private nextNumber(): number {
    let max = this.openNumber ?? 0;
    for (const n of this.sealed) if (n > max) max = n;
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
    this.sealed.add(n);
    this.open = [];
    this.openNumber = null;
    await this.storage.remove(this.openPath(n));
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

  /** Numbers of the sealed blocks, ascending. */
  blocks(): number[] {
    return [...this.sealed].sort((a, b) => a - b);
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
    for (const n of this.blocks()) sources.push(await this.readSealed(n));
    if (this.open.length > 0) sources.push([...this.open].sort(compareEvents));
    return sources;
  }

  /**
   * The largest timestamp in the newest block, or 0 if the log is empty. For a log whose
   * entries arrive with increasing timestamps (a device's own local log) this is the last
   * one issued. Reads a sealed block only when the open block is empty.
   */
  async lastT(): Promise<number> {
    if (this.open.length > 0) {
      let max = 0;
      for (const e of this.open) if (e.t > max) max = e.t;
      return max;
    }
    const newest = this.blocks().pop();
    if (newest === undefined) return 0;
    const events = await this.readSealed(newest); // sorted, so the last has the largest t
    return events.length > 0 ? events[events.length - 1]!.t : 0;
  }

  /** Wait for all queued operations. */
  idle(): Promise<void> {
    return this.queue.then(() => undefined);
  }
}
