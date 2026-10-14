import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, normalizeCardsFolder, normalizeStateDir } from "./settings";

describe("normalizeStateDir", () => {
  it("normalizes separators, dots, and surrounding slashes", () => {
    expect(normalizeStateDir(".obsidiflash")).toBe(".obsidiflash");
    expect(normalizeStateDir("  /state/dir/ ")).toBe("state/dir");
    expect(normalizeStateDir("./a//b")).toBe("a/b");
    expect(normalizeStateDir("a\\b")).toBe("a/b");
  });

  it("rejects empty paths, paths that leave the vault, and invalid characters", () => {
    for (const bad of ["", "   ", "/", ".", "..", "a/../b", "../x", "a:b", "a*b", "a?b", 'a"b', "a<b", "a|b"]) {
      expect(normalizeStateDir(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("normalizeCardsFolder", () => {
  it("allows an empty input, meaning the vault root", () => {
    expect(normalizeCardsFolder("")).toBe("");
    expect(normalizeCardsFolder("  /  ")).toBe("");
    expect(normalizeCardsFolder("./")).toBe("");
  });

  it("normalizes like the state directory and rejects the same bad paths", () => {
    expect(normalizeCardsFolder("/Cards//Deck/")).toBe("Cards/Deck");
    expect(normalizeCardsFolder("../x")).toBeNull();
    expect(normalizeCardsFolder("a:b")).toBeNull();
  });
});

describe("loadSettings", () => {
  it("returns the defaults for missing or malformed data", () => {
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings("nope")).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings({ stateDir: 5, manageSyncthingIgnore: "yes" })).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid stored values and normalizes the directory", () => {
    expect(loadSettings({ stateDir: "/my/state/", manageSyncthingIgnore: true, cardsFolder: " Cards/Deck " })).toEqual({
      stateDir: "my/state",
      manageSyncthingIgnore: true,
      cardsFolder: "Cards/Deck",
    });
  });

  it("falls back to the default directory if the stored one is invalid", () => {
    expect(loadSettings({ stateDir: "../outside" }).stateDir).toBe(DEFAULT_SETTINGS.stateDir);
    expect(loadSettings({ cardsFolder: "../outside" }).cardsFolder).toBe(DEFAULT_SETTINGS.cardsFolder);
  });

  it("does not modify the shared defaults", () => {
    loadSettings({ stateDir: "x", manageSyncthingIgnore: true });
    expect(DEFAULT_SETTINGS).toEqual({ stateDir: ".obsidiflash", manageSyncthingIgnore: false, cardsFolder: "Flashcards" });
  });
});
