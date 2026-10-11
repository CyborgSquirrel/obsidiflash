/**
 * Minimal text-file storage the log needs. The Obsidian plugin implements it over
 * the vault adapter; tests use MemoryStorage. Paths use "/" separators.
 */
export interface Storage {
  /** File contents, or null if the file does not exist. */
  read(path: string): Promise<string | null>;
  /** Create or replace a whole file. */
  write(path: string, data: string): Promise<void>;
  /** Append to a file, creating it if needed. */
  append(path: string, data: string): Promise<void>;
  /** Remove a file; removing a missing file is not an error. */
  remove(path: string): Promise<void>;
  /** Rename a file, replacing the destination if it exists. */
  rename(from: string, to: string): Promise<void>;
  /** Names (not paths) of the files directly inside a directory. */
  list(dir: string): Promise<string[]>;
  /** Create a directory and its parents if missing. */
  mkdir(dir: string): Promise<void>;
}

/** Write via a temp file and rename, so readers never see a half-written file. */
export async function writeAtomic(storage: Storage, path: string, data: string): Promise<void> {
  const tmp = path + ".tmp";
  await storage.write(tmp, data);
  await storage.rename(tmp, path);
}

export class MemoryStorage implements Storage {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }

  async append(path: string, data: string): Promise<void> {
    this.files.set(path, (this.files.get(path) ?? "") + data);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const data = this.files.get(from);
    if (data === undefined) throw new Error(`rename: no such file: ${from}`);
    this.files.delete(from);
    this.files.set(to, data);
  }

  async list(dir: string): Promise<string[]> {
    const prefix = dir + "/";
    const names: string[] = [];
    for (const path of this.files.keys()) {
      if (path.startsWith(prefix) && !path.slice(prefix.length).includes("/")) {
        names.push(path.slice(prefix.length));
      }
    }
    return names;
  }

  async mkdir(dir: string): Promise<void> {
    this.dirs.add(dir);
  }
}
