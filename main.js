"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => VoiceMemosSyncPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian4 = require("obsidian");

// types.ts
var path = __toESM(require("path"));
var os = __toESM(require("os"));
var DEFAULT_SETTINGS = {
  recordingsPath: path.join(
    os.homedir(),
    "Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings"
  ),
  notesFolder: "Voice Memos/Notes",
  audioFolder: "Voice Memos/Audio",
  ffmpegPath: "ffmpeg",
  indexHash: "",
  useCustomPath: false
};
var CORE_DATA_EPOCH_OFFSET = 978307200;

// sync.ts
var import_obsidian = require("obsidian");
var import_child_process = require("child_process");
var import_util = require("util");
var fs = __toESM(require("fs"));
var path2 = __toESM(require("path"));
var execFileAsync = (0, import_util.promisify)(import_child_process.execFile);
var SyncEngine = class {
  constructor(plugin) {
    this.syncing = false;
    this.cancel = false;
    this.plugin = plugin;
  }
  async run() {
    if (this.syncing) {
      new import_obsidian.Notice("Voice Memos: sync already in progress");
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
  async doSync() {
    const s = this.plugin.settings;
    const recordingsPath = s.useCustomPath ? s.recordingsPath : DEFAULT_SETTINGS.recordingsPath;
    const dbPath = path2.join(recordingsPath, "CloudRecordings.db");
    if (!fs.existsSync(dbPath)) {
      new import_obsidian.Notice(`CloudRecordings.db not found:
${recordingsPath}`);
      return;
    }
    const vaultBase = this.plugin.app.vault.adapter.basePath;
    const audioDir = path2.join(vaultBase, s.audioFolder);
    const notesDir = path2.join(vaultBase, s.notesFolder);
    await fs.promises.mkdir(audioDir, { recursive: true });
    await fs.promises.mkdir(notesDir, { recursive: true });
    const sqliteBin = await this.findBinary("sqlite3", [
      "/usr/bin/sqlite3",
      "/opt/homebrew/bin/sqlite3"
    ]);
    if (!sqliteBin) {
      new import_obsidian.Notice("sqlite3 not found. Install with: brew install sqlite");
      return;
    }
    const ffmpegBin = await this.findBinary(s.ffmpegPath, [
      "/opt/homebrew/bin/ffmpeg",
      "/usr/local/bin/ffmpeg"
    ]);
    if (!ffmpegBin) {
      new import_obsidian.Notice(`ffmpeg not found: ${s.ffmpegPath}`);
      return;
    }
    const ffprobeBin = await this.findBinary("ffprobe", [
      "/opt/homebrew/bin/ffprobe",
      "/usr/local/bin/ffprobe"
    ]);
    this.plugin.setStatus("Voice Memos: reading database\u2026");
    const query = "SELECT ZPATH, ZDATE, ZDURATION, ZCUSTOMLABELFORSORTING FROM ZCLOUDRECORDING";
    let rows;
    try {
      const result = await execFileAsync(sqliteBin, [dbPath, query], {
        encoding: "utf-8"
      });
      rows = result.stdout;
    } catch (e) {
      const msg = e.message || String(e);
      if (msg.includes("authorization")) {
        new import_obsidian.Notice(
          `Cannot read CloudRecordings.db \u2014 Obsidian needs Full Disk Access.

Open plugin settings and click "Grant Full Disk Access", then restart Obsidian.`
        );
      } else {
        new import_obsidian.Notice(`Failed to read CloudRecordings.db: ${msg}`);
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
    const errors = [];
    const convertedFiles = [];
    const newFiles = [];
    for (const line of lines) {
      if (this.cancel) break;
      const parts2 = line.split("|");
      if (parts2.length < 4) continue;
      const zpath = parts2[0].trim();
      if (!zpath) continue;
      const stem = zpath.replace(/\.(m4a|qta)$/i, "");
      if (!stem || stem === "." || stem === "/") continue;
      const zdate = parseFloat(parts2[1]);
      const zduration = parseFloat(parts2[2]);
      const zlabel = parts2[3] || "";
      const destAudio = path2.join(audioDir, stem + ".m4a");
      const destNote = path2.join(notesDir, stem + ".md");
      const audioExists = fs.existsSync(destAudio);
      let needsEncode = !audioExists;
      const isNewFile = !audioExists;
      const sourceFile = path2.join(recordingsPath, zpath);
      let inputFile = sourceFile;
      if (audioExists && ffprobeBin) {
        try {
          const { stdout } = await execFileAsync(ffprobeBin, [
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_name",
            "-of",
            "csv=p=0",
            destAudio
          ], { encoding: "utf-8" });
          if (stdout.trim() === "alac") {
            needsEncode = true;
            inputFile = destAudio;
          }
        } catch {
        }
      }
      if (fs.existsSync(destNote) && audioExists && !needsEncode) {
        skipDone++;
        processed++;
        continue;
      }
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
      this.plugin.setStatus(
        `Voice Memos: ${processed}/${total} \xB7 ${needsEncode ? isNewFile ? "New" : "Re-encoding" : "Updating note"} ${zpath}`
      );
      if (needsEncode) {
        try {
          await execFileAsync(ffmpegBin, [
            "-y",
            "-i",
            inputFile,
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-map",
            "0:a:0",
            destAudio.replace(/\.m4a$/, ".tmp.m4a")
          ]);
          await fs.promises.rename(destAudio.replace(/\.m4a$/, ".tmp.m4a"), destAudio);
          remuxCount++;
          if (isNewFile) {
            newFiles.push(stem);
          } else {
            convertedFiles.push(stem);
          }
        } catch (e) {
          try {
            await fs.promises.unlink(destAudio.replace(/\.m4a$/, ".tmp.m4a"));
          } catch {
          }
          errorCount++;
          processed++;
          errors.push(`${zpath}: audio conversion failed \u2014 ${e.message || String(e)}`);
          continue;
        }
      }
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
      try {
        await fs.promises.writeFile(destNote + ".tmp", note, "utf-8");
        await fs.promises.rename(destNote + ".tmp", destNote);
      } catch (e) {
        try {
          await fs.promises.unlink(destAudio);
        } catch {
        }
        errorCount++;
        processed++;
        errors.push(`${zpath}: note write failed \u2014 ${e.message || String(e)}`);
        continue;
      }
      newCount++;
      processed++;
    }
    const parts = [];
    if (newCount > 0) parts.push(`${newCount} new`);
    if (skipDone > 0) parts.push(`${skipDone} skipped`);
    if (remuxCount > 0) parts.push(`${remuxCount} converted`);
    if (errorCount > 0) parts.push(`${errorCount} errors`);
    const summary = parts.length > 0 ? `Voice Memos: ${parts.join(", ")}` : "Voice Memos: up to date";
    const cancelled = this.cancel ? " (cancelled)" : "";
    this.plugin.setStatus(summary + cancelled);
    this.plugin.clearStatus(8e3);
    new import_obsidian.Notice(summary + cancelled);
    setTimeout(() => this.plugin.refreshView(), 250);
    if (errors.length > 0 || convertedFiles.length > 0 || newFiles.length > 0) {
      new SyncResultsModal(this.plugin.app, { errors, convertedFiles, newFiles, skipDone }).open();
    }
  }
  async repairFrontmatter(file) {
    const s = this.plugin.settings;
    const content = await this.plugin.app.vault.read(file);
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) {
      new import_obsidian.Notice("No frontmatter found");
      return;
    }
    const fmRaw = fmMatch[1];
    const mxMatch = fmRaw.match(/mx-uid:\s*"?(.+?)"?\s*$/m);
    const stem = mxMatch?.[1] || file.basename;
    const body = content.slice(fmMatch.index + fmMatch[0].length);
    const dbPath = path2.join(s.recordingsPath, "CloudRecordings.db");
    if (!fs.existsSync(dbPath)) {
      new import_obsidian.Notice(`Database not found: ${dbPath}`);
      return;
    }
    const sqliteBin = await this.findBinary("sqlite3", [
      "/usr/bin/sqlite3",
      "/opt/homebrew/bin/sqlite3"
    ]);
    if (!sqliteBin) {
      new import_obsidian.Notice("sqlite3 not found");
      return;
    }
    const query = `SELECT ZPATH, ZDATE, ZDURATION, ZCUSTOMLABELFORSORTING FROM ZCLOUDRECORDING WHERE ZPATH LIKE '${stem}.%'`;
    let zpath = "", zdate = 0, zduration = 0, zlabel = "";
    try {
      const result = await execFileAsync(sqliteBin, [dbPath, query], { encoding: "utf-8" });
      const dbRows = result.stdout.trim().split("\n").filter((l) => l.includes("|"));
      if (dbRows.length > 0) {
        const parts = dbRows[0].split("|");
        zpath = parts[0].trim();
        zdate = parseFloat(parts[1]) || 0;
        zduration = parseFloat(parts[2]) || 0;
        zlabel = (parts[3] || "").trim();
      }
    } catch {
    }
    if (!zpath) {
      new import_obsidian.Notice(`Recording "${stem}" not found in database`);
      return;
    }
    let durationSec = zduration;
    const vaultBase = this.plugin.app.vault.adapter.basePath;
    const audioPath = path2.join(vaultBase, s.audioFolder, stem + ".m4a");
    if (fs.existsSync(audioPath)) {
      try {
        const ffprobeBin = await this.findBinary("ffprobe", [
          "/opt/homebrew/bin/ffprobe",
          "/usr/local/bin/ffprobe"
        ]);
        if (ffprobeBin) {
          const probe = await execFileAsync(ffprobeBin, [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
            audioPath
          ], { encoding: "utf-8" });
          const parsed = parseFloat(probe.stdout);
          if (parsed > 0) durationSec = parsed;
        }
      } catch {
      }
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
    new import_obsidian.Notice(`Repaired "${label}"`);
    this.plugin.refreshView();
  }
  async findBinary(name, fallbacks) {
    for (const bin of [name, ...fallbacks]) {
      if (path2.isAbsolute(bin) && !fs.existsSync(bin)) continue;
      try {
        await execFileAsync(bin, ["-version"]);
        return bin;
      } catch {
      }
    }
    return null;
  }
};
var SyncResultsModal = class extends import_obsidian.Modal {
  constructor(app, results) {
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
        cls: "vm-errors-hint"
      });
    }
    if (this.errors.length > 0) {
      contentEl.createEl("h3", { text: `Errors (${this.errors.length})` });
      contentEl.createEl("p", {
        text: "These files will be retried on the next sync.",
        cls: "vm-errors-hint"
      });
      const pre = contentEl.createEl("pre", { cls: "vm-errors-list" });
      pre.setText(this.errors.join("\n"));
    }
    const allText = [
      ...this.newFiles.map((f) => `[NEW] ${f}`),
      ...this.convertedFiles.map((f) => `[CONV] ${f}`),
      ...this.errors
    ].join("\n");
    new import_obsidian.Setting(contentEl).addButton(
      (btn) => btn.setButtonText("Copy to clipboard").setCta().onClick(async () => {
        await navigator.clipboard.writeText(allText);
        new import_obsidian.Notice("Copied!");
      })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
};
function parseDatetime(zpath, zdate) {
  const m = zpath.match(/^(\d{4})(\d{2})(\d{2}) (\d{2})(\d{2})(\d{2})/);
  if (!m) {
    const utcDate2 = new Date((zdate + CORE_DATA_EPOCH_OFFSET) * 1e3);
    return {
      date: utcDate2.toISOString().slice(0, 10),
      timeLocal: utcDate2.toISOString().slice(11, 19),
      timeUtc: utcDate2.toISOString().slice(11, 19),
      tzOffset: "+00:00"
    };
  }
  const [, year, month, day, hour, min, sec] = m;
  const localUnix = new Date(+year, +month - 1, +day, +hour, +min, +sec).getTime() / 1e3;
  const utcUnix = zdate + CORE_DATA_EPOCH_OFFSET;
  const offsetSecs = Math.round((localUnix - utcUnix) / 900) * 900;
  const absH = Math.floor(Math.abs(offsetSecs) / 3600);
  const absM = Math.floor(Math.abs(offsetSecs) % 3600 / 60);
  const sign = offsetSecs >= 0 ? "+" : "-";
  const tzOffset = `${sign}${String(absH).padStart(2, "0")}:${String(absM).padStart(2, "0")}`;
  const utcDate = new Date(utcUnix * 1e3);
  return {
    date: utcDate.toISOString().slice(0, 10),
    timeLocal: `${hour}:${min}:${sec}`,
    timeUtc: utcDate.toISOString().slice(11, 19),
    tzOffset
  };
}
function formatDuration(totalSecs) {
  const ts = Math.round(totalSecs);
  const m = Math.floor(ts / 60);
  const s = ts % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// view.ts
var import_obsidian2 = require("obsidian");

// player.ts
var Miniplayer = class {
  constructor() {
    this.audioEl = null;
    this.playBtn = null;
    this.currentEl = null;
    this.totalEl = null;
    this.seekEl = null;
    this.labelEl = null;
    this._label = null;
    this.onTimeUpdate = null;
    this.onEnded = null;
    this.onError = null;
    this.onLabelClick = null;
  }
  get label() {
    return this._label;
  }
  get currentTime() {
    return this.audioEl?.currentTime ?? 0;
  }
  set currentTime(v) {
    if (this.audioEl) this.audioEl.currentTime = v;
  }
  get duration() {
    return this.audioEl?.duration ?? 0;
  }
  get paused() {
    return !this.audioEl || this.audioEl.paused;
  }
  render(container, label) {
    this._label = label;
    const player = container.createDiv("vm-player");
    this.labelEl = player.createDiv("vm-player-label");
    this.labelEl.setText(label || "\u2014");
    if (label) {
      this.labelEl.addClass("vm-clickable");
      this.labelEl.addEventListener("click", () => {
        if (this.onLabelClick) this.onLabelClick();
      });
    }
    const controls = player.createDiv("vm-player-controls");
    this.playBtn = controls.createDiv("vm-player-play");
    this.playBtn.setText(
      label && this.audioEl && !this.audioEl.paused ? "\u23F8" : "\u25B6"
    );
    this.playBtn.addEventListener("click", () => this.togglePlay());
    this.currentEl = controls.createDiv("vm-player-time");
    this.currentEl.setText("0:00");
    this.seekEl = controls.createEl("input", {
      type: "range",
      cls: "vm-player-seek"
    });
    this.seekEl.min = "0";
    this.seekEl.max = "100";
    this.seekEl.value = "0";
    this.seekEl.addEventListener("input", () => {
      if (this.audioEl) {
        const pct = parseFloat(this.seekEl.value);
        this.audioEl.currentTime = pct / 100 * this.audioEl.duration;
      }
    });
    this.totalEl = controls.createDiv("vm-player-time");
    this.totalEl.setText("0:00");
    this.attachAudio(container);
  }
  play() {
    if (!this.audioEl) return;
    this.audioEl.play().catch((e) => {
      if (this.onError) this.onError(e instanceof Error ? e.message : String(e));
    });
    if (this.playBtn) this.playBtn.setText("\u23F8");
  }
  pause() {
    this.audioEl?.pause();
    if (this.playBtn) this.playBtn.setText("\u25B6");
  }
  togglePlay() {
    if (!this.audioEl) return;
    if (this.audioEl.paused) this.play();
    else this.pause();
  }
  load(src, label) {
    if (!this.audioEl) {
      console.warn("[VoiceMemos] load: no audio element");
      return;
    }
    console.log("[VoiceMemos] load:", label, "src:", src.substring(0, 80));
    this.audioEl.src = src;
    this._label = label;
    if (this.labelEl) this.labelEl.setText(label || "\u2014");
  }
  setPlayBtn(icon) {
    if (this.playBtn) this.playBtn.setText(icon);
  }
  detachAudio() {
    if (this.audioEl?.parentNode) {
      this.audioEl.parentNode.removeChild(this.audioEl);
    }
  }
  attachAudio(container) {
    if (this.audioEl) {
      container.appendChild(this.audioEl);
    } else {
      this.audioEl = container.createEl("audio", { attr: { preload: "auto" } });
      this.audioEl.addEventListener("timeupdate", () => {
        if (!this.audioEl || !this.currentEl || !this.seekEl || !this.totalEl) return;
        const { currentTime, duration } = this.audioEl;
        if (duration && isFinite(duration)) {
          this.seekEl.value = String(currentTime / duration * 100);
          this.totalEl.setText(formatDuration2(duration));
        }
        this.currentEl.setText(formatDuration2(currentTime));
        if (this.onTimeUpdate) this.onTimeUpdate(currentTime, duration);
      });
      this.audioEl.addEventListener("loadedmetadata", () => {
        if (this.onTimeUpdate && this.audioEl) {
          this.onTimeUpdate(this.audioEl.currentTime, this.audioEl.duration);
        }
      });
      this.audioEl.addEventListener("ended", () => {
        if (this.onEnded) this.onEnded();
      });
      this.audioEl.addEventListener("play", () => this.setPlayBtn("\u23F8"));
      this.audioEl.addEventListener("pause", () => this.setPlayBtn("\u25B6"));
    }
  }
  updateTimeDisplay(currentTime, duration) {
    if (this.currentEl) this.currentEl.setText(formatDuration2(currentTime));
    if (this.totalEl && duration && isFinite(duration)) {
      this.totalEl.setText(formatDuration2(duration));
    }
    if (this.seekEl && duration && isFinite(duration)) {
      this.seekEl.value = String(currentTime / duration * 100);
    }
  }
  destroy() {
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.src = "";
      this.audioEl = null;
    }
  }
};
function formatDuration2(sec) {
  if (!sec || sec <= 0) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor(sec % 3600 / 60);
  const s = Math.floor(sec % 60);
  const mmss = `${m}:${s.toString().padStart(2, "0")}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

// timestamps.ts
function formatDuration3(sec) {
  if (!sec || sec <= 0) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor(sec % 3600 / 60);
  const s = Math.floor(sec % 60);
  const mmss = `${m}:${s.toString().padStart(2, "0")}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}
async function loadTimestamps(vault, noteFile) {
  const content = (await vault.cachedRead(noteFile)).split("\n");
  const fmEnd = content.indexOf("---", 1);
  const bodyStart = fmEnd === -1 ? 0 : fmEnd + 1;
  const result = [];
  for (let i = bodyStart; i < content.length; i++) {
    const line = content[i];
    const stripped = line.replace(/^\s*-+\s*/, "").trim();
    if (!stripped) continue;
    const m = stripped.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s*(.*)/);
    if (m) {
      const parts = m[1].split(":").map(Number);
      const timeSec = parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2];
      result.push({ timeSec, label: m[2] });
    }
  }
  return result.sort((a, b) => a.timeSec - b.timeSec);
}
async function insertTimestampInFile(noteFile, sec, vault) {
  const ts = formatDuration3(sec);
  let resultTimestamps = [];
  await vault.process(noteFile, (content) => {
    const fmEnd = content.indexOf("\n---", 3);
    const bodyStart = fmEnd === -1 ? 0 : fmEnd + 4;
    const after = content.slice(bodyStart);
    const lines = after.split("\n");
    const entry = `- ${ts} `;
    const existing = [];
    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].replace(/^\s*-+\s*/, "").trim();
      const m = stripped.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s*(.*)/);
      if (m) {
        const parts = m[1].split(":").map(Number);
        existing.push({
          line: lines[i],
          sec: parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2],
          label: m[2]
        });
      }
    }
    const all = [...existing, { line: entry, sec, label: "" }].sort((a, b) => a.sec - b.sec);
    resultTimestamps = all.map((e) => ({ timeSec: e.sec, label: e.label }));
    const nonTsLines = lines.filter((l) => {
      const s = l.replace(/^\s*-+\s*/, "").trim();
      return !s.match(/^\d{1,2}:\d{2}(?::\d{2})?/);
    });
    while (nonTsLines.length && nonTsLines[nonTsLines.length - 1] === "") nonTsLines.pop();
    const prefix = content.slice(0, bodyStart);
    return prefix + nonTsLines.join("\n") + "\n" + all.map((e) => e.line).join("\n");
  });
  return { ts, timestamps: resultTimestamps };
}
var TimestampPanel = class {
  constructor() {
    this.container = null;
    this.timestamps = [];
    this.activeIdx = -1;
    this.onSeek = null;
    this.onInsert = null;
  }
  render(parent, timestamps, activeIdx, currentTime) {
    this.timestamps = timestamps;
    this.activeIdx = activeIdx;
    const tsContainer = parent.createDiv("vm-timestamps");
    this.container = tsContainer;
    const header = tsContainer.createDiv("vm-ts-header");
    header.setText("Timestamps");
    let currentRowInserted = false;
    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      if (!currentRowInserted && currentTime < ts.timeSec) {
        this.createCurrentRow(tsContainer, currentTime);
        currentRowInserted = true;
      }
      const row = tsContainer.createDiv("vm-ts-row");
      if (i === activeIdx) row.addClass("active");
      row.createDiv("vm-ts-time").setText(formatDuration3(ts.timeSec));
      row.createDiv("vm-ts-label").setText(ts.label.trim() || "(unnamed)");
      row.addEventListener("click", () => {
        if (this.onSeek) this.onSeek(ts.timeSec);
      });
    }
    if (!currentRowInserted) {
      this.createCurrentRow(tsContainer, currentTime);
    }
  }
  createCurrentRow(parent, currentTime) {
    const row = parent.createDiv("vm-ts-row vm-ts-current-row");
    row.createDiv("vm-ts-time").setText(formatDuration3(currentTime));
    row.createDiv("vm-ts-label").setText("\u2190 click to insert");
    row.addEventListener("click", () => {
      if (this.onInsert) this.onInsert();
    });
  }
  updateCurrentTime(currentTime) {
    if (!this.container) return;
    const el = this.container.querySelector(".vm-ts-current-row .vm-ts-time");
    if (el) el.textContent = formatDuration3(currentTime);
  }
  updateActive(activeIdx) {
    if (activeIdx === this.activeIdx || !this.container) return;
    this.activeIdx = activeIdx;
    const rows = this.container.querySelectorAll(".vm-ts-row:not(.vm-ts-current-row)");
    rows.forEach((el, i) => {
      if (i === activeIdx) el.addClass("active");
      else el.removeClass("active");
    });
  }
};

// view.ts
var VIEW_TYPE = "voice-memos-list";
function formatDuration4(sec) {
  if (!sec || sec <= 0) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor(sec % 3600 / 60);
  const s = Math.floor(sec % 60);
  const mmss = `${m}:${s.toString().padStart(2, "0")}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}
function parseDurationSec(fm) {
  if (typeof fm.duration_sec === "number") return fm.duration_sec;
  if (typeof fm.duration === "number") return fm.duration;
  if (typeof fm.duration === "string") return parseFloat(fm.duration) || 0;
  return 0;
}
var VoiceMemosListView = class extends import_obsidian2.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.recordings = [];
    this.sortKey = "date";
    this.sortDir = "desc";
    this.filterText = "";
    this.playingLabel = null;
    this.playingFile = null;
    this.timestamps = [];
    this.activeTsIdx = -1;
    this.player = new Miniplayer();
    this.tsPanel = new TimestampPanel();
    this._syncDebounce = 0;
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
      new import_obsidian2.Notice(`Playback error: ${msg}`);
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
  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "Voice Memos";
  }
  getIcon() {
    return "mic";
  }
  async onOpen() {
    this.loadRecordings();
    this.render();
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (this.playingFile && file.path === this.playingFile.path) {
          clearTimeout(this._syncDebounce);
          this._syncDebounce = window.setTimeout(async () => {
            this.timestamps = await loadTimestamps(this.app.vault, this.playingFile);
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
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(s.notesFolder) && f.path.endsWith(".md"));
    this.recordings = [];
    for (const file of files) {
      const meta = this.app.metadataCache.getFileCache(file);
      const fm = meta?.frontmatter;
      const label = fm?.label || fm?.["mx-uid"] || file.basename;
      if (!label) continue;
      const audioMatch = fm?.audio ? typeof fm.audio === "string" ? fm.audio.match(/\[\[(.*?)\]\]/) : null : null;
      this.recordings.push({
        label,
        date: fm?.date || "",
        time: fm?.time_local || "",
        durationSec: parseDurationSec(fm || {}),
        file,
        audioPath: audioMatch?.[1] || ""
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
    const header = container.createDiv("vm-header");
    const sortButtons = header.createDiv("vm-sort-buttons");
    this.createSortBtn(sortButtons, "Date", "date");
    this.createSortBtn(sortButtons, "Label", "label");
    this.createSortBtn(sortButtons, "Duration", "duration");
    const dirBtn = sortButtons.createEl("button", {
      cls: "vm-sort-btn",
      text: this.sortDir === "desc" ? "\u2193 Newest" : "\u2191 Oldest"
    });
    dirBtn.addEventListener("click", () => {
      this.sortDir = this.sortDir === "desc" ? "asc" : "desc";
      this.sortRecordings();
      this.render();
    });
    const filterRow = container.createDiv("vm-filter");
    const filterInput = filterRow.createEl("input", {
      type: "text",
      placeholder: "Filter recordings\u2026",
      value: this.filterText
    });
    filterInput.addEventListener("input", (e) => {
      const input = e.target;
      const cursor = input.selectionStart;
      this.filterText = input.value.toLowerCase();
      this.render();
      const newInput = this.containerEl.querySelector(".vm-filter input");
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
    const list = container.createDiv("vm-list");
    const filtered = this.recordings.filter(
      (r) => !this.filterText || r.label.toLowerCase().includes(this.filterText) || r.date.includes(this.filterText)
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
        const menu = new import_obsidian2.Menu();
        menu.addItem(
          (item) => item.setTitle("Open in new tab").onClick(() => {
            this.app.workspace.getLeaf("tab").openFile(r.file);
          })
        );
        menu.showAtMouseEvent(e);
      });
      const meta = info.createDiv("vm-meta");
      meta.setText(`${r.date} \xB7 ${formatDuration4(r.durationSec)}`);
      const repairBtn = row.createDiv("vm-repair-btn");
      repairBtn.setText("\u21BB");
      repairBtn.setAttr("aria-label", "Repair frontmatter");
      repairBtn.addEventListener("click", async () => {
        repairBtn.setText("\u23F3");
        await new SyncEngine(this.plugin).repairFrontmatter(r.file);
        repairBtn.setText("\u21BB");
      });
    }
    if (this.playingLabel) {
      this.tsPanel.render(
        container,
        this.timestamps,
        this.activeTsIdx,
        this.player.currentTime
      );
    }
    this.player.render(container, this.playingLabel);
  }
  createSortBtn(parent, label, key) {
    const btn = parent.createEl("button", {
      cls: `vm-sort-btn${this.sortKey === key ? " active" : ""}`,
      text: label
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
  async playFromLink(audioPath, seekSec) {
    const file = this.app.vault.getAbstractFileByPath(audioPath);
    if (!(file instanceof import_obsidian2.TFile)) return;
    const stem = audioPath.split("/").pop()?.replace(/\.m4a$/i, "");
    let label = stem || "Recording";
    let noteFile = null;
    if (stem) {
      const notePath = `${this.plugin.settings.notesFolder}/${stem}.md`;
      const nf = this.app.vault.getAbstractFileByPath(notePath);
      if (nf instanceof import_obsidian2.TFile) {
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
  async togglePlay(r) {
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
      new import_obsidian2.Notice("No audio file linked to this recording");
      return;
    }
    try {
      const file = this.app.vault.getAbstractFileByPath(r.audioPath);
      if (!file) {
        new import_obsidian2.Notice(`Audio file not found: ${r.audioPath}`);
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
      new import_obsidian2.Notice(`Playback failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  computeActiveTimestamp(currentTime) {
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
  async insertTimestamp() {
    if (!this.playingFile) return;
    const sec = Math.round(this.player.currentTime);
    const { ts, timestamps } = await insertTimestampInFile(this.playingFile, sec, this.app.vault);
    this.timestamps = timestamps;
    this.render();
    const existingLeaf = this.app.workspace.getLeavesOfType("markdown").find((l) => l.view?.file?.path === this.playingFile.path);
    const leaf = existingLeaf || this.app.workspace.getLeaf("tab");
    await leaf.openFile(this.playingFile);
    setTimeout(() => {
      const editor = leaf.view?.editor;
      if (!editor) return;
      const lines = editor.getValue().split("\n");
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
};

// settings.ts
var import_obsidian3 = require("obsidian");
var import_child_process2 = require("child_process");
var fs2 = __toESM(require("fs"));
var path3 = __toESM(require("path"));
var VoiceMemosSettingTab = class extends import_obsidian3.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Voice Memos Sync" });
    const s = this.plugin.settings;
    const systemPath = DEFAULT_SETTINGS.recordingsPath;
    const customPath = s.recordingsPath;
    const activePath = s.useCustomPath ? customPath : systemPath;
    const dbFilePath = path3.join(activePath, "CloudRecordings.db");
    let accessible = false;
    try {
      fs2.accessSync(dbFilePath, fs2.constants.R_OK);
      accessible = true;
    } catch {
    }
    new import_obsidian3.Setting(containerEl).setName("System recordings path").setDesc("macOS Voice Memos default location").addText(
      (text) => text.setValue(systemPath).setDisabled(true)
    );
    new import_obsidian3.Setting(containerEl).setName("Use custom recordings path").setDesc("Sync from a different folder (e.g. external drive)").addToggle(
      (toggle) => toggle.setValue(s.useCustomPath).onChange(async (value) => {
        s.useCustomPath = value;
        await this.plugin.saveSettings();
        this.display();
      })
    );
    if (s.useCustomPath) {
      new import_obsidian3.Setting(containerEl).setName("Custom recordings path").setDesc("Folder containing CloudRecordings.db and audio files").addText(
        (text) => text.setPlaceholder("/path/to/Recordings").setValue(customPath).onChange(async (value) => {
          s.recordingsPath = value;
          await this.plugin.saveSettings();
        })
      );
    }
    const sourceLabel = s.useCustomPath ? "Custom" : "System";
    if (accessible) {
      containerEl.createDiv({ cls: "setting-item-description" }).innerHTML = `<span style="color:green">\u2713 Syncing from ${sourceLabel}: ${activePath}</span>`;
    } else {
      containerEl.createDiv({ cls: "setting-item-description" }).innerHTML = `<span style="color:red">\u2717 ${sourceLabel} path not readable: ${activePath}</span>`;
      if (!s.useCustomPath) {
        containerEl.createDiv({ cls: "setting-item-description" }).createEl("p", {
          text: "Obsidian needs Full Disk Access to read the Voice Memos database."
        });
        new import_obsidian3.Setting(containerEl).setName("Grant Full Disk Access").setDesc(
          "Opens macOS System Settings \u2192 Privacy & Security \u2192 Full Disk Access. Add Obsidian, then restart Obsidian."
        ).addButton(
          (btn) => btn.setButtonText("Open Settings").setCta().onClick(() => {
            (0, import_child_process2.execFile)("open", [
              "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
            ]);
          })
        );
      }
    }
    new import_obsidian3.Setting(containerEl).setName("Notes folder").setDesc("Vault folder for synced notes").addText(
      (text) => text.setPlaceholder(DEFAULT_SETTINGS.notesFolder).setValue(this.plugin.settings.notesFolder).onChange(async (value) => {
        this.plugin.settings.notesFolder = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Audio folder").setDesc("Vault folder for synced audio files").addText(
      (text) => text.setPlaceholder(DEFAULT_SETTINGS.audioFolder).setValue(this.plugin.settings.audioFolder).onChange(async (value) => {
        this.plugin.settings.audioFolder = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("ffmpeg path").setDesc("Path to ffmpeg binary").addText(
      (text) => text.setPlaceholder("ffmpeg").setValue(this.plugin.settings.ffmpegPath).onChange(async (value) => {
        this.plugin.settings.ffmpegPath = value;
        await this.plugin.saveSettings();
      })
    );
  }
};

// main.ts
var VoiceMemosSyncPlugin = class extends import_obsidian4.Plugin {
  constructor() {
    super(...arguments);
    this.statusBarItem = null;
  }
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
      callback: () => new SyncEngine(this).run()
    });
    this.addCommand({
      id: "open-voice-memos-list",
      name: "Open Voice Memos list",
      callback: () => this.activateView()
    });
    this.addSettingTab(new VoiceMemosSettingTab(this.app, this));
    this.registerDomEvent(document, "click", (evt) => {
      const anchor = evt.target.closest("a");
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
      try {
        linkPath = decodeURIComponent(linkPath);
      } catch {
      }
      this.playInSidebar(linkPath, parseFloat(tMatch[1]));
    }, { capture: true });
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  setStatus(text) {
    if (this.statusBarItem) {
      this.statusBarItem.setText(text);
    }
  }
  clearStatus(delayMs = 5e3) {
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
  async playInSidebar(audioPath, seekSec) {
    await this.activateView();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (leaf) {
      leaf.view.playFromLink(audioPath, seekSec);
    }
  }
  refreshView() {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (leaf?.view) {
      const view = leaf.view;
      view.loadRecordings();
      view.render();
    }
  }
};
