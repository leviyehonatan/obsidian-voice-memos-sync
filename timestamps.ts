import { TFile, Vault } from "obsidian";

export interface Timestamp {
  timeSec: number;
  label: string;
}

function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mmss = `${m}:${s.toString().padStart(2, "0")}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

export async function loadTimestamps(vault: Vault, noteFile: TFile): Promise<Timestamp[]> {
  const content = (await vault.cachedRead(noteFile)).split("\n");

  const fmEnd = content.indexOf("---", 1);
  const bodyStart = fmEnd === -1 ? 0 : fmEnd + 1;

  const result: Timestamp[] = [];

  for (let i = bodyStart; i < content.length; i++) {
    const line = content[i];
    const stripped = line.replace(/^\s*-+\s*/, "").trim();
    if (!stripped) continue;
    const m = stripped.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s*(.*)/);
    if (m) {
      const parts = m[1].split(":").map(Number);
      const timeSec = parts.length === 2
        ? parts[0] * 60 + parts[1]
        : parts[0] * 3600 + parts[1] * 60 + parts[2];
      result.push({ timeSec, label: m[2] });
    }
  }

  return result.sort((a, b) => a.timeSec - b.timeSec);
}

export async function insertTimestampInFile(
  noteFile: TFile,
  sec: number,
  vault: Vault,
): Promise<{ ts: string; timestamps: Timestamp[] }> {
  const ts = formatDuration(sec);
  let resultTimestamps: Timestamp[] = [];

  await vault.process(noteFile, (content) => {
    const fmEnd = content.indexOf("\n---", 3);
    const bodyStart = fmEnd === -1 ? 0 : fmEnd + 4;

    const after = content.slice(bodyStart);
    const lines = after.split("\n");
    const entry = `- ${ts}`;

    const existing: { line: string; sec: number; label: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].replace(/^\s*-+\s*/, "").trim();
      const m = stripped.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s*(.*)/);
      if (m) {
        const parts = m[1].split(":").map(Number);
        existing.push({
          line: lines[i],
          sec: parts.length === 2
            ? parts[0] * 60 + parts[1]
            : parts[0] * 3600 + parts[1] * 60 + parts[2],
          label: m[2],
        });
      }
    }

    const all = [...existing, { line: entry, sec, label: "" }].sort((a, b) => a.sec - b.sec);

    // compute result timestamps from sorted list
    resultTimestamps = all.map((e) => ({ timeSec: e.sec, label: e.label }));

    // keep non-timestamp lines, append sorted timestamps
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

export class TimestampPanel {
  private container: HTMLElement | null = null;
  private timestamps: Timestamp[] = [];
  private activeIdx: number = -1;

  onSeek: ((timeSec: number) => void) | null = null;
  onInsert: (() => void) | null = null;

  render(
    parent: HTMLElement,
    timestamps: Timestamp[],
    activeIdx: number,
    currentTime: number,
  ) {
    this.timestamps = timestamps;
    this.activeIdx = activeIdx;

    const tsContainer = parent.createDiv("vm-timestamps");
    this.container = tsContainer;

    const header = tsContainer.createDiv("vm-ts-header");
    header.setText("Timestamps");

    // Live current-position row — click to insert
    const currentRow = tsContainer.createDiv("vm-ts-row vm-ts-current-row");
    currentRow.createDiv("vm-ts-time").setText(formatDuration(currentTime));
    currentRow.createDiv("vm-ts-label").setText("\u2190 click to insert");
    currentRow.addEventListener("click", () => {
      if (this.onInsert) this.onInsert();
    });

    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      const row = tsContainer.createDiv("vm-ts-row");
      if (i === activeIdx) row.addClass("active");

      row.createDiv("vm-ts-time").setText(formatDuration(ts.timeSec));
      row.createDiv("vm-ts-label").setText(ts.label.trim() || "(unnamed)");

      row.addEventListener("click", () => {
        if (this.onSeek) this.onSeek(ts.timeSec);
      });
    }
  }

  updateCurrentTime(currentTime: number) {
    if (!this.container) return;
    const el = this.container.querySelector(".vm-ts-current-row .vm-ts-time");
    if (el) el.textContent = formatDuration(currentTime);
  }

  updateActive(activeIdx: number) {
    if (activeIdx === this.activeIdx || !this.container) return;
    this.activeIdx = activeIdx;
    const rows = this.container.querySelectorAll(".vm-ts-row:not(.vm-ts-current-row)");
    rows.forEach((el, i) => {
      if (i === activeIdx) el.addClass("active");
      else el.removeClass("active");
    });
  }
}
