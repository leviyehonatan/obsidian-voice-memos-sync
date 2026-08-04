import { ItemView, WorkspaceLeaf, TFile, Menu, Notice } from "obsidian";
import VoiceMemosSyncPlugin from "./main";
import { SyncEngine } from "./sync";
import { Miniplayer } from "./player";
import {
  TimestampPanel,
  loadTimestamps,
  insertTimestampInFile,
  type Timestamp,
} from "./timestamps";

interface Recording {
  label: string;
  date: string;
  time: string;
  durationSec: number;
  file: TFile;
  audioPath: string;
}

type SortKey = "date" | "label" | "duration";
type SortDir = "asc" | "desc";

export const VIEW_TYPE = "voice-memos-list";

function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mmss = `${m}:${s.toString().padStart(2, "0")}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

function parseDurationSec(fm: Record<string, any>): number {
  if (typeof fm.duration_sec === "number") return fm.duration_sec;
  if (typeof fm.duration === "number") return fm.duration;
  if (typeof fm.duration === "string") return parseFloat(fm.duration) || 0;
  return 0;
}

export class VoiceMemosListView extends ItemView {
  plugin: VoiceMemosSyncPlugin;
  recordings: Recording[] = [];
  sortKey: SortKey = "date";
  sortDir: SortDir = "desc";
  filterText = "";

  playingLabel: string | null = null;
  playingFile: TFile | null = null;
  timestamps: Timestamp[] = [];
  activeTsIdx: number = -1;

  player = new Miniplayer();
  tsPanel = new TimestampPanel();

  private _syncDebounce = 0;

  constructor(leaf: WorkspaceLeaf, plugin: VoiceMemosSyncPlugin) {
    super(leaf);
    this.plugin = plugin;

    this.player.onTimeUpdate = (currentTime, duration) => {
      this.tsPanel.updateCurrentTime(currentTime);
      this.computeActiveTimestamp(currentTime);
    };

    this.player.onEnded = () => {
      this.playingLabel = null;
      this.playingFile = null;
      this.timestamps = [];
      this.activeTsIdx = -1;
      this.render();
    };

    this.player.onError = (msg) => {
      new Notice(`Playback error: ${msg}`);
    };

    this.player.onLabelClick = () => {
      if (this.playingFile) this.app.workspace.getLeaf().openFile(this.playingFile);
    };

    this.tsPanel.onSeek = (timeSec) => {
      this.player.currentTime = timeSec;
      if (this.player.paused) this.player.play();
    };

    this.tsPanel.onInsert = () => this.insertTimestamp();
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "Voice Memos"; }
  getIcon(): string { return "mic"; }

  async onOpen() {
    this.loadRecordings();
    this.render();

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (this.playingFile && file.path === this.playingFile.path) {
          clearTimeout(this._syncDebounce);
          this._syncDebounce = window.setTimeout(async () => {
            this.timestamps = await loadTimestamps(this.app.vault, this.playingFile!);
            this.render();
          }, 300);
        }
      })
    );
  }

  onClose() {
    clearTimeout(this._syncDebounce);
    this.player.destroy();
  }

  loadRecordings() {
    const s = this.plugin.settings;
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(s.notesFolder) && f.path.endsWith(".md"));

    this.recordings = [];
    for (const file of files) {
      const meta = this.app.metadataCache.getFileCache(file);
      const fm = meta?.frontmatter;

      const label = fm?.label || fm?.["mx-uid"] || file.basename;
      if (!label) continue;

      const audioMatch = fm?.audio
        ? typeof fm.audio === "string"
          ? fm.audio.match(/\[\[(.*?)\]\]/)
          : null
        : null;

      this.recordings.push({
        label,
        date: fm?.date || "",
        time: fm?.time_local || "",
        durationSec: parseDurationSec(fm || {}),
        file,
        audioPath: audioMatch?.[1] || "",
      });
    }

    this.sortRecordings();
  }

  sortRecordings() {
    const dir = this.sortDir === "desc" ? -1 : 1;
    this.recordings.sort((a, b) => {
      if (this.sortKey === "date") {
        return (a.date + a.time).localeCompare(b.date + b.time) * dir;
      }
      if (this.sortKey === "label") {
        return a.label.localeCompare(b.label) * dir;
      }
      return (a.durationSec - b.durationSec) * dir;
    });
  }

  render() {
    const container = this.containerEl.children[1];

    this.player.detachAudio();

    container.empty();
    container.addClass("voice-memos-view");

    // Header with sort controls
    const header = container.createDiv("vm-header");
    const sortButtons = header.createDiv("vm-sort-buttons");
    this.createSortBtn(sortButtons, "Date", "date");
    this.createSortBtn(sortButtons, "Label", "label");
    this.createSortBtn(sortButtons, "Duration", "duration");

    const dirBtn = sortButtons.createEl("button", {
      cls: "vm-sort-btn",
      text: this.sortDir === "desc" ? "\u2193 Newest" : "\u2191 Oldest",
    });
    dirBtn.addEventListener("click", () => {
      this.sortDir = this.sortDir === "desc" ? "asc" : "desc";
      this.sortRecordings();
      this.render();
    });

    // Filter input
    const filterRow = container.createDiv("vm-filter");
    const filterInput = filterRow.createEl("input", {
      type: "text",
      placeholder: "Filter recordings\u2026",
      value: this.filterText,
    });
    filterInput.addEventListener("input", (e) => {
      const input = e.target as HTMLInputElement;
      const cursor = input.selectionStart;
      this.filterText = input.value.toLowerCase();
      this.render();
      const newInput = this.containerEl.querySelector(".vm-filter input") as HTMLInputElement;
      if (newInput) {
        newInput.focus();
        newInput.setSelectionRange(cursor, cursor);
      }
    });

    if (this.filterText) {
      const clearBtn = filterRow.createEl("button", { text: "\u2715", cls: "vm-filter-clear" });
      clearBtn.addEventListener("click", () => {
        this.filterText = "";
        this.render();
      });
    }

    // Recordings list
    const list = container.createDiv("vm-list");

    const filtered = this.recordings.filter(
      (r) =>
        !this.filterText ||
        r.label.toLowerCase().includes(this.filterText) ||
        r.date.includes(this.filterText)
    );

    if (filtered.length === 0) {
      list.createDiv("vm-empty").setText("No recordings found");
    }

    for (const r of filtered) {
      const row = list.createDiv("vm-row");

      const playBtn = row.createDiv("vm-play-btn");
      const isPlaying = this.playingFile?.path === r.file.path;
      playBtn.setText(isPlaying ? "\u23F8" : "\u25B6");
      playBtn.addEventListener("click", () => this.togglePlay(r));

      const info = row.createDiv("vm-info");
      const labelEl = info.createDiv("vm-label");
      labelEl.setText(r.label);
      labelEl.addEventListener("click", () => {
        this.app.workspace.getLeaf().openFile(r.file);
      });
      labelEl.addEventListener("contextmenu", (e) => {
        const menu = new Menu();
        menu.addItem((item) =>
          item.setTitle("Open in new tab").onClick(() => {
            this.app.workspace.getLeaf("tab").openFile(r.file);
          })
        );
        menu.showAtMouseEvent(e);
      });

      const meta = info.createDiv("vm-meta");
      meta.setText(`${r.date} \u00b7 ${formatDuration(r.durationSec)}`);

      const repairBtn = row.createDiv("vm-repair-btn");
      repairBtn.setText("\u21BB");
      repairBtn.setAttr("aria-label", "Repair frontmatter");
      repairBtn.addEventListener("click", async () => {
        repairBtn.setText("\u23F3");
        await new SyncEngine(this.plugin).repairFrontmatter(r.file);
        repairBtn.setText("\u21BB");
      });
    }

    // Timestamp list (between list and player)
    if (this.playingLabel) {
      this.tsPanel.render(
        container,
        this.timestamps,
        this.activeTsIdx,
        this.player.currentTime,
      );
    }

    // Miniplayer footer
    this.player.render(container, this.playingLabel);
  }

  private createSortBtn(parent: HTMLElement, label: string, key: SortKey) {
    const btn = parent.createEl("button", {
      cls: `vm-sort-btn${this.sortKey === key ? " active" : ""}`,
      text: label,
    });
    btn.addEventListener("click", () => {
      if (this.sortKey === key) {
        this.sortDir = this.sortDir === "desc" ? "asc" : "desc";
      } else {
        this.sortKey = key;
        this.sortDir = key === "label" ? "asc" : "desc";
      }
      this.sortRecordings();
      this.render();
    });
  }

  async playFromLink(audioPath: string, seekSec: number) {
    const file = this.app.vault.getAbstractFileByPath(audioPath);
    if (!(file instanceof TFile)) return;

    const stem = audioPath.split("/").pop()?.replace(/\.m4a$/i, "");
    let label = stem || "Recording";
    let noteFile: TFile | null = null;

    if (stem) {
      const notePath = `${this.plugin.settings.notesFolder}/${stem}.md`;
      const nf = this.app.vault.getAbstractFileByPath(notePath);
      if (nf instanceof TFile) {
        noteFile = nf;
        this.timestamps = await loadTimestamps(this.app.vault, nf);
        const meta = this.app.metadataCache.getFileCache(nf);
        if (meta?.frontmatter?.label) {
          label = meta.frontmatter.label;
        }
      }
    }

    this.activeTsIdx = -1;
    this.playingLabel = label;
    this.playingFile = noteFile;

    const resourcePath = this.app.vault.getResourcePath(file);
    this.player.load(resourcePath, label);

    this.player.audioEl?.addEventListener("loadedmetadata", () => {
      this.player.currentTime = seekSec;
    }, { once: true });

    this.player.play();
    this.render();
  }

  private async togglePlay(r: Recording) {
    if (this.playingFile?.path === r.file.path) {
      this.player.pause();
      this.playingLabel = null;
      this.playingFile = null;
      this.timestamps = [];
      this.activeTsIdx = -1;
      this.render();
      return;
    }

    if (!r.audioPath) {
      new Notice("No audio file linked to this recording");
      return;
    }

    try {
      const file = this.app.vault.getAbstractFileByPath(r.audioPath);
      if (!file) {
        new Notice(`Audio file not found: ${r.audioPath}`);
        return;
      }

      this.timestamps = await loadTimestamps(this.app.vault, r.file);
      this.activeTsIdx = -1;

      const resourcePath = this.app.vault.getResourcePath(file);
      this.player.load(resourcePath, r.label);

      this.playingLabel = r.label;
      this.playingFile = r.file;
      this.render();
      this.player.play();
    } catch (e) {
      new Notice(`Playback failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private computeActiveTimestamp(currentTime: number) {
    let active = -1;
    for (let i = this.timestamps.length - 1; i >= 0; i--) {
      if (this.timestamps[i].timeSec <= currentTime + 0.5) {
        active = i;
        break;
      }
    }
    if (active !== this.activeTsIdx) {
      this.activeTsIdx = active;
      this.tsPanel.updateActive(active);
    }
  }

  private async insertTimestamp() {
    if (!this.playingFile) return;
    const sec = Math.round(this.player.currentTime);
    const { ts, timestamps } = await insertTimestampInFile(this.playingFile, sec, this.app.vault);

    this.timestamps = timestamps;
    this.render();

    // Open note in the main editor, position cursor after timestamp
    const existingLeaf = this.app.workspace
      .getLeavesOfType("markdown")
      .find((l) => (l.view as any)?.file?.path === this.playingFile!.path);
    const leaf = existingLeaf || this.app.workspace.getLeaf("tab");
    await leaf.openFile(this.playingFile!);

    setTimeout(() => {
      const editor = (leaf.view as any)?.editor;
      if (!editor) return;
      const lines: string[] = editor.getValue().split("\n");
      const entry = `- ${ts}`;
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trimEnd();
        if (trimmed.startsWith(entry) && /^\s*$/.test(trimmed.slice(entry.length))) {
          editor.setCursor({ line: i, ch: entry.length + 1 });
          break;
        }
      }
    }, 50);
  }
}
