import { clipboard, contextBridge, ipcRenderer } from "electron";

import { IPC_CHANNELS } from "./shared/ipc.js";
import type { AppState, AudioOutputDevice, QueueItem, Settings } from "./shared/types.js";

interface BootstrapPayload {
  settings: Settings;
  state: AppState;
  logs: string[];
}

interface SetupRconRequiredPayload {
  missingTokens: string[];
  currentLaunchOptions: string | null;
  launchOptionsFile: string | null;
  requiredLaunchOptions: string;
}

const api = {
  getSettings: (): Promise<BootstrapPayload> => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
  updateSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, patch),
  listAudioOutputDevices: (options?: { forceRefresh?: boolean }): Promise<AudioOutputDevice[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.listAudioOutputs, options ?? {}),
  startService: (): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke(IPC_CHANNELS.serviceStart),
  stopService: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC_CHANNELS.serviceStop),
  skipQueue: (): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke(IPC_CHANNELS.queueSkip),
  togglePausePlayback: (): Promise<{ ok: boolean; reason?: string; action?: "paused" | "resumed" }> =>
    ipcRenderer.invoke(IPC_CHANNELS.queuePauseToggle),
  stopQueue: (): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke(IPC_CHANNELS.queueStop),
  clearQueue: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC_CHANNELS.queueClear),
  addToQueue: (query: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.queueAdd, query),
  removeFromQueue: (id: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.queueRemove, id),
  copyText: (text: string): void => {
    clipboard.writeText(text);
  },
  onStateUpdate: (handler: (state: AppState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AppState) => handler(payload);
    ipcRenderer.on(IPC_CHANNELS.stateUpdate, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.stateUpdate, listener);
  },
  onPlaybackStart: (handler: (item: QueueItem) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: QueueItem) => handler(payload);
    ipcRenderer.on(IPC_CHANNELS.playbackStart, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.playbackStart, listener);
  },
  onPlaybackStop: (handler: () => void): (() => void) => {
    const listener = () => handler();
    ipcRenderer.on(IPC_CHANNELS.playbackStop, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.playbackStop, listener);
  },
  onPlaybackPause: (handler: () => void): (() => void) => {
    const listener = () => handler();
    ipcRenderer.on(IPC_CHANNELS.playbackPause, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.playbackPause, listener);
  },
  onPlaybackResume: (handler: () => void): (() => void) => {
    const listener = () => handler();
    ipcRenderer.on(IPC_CHANNELS.playbackResume, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.playbackResume, listener);
  },
  onSetupRconRequired: (handler: (payload: SetupRconRequiredPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SetupRconRequiredPayload) => handler(payload);
    ipcRenderer.on(IPC_CHANNELS.setupRconRequired, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.setupRconRequired, listener);
  },
  onLogAppend: (handler: (line: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, line: string) => handler(line);
    ipcRenderer.on(IPC_CHANNELS.logAppend, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.logAppend, listener);
  },
  notifyPlaybackReady: (): void => {
    ipcRenderer.send(IPC_CHANNELS.playbackReady);
  },
  notifyPlaybackEnded: (): void => {
    ipcRenderer.send(IPC_CHANNELS.playbackEnded);
  },
  notifyPlaybackError: (message: string): void => {
    ipcRenderer.send(IPC_CHANNELS.playbackError, message);
  }
};

contextBridge.exposeInMainWorld("tfRadio", api);

declare global {
  interface Window {
    tfRadio: typeof api;
  }
}
