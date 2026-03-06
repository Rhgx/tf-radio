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
  inGameVolume: number;
  playbackVolume: number;
  maxTracksPerUser: number;
  minimizeToTray: boolean;
  overlayEnabled: boolean;
  chatSkipCommandEnabled: boolean;
  chatPauseCommandEnabled: boolean;
  chatStopCommandEnabled: boolean;
  chatLinksEnabled: boolean;
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

export interface AudioOutputDevice {
  deviceId: string;
  label: string;
  isDefault: boolean;
  isLikelyVirtualCable: boolean;
}

export interface BootstrapPayload {
  settings: Settings;
  state: AppState;
  logs: string[];
}

export interface SetupRconRequiredPayload {
  missingTokens: string[];
  currentLaunchOptions: string | null;
  launchOptionsFile: string | null;
  requiredLaunchOptions: string;
}

export interface TfRadioApi {
  getSettings: () => Promise<BootstrapPayload>;
  updateSettings: (patch: Partial<Settings>) => Promise<Settings>;
  listAudioOutputDevices: (options?: { forceRefresh?: boolean }) => Promise<AudioOutputDevice[]>;
  startService: () => Promise<{ ok: boolean; reason?: string }>;
  stopService: () => Promise<{ ok: boolean }>;
  skipQueue: () => Promise<{ ok: boolean; reason?: string }>;
  togglePausePlayback: () => Promise<{ ok: boolean; reason?: string; action?: "paused" | "resumed" }>;
  stopQueue: () => Promise<{ ok: boolean; reason?: string }>;
  clearQueue: () => Promise<{ ok: boolean }>;
  addToQueue: (query: string) => Promise<{ ok: boolean; reason?: string }>;
  removeFromQueue: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  copyText: (text: string) => void;
  onStateUpdate: (handler: (state: AppState) => void) => () => void;
  onPlaybackStart: (handler: (item: QueueItem) => void) => () => void;
  onPlaybackStop: (handler: () => void) => () => void;
  onPlaybackPause: (handler: () => void) => () => void;
  onPlaybackResume: (handler: () => void) => () => void;
  onSetupRconRequired: (handler: (payload: SetupRconRequiredPayload) => void) => () => void;
  onLogAppend: (handler: (line: string) => void) => () => void;
  notifyPlaybackReady: () => void;
  notifyPlaybackEnded: () => void;
  notifyPlaybackError: (message: string) => void;
}
