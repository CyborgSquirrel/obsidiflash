import { Notice, Plugin } from "obsidian";

export default class ObsiflashPlugin extends Plugin {
  async onload() {
    this.addCommand({
      id: "hello",
      name: "Hello",
      callback: () => new Notice("Obsiflash loaded"),
    });
  }

  onunload() {}
}
