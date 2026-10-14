import { PluginSettingTab, Setting, type App } from "obsidian";
import type ObsidiflashPlugin from "./main";
import { DEFAULT_SETTINGS, normalizeCardsFolder, normalizeStateDir } from "./settings";
import { ignorePattern } from "./syncthing";

export class ObsidiflashSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ObsidiflashPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const cardsSetting = new Setting(containerEl)
      .setName("Cards folder")
      .setDesc("Where new flashcards are created, relative to the vault root. Leave empty for the vault root.");
    const cardsStatus = containerEl.createDiv({ cls: "setting-item-description obsidiflash-setting-status" });
    cardsSetting.addText((text) =>
      text
        .setPlaceholder(DEFAULT_SETTINGS.cardsFolder)
        .setValue(this.plugin.settings.cardsFolder)
        .onChange(async (value) => {
          const folder = normalizeCardsFolder(value);
          if (folder === null) {
            cardsStatus.setText('Not a usable path: it must stay inside the vault and avoid < > : " | ? *');
            return;
          }
          cardsStatus.setText("");
          this.plugin.settings.cardsFolder = folder;
          await this.plugin.saveSettings();
        }),
    );

    const dirSetting = new Setting(containerEl)
      .setName("State directory")
      .setDesc(
        "Where Obsidiflash keeps its review history, relative to the vault root. Changing it does not move existing data; reload the plugin afterwards.",
      );
    const dirStatus = containerEl.createDiv({ cls: "setting-item-description obsidiflash-setting-status" });
    const patternSetting = new Setting(containerEl).setName("Syncthing ignore pattern");

    const showPattern = (): void => {
      try {
        patternSetting.setDesc(ignorePattern(this.plugin.settings.stateDir));
      } catch (err) {
        patternSetting.setDesc(err instanceof Error ? err.message : String(err));
      }
    };

    dirSetting.addText((text) =>
      text
        .setPlaceholder(DEFAULT_SETTINGS.stateDir)
        .setValue(this.plugin.settings.stateDir)
        .onChange(async (value) => {
          const dir = normalizeStateDir(value);
          if (dir === null) {
            dirStatus.setText("Not a usable path: it must be non-empty, stay inside the vault, and avoid < > : \" | ? *");
            return;
          }
          dirStatus.setText("");
          this.plugin.settings.stateDir = dir;
          await this.plugin.saveSettings();
          showPattern();
          await this.plugin.applySyncthingIgnore();
        }),
    );

    new Setting(containerEl)
      .setName("Keep the state directory out of Syncthing")
      .setDesc(
        "Add the pattern below to the .stignore at the vault root. This only works when the vault root is the Syncthing folder root (a .stfolder marker is found there). .stignore is never synced, so turn this on for every device. If your vault is inside a larger Syncthing folder, add the pattern yourself, prefixed with the vault's path.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.manageSyncthingIgnore).onChange(async (value) => {
          this.plugin.settings.manageSyncthingIgnore = value;
          await this.plugin.saveSettings();
          await this.plugin.applySyncthingIgnore();
        }),
      );

    showPattern();
  }
}
