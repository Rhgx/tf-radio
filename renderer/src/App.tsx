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
  PictureInPicture2,
  Play,
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

function normalizeMaxTracksPerUser(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) {
    return 1;
  }

  return Math.min(20, Math.max(1, Math.round(value!)));
}

type SettingsTab = "general" | "audio" | "automation" | "ui";
type CaptureTarget = "skip" | "stop" | null;

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);

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

  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [state, setState] = useState<AppState>(emptyState());
  const [logs, setLogs] = useState<string[]>([]);
  const [devices, setDevices] = useState<AudioOutputDevice[]>([]);
  const [launchHint, setLaunchHint] = useState<string>("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [captureTarget, setCaptureTarget] = useState<CaptureTarget>(null);
  const [copiedLaunchHint, setCopiedLaunchHint] = useState(false);

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

  function applyVolume(nextSettings: Settings | null): void {
    const volume = normalizeVolume(nextSettings?.botVolume);

    if (micAudioRef.current) {
      micAudioRef.current.volume = volume;
    }

    if (mirrorAudioRef.current) {
      mirrorAudioRef.current.volume = volume;
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

      applyVolume(activeSettings);
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
      applyVolume(payload.settings);
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
      botVolume: normalizeVolume(draft.botVolume),
      maxTracksPerUser: normalizeMaxTracksPerUser(draft.maxTracksPerUser),
      minimizeToTray: Boolean(draft.minimizeToTray),
      overlayEnabled: Boolean(draft.overlayEnabled),
      chatSkipCommandEnabled: Boolean(draft.chatSkipCommandEnabled),
      chatStopCommandEnabled: Boolean(draft.chatStopCommandEnabled),
      skipShortcut: draft.skipShortcut?.trim() ? draft.skipShortcut.trim() : null,
      stopShortcut: draft.stopShortcut?.trim() ? draft.stopShortcut.trim() : null,
      chatResponsesEnabled: draft.chatResponsesEnabled
    });

    setSettings(next);
    settingsRef.current = next;
    setDraft(next);
    applyVolume(next);
    setCaptureTarget(null);
    setSettingsOpen(false);
  }

  return (
    <div class="app-shell">
      <header class="top-bar">
        <div class="top-bar-left">
          <Radio size={16} class="icon" />
          <span class="app-title">TF2 Radio</span>
        </div>
        <div class="top-bar-right">
          <span class={`chip ${state.serviceRunning ? "ok" : "bad"}`}>
            {state.serviceRunning ? "ONLINE" : "OFFLINE"}
          </span>
          <span class={`chip ${state.connectedToRcon ? "ok" : "bad"}`}>
            {state.connectedToRcon ? "RCON" : "NO RCON"}
          </span>
          <button
            class="icon-btn"
            type="button"
            title="Settings"
            onClick={() => {
              if (settingsRef.current) {
                setDraft(settingsRef.current);
              }
              setSettingsTab("general");
              setSettingsOpen(true);
            }}
          >
            <SettingsIcon size={16} />
          </button>
        </div>
      </header>

      {(setupMessage || hintText) && (
        <div class="alert-banner">
          {setupMessage && (
            <p class="alert-text">
              <AlertTriangle size={14} class="icon" />
              {setupMessage}
            </p>
          )}
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
                  {settings?.chatStopCommandEnabled ? <>, <code>?stop</code></> : null} in TF2 chat
                </p>
              </>
            )}
          </div>

          <div class="controls-row">
            <button
              class="btn primary"
              type="button"
              onClick={() => void window.tfRadio.startService()}
            >
              <span class="btn-content">
                <Play size={14} class="icon" />
                Start
              </span>
            </button>
            <button
              class="btn ghost"
              type="button"
              onClick={() => void window.tfRadio.stopService()}
            >
              <span class="btn-content">
                <Square size={14} class="icon" />
                Stop
              </span>
            </button>
            <button
              class="btn ghost"
              type="button"
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
              onClick={() => void window.tfRadio.clearQueue()}
            >
              <span class="btn-content">
                <Trash2 size={14} class="icon" />
                Clear
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
              <span>{Math.round(normalizeVolume(settings?.botVolume) * 100)}%</span>
            </div>
            <div class="stat-item">
              <Music2 size={12} class="icon" />
              <span>{state.queue.length} queued</span>
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
                        <span class="queue-requester">{item.requestedBy}</span>
                      </div>
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

      {settingsOpen && (
        <div
          class="modal-overlay"
          onClick={() => {
            setSettingsOpen(false);
            setSettingsTab("general");
            setCaptureTarget(null);
            setDraft(settingsRef.current);
          }}
        >
          <div class="modal card" onClick={(event) => event.stopPropagation()}>
            <div class="modal-top">
              <h2 class="heading-with-icon">
                <SettingsIcon size={14} class="icon" />
                Settings
              </h2>
              <button
                class="icon-btn"
                type="button"
                title="Close"
                onClick={() => {
                  setSettingsOpen(false);
                  setSettingsTab("general");
                  setCaptureTarget(null);
                  setDraft(settingsRef.current);
                }}
              >
                <X size={14} />
              </button>
            </div>

            <div class="settings-tabs">
              <button
                type="button"
                class={`tab-btn ${settingsTab === "general" ? "active" : ""}`}
                onClick={() => setSettingsTab("general")}
              >
                <User size={14} class="icon" />
                General
              </button>
              <button
                type="button"
                class={`tab-btn ${settingsTab === "audio" ? "active" : ""}`}
                onClick={() => setSettingsTab("audio")}
              >
                <Volume2 size={14} class="icon" />
                Audio
              </button>
              <button
                type="button"
                class={`tab-btn ${settingsTab === "automation" ? "active" : ""}`}
                onClick={() => setSettingsTab("automation")}
              >
                <SlidersHorizontal size={14} class="icon" />
                Automation
              </button>
              <button
                type="button"
                class={`tab-btn ${settingsTab === "ui" ? "active" : ""}`}
                onClick={() => setSettingsTab("ui")}
              >
                <PictureInPicture2 size={14} class="icon" />
                UI
              </button>
            </div>

            {settingsTab === "general" && (
              <div class="settings-pane">
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
                <label class="toggle">
                  <input
                    type="checkbox"
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
                  />
                  Clear logs on startup
                </label>
              </div>
            )}

            {settingsTab === "audio" && (
              <div class="settings-pane">
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
                    Bot Volume: {Math.round(normalizeVolume(draft?.botVolume) * 100)}%
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={Math.round(normalizeVolume(draft?.botVolume) * 100)}
                    onInput={(event) =>
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              botVolume: Number((event.currentTarget as HTMLInputElement).value) / 100
                            }
                          : current
                      )
                    }
                  />
                </div>
                <label class="toggle">
                  <input
                    type="checkbox"
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
                  />
                  Mirror to default speakers
                </label>
              </div>
            )}

            {settingsTab === "automation" && (
              <div class="settings-pane">
                <label class="toggle">
                  <input
                    type="checkbox"
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
                  />
                  <MessageSquare size={14} class="icon" />
                  Bot chat responses (say)
                </label>
                <label class="toggle">
                  <input
                    type="checkbox"
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
                  />
                  <SkipForward size={14} class="icon" />
                  Allow <code>?skip</code> in chat
                </label>
                <label class="toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(draft?.chatStopCommandEnabled)}
                    onChange={(event) =>
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              chatStopCommandEnabled: (event.currentTarget as HTMLInputElement)
                                .checked
                            }
                          : current
                      )
                    }
                  />
                  <Square size={14} class="icon" />
                  Allow <code>?stop</code> in chat
                </label>
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
                        : draft?.stopShortcut ?? "Set shortcut"}
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
            )}

            {settingsTab === "ui" && (
              <div class="settings-pane">
                <label class="toggle">
                  <input
                    type="checkbox"
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
                  />
                  <Minimize2 size={14} class="icon" />
                  Minimize/close to tray
                </label>
                <label class="toggle">
                  <input
                    type="checkbox"
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
                  />
                  <PictureInPicture2 size={14} class="icon" />
                  Show top-left now playing overlay
                </label>
              </div>
            )}

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
                onClick={() => {
                  setDraft(settingsRef.current);
                  setSettingsTab("general");
                  setCaptureTarget(null);
                  setSettingsOpen(false);
                }}
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
