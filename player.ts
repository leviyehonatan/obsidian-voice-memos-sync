export class Miniplayer {
  audioEl: HTMLAudioElement | null = null;

  private playBtn: HTMLElement | null = null;
  private currentEl: HTMLElement | null = null;
  private totalEl: HTMLElement | null = null;
  private seekEl: HTMLInputElement | null = null;
  private labelEl: HTMLElement | null = null;
  private _label: string | null = null;

  onTimeUpdate: ((currentTime: number, duration: number) => void) | null = null;
  onEnded: (() => void) | null = null;
  onError: ((message: string) => void) | null = null;
  onLabelClick: (() => void) | null = null;

  get label() { return this._label; }

  get currentTime(): number { return this.audioEl?.currentTime ?? 0; }
  set currentTime(v: number) { if (this.audioEl) this.audioEl.currentTime = v; }

  get duration(): number { return this.audioEl?.duration ?? 0; }
  get paused(): boolean { return !this.audioEl || this.audioEl.paused; }

  render(container: HTMLElement, label: string | null) {
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
      cls: "vm-player-seek",
    }) as HTMLInputElement;
    this.seekEl.min = "0";
    this.seekEl.max = "100";
    this.seekEl.value = "0";
    this.seekEl.addEventListener("input", () => {
      if (this.audioEl) {
        const pct = parseFloat(this.seekEl.value);
        this.audioEl.currentTime = (pct / 100) * this.audioEl.duration;
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

  load(src: string, label: string | null) {
    if (!this.audioEl) {
      console.warn("[VoiceMemos] load: no audio element");
      return;
    }
    console.log("[VoiceMemos] load:", label, "src:", src.substring(0, 80));
    this.audioEl.src = src;
    this._label = label;
    if (this.labelEl) this.labelEl.setText(label || "\u2014");
  }

  setPlayBtn(icon: string) {
    if (this.playBtn) this.playBtn.setText(icon);
  }

  detachAudio() {
    if (this.audioEl?.parentNode) {
      this.audioEl.parentNode.removeChild(this.audioEl);
    }
  }

  private attachAudio(container: HTMLElement) {
    if (this.audioEl) {
      container.appendChild(this.audioEl);
    } else {
      this.audioEl = container.createEl("audio", { attr: { preload: "auto" } });

      this.audioEl.addEventListener("timeupdate", () => {
        if (!this.audioEl || !this.currentEl || !this.seekEl || !this.totalEl) return;
        const { currentTime, duration } = this.audioEl;
        if (duration && isFinite(duration)) {
          this.seekEl.value = String((currentTime / duration) * 100);
          this.totalEl.setText(formatDuration(duration));
        }
        this.currentEl.setText(formatDuration(currentTime));
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

  updateTimeDisplay(currentTime: number, duration: number) {
    if (this.currentEl) this.currentEl.setText(formatDuration(currentTime));
    if (this.totalEl && duration && isFinite(duration)) {
      this.totalEl.setText(formatDuration(duration));
    }
    if (this.seekEl && duration && isFinite(duration)) {
      this.seekEl.value = String((currentTime / duration) * 100);
    }
  }

  destroy() {
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.src = "";
      this.audioEl = null;
    }
  }
}

function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mmss = `${m}:${s.toString().padStart(2, "0")}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}
