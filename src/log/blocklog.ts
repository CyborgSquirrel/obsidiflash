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

type BlockId = number;

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

  /**
   * Set when a storage write failed, so the open file may hold a torn fragment that
   * memory does not know about. Nothing is appended until the file has been rewritten
   * from memory, because a new line glued onto the fragment would be lost.
   */
  private needsRepair = false;

  private constructor(
    private readonly storage: Storage,
    private readonly dir: string,
    private readonly blockSize: number,

    private openBlockId: BlockId,
    private openBlock: ReviewEvent[],
  ) {}

  static async open(
    storage: Storage,
    dir: string,
    options: BlockLogOptions = {},
  ): Promise<BlockLog> {
    const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;

    await storage.mkdir(`${dir}`);

    // Figure out format version
    const versionPath = `${dir}/VERSION`;
    const version = await storage.read(versionPath);
    if (version === null) await writeAtomic(storage, versionPath, FORMAT_VERSION + "\n");
    else if (version.trim() !== FORMAT_VERSION) {
      throw new Error(`unsupported log format version "${version.trim()}" in ${dir}`);
    }

    await storage.mkdir(`${dir}/sealed`);
    await storage.mkdir(`${dir}/open`);

    // Leftovers of interrupted atomic writes.
    for (const d of [dir, `${dir}/sealed`, `${dir}/open`]) {
      for (const name of await storage.list(d)) {
        if (name.endsWith(".tmp")) await storage.remove(`${d}/${name}`);
      }
    }

    // Run through all the blocks
    let openBlockId: BlockId;
    {
      // One directory listing each, instead of an exists() call per block.
      const sealedNames = new Set(await storage.list(`${dir}/sealed`));
      const openNames = new Set(await storage.list(`${dir}/open`));

      let blockId = 1;
      while (sealedNames.has(`${pad(blockId)}.jsonl`)) {
        // Remove open blocks which have been sealed
        const openName = `${pad(blockId)}.jsonl`;
        if (openNames.has(openName)) {
          await storage.remove(`${dir}/open/${openName}`);
        }

        blockId += 1;
      }
      openBlockId = blockId;
    }

    // Read the open block
    let open: ReviewEvent[] = [];
    {
      const path = `${dir}/open/${pad(openBlockId)}.jsonl`;
      let text = (await storage.read(path)) ?? "";
      if (text !== "" && !text.endsWith("\n")) {
        // Torn last line: rewrite the open block trimmed to its last newline.
        text = trimToLastNewline(text);
        await writeAtomic(storage, path, text);
      }
      open = parseEvents(text);
    }

    const log = new BlockLog(storage, dir, blockSize, openBlockId, open);

    // Poke the log so that it seals stuff if it needs to
    await log.appendMany([]);

    return log;
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private openPath(n: number): string {
    return `${this.dir}/open/${pad(n)}.jsonl`;
  }

  private sealedPath(n: number): string {
    return `${this.dir}/sealed/${pad(n)}.jsonl`;
  }

  /** Append one event. Durable once the returned promise resolves. */
  append(event: ReviewEvent): Promise<void> {
    return this.appendMany([event]);
  }

  appendMany(events: readonly ReviewEvent[]): Promise<void> {
    return this.run(async () => {
      let ei = 0;
      while (true) {
        if (this.openBlock.length >= this.blockSize) {
          if (this.openBlock.length > this.blockSize) {
            // TODO: log error message
          }

          const id = this.openBlockId;
          const sealedBlock = [...this.openBlock].sort(compareEvents);
          const text = encodeEvents(sealedBlock);
          // Renaming the file into place is the commit.
          await writeAtomic(this.storage, this.sealedPath(id), text);
          this.needsRepair = false; // the old open file is obsolete now
          this.openBlock = [];
          this.openBlockId += 1;
          await this.storage.remove(this.openPath(id));

          continue;
        }

        if (ei >= events.length) {
          break;
        }
        const e = events[ei];
        ei += 1

        if (!isReviewEvent(e)) throw new Error("invalid review event");
        const path = this.openPath(this.openBlockId);
        try {
          if (this.needsRepair) {
            // Memory holds every acknowledged event; make the file match it again.
            await writeAtomic(this.storage, path, encodeEvents(this.openBlock));
            this.needsRepair = false;
          }
          await this.storage.append(path, encodeEvent(e) + "\n");
        } catch (err) {
          // If we get here the append (or the repair) may have left a fragment.
          // Refuse to write anything else until a repair succeeds.
          this.needsRepair = true;
          throw err;
        }
        this.openBlock.push(e);
      }
    });
  }

  /** Number of the in-progress block, or null if there is none yet. */
  openBlockNumber(): number {
    return this.openBlockId;
  }

  /** Events of the in-progress block, in arrival order. */
  openEvents(): ReviewEvent[] {
    return [...this.openBlock];
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
    const openBlockId = this.openBlockId;
    const openBlock = [...this.openBlock];

    const sources: ReviewEvent[][] = [];
    for (let n = 1; n < openBlockId; ++n) sources.push(await this.readSealed(n));
    if (openBlock.length > 0) sources.push(openBlock.sort(compareEvents));
    return sources;
  }

  /**
   * The largest timestamp in the newest block, or 0 if the log is empty. For a log whose
   * entries arrive with increasing timestamps (a device's own local log) this is the last
   * one issued. Reads a sealed block only when the open block is empty.
   */
  async lastT(): Promise<number> {
    if (this.openBlock.length > 0) {
      let max = 0;
      for (const e of this.openBlock) if (e.t > max) max = e.t;
      return max;
    }
    const newest = this.openBlockId - 1;
    if (newest < 1) return 0;
    const events = await this.readSealed(newest); // sorted, so the last has the largest t
    return events.length > 0 ? events[events.length - 1]!.t : 0;
  }

  /** Wait for all queued operations. */
  idle(): Promise<void> {
    return this.queue.then(() => undefined);
  }
}
