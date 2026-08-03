import {
  Notice,
  Plugin,
  TFile,
} from "obsidian";
import { VoiceMemosSyncSettings, DEFAULT_SETTINGS } from "./types";
import { SyncEngine } from "./sync";
import { VoiceMemosListView, VIEW_TYPE } from "./view";
import { VoiceMemosSettingTab } from "./settings";

export default class VoiceMemosSyncPlugin extends Plugin {
  settings: VoiceMemosSyncSettings;
  statusBarItem: HTMLElement | null = null;

  async onload() {
    await this.loadSettings();

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.setText("");

    this.registerView(VIEW_TYPE, (leaf) => new VoiceMemosListView(leaf, this));

    this.addRibbonIcon("mic", "Voice Memos", () => {
      this.activateView();
    });

    this.addCommand({
      id: "sync-voice-memos",
      name: "Sync Recordings",
      callback: () => new SyncEngine(this).run(),
    });

    this.addCommand({
      id: "open-voice-memos-list",
      name: "Open Voice Memos list",
      callback: () => this.activateView(),
    });

    this.addSettingTab(new VoiceMemosSettingTab(this.app, this));

    this.registerDomEvent(document, "click", (evt: MouseEvent) => {
      const anchor = (evt.target as HTMLElement).closest("a");
      if (!anchor) return;

      const href = anchor.getAttribute("href") || anchor.getAttribute("data-href") || "";
      const tMatch = href.match(/#t=(\d+(?:\.\d+)?)/);
      if (!tMatch) return;
      if (!/\.m4a[#?]/.test(href) || !href.includes(this.settings.audioFolder)) return;

      evt.preventDefault();
      evt.stopPropagation();
      evt.stopImmediatePropagation();

      const rawPath = href.replace(/#.*$/, "").replace(/^app:\/\/obsidian\.md\//, "");
      let linkPath = rawPath;
      try { linkPath = decodeURIComponent(linkPath); } catch {}
      this.playInSidebar(linkPath, parseFloat(tMatch[1]));
    }, { capture: true });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  setStatus(text: string) {
    if (this.statusBarItem) {
      this.statusBarItem.setText(text);
    }
  }

  clearStatus(delayMs = 5000) {
    const el = this.statusBarItem;
    if (el) {
      setTimeout(() => el.setText(""), delayMs);
    }
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE, active: true });
      }
    }
    if (leaf) workspace.revealLeaf(leaf);
  }

  async playInSidebar(audioPath: string, seekSec: number) {
    await this.activateView();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (leaf) {
      (leaf.view as VoiceMemosListView).playFromLink(audioPath, seekSec);
    }
  }
}
