import {
  App,
  PluginSettingTab,
  Setting,
} from "obsidian";
import { execFile } from "child_process";
import { DEFAULT_SETTINGS } from "./types";
import * as fs from "fs";
import * as path from "path";
import type VoiceMemosSyncPlugin from "./main";

export class VoiceMemosSettingTab extends PluginSettingTab {
  plugin: VoiceMemosSyncPlugin;

  constructor(app: App, plugin: VoiceMemosSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Voice Memos Sync" });

    const s = this.plugin.settings;
    const systemPath = DEFAULT_SETTINGS.recordingsPath;
    const customPath = s.recordingsPath;
    const activePath = s.useCustomPath ? customPath : systemPath;
    const dbFilePath = path.join(activePath, "CloudRecordings.db");
    let accessible = false;
    try {
      fs.accessSync(dbFilePath, fs.constants.R_OK);
      accessible = true;
    } catch {}

    // System path (read-only)
    new Setting(containerEl)
      .setName("System recordings path")
      .setDesc("macOS Voice Memos default location")
      .addText((text) =>
        text.setValue(systemPath).setDisabled(true)
      );

    // Custom path toggle
    new Setting(containerEl)
      .setName("Use custom recordings path")
      .setDesc("Sync from a different folder (e.g. external drive)")
      .addToggle((toggle) =>
        toggle.setValue(s.useCustomPath).onChange(async (value) => {
          s.useCustomPath = value;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (s.useCustomPath) {
      new Setting(containerEl)
        .setName("Custom recordings path")
        .setDesc("Folder containing CloudRecordings.db and audio files")
        .addText((text) =>
          text
            .setPlaceholder("/path/to/Recordings")
            .setValue(customPath)
            .onChange(async (value) => {
              s.recordingsPath = value;
              await this.plugin.saveSettings();
            })
        );
    }

    // Active source + status
    const sourceLabel = s.useCustomPath ? "Custom" : "System";
    if (accessible) {
      containerEl.createDiv({ cls: "setting-item-description" }).innerHTML =
        `<span style="color:green">✓ Syncing from ${sourceLabel}: ${activePath}</span>`;
    } else {
      containerEl.createDiv({ cls: "setting-item-description" }).innerHTML =
        `<span style="color:red">✗ ${sourceLabel} path not readable: ${activePath}</span>`;
      if (!s.useCustomPath) {
        containerEl.createDiv({ cls: "setting-item-description" }).createEl("p", {
          text: "Obsidian needs Full Disk Access to read the Voice Memos database.",
        });
        new Setting(containerEl)
          .setName("Grant Full Disk Access")
          .setDesc(
            "Opens macOS System Settings → Privacy & Security → Full Disk Access. Add Obsidian, then restart Obsidian."
          )
          .addButton((btn) =>
            btn
              .setButtonText("Open Settings")
              .setCta()
              .onClick(() => {
                execFile("open", [
                  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
                ]);
              })
          );
      }
    }

    new Setting(containerEl)
      .setName("Notes folder")
      .setDesc("Vault folder for synced notes")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.notesFolder)
          .setValue(this.plugin.settings.notesFolder)
          .onChange(async (value) => {
            this.plugin.settings.notesFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Audio folder")
      .setDesc("Vault folder for synced audio files")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.audioFolder)
          .setValue(this.plugin.settings.audioFolder)
          .onChange(async (value) => {
            this.plugin.settings.audioFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("ffmpeg path")
      .setDesc("Path to ffmpeg binary")
      .addText((text) =>
        text
          .setPlaceholder("ffmpeg")
          .setValue(this.plugin.settings.ffmpegPath)
          .onChange(async (value) => {
            this.plugin.settings.ffmpegPath = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
