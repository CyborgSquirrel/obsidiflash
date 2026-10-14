import { MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { generateUuid, newCardPath, newCardTemplate } from "./cards/note";
import { DEFAULT_SETTINGS, loadSettings, type ObsidiflashSettings } from "./settings";
import { ObsidiflashSettingTab } from "./settings-tab";
import { addIgnoreLine, ignorePattern } from "./syncthing";
import { CARD_VIEW_TYPE, CardView } from "./views/card-view";

const SYNCTHING_FOLDER_MARKER = ".stfolder";
const SYNCTHING_IGNORE_FILE = ".stignore";

export default class ObsidiflashPlugin extends Plugin {
  settings: ObsidiflashSettings = { ...DEFAULT_SETTINGS };
  private warnedNoSyncthingRoot = false;

  async onload(): Promise<void> {
    this.settings = loadSettings(await this.loadData());

    this.registerView(CARD_VIEW_TYPE, (leaf) => new CardView(leaf));

    this.addCommand({
      id: "preview-flashcard",
      name: "Preview flashcard of the current note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.previewCard(file);
        return true;
      },
    });

    this.addCommand({
      id: "create-flashcard",
      name: "Create flashcard",
      callback: () => void this.createCard(),
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item) =>
          item
            .setTitle("Preview flashcard")
            .setIcon("layers")
            .onClick(() => void this.previewCard(file)),
        );
      }),
    );

    this.addSettingTab(new ObsidiflashSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => void this.applySyncthingIgnore());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Create an empty, tagged card named by a new UUID and open it with the cursor under "# Front". */
  async createCard(): Promise<void> {
    try {
      const { vault, workspace } = this.app;
      const folder = this.settings.cardsFolder;
      await this.ensureFolder(folder);

      let path = newCardPath(folder, generateUuid());
      while (vault.getAbstractFileByPath(path)) path = newCardPath(folder, generateUuid());

      const { content, frontLine } = newCardTemplate();
      const file = await vault.create(path, content);
      const leaf = workspace.getLeaf("tab");
      await leaf.openFile(file);
      const view = leaf.view;
      if (view instanceof MarkdownView) {
        view.editor.setCursor({ line: frontLine, ch: 0 });
        view.editor.focus();
      }
    } catch (err) {
      new Notice(`Obsidiflash: could not create a flashcard: ${err instanceof Error ? err.message : String(err)}`, 10000);
    }
  }

  private async ensureFolder(folder: string): Promise<void> {
    let current = "";
    for (const segment of folder.split("/").filter((s) => s !== "")) {
      current = current === "" ? segment : `${current}/${segment}`;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }

  /** Open (or reuse) the card view on the given note, showing its front. */
  async previewCard(file: TFile): Promise<void> {
    const { workspace } = this.app;
    const leaf = workspace.getLeavesOfType(CARD_VIEW_TYPE)[0] ?? workspace.getRightLeaf(false) ?? workspace.getLeaf("split");
    await leaf.setViewState({ type: CARD_VIEW_TYPE, active: true, state: { file: file.path, side: "front" } });
    await workspace.revealLeaf(leaf);
  }

  /**
   * If enabled, make sure the vault's .stignore ignores the state directory. Syncthing only
   * reads .stignore from the root of a synced folder, so this only acts when the vault root
   * has a .stfolder marker, which means it is that root.
   */
  async applySyncthingIgnore(): Promise<void> {
    if (!this.settings.manageSyncthingIgnore) return;
    const adapter = this.app.vault.adapter;
    try {
      if (!(await adapter.exists(SYNCTHING_FOLDER_MARKER))) {
        if (!this.warnedNoSyncthingRoot) {
          this.warnedNoSyncthingRoot = true;
          new Notice(
            `Obsidiflash: the vault root does not look like a Syncthing folder root, so .stignore was not changed. Add "${ignorePattern(this.settings.stateDir)}" to your Syncthing folder's .stignore yourself.`,
            12000,
          );
        }
        return;
      }
      const current = (await adapter.exists(SYNCTHING_IGNORE_FILE)) ? await adapter.read(SYNCTHING_IGNORE_FILE) : null;
      const next = addIgnoreLine(current, ignorePattern(this.settings.stateDir));
      if (next !== null) await adapter.write(SYNCTHING_IGNORE_FILE, next);
    } catch (err) {
      new Notice(`Obsidiflash: could not update .stignore: ${err instanceof Error ? err.message : String(err)}`, 12000);
    }
  }
}
