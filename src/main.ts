import { Notice, Plugin } from "obsidian";

export default class ObsidiflashPlugin extends Plugin {
  async onload() {
    this.addCommand({
      id: "hello",
      name: "Hello",
      callback: () => new Notice("Obsidiflash loaded"),
    });
  }

  onunload() {}
}
