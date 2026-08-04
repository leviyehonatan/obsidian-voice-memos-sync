import { Notice, Modal, App, Setting, TFile } from "obsidian";
import { execFile } from "child_process";
import { promisify } from "util";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import VoiceMemosSyncPlugin from "./main";
import { CORE_DATA_EPOCH_OFFSET, DEFAULT_SETTINGS } from "./types";

const execFileAsync = promisify(execFile);

export class SyncEngine {
  plugin: VoiceMemosSyncPlugin;
  syncing = false;
  cancel = false;

  constructor(plugin: VoiceMemosSyncPlugin) {
    this.plugin = plugin;
  }

  async run() {
    if (this.syncing) {
      new Notice("Voice Memos: sync already in progress");
      return;
    }
    this.syncing = true;
    this.cancel = false;

    try {
      await this.doSync();
    } finally {
      this.syncing = false;
    }
  }

  private async doSync() {
    const s = this.plugin.settings;
    const recordingsPath = s.useCustomPath
      ? s.recordingsPath
      : DEFAULT_SETTINGS.recordingsPath;

    const dbPath = path.join(recordingsPath, "CloudRecordings.db");
    if (!fs.existsSync(dbPath)) {
      new Notice(`CloudRecordings.db not found:\n${recordingsPath}`);
      return;
    }

    const vaultBase = (this.plugin.app.vault.adapter as any).basePath;
    const audioDir = path.join(vaultBase, s.audioFolder);
    const notesDir = path.join(vaultBase, s.notesFolder);
    const indexPath = path.join(vaultBase, "Index.md");

    await fs.promises.mkdir(audioDir, { recursive: true });
    await fs.promises.mkdir(notesDir, { recursive: true });

    // Write/update Index upfront so user sees it immediately
    const indexContent = `# Voice Memos Index

\`\`\`dataview
TABLE label, date, time_local, duration, original_file
FROM "${s.notesFolder}"
SORT date DESC
\`\`\`
`;
    const newHash = createHash("md5").update(indexContent).digest("hex");
    const onDiskHash = fs.existsSync(indexPath)
      ? createHash("md5")
          .update(fs.readFileSync(indexPath, "utf-8"))
          .digest("hex")
      : null;
    const isNew = !onDiskHash;
    const isUntouched = onDiskHash && s.indexHash && s.indexHash === onDiskHash;
    const isEdited = onDiskHash && !isUntouched;
    let writeIndex = isNew || isUntouched;
    if (isEdited) {
      writeIndex = await showIndexPrompt(this.plugin.app);
    }
    if (writeIndex) {
      await fs.promises.writeFile(indexPath + ".tmp", indexContent, "utf-8");
      await fs.promises.rename(indexPath + ".tmp", indexPath);
      s.indexHash = newHash;
      await this.plugin.saveSettings();
    }

    const sqliteBin = await this.findBinary("sqlite3", [
      "/usr/bin/sqlite3",
      "/opt/homebrew/bin/sqlite3",
    ]);
    if (!sqliteBin) {
      new Notice("sqlite3 not found. Install with: brew install sqlite");
      return;
    }

    const ffmpegBin = await this.findBinary(s.ffmpegPath, [
      "/opt/homebrew/bin/ffmpeg",
      "/usr/local/bin/ffmpeg",
    ]);
    if (!ffmpegBin) {
      new Notice(`ffmpeg not found: ${s.ffmpegPath}`);
      return;
    }

    const ffprobeBin = await this.findBinary("ffprobe", [
      "/opt/homebrew/bin/ffprobe",
      "/usr/local/bin/ffprobe",
    ]);

    this.plugin.setStatus("Voice Memos: reading database\u2026");

    const query =
      "SELECT ZPATH, ZDATE, ZDURATION, ZCUSTOMLABELFORSORTING FROM ZCLOUDRECORDING";
    let rows: string;
    try {
      const result = await execFileAsync(sqliteBin, [dbPath, query], {
        encoding: "utf-8",
      });
      rows = result.stdout;
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("authorization")) {
        new Notice(
          `Cannot read CloudRecordings.db — Obsidian needs Full Disk Access.\n\nOpen plugin settings and click "Grant Full Disk Access", then restart Obsidian.`
        );
      } else {
        new Notice(`Failed to read CloudRecordings.db: ${msg}`);
      }
      return;
    }

    const lines = rows.trim().split("\n").filter((l) => l.includes("|"));
    const total = lines.length;
    let newCount = 0;
    let skipDone = 0;
    let remuxCount = 0;
    let errorCount = 0;
    let processed = 0;
    const errors: string[] = [];
    const convertedFiles: string[] = [];
    const newFiles: string[] = [];

    for (const line of lines) {
      if (this.cancel) break;

      const parts = line.split("|");
      if (parts.length < 4) continue;

      const zpath = parts[0].trim();
      if (!zpath) continue;
      const stem = zpath.replace(/\.(m4a|qta)$/i, "");
      if (!stem || stem === "." || stem === "/") continue;

      const zdate = parseFloat(parts[1]);
      const zduration = parseFloat(parts[2]);
      const zlabel = parts[3] || "";

      // Check if audio needs re-encoding (ALAC → AAC)
      const destAudio = path.join(audioDir, stem + ".m4a");
      const destNote = path.join(notesDir, stem + ".md");

      const audioExists = fs.existsSync(destAudio);
      let needsEncode = !audioExists;
      const isNewFile = !audioExists;
      const sourceFile = path.join(recordingsPath, zpath);
      let inputFile = sourceFile;

      if (audioExists && ffprobeBin) {
        try {
          const { stdout } = await execFileAsync(ffprobeBin, [
            "-v", "error",
            "-select_streams", "a:0",
            "-show_entries", "stream=codec_name",
            "-of", "csv=p=0",
            destAudio,
          ], { encoding: "utf-8" });
          if (stdout.trim() === "alac") {
            needsEncode = true;
            inputFile = destAudio;
          }
        } catch {}
      }

      // Both note and audio already exist and are AAC — skip entirely
      if (fs.existsSync(destNote) && audioExists && !needsEncode) {
        skipDone++;
        processed++;
        continue;
      }

      // Only require source if we're converting a new file (not re-encoding from vault)
      if (needsEncode && inputFile === sourceFile) {
        if (!fs.existsSync(sourceFile)) {
          errorCount++;
          processed++;
          errors.push(`${zpath}: source file not found`);
          continue;
        }
        const srcStat = fs.statSync(sourceFile);
        if (!srcStat.isFile()) {
          errorCount++;
          processed++;
          errors.push(`${zpath}: source is not a regular file`);
          continue;
        }
      }

      // Progress update
      this.plugin.setStatus(
        `Voice Memos: ${processed}/${total} \u00b7 ${
          needsEncode ? (isNewFile ? "New" : "Re-encoding") : "Updating note"
        } ${zpath}`
      );

      // Convert audio to AAC (skip if already AAC)
      if (needsEncode) {
        try {
          await execFileAsync(ffmpegBin, [
            "-y",
            "-i", inputFile,
            "-c:a", "aac",
            "-b:a", "128k",
            "-map", "0:a:0",
            destAudio.replace(/\.m4a$/, ".tmp.m4a"),
          ]);
          await fs.promises.rename(destAudio.replace(/\.m4a$/, ".tmp.m4a"), destAudio);
          remuxCount++;
          if (isNewFile) {
            newFiles.push(stem);
          } else {
            convertedFiles.push(stem);
          }
        } catch (e: any) {
          try { await fs.promises.unlink(destAudio.replace(/\.m4a$/, ".tmp.m4a")); } catch {}
          errorCount++;
          processed++;
          errors.push(`${zpath}: audio conversion failed — ${e.message || String(e)}`);
          continue;
        }
      }

      // Build note
      const dt = parseDatetime(zpath, zdate);
      const dur = formatDuration(zduration);
      const label = zlabel || stem;
      const audioRel = `${s.audioFolder}/${stem}.m4a`;

      const note = `---
mx-uid: "${stem}"
audio: "[[${audioRel}]]"
duration: "${dur}"
duration_sec: ${zduration}
date: ${dt.date}
time_local: ${dt.timeLocal}
time_utc: ${dt.timeUtc}
timezone_offset: "${dt.tzOffset}"
label: "${label.replace(/"/g, '\\"')}"
original_file: "${zpath}"
tags:
  - voice-memo
---

# ${label}

- **Date (local):** ${dt.date} ${dt.timeLocal} (${dt.tzOffset})
- **Duration:** ${dur}
- **Original file:** \`${zpath}\`

## Notes

`;

      // Atomic note write
      try {
        await fs.promises.writeFile(destNote + ".tmp", note, "utf-8");
        await fs.promises.rename(destNote + ".tmp", destNote);
      } catch (e: any) {
        try { await fs.promises.unlink(destAudio); } catch {}
        errorCount++;
        processed++;
        errors.push(`${zpath}: note write failed — ${e.message || String(e)}`);
        continue;
      }

      newCount++;
      processed++;
    }

    // Summary
    const parts: string[] = [];
    if (newCount > 0) parts.push(`${newCount} new`);
    if (skipDone > 0) parts.push(`${skipDone} skipped`);
    if (remuxCount > 0) parts.push(`${remuxCount} converted`);
    if (errorCount > 0) parts.push(`${errorCount} errors`);

    const summary =
      parts.length > 0
        ? `Voice Memos: ${parts.join(", ")}`
        : "Voice Memos: up to date";
    const cancelled = this.cancel ? " (cancelled)" : "";

    this.plugin.setStatus(summary + cancelled);
    this.plugin.clearStatus(8000);
    new Notice(summary + cancelled);

    setTimeout(() => this.plugin.refreshView(), 250);

    if (errors.length > 0 || convertedFiles.length > 0 || newFiles.length > 0) {
      new SyncResultsModal(this.plugin.app, { errors, convertedFiles, newFiles, skipDone }).open();
    }
  }

  async repairFrontmatter(file: TFile) {
    const s = this.plugin.settings;
    const content = await this.plugin.app.vault.read(file);

    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) {
      new Notice("No frontmatter found");
      return;
    }

    const fmRaw = fmMatch[1];
    const mxMatch = fmRaw.match(/mx-uid:\s*"?(.+?)"?\s*$/m);
    const stem = mxMatch?.[1] || file.basename;

    const body = content.slice(fmMatch.index! + fmMatch[0].length);

    const dbPath = path.join(s.recordingsPath, "CloudRecordings.db");
    if (!fs.existsSync(dbPath)) {
      new Notice(`Database not found: ${dbPath}`);
      return;
    }

    const sqliteBin = await this.findBinary("sqlite3", [
      "/usr/bin/sqlite3",
      "/opt/homebrew/bin/sqlite3",
    ]);
    if (!sqliteBin) {
      new Notice("sqlite3 not found");
      return;
    }

    const query = `SELECT ZPATH, ZDATE, ZDURATION, ZCUSTOMLABELFORSORTING FROM ZCLOUDRECORDING WHERE ZPATH LIKE '${stem}.%'`;
    let zpath = "", zdate = 0, zduration = 0, zlabel = "";

    try {
      const result = await execFileAsync(sqliteBin, [dbPath, query], { encoding: "utf-8" });
      const dbRows = result.stdout.trim().split("\n").filter((l: string) => l.includes("|"));
      if (dbRows.length > 0) {
        const parts = dbRows[0].split("|");
        zpath = parts[0].trim();
        zdate = parseFloat(parts[1]) || 0;
        zduration = parseFloat(parts[2]) || 0;
        zlabel = (parts[3] || "").trim();
      }
    } catch {}

    if (!zpath) {
      new Notice(`Recording "${stem}" not found in database`);
      return;
    }

    let durationSec = zduration;
    const vaultBase = (this.plugin.app.vault.adapter as any).basePath;
    const audioPath = path.join(vaultBase, s.audioFolder, stem + ".m4a");
    if (fs.existsSync(audioPath)) {
      try {
        const ffprobeBin = await this.findBinary("ffprobe", [
          "/opt/homebrew/bin/ffprobe",
          "/usr/local/bin/ffprobe",
        ]);
        if (ffprobeBin) {
          const probe = await execFileAsync(ffprobeBin, [
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "csv=p=0",
            audioPath,
          ], { encoding: "utf-8" });
          const parsed = parseFloat(probe.stdout);
          if (parsed > 0) durationSec = parsed;
        }
      } catch {}
    }

    const dt = parseDatetime(zpath, zdate);
    const dur = formatDuration(durationSec);
    const label = zlabel || stem;
    const audioRel = `${s.audioFolder}/${stem}.m4a`;

    const newFm = `---
mx-uid: "${stem}"
audio: "[[${audioRel}]]"
duration: "${dur}"
duration_sec: ${durationSec}
date: ${dt.date}
time_local: ${dt.timeLocal}
time_utc: ${dt.timeUtc}
timezone_offset: "${dt.tzOffset}"
label: "${label.replace(/"/g, '\\"')}"
original_file: "${zpath}"
tags:
  - voice-memo
---

`;

    await this.plugin.app.vault.modify(file, newFm + body);
    new Notice(`Repaired "${label}"`);
    this.plugin.refreshView();
  }

  private async findBinary(
    name: string,
    fallbacks: string[]
  ): Promise<string | null> {
    for (const bin of [name, ...fallbacks]) {
      if (path.isAbsolute(bin) && !fs.existsSync(bin)) continue;
      try {
        await execFileAsync(bin, ["-version"]);
        return bin;
      } catch {}
    }
    return null;
  }
}

// ---- Error Modal ----

class SyncResultsModal extends Modal {
  errors: string[];
  convertedFiles: string[];
  newFiles: string[];
  skipDone: number;

  constructor(app: App, results: { errors: string[]; convertedFiles: string[]; newFiles: string[]; skipDone: number }) {
    super(app);
    this.errors = results.errors;
    this.convertedFiles = results.convertedFiles;
    this.newFiles = results.newFiles;
    this.skipDone = results.skipDone;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("vm-errors-modal");

    if (this.newFiles.length > 0) {
      contentEl.createEl("h3", { text: `New (${this.newFiles.length})` });
      const pre = contentEl.createEl("pre", { cls: "vm-errors-list" });
      pre.setText(this.newFiles.join("\n"));
    }

    if (this.convertedFiles.length > 0) {
      contentEl.createEl("h3", { text: `Re-encoded ALAC \u2192 AAC (${this.convertedFiles.length})` });
      const pre = contentEl.createEl("pre", { cls: "vm-errors-list" });
      pre.setText(this.convertedFiles.join("\n"));
    }

    if (this.skipDone > 0) {
      contentEl.createEl("p", {
        text: `${this.skipDone} files skipped (already synced)`,
        cls: "vm-errors-hint",
      });
    }

    if (this.errors.length > 0) {
      contentEl.createEl("h3", { text: `Errors (${this.errors.length})` });
      contentEl.createEl("p", {
        text: "These files will be retried on the next sync.",
        cls: "vm-errors-hint",
      });
      const pre = contentEl.createEl("pre", { cls: "vm-errors-list" });
      pre.setText(this.errors.join("\n"));
    }

    const allText = [
      ...this.newFiles.map((f) => `[NEW] ${f}`),
      ...this.convertedFiles.map((f) => `[CONV] ${f}`),
      ...this.errors,
    ].join("\n");

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Copy to clipboard")
        .setCta()
        .onClick(async () => {
          await navigator.clipboard.writeText(allText);
          new Notice("Copied!");
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class IndexUpdateModal extends Modal {
  private resolve: (value: boolean) => void;

  constructor(app: App, resolve: (value: boolean) => void) {
    super(app);
    this.resolve = resolve;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Index Update" });
    contentEl.createEl("p", {
      text: "A new version of the Voice Memos Index is available. Would you like to update it? Your custom edits will be lost.",
    });
    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Overwrite").setCta().onClick(() => {
          this.resolve(true);
          this.close();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Keep mine").onClick(() => {
          this.resolve(false);
          this.close();
        })
      );
  }

  onClose() {
    this.resolve(false);
  }
}

function showIndexPrompt(app: App): Promise<boolean> {
  return new Promise((resolve) => {
    new IndexUpdateModal(app, resolve).open();
  });
}

// ---- Utilities ----

function parseDatetime(
  zpath: string,
  zdate: number
): { date: string; timeLocal: string; timeUtc: string; tzOffset: string } {
  const m = zpath.match(/^(\d{4})(\d{2})(\d{2}) (\d{2})(\d{2})(\d{2})/);
  if (!m) {
    const utcDate = new Date((zdate + CORE_DATA_EPOCH_OFFSET) * 1000);
    return {
      date: utcDate.toISOString().slice(0, 10),
      timeLocal: utcDate.toISOString().slice(11, 19),
      timeUtc: utcDate.toISOString().slice(11, 19),
      tzOffset: "+00:00",
    };
  }

  const [, year, month, day, hour, min, sec] = m;
  const localUnix =
    new Date(+year, +month - 1, +day, +hour, +min, +sec).getTime() / 1000;
  const utcUnix = zdate + CORE_DATA_EPOCH_OFFSET;
  const offsetSecs = Math.round((localUnix - utcUnix) / 900) * 900;
  const absH = Math.floor(Math.abs(offsetSecs) / 3600);
  const absM = Math.floor((Math.abs(offsetSecs) % 3600) / 60);
  const sign = offsetSecs >= 0 ? "+" : "-";
  const tzOffset = `${sign}${String(absH).padStart(2, "0")}:${String(absM).padStart(2, "0")}`;

  const utcDate = new Date(utcUnix * 1000);
  return {
    date: utcDate.toISOString().slice(0, 10),
    timeLocal: `${hour}:${min}:${sec}`,
    timeUtc: utcDate.toISOString().slice(11, 19),
    tzOffset,
  };
}

function formatDuration(totalSecs: number): string {
  const ts = Math.round(totalSecs);
  const m = Math.floor(ts / 60);
  const s = ts % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
