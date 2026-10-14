import { describe, expect, it } from "vitest";
import { addIgnoreLine, ignorePattern } from "./syncthing";

describe("ignorePattern", () => {
  it("anchors the directory to the folder root", () => {
    expect(ignorePattern(".obsidiflash")).toBe("/.obsidiflash");
    expect(ignorePattern("state/dir")).toBe("/state/dir");
    expect(ignorePattern("/state/")).toBe("/state");
  });

  it("refuses directories containing pattern syntax", () => {
    for (const bad of ["a*b", "a[1]", "a{b}", "a!b", "a#b", "a\\b", "a?b", ""]) {
      expect(() => ignorePattern(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe("addIgnoreLine", () => {
  it("creates the file content when there is no .stignore", () => {
    expect(addIgnoreLine(null, "/.obsidiflash")).toBe(
      "// Obsidiflash state: device-local, do not sync\n/.obsidiflash\n",
    );
  });

  it("appends to existing content, keeping it intact", () => {
    expect(addIgnoreLine("*.tmp\n", "/.obsidiflash")).toBe(
      "*.tmp\n// Obsidiflash state: device-local, do not sync\n/.obsidiflash\n",
    );
  });

  it("adds a newline first if the file does not end with one", () => {
    expect(addIgnoreLine("*.tmp", "/.obsidiflash")).toBe(
      "*.tmp\n// Obsidiflash state: device-local, do not sync\n/.obsidiflash\n",
    );
  });

  it("keeps CRLF line endings", () => {
    expect(addIgnoreLine("*.tmp\r\n", "/.obsidiflash")).toBe(
      "*.tmp\r\n// Obsidiflash state: device-local, do not sync\r\n/.obsidiflash\r\n",
    );
  });

  it("returns null when the pattern is already present, with or without trailing slash or spaces", () => {
    expect(addIgnoreLine("/.obsidiflash\n", "/.obsidiflash")).toBeNull();
    expect(addIgnoreLine("*.tmp\n/.obsidiflash/\n", "/.obsidiflash")).toBeNull();
    expect(addIgnoreLine("  /.obsidiflash  \r\n", "/.obsidiflash")).toBeNull();
  });

  it("is idempotent", () => {
    const once = addIgnoreLine("*.tmp\n", "/.obsidiflash")!;
    expect(addIgnoreLine(once, "/.obsidiflash")).toBeNull();
  });

  it("does not treat a comment or a different pattern as a match", () => {
    expect(addIgnoreLine("// /.obsidiflash\n", "/.obsidiflash")).not.toBeNull();
    expect(addIgnoreLine("/.obsidiflash-old\n", "/.obsidiflash")).not.toBeNull();
  });
});
