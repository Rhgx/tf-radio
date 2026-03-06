export type CommandScope = "self" | "anyone";

export type PlaybackState = "idle" | "buffering" | "playing" | "paused" | "error";

export interface Settings {
  tf2Path: string | null;
  consoleLogPath: string | null;
  playerName: string;
  commandPrefix: "?play";
  commandScope: CommandScope;
  clearLogsOnStartup: boolean;
  rconHost: "127.0.0.1";
  rconPort: number;
  rconPassword: string;
  outputDeviceId: string | null;
  mirrorToDefaultSpeaker: boolean;
  botVolume: number;
  maxTracksPerUser: number;
  minimizeToTray: boolean;
  overlayEnabled: boolean;
  chatSkipCommandEnabled: boolean;
  chatPauseCommandEnabled: boolean;
  chatStopCommandEnabled: boolean;
  skipShortcut: string | null;
  pauseShortcut: string | null;
  stopShortcut: string | null;
  chatResponsesEnabled: boolean;
}

export interface QueueItem {
  id: string;
  requestedBy: string;
  query: string;
  title: string;
  channel: string;
  durationSec: number | null;
  webpageUrl: string;
  streamUrl: string;
  thumbnailUrl: string | null;
}

export interface AppState {
  connectedToRcon: boolean;
  playback: PlaybackState;
  playbackStartedAt: number | null;
  current: QueueItem | null;
  queue: QueueItem[];
  lastError: string | null;
  serviceRunning: boolean;
  setupIssue: SetupIssue | null;
}

export interface SetupIssue {
  code:
    | "tf2_not_found"
    | "console_log_missing"
    | "launch_options_missing"
    | "rcon_connect_failed"
    | "yt_dlp_error"
    | "unknown";
  message: string;
  launchOptionsHint?: string;
}

export interface AudioOutputDevice {
  deviceId: string;
  label: string;
  isDefault: boolean;
  isLikelyVirtualCable: boolean;
}

export type ParsedCommand =
  | {
      speaker: string;
      kind: "play";
      query: string;
    }
  | {
      speaker: string;
      kind: "skip" | "pause" | "resume" | "stop";
    };

export interface LogLineEvent {
  line: string;
  offset: number;
}
