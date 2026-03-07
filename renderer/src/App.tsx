import type { ComponentChildren, JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  Activity,
  AlertTriangle,
  Command,
  Copy,
  FolderOpen,
  MessageSquare,
  Minimize2,
  MonitorSpeaker,
  Music2,
  Pause,
  PictureInPicture2,
  Play,
  Plus,
  Power,
  Radio,
  RefreshCw,
  Settings as SettingsIcon,
  SkipForward,
  SlidersHorizontal,
  Square,
  Trash2,
  User,
  Users,
  Volume2,
  X
} from "lucide-preact";

import type {
  AppState,
  AudioOutputDevice,
  BootstrapPayload,
  QueueItem,
  Settings,
  SetupRconRequiredPayload
} from "./types";

function emptyState(): AppState {
  return {
    connectedToRcon: false,
    playback: "idle",
    playbackStartedAt: null,
    current: null,
    queue: [],
    lastError: null,
    serviceRunning: false,
    setupIssue: null
  };
}

function safeText(value: string): string {
  return value.length > 0 ? value : "-";
}

function formatPlaybackState(value: AppState["playback"]): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalizeVolume(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 1;
  }

  return Math.min(1, Math.max(0, value));
}

function formatVolumePercent(value: number | undefined): string {
  return `${Math.round(normalizeVolume(value) * 100)}%`;
}

function normalizeMaxTracksPerUser(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) {
    return 1;
  }

  return Math.min(20, Math.max(1, Math.round(value!)));
}

function normalizeMaxAudioDurationSec(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) {
    return 390;
  }

  return Math.min(86400, Math.max(1, Math.round(value!)));
}

function formatDurationLabel(totalSeconds: number | undefined): string {
  const safeSeconds = normalizeMaxAudioDurationSec(totalSeconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

type SettingsTab = "general" | "audio" | "automation" | "ui";
type CaptureTarget = "skip" | "pause" | "stop" | null;

interface SettingsToggleProps {
  checked: boolean;
  onChange: JSX.GenericEventHandler<HTMLInputElement>;
  children: ComponentChildren;
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);
const SETTINGS_MODAL_TRANSITION_MS = 220;

function SettingsToggle({ checked, onChange, children }: SettingsToggleProps) {
  return (
    <label class="toggle">
      <span class="toggle-copy">{children}</span>
      <span class="toggle-switch">
        <input class="toggle-input" type="checkbox" checked={checked} onChange={onChange} />
        <span class="toggle-track" aria-hidden="true">
          <span class="toggle-thumb" />
        </span>
      </span>
    </label>
  );
}

function normalizeAcceleratorKey(event: KeyboardEvent): string | null {
  const { key } = event;

  if (MODIFIER_KEYS.has(key)) {
    return null;
  }

  if (/^[a-z0-9]$/i.test(key)) {
    return key.toUpperCase();
  }

  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(key)) {
    return key.toUpperCase();
  }

  switch (key) {
    case "ArrowUp":
      return "Up";
    case "ArrowDown":
      return "Down";
    case "ArrowLeft":
      return "Left";
    case "ArrowRight":
      return "Right";
    case "PageUp":
      return "PageUp";
    case "PageDown":
      return "PageDown";
    case "Backspace":
      return "Backspace";
    case "Delete":
      return "Delete";
    case "Insert":
      return "Insert";
    case "Home":
      return "Home";
    case "End":
      return "End";
    case "Tab":
      return "Tab";
    case "Enter":
      return "Return";
    case " ":
    case "Spacebar":
      return "Space";
    default:
      return null;
  }
}

function buildAccelerator(event: KeyboardEvent): string | null {
  const keyPart = normalizeAcceleratorKey(event);
  if (!keyPart) {
    return null;
  }

  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) {
    parts.push("CommandOrControl");
  }
  if (event.altKey) {
    parts.push("Alt");
  }
  if (event.shiftKey) {
    parts.push("Shift");
  }

  parts.push(keyPart);
  return parts.join("+");
}

export function App() {
  const micAudioRef = useRef<HTMLAudioElement>(null);
  const mirrorAudioRef = useRef<HTMLAudioElement>(null);
  const settingsRef = useRef<Settings | null>(null);
  const playbackAttemptRef = useRef(0);
  const mediaSuppressDepthRef = useRef(0);
  const terminalNotifiedAttemptRef = useRef(-1);
  const logsBodyRef = useRef<HTMLDivElement>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const pendingLogsRef = useRef<string[]>([]);
  const flushLogsTimerRef = useRef<number | null>(null);
  const shouldStickLogsToBottomRef = useRef(true);
  const settingsModalFrameRef = useRef<number | null>(null);
  const settingsModalTimerRef = useRef<number | null>(null);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [state, setState] = useState<AppState>(emptyState());
  const [logs, setLogs] = useState<string[]>([]);
  const [devices, setDevices] = useState<AudioOutputDevice[]>([]);
  const [launchHint, setLaunchHint] = useState<string>("");
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [captureTarget, setCaptureTarget] = useState<CaptureTarget>(null);
  const [copiedLaunchHint, setCopiedLaunchHint] = useState(false);
  const [queueInput, setQueueInput] = useState("");
  const [addingToQueue, setAddingToQueue] = useState(false);
  const [dismissedAlertKey, setDismissedAlertKey] = useState<string | null>(null);

  function isSettingsTabActive(tab: SettingsTab): boolean {
    return settingsTab === tab;
  }

  function clearSettingsModalAnimationHandles(): void {
    if (settingsModalFrameRef.current !== null) {
      window.cancelAnimationFrame(settingsModalFrameRef.current);
      settingsModalFrameRef.current = null;
    }

    if (settingsModalTimerRef.current !== null) {
      window.clearTimeout(settingsModalTimerRef.current);
      settingsModalTimerRef.current = null;
    }
  }

  function openSettingsModal(): void {
    clearSettingsModalAnimationHandles();
    if (settingsRef.current) {
      setDraft(settingsRef.current);
    }
    setSettingsTab("general");
    setCaptureTarget(null);
    setSettingsMounted(true);
    settingsModalFrameRef.current = window.requestAnimationFrame(() => {
      setSettingsOpen(true);
      settingsModalFrameRef.current = null;
    });
  }

  function closeSettingsModal(options?: { resetDraft?: boolean }): void {
    clearSettingsModalAnimationHandles();
    setSettingsOpen(false);
    settingsModalTimerRef.current = window.setTimeout(() => {
      setSettingsMounted(false);
      setSettingsTab("general");
      setCaptureTarget(null);
      if (options?.resetDraft ?? true) {
        setDraft(settingsRef.current);
      }
      settingsModalTimerRef.current = null;
    }, SETTINGS_MODAL_TRANSITION_MS);
  }

  useEffect(() => () => clearSettingsModalAnimationHandles(), []);

  function suppressMediaEventsTemporarily(durationMs = 150): void {
    mediaSuppressDepthRef.current += 1;
    window.setTimeout(() => {
      mediaSuppressDepthRef.current = Math.max(0, mediaSuppressDepthRef.current - 1);
    }, durationMs);
  }

  function isMediaEventSuppressed(): boolean {
    return mediaSuppressDepthRef.current > 0;
  }

  function queueLogAppend(line: string): void {
    const container = logsBodyRef.current;
    if (container) {
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      shouldStickLogsToBottomRef.current = distanceFromBottom <= 24;
    }

    pendingLogsRef.current.push(line);
    if (flushLogsTimerRef.current !== null) {
      return;
    }

    flushLogsTimerRef.current = window.setTimeout(() => {
      const batch = pendingLogsRef.current.splice(0, pendingLogsRef.current.length);
      flushLogsTimerRef.current = null;
      if (batch.length === 0) {
        return;
      }

      setLogs((current) => [...current, ...batch].slice(-300));
    }, 80);
  }

  async function refreshDevices(options?: { forceRefresh?: boolean }): Promise<void> {
    const list = await window.tfRadio.listAudioOutputDevices({
      forceRefresh: options?.forceRefresh ?? false
    });
    setDevices(list);
  }

  async function stopTrack(options?: { invalidateAttempt?: boolean }): Promise<void> {
    if (options?.invalidateAttempt !== false) {
      playbackAttemptRef.current += 1;
    }

    suppressMediaEventsTemporarily();

    const micAudio = micAudioRef.current;
    const mirrorAudio = mirrorAudioRef.current;

    if (micAudio) {
      micAudio.pause();
      micAudio.currentTime = 0;
      micAudio.src = "";
    }

    if (mirrorAudio) {
      mirrorAudio.pause();
      mirrorAudio.currentTime = 0;
      mirrorAudio.src = "";
      mirrorAudio.muted = true;
    }
  }

  async function pauseTrack(): Promise<void> {
    micAudioRef.current?.pause();
    mirrorAudioRef.current?.pause();
  }

  async function resumeTrack(): Promise<void> {
    const micAudio = micAudioRef.current;
    const mirrorAudio = mirrorAudioRef.current;
    const activeSettings = settingsRef.current;
    if (!micAudio || !mirrorAudio || !activeSettings || !micAudio.src) {
      return;
    }

    const attemptId = playbackAttemptRef.current;
    terminalNotifiedAttemptRef.current = -1;

    try {
      applyVolumes(activeSettings);
      mirrorAudio.muted = !activeSettings.mirrorToDefaultSpeaker;
      await micAudio.play();
      if (attemptId !== playbackAttemptRef.current) {
        return;
      }

      if (activeSettings.mirrorToDefaultSpeaker && mirrorAudio.src) {
        mirrorAudio.muted = false;
        try {
          await mirrorAudio.play();
        } catch {
          // Mirror is optional. Keep primary mic playback active.
        }
      }
    } catch (error) {
      if (attemptId !== playbackAttemptRef.current) {
        return;
      }
      if (terminalNotifiedAttemptRef.current === attemptId) {
        return;
      }
      terminalNotifiedAttemptRef.current = attemptId;
      window.tfRadio.notifyPlaybackError(String(error));
    }
  }

  function applyVolumes(nextSettings: Settings | null): void {
    if (micAudioRef.current) {
      micAudioRef.current.volume = normalizeVolume(nextSettings?.inGameVolume);
    }

    if (mirrorAudioRef.current) {
      mirrorAudioRef.current.volume = normalizeVolume(nextSettings?.playbackVolume);
    }
  }

  async function syncAudioSettings(nextSettings: Settings | null): Promise<void> {
    applyVolumes(nextSettings);

    const micAudio = micAudioRef.current;
    const mirrorAudio = mirrorAudioRef.current;
    if (!mirrorAudio) {
      return;
    }

    if (!nextSettings?.mirrorToDefaultSpeaker) {
      mirrorAudio.muted = true;
      mirrorAudio.pause();
      return;
    }

    mirrorAudio.muted = false;

    if (!micAudio?.src) {
      return;
    }

    if (mirrorAudio.src !== micAudio.src) {
      mirrorAudio.src = micAudio.src;
    }

    if (Math.abs(mirrorAudio.currentTime - micAudio.currentTime) > 1) {
      mirrorAudio.currentTime = micAudio.currentTime;
    }

    if (!micAudio.paused) {
      try {
        await mirrorAudio.play();
      } catch {
        // Mirror playback is optional.
      }
    }
  }

  async function playTrack(track: QueueItem): Promise<void> {
    const micAudio = micAudioRef.current;
    const mirrorAudio = mirrorAudioRef.current;
    const activeSettings = settingsRef.current;
    if (!micAudio || !mirrorAudio || !activeSettings) {
      return;
    }

    const attemptId = ++playbackAttemptRef.current;
    terminalNotifiedAttemptRef.current = -1;

    try {
      await stopTrack({ invalidateAttempt: false });
      if (attemptId !== playbackAttemptRef.current) {
        return;
      }

      if (activeSettings.outputDeviceId && typeof micAudio.setSinkId === "function") {
        try {
          await micAudio.setSinkId(activeSettings.outputDeviceId);
        } catch {
          // Fallback to default output device if sink assignment fails.
        }
      }

      applyVolumes(activeSettings);
      micAudio.src = track.streamUrl;
      await micAudio.play();
      if (attemptId !== playbackAttemptRef.current) {
        return;
      }

      if (activeSettings.mirrorToDefaultSpeaker) {
        mirrorAudio.muted = false;
        mirrorAudio.src = track.streamUrl;
        try {
          await mirrorAudio.play();
        } catch {
          // Mirror is optional. Keep primary mic playback active.
        }
      }

      if (attemptId !== playbackAttemptRef.current) {
        return;
      }

      window.tfRadio.notifyPlaybackReady();
    } catch (error) {
      if (attemptId !== playbackAttemptRef.current) {
        return;
      }
      if (terminalNotifiedAttemptRef.current === attemptId) {
        return;
      }
      terminalNotifiedAttemptRef.current = attemptId;
      window.tfRadio.notifyPlaybackError(String(error));
    }
  }

  useEffect(() => {
    let mounted = true;
    const unsubscribers: Array<() => void> = [];

    void (async () => {
      const payload: BootstrapPayload = await window.tfRadio.getSettings();
      if (!mounted) {
        return;
      }

      setSettings(payload.settings);
      settingsRef.current = payload.settings;
      setDraft(payload.settings);
      applyVolumes(payload.settings);
      setState(payload.state);
      setLogs(payload.logs);
      await refreshDevices();

      unsubscribers.push(
        window.tfRadio.onStateUpdate((next) => {
          if (mounted) {
            setState(next);
          }
        })
      );

      unsubscribers.push(
        window.tfRadio.onLogAppend((line) => {
          if (!mounted) {
            return;
          }

          queueLogAppend(line);
        })
      );

      unsubscribers.push(
        window.tfRadio.onSetupRconRequired((payload: SetupRconRequiredPayload) => {
          if (mounted) {
            setLaunchHint(payload.requiredLaunchOptions);
          }
        })
      );

      unsubscribers.push(
        window.tfRadio.onPlaybackStart((track) => {
          if (mounted) {
            void playTrack(track);
          }
        })
      );

      unsubscribers.push(
        window.tfRadio.onPlaybackStop(() => {
          if (mounted) {
            void stopTrack();
          }
        })
      );

      unsubscribers.push(
        window.tfRadio.onPlaybackPause(() => {
          if (mounted) {
            void pauseTrack();
          }
        })
      );

      unsubscribers.push(
        window.tfRadio.onPlaybackResume(() => {
          if (mounted) {
            void resumeTrack();
          }
        })
      );
    })();

    return () => {
      mounted = false;
      if (flushLogsTimerRef.current !== null) {
        window.clearTimeout(flushLogsTimerRef.current);
        flushLogsTimerRef.current = null;
      }
      pendingLogsRef.current = [];
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, []);

  useEffect(() => {
    if (!shouldStickLogsToBottomRef.current) {
      return;
    }

    logsEndRef.current?.scrollIntoView({ block: "end" });
  }, [logs]);

  useEffect(() => {
    if (!captureTarget) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setCaptureTarget(null);
        return;
      }

      const accelerator = buildAccelerator(event);
      if (!accelerator) {
        return;
      }

      event.preventDefault();
      setDraft((current) => {
        if (!current) {
          return current;
        }

        if (captureTarget === "skip") {
          return { ...current, skipShortcut: accelerator };
        }

        if (captureTarget === "pause") {
          return { ...current, pauseShortcut: accelerator };
        }

        return { ...current, stopShortcut: accelerator };
      });
      setCaptureTarget(null);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [captureTarget]);

  const setupMessage = useMemo(() => {
    if (state.setupIssue?.message) {
      return state.setupIssue.message;
    }

    if (state.lastError) {
      return state.lastError;
    }

    return null;
  }, [state]);

  const hintText = launchHint || state.setupIssue?.launchOptionsHint || null;
  const alertKey = useMemo(
    () => (setupMessage || hintText ? `${setupMessage ?? ""}::${hintText ?? ""}` : null),
    [setupMessage, hintText]
  );
  const isAlertVisible = Boolean(alertKey) && dismissedAlertKey !== alertKey;
  const upcomingQueueCount = state.current ? Math.max(0, state.queue.length - 1) : state.queue.length;
  const isPlaybackPaused = state.playback === "paused";
  const canTogglePlayback =
    state.serviceRunning && Boolean(state.current) && state.playback !== "buffering";

  useEffect(() => {
    if (!alertKey) {
      setDismissedAlertKey(null);
    }
  }, [alertKey]);
  const canStopPlayback = state.serviceRunning && (Boolean(state.current) || state.queue.length > 0);

  function copyLaunchHint(): void {
    if (!hintText) {
      return;
    }

    window.tfRadio.copyText(hintText);
    setCopiedLaunchHint(true);
    window.setTimeout(() => {
      setCopiedLaunchHint(false);
    }, 1800);
  }

  async function saveSettings(): Promise<void> {
    if (!draft) {
      return;
    }

    const next = await window.tfRadio.updateSettings({
      tf2Path: draft.tf2Path,
      playerName: draft.playerName,
      commandScope: draft.commandScope,
      outputDeviceId: draft.outputDeviceId,
      mirrorToDefaultSpeaker: draft.mirrorToDefaultSpeaker,
      clearLogsOnStartup: draft.clearLogsOnStartup,
      inGameVolume: normalizeVolume(draft.inGameVolume),
      playbackVolume: normalizeVolume(draft.playbackVolume),
      maxAudioDurationSec: normalizeMaxAudioDurationSec(draft.maxAudioDurationSec),
      maxTracksPerUser: normalizeMaxTracksPerUser(draft.maxTracksPerUser),
      minimizeToTray: Boolean(draft.minimizeToTray),
      overlayEnabled: Boolean(draft.overlayEnabled),
      chatSkipCommandEnabled: Boolean(draft.chatSkipCommandEnabled),
      chatPauseCommandEnabled: Boolean(draft.chatPauseCommandEnabled),
      chatStopCommandEnabled: Boolean(draft.chatStopCommandEnabled),
      chatLinksEnabled: Boolean(draft.chatLinksEnabled),
      skipShortcut: draft.skipShortcut?.trim() ? draft.skipShortcut.trim() : null,
      pauseShortcut: draft.pauseShortcut?.trim() ? draft.pauseShortcut.trim() : null,
      stopShortcut: draft.stopShortcut?.trim() ? draft.stopShortcut.trim() : null,
      chatResponsesEnabled: draft.chatResponsesEnabled
    });

    setSettings(next);
    settingsRef.current = next;
    setDraft(next);
    await syncAudioSettings(next);
    setCaptureTarget(null);
    closeSettingsModal({ resetDraft: false });
  }

  async function handleAddToQueue(): Promise<void> {
    const trimmed = queueInput.trim();
    if (!trimmed || addingToQueue) {
      return;
    }

    setAddingToQueue(true);
    try {
      const result = await window.tfRadio.addToQueue(trimmed);
      if (result.ok) {
        setQueueInput("");
      }
    } finally {
      setAddingToQueue(false);
    }
  }

  return (
    <div class="app-shell">
      <header class="top-bar">
        <div class="top-bar-left">
          <Radio size={16} class="icon" />
          <span class="app-title">TF2 Radio</span>
        </div>
        <div class="top-bar-right">
          <button
            class={`power-toggle ${state.serviceRunning ? "on" : "off"}`}
            type="button"
            title={state.serviceRunning ? "Stop service" : "Start service"}
            onClick={() => {
              if (state.serviceRunning) {
                void window.tfRadio.stopService();
              } else {
                void window.tfRadio.startService();
              }
            }}
          >
            <span class="power-toggle-track">
              <span class="power-toggle-thumb">
                <Power size={11} />
              </span>
            </span>
            <span class="power-toggle-label">
              {state.serviceRunning ? "ON" : "OFF"}
            </span>
          </button>
          <span class={`chip ${state.connectedToRcon ? "ok" : "bad"}`}>
            {state.connectedToRcon ? "RCON" : "NO RCON"}
          </span>
          <button
            class="icon-btn"
            type="button"
            title="Settings"
            onClick={openSettingsModal}
          >
            <SettingsIcon size={16} />
          </button>
        </div>
      </header>

      {isAlertVisible && (
        <div class="alert-banner">
          <div class="alert-header">
            {setupMessage ? (
              <p class="alert-text">
                <AlertTriangle size={14} class="icon" />
                {setupMessage}
              </p>
            ) : (
              <div />
            )}
            <button
              class="alert-close-btn"
              type="button"
              title="Dismiss alert"
              aria-label="Dismiss alert"
              onClick={() => setDismissedAlertKey(alertKey)}
            >
              <X size={14} />
            </button>
          </div>
          {hintText && (
            <>
              <div class="alert-actions">
                <span class="alert-actions-label">Required TF2 launch options</span>
                <button class="btn ghost compact alert-copy-btn" type="button" onClick={copyLaunchHint}>
                  <span class="btn-content">
                    <Copy size={14} class="icon" />
                    {copiedLaunchHint ? "Copied" : "Copy"}
                  </span>
                </button>
              </div>
              <pre class="hint">{hintText}</pre>
            </>
          )}
        </div>
      )}

      <div class="main-content">
        <section class="player-section card">
          <div class="player-info">
            {state.current ? (
              <>
                <p class="player-label">NOW PLAYING</p>
                <h2 class="player-title">{safeText(state.current.title)}</h2>
                <p class="player-meta">
                  {safeText(state.current.channel)} &middot; requested by{" "}
                  {safeText(state.current.requestedBy)}
                </p>
              </>
            ) : (
              <>
                <p class="player-label">NO TRACK PLAYING</p>
                <p class="player-meta">
                  Type <code>?play &lt;query&gt;</code>
                  {settings?.chatSkipCommandEnabled ? <>, <code>?skip</code></> : null}
                  {settings?.chatPauseCommandEnabled ? (
                    <>
                      , <code>?pause</code>, <code>?resume</code>
                    </>
                  ) : null}{" "}
                  {settings?.chatStopCommandEnabled ? <>, <code>?stop</code></> : null}{" "}
                  in TF2 chat
                </p>
              </>
            )}
          </div>

          <div class="controls-row">
            <button
              class="btn ghost"
              type="button"
              disabled={!canTogglePlayback}
              onClick={() => void window.tfRadio.togglePausePlayback()}
            >
              <span class="btn-content">
                {isPlaybackPaused ? <Play size={14} class="icon" /> : <Pause size={14} class="icon" />}
                {isPlaybackPaused ? "Resume" : "Pause"}
              </span>
            </button>
            <button
              class="btn ghost"
              type="button"
              disabled={!state.serviceRunning}
              onClick={() => void window.tfRadio.skipQueue()}
            >
              <span class="btn-content">
                <SkipForward size={14} class="icon" />
                Skip
              </span>
            </button>
            <button
              class="btn ghost"
              type="button"
              disabled={!canStopPlayback}
              onClick={() => void window.tfRadio.stopQueue()}
            >
              <span class="btn-content">
                <Square size={14} class="icon" />
                Stop
              </span>
            </button>
            <button
              class="btn ghost"
              type="button"
              disabled={!state.serviceRunning || upcomingQueueCount === 0}
              onClick={() => void window.tfRadio.clearQueue()}
            >
              <span class="btn-content">
                <Trash2 size={14} class="icon" />
                Clear Queue
              </span>
            </button>
          </div>

          <div class="stats-row">
            <div class="stat-item">
              <Activity size={12} class="icon" />
              <span>{formatPlaybackState(state.playback)}</span>
            </div>
            <div class="stat-item">
              <Volume2 size={12} class="icon" />
              <span>Game {formatVolumePercent(settings?.inGameVolume)}</span>
            </div>
            <div class="stat-item">
              <MonitorSpeaker size={12} class="icon" />
              <span>
                {settings?.mirrorToDefaultSpeaker
                  ? `Monitor ${formatVolumePercent(settings?.playbackVolume)}`
                  : "Monitor off"}
              </span>
            </div>
            <div class="stat-item">
              <Music2 size={12} class="icon" />
              <span>{upcomingQueueCount} queued</span>
            </div>
            <div class="stat-item">
              <Users size={12} class="icon" />
              <span>{settings?.commandScope === "anyone" ? "Anyone" : "Self"}</span>
            </div>
            <div class="stat-item">
              <User size={12} class="icon" />
              <span>{normalizeMaxTracksPerUser(settings?.maxTracksPerUser)}/user</span>
            </div>
          </div>
        </section>

        <section class="panels">
          <article class="panel card">
            <div class="panel-header">
              <h2 class="heading-with-icon">
                <Music2 size={14} class="icon" />
                Queue
              </h2>
              {state.queue.length > 0 && (
                <span class="panel-count">{state.queue.length}</span>
              )}
            </div>
            <div class="queue-add-row">
              <input
                class="queue-add-input"
                type="text"
                placeholder="Search or paste a YouTube link..."
                value={queueInput}
                disabled={!state.serviceRunning || addingToQueue}
                onInput={(event) =>
                  setQueueInput((event.currentTarget as HTMLInputElement).value)
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void handleAddToQueue();
                  }
                }}
              />
              <button
                class="btn primary compact"
                type="button"
                title="Add to queue"
                disabled={!state.serviceRunning || addingToQueue || !queueInput.trim()}
                onClick={() => void handleAddToQueue()}
              >
                <Plus size={14} />
              </button>
            </div>
            <div class="panel-body">
              {state.queue.length === 0 ? (
                <p class="panel-empty">Queue is empty</p>
              ) : (
                <div class="queue-list">
                  {state.queue.map((item, index) => (
                    <div key={`${item.id}-${index}`} class="queue-item">
                      <span class="queue-num">#{index + 1}</span>
                      <div class="queue-details">
                        <span class="queue-title">{item.title}</span>
                        <span class="queue-requester">
                          {item.requestedBy}
                          {state.current?.id === item.id ? " • now playing" : ""}
                        </span>
                      </div>
                      <button
                        class="queue-remove-btn"
                        type="button"
                        title="Remove from queue"
                        onClick={() => void window.tfRadio.removeFromQueue(item.id)}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </article>

          <article class="panel card">
            <div class="panel-header">
              <h2 class="heading-with-icon">
                <Activity size={14} class="icon" />
                Logs
              </h2>
            </div>
            <div
              ref={logsBodyRef}
              class="panel-body logs-body"
              onScroll={(event) => {
                const container = event.currentTarget as HTMLDivElement;
                const distanceFromBottom =
                  container.scrollHeight - container.scrollTop - container.clientHeight;
                shouldStickLogsToBottomRef.current = distanceFromBottom <= 24;
              }}
            >
              {logs.length === 0 ? (
                <p class="panel-empty">No log entries yet</p>
              ) : (
                <>
                  {logs.map((entry, index) => (
                    <div key={`${entry}-${index}`} class="log-line">
                      {entry}
                    </div>
                  ))}
                  <div ref={logsEndRef} />
                </>
              )}
            </div>
          </article>
        </section>
      </div>

      {settingsMounted && (
        <div
          class={`modal-overlay ${settingsOpen ? "open" : ""}`}
          onClick={() => closeSettingsModal()}
        >
          <div class={`modal card ${settingsOpen ? "open" : ""}`} onClick={(event) => event.stopPropagation()}>
            <div class="modal-top">
              <h2 class="heading-with-icon">
                <SettingsIcon size={14} class="icon" />
                Settings
              </h2>
              <button
                class="icon-btn"
                type="button"
                title="Close"
                onClick={() => closeSettingsModal()}
              >
                <X size={14} />
              </button>
            </div>

            <div class="settings-tabs" role="tablist" aria-label="Settings sections">
              <button
                type="button"
                id="settings-tab-general"
                role="tab"
                aria-selected={isSettingsTabActive("general")}
                aria-controls="settings-panel-general"
                class={`tab-btn ${isSettingsTabActive("general") ? "active" : ""}`}
                onClick={() => setSettingsTab("general")}
              >
                <User size={14} class="icon" />
                General
              </button>
              <button
                type="button"
                id="settings-tab-audio"
                role="tab"
                aria-selected={isSettingsTabActive("audio")}
                aria-controls="settings-panel-audio"
                class={`tab-btn ${isSettingsTabActive("audio") ? "active" : ""}`}
                onClick={() => setSettingsTab("audio")}
              >
                <Volume2 size={14} class="icon" />
                Audio
              </button>
              <button
                type="button"
                id="settings-tab-automation"
                role="tab"
                aria-selected={isSettingsTabActive("automation")}
                aria-controls="settings-panel-automation"
                class={`tab-btn ${isSettingsTabActive("automation") ? "active" : ""}`}
                onClick={() => setSettingsTab("automation")}
              >
                <SlidersHorizontal size={14} class="icon" />
                Automation
              </button>
              <button
                type="button"
                id="settings-tab-ui"
                role="tab"
                aria-selected={isSettingsTabActive("ui")}
                aria-controls="settings-panel-ui"
                class={`tab-btn ${isSettingsTabActive("ui") ? "active" : ""}`}
                onClick={() => setSettingsTab("ui")}
              >
                <PictureInPicture2 size={14} class="icon" />
                UI
              </button>
            </div>

            <div class="settings-stage">
              <div
                id="settings-panel-general"
                role="tabpanel"
                aria-labelledby="settings-tab-general"
                aria-hidden={!isSettingsTabActive("general")}
                class={`settings-pane ${isSettingsTabActive("general") ? "active" : ""}`}
              >
                <div class="field">
                  <label class="label-with-icon">
                    <FolderOpen size={14} class="icon" />
                    TF2 Path
                  </label>
                  <input
                    value={draft?.tf2Path ?? ""}
                    onInput={(event) =>
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              tf2Path: (event.currentTarget as HTMLInputElement).value || null
                            }
                          : current
                      )
                    }
                  />
                </div>
                <div class="field">
                  <label class="label-with-icon">
                    <User size={14} class="icon" />
                    Player Name
                  </label>
                  <input
                    value={draft?.playerName ?? ""}
                    onInput={(event) =>
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              playerName: (event.currentTarget as HTMLInputElement).value
                            }
                          : current
                      )
                    }
                  />
                </div>
                <div class="field">
                  <label class="label-with-icon">
                    <Users size={14} class="icon" />
                    Command Scope
                  </label>
                  <select
                    value={draft?.commandScope ?? "anyone"}
                    onChange={(event) =>
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              commandScope: (event.currentTarget as HTMLSelectElement).value as
                                | "self"
                                | "anyone"
                            }
                          : current
                      )
                    }
                  >
                    <option value="self">Only me</option>
                    <option value="anyone">Anyone in server</option>
                  </select>
                </div>
                <div class="field">
                  <label class="label-with-icon">
                    <User size={14} class="icon" />
                    Max Tracks Per User
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="20"
                    step="1"
                    value={normalizeMaxTracksPerUser(draft?.maxTracksPerUser)}
                    onInput={(event) =>
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              maxTracksPerUser: normalizeMaxTracksPerUser(
                                Number((event.currentTarget as HTMLInputElement).value)
                              )
                            }
                          : current
                      )
                    }
                  />
                </div>
                <div class="field">
                  <label class="label-with-icon">
                    <Music2 size={14} class="icon" />
                    Max Audio Time: {formatDurationLabel(draft?.maxAudioDurationSec)}
                  </label>
                  <p class="field-caption">
                    Searches try the top 5 matches and skip anything longer than this limit.
                  </p>
                  <input
                    type="number"
                    min="1"
                    max="86400"
                    step="1"
                    value={normalizeMaxAudioDurationSec(draft?.maxAudioDurationSec)}
                    onInput={(event) =>
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              maxAudioDurationSec: normalizeMaxAudioDurationSec(
                                Number((event.currentTarget as HTMLInputElement).value)
                              )
                            }
                          : current
                      )
                    }
                  />
                </div>
                <SettingsToggle
                  checked={Boolean(draft?.clearLogsOnStartup)}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            clearLogsOnStartup: (event.currentTarget as HTMLInputElement).checked
                          }
                        : current
                    )
                  }
                >
                  Clear logs on startup
                </SettingsToggle>
              </div>

              <div
                id="settings-panel-audio"
                role="tabpanel"
                aria-labelledby="settings-tab-audio"
                aria-hidden={!isSettingsTabActive("audio")}
                class={`settings-pane ${isSettingsTabActive("audio") ? "active" : ""}`}
              >
                <div class="field">
                  <label class="label-with-icon">
                    <MonitorSpeaker size={14} class="icon" />
                    Output Device
                  </label>
                  <div class="field-row">
                    <select
                      value={draft?.outputDeviceId ?? ""}
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                outputDeviceId:
                                  (event.currentTarget as HTMLSelectElement).value || null
                              }
                            : current
                        )
                      }
                    >
                      {devices.length === 0 && <option value="">No device found</option>}
                      {devices.map((device) => (
                        <option value={device.deviceId} key={device.deviceId}>
                          {device.label}
                          {device.isDefault ? " (default)" : ""}
                          {device.isLikelyVirtualCable ? " [VB]" : ""}
                        </option>
                      ))}
                    </select>
                    <button
                      class="btn ghost compact"
                      type="button"
                      onClick={() => void refreshDevices({ forceRefresh: true })}
                      title="Refresh audio devices"
                    >
                      <RefreshCw size={14} />
                    </button>
                  </div>
                </div>
                <div class="field">
                  <label class="label-with-icon">
                    <Volume2 size={14} class="icon" />
                    In-Game Volume: {formatVolumePercent(draft?.inGameVolume)}
                  </label>
                  <p class="field-caption">Sent to the selected output device or virtual cable.</p>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={Math.round(normalizeVolume(draft?.inGameVolume) * 100)}
                    onInput={(event) =>
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              inGameVolume:
                                Number((event.currentTarget as HTMLInputElement).value) / 100
                            }
                          : current
                      )
                    }
                  />
                </div>
                <div class="field">
                  <label class="label-with-icon">
                    <MonitorSpeaker size={14} class="icon" />
                    Playback Volume: {formatVolumePercent(draft?.playbackVolume)}
                  </label>
                  <p class="field-caption">Used for the local speaker mirror only.</p>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={Math.round(normalizeVolume(draft?.playbackVolume) * 100)}
                    disabled={!draft?.mirrorToDefaultSpeaker}
                    onInput={(event) =>
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              playbackVolume:
                                Number((event.currentTarget as HTMLInputElement).value) / 100
                            }
                          : current
                      )
                    }
                  />
                </div>
                <SettingsToggle
                  checked={Boolean(draft?.mirrorToDefaultSpeaker)}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            mirrorToDefaultSpeaker: (event.currentTarget as HTMLInputElement)
                              .checked
                          }
                        : current
                    )
                  }
                >
                  Mirror to default speakers
                </SettingsToggle>
              </div>

              <div
                id="settings-panel-automation"
                role="tabpanel"
                aria-labelledby="settings-tab-automation"
                aria-hidden={!isSettingsTabActive("automation")}
                class={`settings-pane ${isSettingsTabActive("automation") ? "active" : ""}`}
              >
                <SettingsToggle
                  checked={Boolean(draft?.chatLinksEnabled)}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            chatLinksEnabled: (event.currentTarget as HTMLInputElement).checked
                          }
                        : current
                    )
                  }
                >
                  <MessageSquare size={14} class="icon" />
                  Allow links in <code>?play</code> chat commands
                </SettingsToggle>
                <SettingsToggle
                  checked={Boolean(draft?.chatResponsesEnabled)}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            chatResponsesEnabled: (event.currentTarget as HTMLInputElement).checked
                          }
                        : current
                    )
                  }
                >
                  <MessageSquare size={14} class="icon" />
                  Bot chat responses (say)
                </SettingsToggle>
                <SettingsToggle
                  checked={Boolean(draft?.chatSkipCommandEnabled)}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            chatSkipCommandEnabled: (event.currentTarget as HTMLInputElement)
                              .checked
                          }
                        : current
                    )
                  }
                >
                  <SkipForward size={14} class="icon" />
                  Allow <code>?skip</code> in chat
                </SettingsToggle>
                <SettingsToggle
                  checked={Boolean(draft?.chatPauseCommandEnabled)}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            chatPauseCommandEnabled: (event.currentTarget as HTMLInputElement)
                              .checked
                          }
                        : current
                    )
                  }
                >
                  <Pause size={14} class="icon" />
                  Allow <code>?pause</code> / <code>?resume</code> in chat
                </SettingsToggle>
                <SettingsToggle
                  checked={Boolean(draft?.chatStopCommandEnabled)}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            chatStopCommandEnabled: (event.currentTarget as HTMLInputElement).checked
                          }
                        : current
                    )
                  }
                >
                  <Square size={14} class="icon" />
                  Allow <code>?stop</code> in chat
                </SettingsToggle>
                <div class="field">
                  <label class="label-with-icon">
                    <Command size={14} class="icon" />
                    Skip Shortcut
                  </label>
                  <div class="field-row">
                    <button
                      type="button"
                      class={`btn ghost shortcut-capture ${captureTarget === "skip" ? "capturing" : ""}`}
                      onClick={() =>
                        setCaptureTarget((current) => (current === "skip" ? null : "skip"))
                      }
                    >
                      {captureTarget === "skip"
                        ? "Press shortcut... (Esc to cancel)"
                        : draft?.skipShortcut ?? "Set shortcut"}
                    </button>
                    <button
                      class="btn ghost compact"
                      type="button"
                      title="Clear skip shortcut"
                      onClick={() =>
                        setDraft((current) => (current ? { ...current, skipShortcut: null } : current))
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <div class="field">
                  <label class="label-with-icon">
                    <Command size={14} class="icon" />
                    Pause/Resume Shortcut
                  </label>
                  <div class="field-row">
                    <button
                      type="button"
                      class={`btn ghost shortcut-capture ${captureTarget === "pause" ? "capturing" : ""}`}
                      onClick={() =>
                        setCaptureTarget((current) => (current === "pause" ? null : "pause"))
                      }
                    >
                      {captureTarget === "pause"
                        ? "Press shortcut... (Esc to cancel)"
                        : draft?.pauseShortcut ?? "Set pause/resume shortcut"}
                    </button>
                    <button
                      class="btn ghost compact"
                      type="button"
                      title="Clear pause/resume shortcut"
                      onClick={() =>
                        setDraft((current) => (current ? { ...current, pauseShortcut: null } : current))
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <div class="field">
                  <label class="label-with-icon">
                    <Command size={14} class="icon" />
                    Stop Shortcut
                  </label>
                  <div class="field-row">
                    <button
                      type="button"
                      class={`btn ghost shortcut-capture ${captureTarget === "stop" ? "capturing" : ""}`}
                      onClick={() =>
                        setCaptureTarget((current) => (current === "stop" ? null : "stop"))
                      }
                    >
                      {captureTarget === "stop"
                        ? "Press shortcut... (Esc to cancel)"
                        : draft?.stopShortcut ?? "Set stop shortcut"}
                    </button>
                    <button
                      class="btn ghost compact"
                      type="button"
                      title="Clear stop shortcut"
                      onClick={() =>
                        setDraft((current) => (current ? { ...current, stopShortcut: null } : current))
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>

              <div
                id="settings-panel-ui"
                role="tabpanel"
                aria-labelledby="settings-tab-ui"
                aria-hidden={!isSettingsTabActive("ui")}
                class={`settings-pane ${isSettingsTabActive("ui") ? "active" : ""}`}
              >
                <SettingsToggle
                  checked={Boolean(draft?.minimizeToTray)}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            minimizeToTray: (event.currentTarget as HTMLInputElement).checked
                          }
                        : current
                    )
                  }
                >
                  <Minimize2 size={14} class="icon" />
                  Minimize/close to tray
                </SettingsToggle>
                <SettingsToggle
                  checked={Boolean(draft?.overlayEnabled)}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            overlayEnabled: (event.currentTarget as HTMLInputElement).checked
                          }
                        : current
                    )
                  }
                >
                  <PictureInPicture2 size={14} class="icon" />
                  Show top-left now playing overlay
                </SettingsToggle>
              </div>
            </div>

            <div class="modal-actions">
              <button class="btn primary" type="button" onClick={() => void saveSettings()}>
                <span class="btn-content">
                  <SettingsIcon size={14} class="icon" />
                  Save Settings
                </span>
              </button>
              <button
                class="btn ghost"
                type="button"
                onClick={() => closeSettingsModal()}
              >
                <span class="btn-content">Cancel</span>
              </button>
            </div>
          </div>
        </div>
      )}

      <audio
        ref={micAudioRef}
        preload="none"
        onEnded={() => {
          if (isMediaEventSuppressed()) {
            return;
          }

          const attemptId = playbackAttemptRef.current;
          if (terminalNotifiedAttemptRef.current === attemptId) {
            return;
          }
          terminalNotifiedAttemptRef.current = attemptId;

          void stopTrack();
          window.tfRadio.notifyPlaybackEnded();
        }}
        onError={() => {
          if (isMediaEventSuppressed()) {
            return;
          }

          const attemptId = playbackAttemptRef.current;
          if (terminalNotifiedAttemptRef.current === attemptId) {
            return;
          }
          terminalNotifiedAttemptRef.current = attemptId;

          const media = micAudioRef.current;
          const code = media?.error?.code;
          void stopTrack();
          window.tfRadio.notifyPlaybackError(code ? `Media error ${code}` : "Unknown media error");
        }}
      />
      <audio ref={mirrorAudioRef} preload="none" muted />
    </div>
  );
}
