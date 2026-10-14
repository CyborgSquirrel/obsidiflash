import fc from "fast-check";
import type { ReviewEvent } from "./event";
import { MemoryStorage } from "./storage";

export function ev(t: number, d = "aaaaaaaa", card = "card-1", rating: 1 | 2 | 3 | 4 = 3): ReviewEvent {
  return { t, d, card, rating };
}

export const deviceIdArb = fc
  .array(fc.constantFrom(..."0123456789abcdef".split("")), { minLength: 8, maxLength: 8 })
  .map((chars) => chars.join(""));

export const eventArb: fc.Arbitrary<ReviewEvent> = fc.record({
  t: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
  d: deviceIdArb,
  card: fc.string({ minLength: 1 }),
  rating: fc.constantFrom(1 as const, 2 as const, 3 as const, 4 as const),
});

/** Storage that "crashes" (throws) on the n-th mutating operation, then keeps failing. */
export class CrashingStorage extends MemoryStorage {
  /** Number of mutating operations attempted so far. */
  ops = 0;
  crashAt = Infinity;

  private tick(): void {
    if (this.ops++ >= this.crashAt) throw new Error("simulated crash");
  }

  override async write(path: string, data: string): Promise<void> {
    this.tick();
    return super.write(path, data);
  }
  override async append(path: string, data: string): Promise<void> {
    this.tick();
    return super.append(path, data);
  }
  override async remove(path: string): Promise<void> {
    this.tick();
    return super.remove(path);
  }
  override async rename(from: string, to: string): Promise<void> {
    this.tick();
    return super.rename(from, to);
  }
  override async mkdir(dir: string): Promise<void> {
    this.tick();
    return super.mkdir(dir);
  }

  /** A healthy view of the same files, as after a restart. */
  survivor(): MemoryStorage {
    const s = new MemoryStorage();
    for (const [k, v] of this.files) s.files.set(k, v);
    return s;
  }
}

/** Storage whose reads take real time, so other operations can run in between. */
export class SlowReadStorage extends MemoryStorage {
  delayMs = 0;

  override async read(path: string): Promise<string | null> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return super.read(path);
  }
}

/**
 * Storage with controllable failures. A failing append first writes a fragment of its
 * data, like a disk-full error halfway through a write; a failing write changes nothing.
 */
export class FlakyStorage extends MemoryStorage {
  failAppends = 0;
  failWrites = 0;

  /** A healthy copy of the current files, as after a restart. */
  clone(): MemoryStorage {
    const copy = new MemoryStorage();
    for (const [k, v] of this.files) copy.files.set(k, v);
    return copy;
  }

  override async append(path: string, data: string): Promise<void> {
    if (this.failAppends > 0) {
      this.failAppends--;
      await super.append(path, data.slice(0, 8));
      throw new Error("append failed");
    }
    return super.append(path, data);
  }

  override async write(path: string, data: string): Promise<void> {
    if (this.failWrites > 0) {
      this.failWrites--;
      throw new Error("write failed");
    }
    return super.write(path, data);
  }
}
