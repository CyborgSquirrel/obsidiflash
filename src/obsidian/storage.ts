import type { DataAdapter } from "obsidian";
import type { Storage } from "../log/storage";

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * `Storage` over Obsidian's vault adapter. Paths are vault-relative with "/" separators.
 *
 * Written defensively because the adapter behaves differently across platforms in ways
 * that are not documented: whether `append` creates a missing file, and whether
 * `rename` replaces an existing destination. Both are handled here instead of assumed.
 */
export class ObsidianStorage implements Storage {
  /** Files known to exist, so most appends skip an `exists` call. */
  private readonly known = new Set<string>();

  constructor(private readonly adapter: DataAdapter) {}

  async read(path: string): Promise<string | null> {
    if (!(await this.adapter.exists(path))) return null;
    return this.adapter.read(path);
  }

  exists(path: string): Promise<boolean> {
    return this.adapter.exists(path);
  }

  async write(path: string, data: string): Promise<void> {
    await this.adapter.write(path, data);
    this.known.add(path);
  }

  async append(path: string, data: string): Promise<void> {
    if (this.known.has(path) || (await this.adapter.exists(path))) {
      await this.adapter.append(path, data);
    } else {
      await this.adapter.write(path, data);
    }
    this.known.add(path);
  }

  async remove(path: string): Promise<void> {
    this.known.delete(path);
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }

  async rename(from: string, to: string): Promise<void> {
    this.known.delete(from);
    this.known.delete(to);
    try {
      await this.adapter.rename(from, to);
    } catch (err) {
      // Some platforms refuse to rename over an existing file. Fall back to
      // remove-then-rename. That is not atomic: a crash in between loses `to`.
      if (!(await this.adapter.exists(to))) throw err;
      await this.adapter.remove(to);
      await this.adapter.rename(from, to);
    }
    this.known.add(to);
  }

  async list(dir: string): Promise<string[]> {
    if (!(await this.adapter.exists(dir))) return [];
    const listed = await this.adapter.list(dir);
    return listed.files.map(basename);
  }

  async mkdir(dir: string): Promise<void> {
    let current = "";
    for (const segment of dir.split("/").filter((s) => s !== "")) {
      current = current === "" ? segment : `${current}/${segment}`;
      if (!(await this.adapter.exists(current))) await this.adapter.mkdir(current);
    }
  }
}
