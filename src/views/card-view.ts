import { Component, getAllTags, ItemView, MarkdownRenderer, TFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { hasFlashcardTag } from "../cards/note";
import { sidesFromHeadings } from "../cards/parse";

export const CARD_VIEW_TYPE = "obsidiflash-card";

export type Side = "front" | "back";

/**
 * Shows the flashcard of the note being viewed, rendered as Markdown, with a switch between
 * the front and the back. Follows the active note, and edits, renames, and deletion of it.
 *
 * Headings come from Obsidian's metadata cache, so what counts as an H1 is decided by
 * Obsidian's own parser.
 */
export class CardView extends ItemView {
  private filePath: string | null = null;
  private side: Side = "front";

  private frontButton: HTMLButtonElement | null = null;
  private backButton: HTMLButtonElement | null = null;
  private bodyEl: HTMLElement | null = null;

  /** The component owning the currently rendered Markdown. */
  private rendered: Component | null = null;
  /** Bumped on every render so a slow, outdated render never overwrites a newer one. */
  private renderSeq = 0;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return CARD_VIEW_TYPE;
  }

  getDisplayText(): string {
    if (this.filePath === null) return "Flashcard";
    const name = this.filePath.slice(this.filePath.lastIndexOf("/") + 1).replace(/\.md$/, "");
    return `Flashcard: ${name}`;
  }

  getIcon(): string {
    return "layers";
  }

  getState(): Record<string, unknown> {
    return { file: this.filePath, side: this.side };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = (typeof state === "object" && state !== null ? state : {}) as Record<string, unknown>;
    this.filePath = typeof s.file === "string" ? s.file : null;
    this.side = s.side === "back" ? "back" : "front";
    await super.setState(state, result);
    await this.render();
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("obsidiflash-card-view");
    root.tabIndex = 0; // so the space bar reaches us

    const bar = root.createDiv({ cls: "obsidiflash-card-bar" });
    this.frontButton = bar.createEl("button", { text: "Front" });
    this.backButton = bar.createEl("button", { text: "Back" });
    this.registerDomEvent(this.frontButton, "click", () => this.showSide("front"));
    this.registerDomEvent(this.backButton, "click", () => this.showSide("back"));
    this.registerDomEvent(root, "keydown", (e: KeyboardEvent) => {
      if (e.key === " " && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        this.showSide(this.side === "front" ? "back" : "front");
      }
    });

    this.bodyEl = root.createDiv({ cls: "obsidiflash-card-body markdown-rendered" });

    this.addAction("file-text", "Open note", () => {
      const file = this.filePath === null ? null : this.app.vault.getAbstractFileByPath(this.filePath);
      if (file instanceof TFile) void this.app.workspace.getLeaf("tab").openFile(file);
    });

    // Follow the note the user is looking at. Opening our own view does not fire this.
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!file || file.extension !== "md" || file.path === this.filePath) return;
        this.filePath = file.path;
        this.side = "front";
        this.app.workspace.requestSaveLayout();
        void this.render();
      }),
    );

    // "changed" fires once the note has been re-parsed, so its text and headings agree.
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file.path === this.filePath) void this.render();
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (oldPath === this.filePath) {
          this.filePath = file.path;
          void this.render();
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file.path === this.filePath) void this.render();
      }),
    );

    await this.render();
  }

  private showSide(side: Side): void {
    this.side = side;
    void this.render();
  }

  private message(text: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "obsidiflash-card-message";
    el.setText(text);
    return el;
  }

  private async render(): Promise<void> {
    const body = this.bodyEl;
    if (!body) return;

    this.frontButton?.toggleClass("is-active", this.side === "front");
    this.backButton?.toggleClass("is-active", this.side === "back");

    const seq = ++this.renderSeq;
    const show = (el: HTMLElement): void => {
      if (seq === this.renderSeq) body.replaceChildren(el);
    };

    if (this.filePath === null) {
      show(this.message("No note selected."));
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(this.filePath);
    if (!(file instanceof TFile)) {
      show(this.message(`Note not found: ${this.filePath}`));
      return;
    }

    const content = await this.app.vault.cachedRead(file);
    if (seq !== this.renderSeq) return;
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) {
      // Not parsed yet; the "changed" event renders again once it is.
      show(this.message("Obsidian has not finished indexing this note yet."));
      return;
    }
    if (!hasFlashcardTag(getAllTags(cache) ?? [])) {
      show(this.message("This note is not a flashcard: it does not have the #flashcard tag."));
      return;
    }
    // Obsidian leaves `headings` out entirely for a note without any.
    const card = sidesFromHeadings(content, cache.headings ?? []);
    if (card === null) {
      show(
        this.message(
          "This note has the flashcard tag, but is not a complete card. It needs two H1 headings: the text under the first is the front, the text under the second is the back.",
        ),
      );
      return;
    }

    const holder = new Component();
    this.addChild(holder);
    const el = document.createElement("div");
    await MarkdownRenderer.render(this.app, this.side === "front" ? card.front : card.back, el, file.path, holder);
    if (seq !== this.renderSeq) {
      this.removeChild(holder);
      return;
    }
    if (this.rendered) this.removeChild(this.rendered);
    this.rendered = holder;
    show(el);
  }
}
