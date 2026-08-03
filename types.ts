import * as path from "path";
import * as os from "os";

export interface VoiceMemosSyncSettings {
  recordingsPath: string;
  notesFolder: string;
  audioFolder: string;
  ffmpegPath: string;
  indexHash: string;
  useCustomPath: boolean;
}

export const DEFAULT_SETTINGS: VoiceMemosSyncSettings = {
  recordingsPath: path.join(
    os.homedir(),
    "Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings"
  ),
  notesFolder: "Voice Memos/Notes",
  audioFolder: "Voice Memos/Audio",
  ffmpegPath: "ffmpeg",
  indexHash: "",
  useCustomPath: false,
};

export const CORE_DATA_EPOCH_OFFSET = 978307200;
