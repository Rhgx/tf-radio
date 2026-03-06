import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, Menu, Tray, app, globalShortcut, ipcMain, nativeImage, screen } from "electron";

import { IPC_CHANNELS } from "../shared/ipc.js";
import type {
  AppState,
  AudioOutputDevice,
  ParsedCommand,
  QueueItem,
  Settings,
  SetupIssue
} from "../shared/types.js";
import { CommandParser } from "./services/command-parser.js";
import { LogTailer } from "./services/log-tailer.js";
import { RconService } from "./services/rcon-service.js";
import { SettingsService } from "./services/settings-service.js";
import {
  buildRequiredLaunchOptions,
  discoverTf2Context,
  resolveRconPort,
  validateRconLaunchOptions
} from "./services/tf2-discovery.js";
import { TrackDurationLimitError, resolveYoutubeTrack } from "./services/youtube.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const settingsService = new SettingsService();
const rconService = new RconService();
const parser = new CommandParser(() => settingsService.getSettings());

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let tailer: LogTailer | null = null;
let pttKeepAlive: NodeJS.Timeout | null = null;
let queue: QueueItem[] = [];
let steamRoots: string[] = [];
let processingChain = Promise.resolve();
let recentLogs: string[] = [];
let rconFailureLogged = false;
let queueAdvanceInFlight = false;
let pausedPlaybackOffsetMs = 0;
let isQuitting = false;
let ownsInstanceFileLock = false;
let audioOutputsCache:
  | {
      at: number;
      devices: AudioOutputDevice[];
    }
  | null = null;
let launchValidationCache:
  | {
      at: number;
      key: string;
      value: Awaited<ReturnType<typeof validateRconLaunchOptions>>;
    }
  | null = null;

const MIN_WINDOW_WIDTH = 980;
const MIN_WINDOW_HEIGHT = 700;
const OVERLAY_WIDTH = 520;
const OVERLAY_HEIGHT = 132;
const AUDIO_OUTPUT_CACHE_TTL_MS = 5_000;
const LAUNCH_VALIDATION_CACHE_TTL_MS = 5_000;
const INSTANCE_LOCK_FILENAME = "tf-radio.lock";
const ICON_CANDIDATE_PATHS =
  process.platform === "win32"
    ? [
        path.join("dist", "renderer", "favicon.ico"),
        path.join("renderer", "favicon.ico"),
        path.join("renderer", "assets", "tf2-icon-purple.png")
      ]
    : [
        path.join("renderer", "assets", "tf2-icon-purple.png"),
        path.join("dist", "renderer", "favicon.ico"),
        path.join("renderer", "favicon.ico")
      ];

const state: AppState = {
  connectedToRcon: false,
  playback: "idle",
  playbackStartedAt: null,
  current: null,
  queue: [],
  lastError: null,
  serviceRunning: false,
  setupIssue: null
};

const instanceLockPath = path.join(app.getPath("userData"), INSTANCE_LOCK_FILENAME);

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function tryAcquireInstanceFileLock(): boolean {
  fs.mkdirSync(path.dirname(instanceLockPath), { recursive: true });

  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: Date.now()
  });

  try {
    fs.writeFileSync(instanceLockPath, payload, { flag: "wx" });
    ownsInstanceFileLock = true;
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      throw error;
    }
  }

  try {
    const existing = JSON.parse(fs.readFileSync(instanceLockPath, "utf8")) as { pid?: unknown };
    const existingPid =
      typeof existing.pid === "number" && Number.isFinite(existing.pid) ? existing.pid : null;

    if (existingPid !== null && isProcessAlive(existingPid)) {
      return false;
    }
  } catch {
    // Treat unreadable or malformed lock files as stale and replace them.
  }

  try {
    fs.rmSync(instanceLockPath, { force: true });
  } catch {
    return false;
  }

  fs.writeFileSync(instanceLockPath, payload, { flag: "wx" });
  ownsInstanceFileLock = true;
  return true;
}

function releaseInstanceFileLock(): void {
  if (!ownsInstanceFileLock) {
    return;
  }

  try {
    fs.rmSync(instanceLockPath, { force: true });
  } finally {
    ownsInstanceFileLock = false;
  }
}

function intersects(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function normalizeSavedBounds(
  bounds: Electron.Rectangle | undefined
): Electron.Rectangle | undefined {
  if (!bounds) {
    return undefined;
  }

  if (
    bounds.width < MIN_WINDOW_WIDTH ||
    bounds.height < MIN_WINDOW_HEIGHT ||
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y)
  ) {
    return undefined;
  }

  const displays = screen.getAllDisplays();
  const visibleDisplay = displays.find((display) => intersects(bounds, display.workArea));
  if (!visibleDisplay) {
    return undefined;
  }

  const area = visibleDisplay.workArea;
  const width = Math.min(Math.max(bounds.width, MIN_WINDOW_WIDTH), area.width);
  const height = Math.min(Math.max(bounds.height, MIN_WINDOW_HEIGHT), area.height);
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height);

  return { x, y, width, height };
}

function getDefaultWindowSize(): { width: number; height: number } {
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.max(MIN_WINDOW_WIDTH, Math.min(1480, Math.floor(area.width * 0.74)));
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.min(980, Math.floor(area.height * 0.86)));
  return { width, height };
}

function getOverlayBounds(): Electron.Rectangle {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: area.x + 14,
    y: area.y + 14,
    width: Math.min(OVERLAY_WIDTH, area.width - 28),
    height: OVERLAY_HEIGHT
  };
}

function canSendToWindow(window: BrowserWindow | null): window is BrowserWindow {
  return Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed());
}

function sendToWindow(window: BrowserWindow | null, channel: string, payload?: unknown): void {
  if (!canSendToWindow(window)) {
    return;
  }

  if (typeof payload === "undefined") {
    window.webContents.send(channel);
  } else {
    window.webContents.send(channel, payload);
  }
}

function sendToMainWindow(channel: string, payload?: unknown): void {
  sendToWindow(mainWindow, channel, payload);
}

function sendToAllWindows(channel: string, payload?: unknown): void {
  sendToWindow(mainWindow, channel, payload);
  sendToWindow(overlayWindow, channel, payload);
}

function syncOverlayVisibility(): void {
  const settings = settingsService.getSettings();
  if (!settings.overlayEnabled) {
    if (canSendToWindow(overlayWindow)) {
      overlayWindow.hide();
    }
    return;
  }

  if (!overlayWindow) {
    return;
  }

  if (!overlayWindow.isVisible()) {
    overlayWindow.showInactive();
  }
}

function normalizeShortcutAccelerator(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

async function executeSkipAction(source: "chat" | "shortcut" | "ui"): Promise<void> {
  if (!state.current) {
    if (source === "shortcut") {
      pushLog("Skip shortcut ignored: nothing is currently playing.");
    }
    return;
  }

  sendToMainWindow(IPC_CHANNELS.playbackStop);
  await advanceQueue(source === "shortcut" ? "shortcut-skip" : "skipped");
}

async function executeStopAction(
  source: "chat" | "shortcut" | "ui"
): Promise<{ ok: boolean; reason?: string }> {
  if (!state.current && queue.length === 0) {
    const reason = "Queue is already empty.";
    if (source === "shortcut") {
      pushLog(`Stop shortcut ignored: ${reason.toLowerCase()}`);
    }
    return { ok: false, reason };
  }

  await clearQueueAndStopPlayback();
  if (source === "shortcut") {
    pushLog("Playback stopped via stop shortcut.");
  }

  return { ok: true };
}

async function executePauseAction(
  source: "chat" | "shortcut" | "ui"
): Promise<{ ok: boolean; reason?: string }> {
  if (!state.current) {
    const reason = "Nothing is currently playing.";
    if (source === "shortcut") {
      pushLog(`Pause/resume shortcut ignored: ${reason.toLowerCase()}`);
    }
    return { ok: false, reason };
  }

  if (state.playback === "paused") {
    const reason = "Playback is already paused.";
    if (source === "shortcut") {
      pushLog(`Pause/resume shortcut ignored: ${reason.toLowerCase()}`);
    }
    return { ok: false, reason };
  }

  if (state.playback !== "playing") {
    const reason = "Playback is not ready to pause yet.";
    if (source === "shortcut") {
      pushLog(`Pause/resume shortcut ignored: ${reason.toLowerCase()}`);
    }
    return { ok: false, reason };
  }

  pausedPlaybackOffsetMs =
    state.playbackStartedAt !== null ? Math.max(0, Date.now() - state.playbackStartedAt) : 0;
  sendToMainWindow(IPC_CHANNELS.playbackPause);
  await stopPttKeepAlive();
  updateState({ playback: "paused", playbackStartedAt: null, lastError: null });

  if (source === "shortcut") {
    pushLog("Playback paused via pause/resume shortcut.");
  }

  return { ok: true };
}

async function executeResumeAction(
  source: "chat" | "shortcut" | "ui"
): Promise<{ ok: boolean; reason?: string }> {
  if (!state.current) {
    const reason = "Nothing is currently paused.";
    if (source === "shortcut") {
      pushLog(`Pause/resume shortcut ignored: ${reason.toLowerCase()}`);
    }
    return { ok: false, reason };
  }

  if (state.playback !== "paused") {
    const reason = "Playback is not paused.";
    if (source === "shortcut") {
      pushLog(`Pause/resume shortcut ignored: ${reason.toLowerCase()}`);
    }
    return { ok: false, reason };
  }

  const playbackStartedAt =
    pausedPlaybackOffsetMs > 0 ? Date.now() - pausedPlaybackOffsetMs : Date.now();
  pausedPlaybackOffsetMs = 0;
  updateState({ playback: "playing", playbackStartedAt, lastError: null });
  sendToMainWindow(IPC_CHANNELS.playbackResume);
  await startPttKeepAlive();

  if (source === "shortcut") {
    pushLog("Playback resumed via pause/resume shortcut.");
  }

  return { ok: true };
}

async function executePauseToggleAction(
  source: "shortcut" | "ui"
): Promise<{ ok: boolean; reason?: string; action?: "paused" | "resumed" }> {
  if (state.playback === "paused") {
    const result = await executeResumeAction(source);
    return { ...result, action: result.ok ? "resumed" : undefined };
  }

  const result = await executePauseAction(source);
  return { ...result, action: result.ok ? "paused" : undefined };
}

function registerGlobalShortcuts(): void {
  if (!app.isReady()) {
    return;
  }

  globalShortcut.unregisterAll();

  const settings = settingsService.getSettings();
  const bindings: Array<{
    accelerator: string | null;
    label: string;
    callback: () => void;
  }> = [
    {
      accelerator: normalizeShortcutAccelerator(settings.skipShortcut),
      label: "skip",
      callback: () => {
        void executeSkipAction("shortcut");
      }
    },
    {
      accelerator: normalizeShortcutAccelerator(settings.pauseShortcut),
      label: "pause/resume",
      callback: () => {
        void executePauseToggleAction("shortcut");
      }
    },
    {
      accelerator: normalizeShortcutAccelerator(settings.stopShortcut),
      label: "stop",
      callback: () => {
        void executeStopAction("shortcut");
      }
    }
  ];

  for (const binding of bindings) {
    if (!binding.accelerator) {
      continue;
    }

    try {
      const ok = globalShortcut.register(binding.accelerator, binding.callback);
      if (!ok) {
        pushLog(`Failed to register ${binding.label} shortcut: ${binding.accelerator}`);
      }
    } catch (error) {
      pushLog(`Invalid ${binding.label} shortcut "${binding.accelerator}": ${String(error)}`);
    }
  }
}

function pushLog(message: string): void {
  const entry = `[${new Date().toLocaleTimeString()}] ${message}`;
  if (recentLogs.length >= 250) {
    recentLogs.shift();
  }
  recentLogs.push(entry);
  sendToMainWindow(IPC_CHANNELS.logAppend, entry);
}

function updateState(patch: Partial<AppState>): void {
  Object.assign(state, patch);
  state.queue = queue;

  sendToAllWindows(IPC_CHANNELS.stateUpdate, state);
}

function invalidateAudioOutputsCache(): void {
  audioOutputsCache = null;
}

function invalidateLaunchValidationCache(): void {
  launchValidationCache = null;
}

function getLaunchValidationCacheKey(settings: Settings): string {
  return JSON.stringify([settings.rconPassword, ...steamRoots]);
}

async function getLaunchValidation(
  settings: Settings,
  options?: { force?: boolean }
): Promise<Awaited<ReturnType<typeof validateRconLaunchOptions>>> {
  const force = options?.force ?? false;
  const now = Date.now();
  const cacheKey = getLaunchValidationCacheKey(settings);

  if (
    !force &&
    launchValidationCache &&
    launchValidationCache.key === cacheKey &&
    now - launchValidationCache.at < LAUNCH_VALIDATION_CACHE_TTL_MS
  ) {
    return launchValidationCache.value;
  }

  const value = await validateRconLaunchOptions(settings, steamRoots);
  launchValidationCache = {
    at: now,
    key: cacheKey,
    value
  };
  return value;
}

function setIssue(issue: SetupIssue | null): void {
  updateState({
    setupIssue: issue,
    lastError: issue ? issue.message : state.setupIssue ? null : state.lastError
  });
}

async function validateLaunchOptionsAtStartup(): Promise<void> {
  const settings = settingsService.getSettings();
  if (!settings.tf2Path) {
    return;
  }

  const launchValidation = await getLaunchValidation(settings);
  if (!launchValidation.isValid) {
    const issue: SetupIssue = {
      code: "launch_options_missing",
      message: `Launch options are missing required tokens: ${launchValidation.missingTokens.join(", ")}`,
      launchOptionsHint: launchValidation.requiredLaunchOptions
    };

    setIssue(issue);
    sendToMainWindow(IPC_CHANNELS.setupRconRequired, {
      missingTokens: launchValidation.missingTokens,
      currentLaunchOptions: launchValidation.currentLaunchOptions,
      launchOptionsFile: launchValidation.launchOptionsFile,
      requiredLaunchOptions: launchValidation.requiredLaunchOptions
    });
    return;
  }

  if (state.setupIssue?.code === "launch_options_missing") {
    setIssue(null);
  }
}

async function discoverAndHydrateSettings(): Promise<void> {
  const discovered = await discoverTf2Context();
  steamRoots = discovered.steamRoots;
  invalidateLaunchValidationCache();

  const current = settingsService.getSettings();
  const next = settingsService.hydrateDetected({
    tf2Path: current.tf2Path ?? discovered.tf2Path,
    consoleLogPath: current.consoleLogPath ?? discovered.consoleLogPath,
    playerName:
      current.playerName && current.playerName !== "unknown"
        ? current.playerName
        : discovered.playerName ?? "unknown"
  });

  if (!next.tf2Path) {
    setIssue({
      code: "tf2_not_found",
      message: "TF2 path could not be auto-detected. Set it manually in Settings."
    });
    return;
  }

  await validateLaunchOptionsAtStartup();
}

async function ensureAudioDeviceDefault(): Promise<void> {
  const settings = settingsService.getSettings();
  if (settings.outputDeviceId) {
    return;
  }

  const devices = await listAudioOutputs();
  const preferred = devices.find((device) => device.isLikelyVirtualCable) ?? devices[0];

  if (!preferred) {
    return;
  }

  settingsService.updateSettings({ outputDeviceId: preferred.deviceId });
}

async function listAudioOutputs(options?: { forceRefresh?: boolean }): Promise<AudioOutputDevice[]> {
  if (!mainWindow) {
    return [];
  }

  const forceRefresh = options?.forceRefresh ?? false;
  const now = Date.now();

  if (
    !forceRefresh &&
    audioOutputsCache &&
    now - audioOutputsCache.at < AUDIO_OUTPUT_CACHE_TTL_MS
  ) {
    return audioOutputsCache.devices;
  }

  const script = `
    (async function () {
      const listFn = window.__tfRadioListAudioOutputs;
      if (typeof listFn !== 'function') return [];
      return await listFn();
    })();
  `;

  const result = (await mainWindow.webContents.executeJavaScript(script, true)) as unknown;
  if (!Array.isArray(result)) {
    return [];
  }

  const devices = result.filter((item) => {
    return (
      typeof item === "object" &&
      item !== null &&
      "deviceId" in item &&
      "label" in item &&
      "isDefault" in item &&
      "isLikelyVirtualCable" in item
    );
  }) as AudioOutputDevice[];

  audioOutputsCache = {
    at: now,
    devices
  };
  return devices;
}

async function sendRcon(command: string, silent = false): Promise<boolean> {
  try {
    await rconService.execute(command);
    rconFailureLogged = false;
    if (!state.connectedToRcon) {
      updateState({ connectedToRcon: true });
    }
    return true;
  } catch (error) {
    updateState({ connectedToRcon: false });
    if (!silent || !rconFailureLogged) {
      pushLog(`RCON command failed: ${String(error)}`);
      rconFailureLogged = true;
    }
    return false;
  }
}

function escapeRconString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizeRequester(value: string): string {
  return value.trim().toLowerCase();
}

function looksLikeLink(value: string): boolean {
  const trimmed = value.trim();
  return /^(https?:\/\/|www\.|(?:music\.)?youtube\.com\/|youtu\.be\/)/i.test(trimmed);
}

function normalizeMaxAudioDurationSec(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value) || Number.isNaN(value)) {
    return 390;
  }

  return Math.max(1, Math.min(86400, value));
}

function getRequesterActiveTrackCount(requester: string): number {
  const normalizedRequester = normalizeRequester(requester);
  let count = 0;

  if (
    state.current &&
    normalizeRequester(state.current.requestedBy) === normalizedRequester
  ) {
    count += 1;
  }

  for (const item of queue) {
    if (normalizeRequester(item.requestedBy) === normalizedRequester) {
      count += 1;
    }
  }

  return count;
}

async function sendChatMessage(text: string): Promise<void> {
  const settings = settingsService.getSettings();
  if (!settings.chatResponsesEnabled) {
    return;
  }

  const payload = escapeRconString(text);
  await sendRcon(`say "${payload}"`, true);
}

async function startPttKeepAlive(): Promise<void> {
  if (pttKeepAlive) {
    return;
  }

  if (!state.current || state.playback !== "playing") {
    return;
  }

  const sent = await sendRcon("+voicerecord");
  if (!sent) {
    return;
  }

  pttKeepAlive = setInterval(() => {
    void (async () => {
      const ok = await sendRcon("+voicerecord", true);
      if (!ok) {
        if (pttKeepAlive) {
          clearInterval(pttKeepAlive);
          pttKeepAlive = null;
        }
        pushLog("PTT keepalive stopped because RCON is unavailable.");
      }
    })();
  }, 1000);
}

async function stopPttKeepAlive(): Promise<void> {
  if (pttKeepAlive) {
    clearInterval(pttKeepAlive);
    pttKeepAlive = null;
  }

  await sendRcon("-voicerecord", true);
}

function enqueuePlayback(item: QueueItem): void {
  queue.push(item);
  updateState({ queue: [...queue] });

  if (!state.current && state.playback === "idle") {
    void startNextTrack();
  }
}

async function startNextTrack(): Promise<void> {
  if (state.current || queue.length === 0) {
    if (!state.current && queue.length === 0) {
      updateState({ playback: "idle", playbackStartedAt: null });
    }
    return;
  }

  const next = queue[0];
  if (!next) {
    return;
  }

  updateState({ current: next, playback: "buffering", playbackStartedAt: null, lastError: null });
  sendToMainWindow(IPC_CHANNELS.playbackStart, next);
  pushLog(`Now buffering: ${next.title}`);
}

async function advanceQueue(reason: string): Promise<void> {
  if (queueAdvanceInFlight) {
    return;
  }

  queueAdvanceInFlight = true;

  try {
    if (queue.length > 0) {
      queue.shift();
    }

    pausedPlaybackOffsetMs = 0;
    await stopPttKeepAlive();

    updateState({ current: null, playback: "idle", playbackStartedAt: null, queue: [...queue] });
    pushLog(`Track finished (${reason}).`);

    if (queue.length > 0) {
      await startNextTrack();
    }
  } finally {
    queueAdvanceInFlight = false;
  }
}

async function clearQueueAndStopPlayback(): Promise<void> {
  queue = [];
  pausedPlaybackOffsetMs = 0;
  sendToMainWindow(IPC_CHANNELS.playbackStop);
  await stopPttKeepAlive();
  updateState({ current: null, playback: "idle", playbackStartedAt: null, queue: [] });
}

function clearUpcomingQueue(): number {
  const removableCount = state.current ? Math.max(0, queue.length - 1) : queue.length;
  if (removableCount === 0) {
    return 0;
  }

  queue = state.current ? [state.current] : [];
  updateState({ queue: [...queue] });
  return removableCount;
}

async function processPlayCommand(speaker: string, query: string): Promise<void> {
  pushLog(`Command from ${speaker}: ${query}`);

  const settings = settingsService.getSettings();

  if (!settings.chatLinksEnabled && looksLikeLink(query)) {
    pushLog(`Rejected link from ${speaker}: chat links are disabled.`);
    await sendChatMessage("Links in chat are disabled.");
    return;
  }

  const maxTracksPerUser = Math.max(1, Math.min(20, settings.maxTracksPerUser));
  const activeTrackCount = getRequesterActiveTrackCount(speaker);
  if (activeTrackCount >= maxTracksPerUser) {
    pushLog(
      `Rejected ?play from ${speaker}: already has ${activeTrackCount}/${maxTracksPerUser} active tracks.`
    );
    await sendChatMessage(`${speaker}, queue limit reached (${maxTracksPerUser}).`);
    return;
  }

  try {
    const track = await resolveYoutubeTrack(
      query,
      speaker,
      normalizeMaxAudioDurationSec(settings.maxAudioDurationSec)
    );
    enqueuePlayback(track);
    updateState({ lastError: null, setupIssue: null });
    pushLog(`Queued: ${track.title} (${track.channel})`);
    await sendChatMessage(`Queued: ${track.title}`);
  } catch (error) {
    const message = `Failed to resolve "${query}": ${String(error)}`;
    updateState({
      playback: "error",
      playbackStartedAt: null,
      lastError: message,
      setupIssue: { code: "yt_dlp_error", message }
    });
    pushLog(message);
    await sendChatMessage(
      error instanceof TrackDurationLimitError ? error.message : "Could not play that query."
    );
  }
}

async function processParsedCommand(command: ParsedCommand): Promise<void> {
  if (command.kind === "play") {
    await processPlayCommand(command.speaker, command.query);
    return;
  }

  if (command.kind === "skip") {
    pushLog(`Command from ${command.speaker}: ?skip`);

    if (!state.current) {
      await sendChatMessage("Nothing is playing right now.");
      return;
    }

    await executeSkipAction("chat");
    await sendChatMessage("Skipped.");
    return;
  }

  if (command.kind === "pause") {
    pushLog(`Command from ${command.speaker}: ?pause`);
    const result = await executePauseAction("chat");
    await sendChatMessage(result.ok ? "Paused playback." : result.reason ?? "Could not pause playback.");
    return;
  }

  if (command.kind === "resume") {
    pushLog(`Command from ${command.speaker}: ?resume`);
    const result = await executeResumeAction("chat");
    await sendChatMessage(result.ok ? "Resumed playback." : result.reason ?? "Could not resume playback.");
    return;
  }

  pushLog(`Command from ${command.speaker}: ?stop`);
  const result = await executeStopAction("chat");
  await sendChatMessage(
    result.ok ? "Stopped playback and cleared the queue." : result.reason ?? "Could not stop playback."
  );
}

function queueParsedCommand(command: ParsedCommand): void {
  processingChain = processingChain
    .then(async () => {
      await processParsedCommand(command);
    })
    .catch((error) => {
      pushLog(`Command processing failed: ${String(error)}`);
    });
}

async function startService(): Promise<{ ok: boolean; reason?: string }> {
  if (state.serviceRunning) {
    return { ok: true };
  }

  const settings = settingsService.getSettings();
  if (!settings.tf2Path) {
    const issue: SetupIssue = {
      code: "tf2_not_found",
      message: "TF2 path is missing. Set it in Settings before starting."
    };
    setIssue(issue);
    return { ok: false, reason: issue.message };
  }

  if (!settings.consoleLogPath) {
    const issue: SetupIssue = {
      code: "console_log_missing",
      message: "Console log path is missing."
    };
    setIssue(issue);
    return { ok: false, reason: issue.message };
  }

  if (!fs.existsSync(settings.consoleLogPath)) {
    const issue: SetupIssue = {
      code: "console_log_missing",
      message: `console.log not found at ${settings.consoleLogPath}. Start TF2 once with +con_logfile console.log.`
    };
    setIssue(issue);
    return { ok: false, reason: issue.message };
  }

  const launchValidation = await getLaunchValidation(settings, { force: true });
  if (!launchValidation.isValid) {
    const issue: SetupIssue = {
      code: "launch_options_missing",
      message: `Launch options are missing required tokens: ${launchValidation.missingTokens.join(", ")}`,
      launchOptionsHint: launchValidation.requiredLaunchOptions
    };

    setIssue(issue);
    sendToMainWindow(IPC_CHANNELS.setupRconRequired, {
      missingTokens: launchValidation.missingTokens,
      currentLaunchOptions: launchValidation.currentLaunchOptions,
      launchOptionsFile: launchValidation.launchOptionsFile,
      requiredLaunchOptions: launchValidation.requiredLaunchOptions
    });

    return { ok: false, reason: issue.message };
  }

  try {
    const connectPort = resolveRconPort(settings, launchValidation.currentLaunchOptions);
    await rconService.connectWithRetry({
      host: settings.rconHost,
      port: connectPort,
      password: settings.rconPassword
    });
    // Force voice transmit off when service starts; we only enable it during active playback.
    await sendRcon("-voicerecord", true);
  } catch (error) {
    const issue: SetupIssue = {
      code: "rcon_connect_failed",
      message: `RCON connection failed: ${String(error)}`,
      launchOptionsHint: buildRequiredLaunchOptions(settings)
    };

    setIssue(issue);
    return { ok: false, reason: issue.message };
  }

  updateState({
    connectedToRcon: true,
    serviceRunning: true,
    playback: "idle",
    playbackStartedAt: null,
    setupIssue: null,
    lastError: null
  });

  tailer = new LogTailer(settings.consoleLogPath, {
    fromEnd: !settings.clearLogsOnStartup,
    clearOnStartup: settings.clearLogsOnStartup,
    onLine: ({ line, offset }) => {
      const parsed = parser.parse(line, offset);
      if (!parsed) {
        return;
      }

      queueParsedCommand(parsed);
    },
    onError: (error) => {
      const message = `Log tailer error: ${error.message}`;
      updateState({ lastError: message });
      pushLog(message);
    }
  });

  await tailer.start();
  const chatCommands = [
    "?play",
    ...(settings.chatSkipCommandEnabled ? ["?skip"] : []),
    ...(settings.chatPauseCommandEnabled ? ["?pause", "?resume"] : []),
    ...(settings.chatStopCommandEnabled ? ["?stop"] : [])
  ];
  pushLog(`Service started. Listening for ${chatCommands.join(", ")} commands.`);
  return { ok: true };
}

async function stopService(): Promise<void> {
  if (tailer) {
    await tailer.stop();
    tailer = null;
  }

  await clearQueueAndStopPlayback();
  await rconService.disconnect();

  updateState({
    connectedToRcon: false,
    serviceRunning: false,
    playback: "idle",
    playbackStartedAt: null,
    current: null,
    queue: []
  });

  pushLog("Service stopped.");
}

function getTrayIcon(): Electron.NativeImage {
  const iconPath = resolveAppIconPath();
  let icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createFromPath(process.execPath);
  if (icon.isEmpty()) {
    icon = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAZUlEQVR4AWNABaNw4QxkYGBQ+P//PwMSMJoA4j8gE8RmIDmQmQwMDAxTQDbwH0Y2IMoA0i2kM0B2gMyA6RA6xQKxQJYB6QxQY2A8QyQ7QLaATIF5hkh2gAwDlQ0m8NQAA0g9Qd3VqC0QAAAAASUVORK5CYII="
    );
  }

  if (process.platform === "win32") {
    return icon.resize({ width: 16, height: 16 });
  }

  return icon;
}

function resolveAppIconPath(): string | null {
  const appPath = app.getAppPath();
  for (const relativePath of ICON_CANDIDATE_PATHS) {
    const candidate = path.join(appPath, relativePath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const hashedIconDir = path.join(appPath, "dist", "renderer", "assets");
  if (fs.existsSync(hashedIconDir)) {
    const hashedIcons = fs
      .readdirSync(hashedIconDir)
      .filter((entry) => /^favicon-.*\.(ico|png)$/i.test(entry))
      .sort((a, b) => a.localeCompare(b));

    const latestHashedIcon = hashedIcons[hashedIcons.length - 1];
    if (latestHashedIcon) {
      return path.join(hashedIconDir, latestHashedIcon);
    }
  }

  return null;
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.focus();
}

const hasInstanceFileLock = tryAcquireInstanceFileLock();
const hasSingleInstanceLock = hasInstanceFileLock ? app.requestSingleInstanceLock() : false;

if (!hasInstanceFileLock || !hasSingleInstanceLock) {
  releaseInstanceFileLock();
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });
}

function createTray(): void {
  if (tray) {
    return;
  }

  tray = new Tray(getTrayIcon());
  tray.setToolTip("TF2 Radio");

  const menu = Menu.buildFromTemplate([
    {
      label: "Show Control Panel",
      click: () => showMainWindow()
    },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(menu);
  tray.on("double-click", () => showMainWindow());
}

async function createOverlayWindow(): Promise<void> {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return;
  }

  const bounds = getOverlayBounds();
  overlayWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    fullscreenable: false,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, "..", "preload.js")
    }
  });

  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });

  const htmlPath = path.join(app.getAppPath(), "dist", "renderer", "overlay.html");
  await overlayWindow.loadFile(htmlPath);

  overlayWindow.webContents.once("did-finish-load", () => {
    sendToWindow(overlayWindow, IPC_CHANNELS.stateUpdate, state);
    syncOverlayVisibility();
  });
}

async function createWindow(): Promise<void> {
  const defaultWindow = getDefaultWindowSize();
  const savedBounds = normalizeSavedBounds(settingsService.getWindowBounds());
  const iconPath = resolveAppIconPath();

  mainWindow = new BrowserWindow({
    width: savedBounds?.width ?? defaultWindow.width,
    height: savedBounds?.height ?? defaultWindow.height,
    x: savedBounds?.x,
    y: savedBounds?.y,
    center: !savedBounds,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    icon: iconPath ?? undefined,
    autoHideMenuBar: true,
    backgroundColor: "#121212",
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, "..", "preload.js")
    }
  });

  mainWindow.on("minimize", () => {
    if (!settingsService.getSettings().minimizeToTray) {
      return;
    }

    setTimeout(() => {
      mainWindow?.hide();
    }, 0);
  });

  mainWindow.on("close", (event) => {
    if (!mainWindow) {
      return;
    }

    if (!isQuitting && settingsService.getSettings().minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
      return;
    }

    const nextBounds = mainWindow.isMaximized() ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    settingsService.setWindowBounds(nextBounds);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const htmlPath = path.join(app.getAppPath(), "dist", "renderer", "index.html");
  await mainWindow.loadFile(htmlPath);

  mainWindow.webContents.once("did-finish-load", async () => {
    await ensureAudioDeviceDefault();
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.settingsGet, async () => {
    return {
      settings: settingsService.getSettings(),
      state,
      logs: recentLogs
    };
  });

  ipcMain.handle(IPC_CHANNELS.settingsUpdate, async (_event, patch) => {
    const patchObject = typeof patch === "object" && patch !== null ? { ...patch } : {};

    if ("tf2Path" in patchObject) {
      const tf2Path = (patchObject as { tf2Path?: string | null }).tf2Path;
      (patchObject as { consoleLogPath: string | null }).consoleLogPath = tf2Path
        ? path.join(tf2Path, "tf", "console.log")
        : null;
    }

    const next = settingsService.updateSettings(patchObject);
    invalidateAudioOutputsCache();
    invalidateLaunchValidationCache();
    registerGlobalShortcuts();
    if (next.overlayEnabled) {
      await createOverlayWindow();
    }
    if (!next.tf2Path) {
      setIssue({
        code: "tf2_not_found",
        message: "TF2 path could not be auto-detected. Set it manually in Settings."
      });
    } else {
      await validateLaunchOptionsAtStartup();
    }
    syncOverlayVisibility();
    return next;
  });

  ipcMain.handle(IPC_CHANNELS.listAudioOutputs, async (_event, options) => {
    const forceRefresh =
      typeof options === "object" &&
      options !== null &&
      "forceRefresh" in options &&
      Boolean((options as { forceRefresh?: boolean }).forceRefresh);
    return listAudioOutputs({ forceRefresh });
  });

  ipcMain.handle(IPC_CHANNELS.serviceStart, async () => {
    return startService();
  });

  ipcMain.handle(IPC_CHANNELS.serviceStop, async () => {
    await stopService();
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.queueSkip, async () => {
    if (!state.current) {
      return { ok: false, reason: "Nothing is currently playing." };
    }

    await executeSkipAction("ui");
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.queuePauseToggle, async () => {
    return executePauseToggleAction("ui");
  });

  ipcMain.handle(IPC_CHANNELS.queueStop, async () => {
    return executeStopAction("ui");
  });

  ipcMain.handle(IPC_CHANNELS.queueClear, async () => {
    const removedCount = clearUpcomingQueue();
    if (removedCount > 0) {
      pushLog(`Cleared ${removedCount} queued ${removedCount === 1 ? "track" : "tracks"}.`);
    }
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.queueAdd, async (_event, query: string) => {
    if (!state.serviceRunning) {
      return { ok: false, reason: "Service is not running." };
    }

    const trimmed = (query ?? "").trim();
    if (!trimmed) {
      return { ok: false, reason: "Query is empty." };
    }

    const settings = settingsService.getSettings();
    const speaker = settings.playerName || "UI";

    try {
      const track = await resolveYoutubeTrack(
        trimmed,
        speaker,
        normalizeMaxAudioDurationSec(settings.maxAudioDurationSec)
      );
      enqueuePlayback(track);
      updateState({ lastError: null, setupIssue: null });
      pushLog(`Queued from UI: ${track.title} (${track.channel})`);
      return { ok: true };
    } catch (error) {
      const message = `Failed to resolve "${trimmed}": ${String(error)}`;
      updateState({ lastError: message });
      pushLog(message);
      return { ok: false, reason: message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.queueRemove, async (_event, id: string) => {
    const index = queue.findIndex((item) => item.id === id);
    if (index === -1) {
      return { ok: false, reason: "Item not found in queue." };
    }

    const removed = queue[index];
    if (state.current?.id === id && index === 0) {
      pushLog(`Removed current track from queue: ${removed?.title ?? id}`);
      sendToMainWindow(IPC_CHANNELS.playbackStop);
      await advanceQueue("removed");
      return { ok: true };
    }

    queue.splice(index, 1);
    updateState({ queue: [...queue] });
    pushLog(`Removed from queue: ${removed?.title ?? id}`);
    return { ok: true };
  });

  ipcMain.on(IPC_CHANNELS.playbackReady, () => {
    if (!state.current) {
      return;
    }

    if (state.playback === "paused") {
      return;
    }

    if (state.playback === "playing" && state.playbackStartedAt !== null) {
      return;
    }

    updateState({ playback: "playing", playbackStartedAt: Date.now() });
    pushLog(`Now playing: ${state.current.title}`);
    void sendChatMessage(`Now playing: ${state.current.title}`);
    void startPttKeepAlive();
  });

  ipcMain.on(IPC_CHANNELS.playbackEnded, () => {
    if (!state.current) {
      return;
    }

    void advanceQueue("ended");
  });

  ipcMain.on(IPC_CHANNELS.playbackError, (_event, message: string) => {
    if (!state.current) {
      return;
    }

    const errorMessage = `Playback error: ${message}`;
    updateState({ lastError: errorMessage, playback: "error", playbackStartedAt: null });
    pushLog(errorMessage);
    void advanceQueue("error");
  });
}

app.whenReady().then(async () => {
  await discoverAndHydrateSettings();
  registerGlobalShortcuts();
  registerIpcHandlers();
  await createWindow();
  createTray();
  if (settingsService.getSettings().overlayEnabled) {
    await createOverlayWindow();
    syncOverlayVisibility();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  releaseInstanceFileLock();
  app.releaseSingleInstanceLock();
  globalShortcut.unregisterAll();
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
    overlayWindow = null;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
  void stopService().catch((error) => {
    console.error("Failed to stop service during shutdown:", error);
  });
});

process.on("exit", () => {
  releaseInstanceFileLock();
});

process.on("SIGINT", () => {
  releaseInstanceFileLock();
});

process.on("SIGTERM", () => {
  releaseInstanceFileLock();
});
