import { describe, expect, it } from "vitest";
import { MemoryStorage } from "./storage";

describe("MemoryStorage", () => {
  it("reports whether a file exists", async () => {
    const s = new MemoryStorage();
    expect(await s.exists("a/b.txt")).toBe(false);
    await s.write("a/b.txt", "x");
    expect(await s.exists("a/b.txt")).toBe(true);
    await s.rename("a/b.txt", "a/c.txt");
    expect(await s.exists("a/b.txt")).toBe(false);
    expect(await s.exists("a/c.txt")).toBe(true);
    await s.remove("a/c.txt");
    expect(await s.exists("a/c.txt")).toBe(false);
  });

  it("treats an empty file as existing", async () => {
    const s = new MemoryStorage();
    await s.write("empty", "");
    expect(await s.exists("empty")).toBe(true);
    expect(await s.read("empty")).toBe("");
  });
});
