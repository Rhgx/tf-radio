import crypto from "node:crypto";
import { z } from "zod";
import Store from "electron-store";

import type { Rectangle } from "electron";
import type { Settings } from "../../shared/types.js";

interface PersistedShape {
  settings: Settings;
  windowBounds?: Rectangle;
}

const settingsPatchSchema = z
  .object({
    tf2Path: z.string().min(1).nullable(),
    consoleLogPath: z.string().min(1).nullable(),
    playerName: z.string().min(1),
    commandScope: z.enum(["self", "anyone"]),
    clearLogsOnStartup: z.boolean(),
    rconPort: z.number().int().min(1).max(65535),
    outputDeviceId: z.string().min(1).nullable(),
    mirrorToDefaultSpeaker: z.boolean(),
    inGameVolume: z.number().min(0).max(1),
    playbackVolume: z.number().min(0).max(1),
    maxAudioDurationSec: z.number().int().min(1).max(86400),
    maxTracksPerUser: z.number().int().min(1).max(20),
    minimizeToTray: z.boolean(),
    overlayEnabled: z.boolean(),
    chatSkipCommandEnabled: z.boolean(),
    chatPauseCommandEnabled: z.boolean(),
    chatStopCommandEnabled: z.boolean(),
    chatLinksEnabled: z.boolean(),
    skipShortcut: z.string().min(1).nullable(),
    pauseShortcut: z.string().min(1).nullable(),
    stopShortcut: z.string().min(1).nullable(),
    chatResponsesEnabled: z.boolean()
  })
  .strict()
  .partial();

function generatePassword(): string {
  return `tf2r_${crypto.randomBytes(10).toString("hex")}`;
}

function normalizeStoredVolume(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 1;
  }

  return Math.max(0, Math.min(1, value));
}

function normalizeStoredMaxAudioDurationSec(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value) || Number.isNaN(value)) {
    return 390;
  }

  return Math.max(1, Math.min(86400, value));
}

function defaults(): Settings {
  return {
    tf2Path: null,
    consoleLogPath: null,
    playerName: "unknown",
    commandPrefix: "?play",
    commandScope: "anyone",
    clearLogsOnStartup: false,
    rconHost: "127.0.0.1",
    rconPort: 21770,
    rconPassword: generatePassword(),
    outputDeviceId: null,
    mirrorToDefaultSpeaker: false,
    inGameVolume: 1,
    playbackVolume: 1,
    maxAudioDurationSec: 390,
    maxTracksPerUser: 1,
    minimizeToTray: true,
    overlayEnabled: false,
    chatSkipCommandEnabled: false,
    chatPauseCommandEnabled: false,
    chatStopCommandEnabled: false,
    chatLinksEnabled: true,
    skipShortcut: null,
    pauseShortcut: null,
    stopShortcut: null,
    chatResponsesEnabled: false
  };
}

export class SettingsService {
  private readonly store: Store<PersistedShape>;

  constructor() {
    this.store = new Store<PersistedShape>({
      name: "tf-radio-config",
      clearInvalidConfig: true,
      defaults: {
        settings: defaults()
      }
    });

    const existing = this.store.get("settings") as Settings & {
      botVolume?: number;
      inGameVolume?: number;
      playbackVolume?: number;
    };
    if (!existing.rconPassword || existing.rconPassword.length < 8) {
      existing.rconPassword = generatePassword();
      this.store.set("settings", existing);
    }

    if (typeof existing.chatResponsesEnabled !== "boolean") {
      existing.chatResponsesEnabled = false;
      this.store.set("settings", existing);
    }

    const legacyVolume = normalizeStoredVolume(existing.botVolume);

    if (typeof existing.inGameVolume !== "number" || Number.isNaN(existing.inGameVolume)) {
      existing.inGameVolume = legacyVolume;
      this.store.set("settings", existing);
    } else if (existing.inGameVolume < 0 || existing.inGameVolume > 1) {
      existing.inGameVolume = Math.max(0, Math.min(1, existing.inGameVolume));
      this.store.set("settings", existing);
    }

    if (typeof existing.playbackVolume !== "number" || Number.isNaN(existing.playbackVolume)) {
      existing.playbackVolume = legacyVolume;
      this.store.set("settings", existing);
    } else if (existing.playbackVolume < 0 || existing.playbackVolume > 1) {
      existing.playbackVolume = Math.max(0, Math.min(1, existing.playbackVolume));
      this.store.set("settings", existing);
    }

    if (!Number.isInteger(existing.maxAudioDurationSec)) {
      existing.maxAudioDurationSec = 390;
      this.store.set("settings", existing);
    } else if (existing.maxAudioDurationSec < 1 || existing.maxAudioDurationSec > 86400) {
      existing.maxAudioDurationSec = normalizeStoredMaxAudioDurationSec(existing.maxAudioDurationSec);
      this.store.set("settings", existing);
    }

    if (!Number.isInteger(existing.maxTracksPerUser)) {
      existing.maxTracksPerUser = 1;
      this.store.set("settings", existing);
    } else if (existing.maxTracksPerUser < 1 || existing.maxTracksPerUser > 20) {
      existing.maxTracksPerUser = Math.max(1, Math.min(20, existing.maxTracksPerUser));
      this.store.set("settings", existing);
    }

    if (typeof existing.minimizeToTray !== "boolean") {
      existing.minimizeToTray = true;
      this.store.set("settings", existing);
    }

    if (typeof existing.overlayEnabled !== "boolean") {
      existing.overlayEnabled = false;
      this.store.set("settings", existing);
    }

    if (typeof existing.chatSkipCommandEnabled !== "boolean") {
      existing.chatSkipCommandEnabled = false;
      this.store.set("settings", existing);
    }

    if (typeof existing.chatPauseCommandEnabled !== "boolean") {
      existing.chatPauseCommandEnabled = false;
      this.store.set("settings", existing);
    }

    if (typeof existing.chatStopCommandEnabled !== "boolean") {
      existing.chatStopCommandEnabled = false;
      this.store.set("settings", existing);
    }

    if (typeof existing.chatLinksEnabled !== "boolean") {
      existing.chatLinksEnabled = true;
      this.store.set("settings", existing);
    }

    if (typeof existing.skipShortcut !== "string" && existing.skipShortcut !== null) {
      existing.skipShortcut = null;
      this.store.set("settings", existing);
    } else if (typeof existing.skipShortcut === "string" && existing.skipShortcut.trim().length === 0) {
      existing.skipShortcut = null;
      this.store.set("settings", existing);
    }

    if (typeof existing.pauseShortcut !== "string" && existing.pauseShortcut !== null) {
      existing.pauseShortcut = null;
      this.store.set("settings", existing);
    } else if (typeof existing.pauseShortcut === "string" && existing.pauseShortcut.trim().length === 0) {
      existing.pauseShortcut = null;
      this.store.set("settings", existing);
    }

    if (typeof existing.stopShortcut !== "string" && existing.stopShortcut !== null) {
      existing.stopShortcut = null;
      this.store.set("settings", existing);
    } else if (typeof existing.stopShortcut === "string" && existing.stopShortcut.trim().length === 0) {
      existing.stopShortcut = null;
      this.store.set("settings", existing);
    }

    if ("botVolume" in existing) {
      const { botVolume: _botVolume, ...next } = existing;
      this.store.set("settings", next as Settings);
    }
  }

  getSettings(): Settings {
    return this.store.get("settings");
  }

  hydrateDetected(partial: Partial<Settings>): Settings {
    const current = this.getSettings();
    const merged: Settings = {
      ...current,
      ...partial,
      commandPrefix: "?play",
      rconHost: "127.0.0.1"
    };

    this.store.set("settings", merged);
    return merged;
  }

  updateSettings(patch: unknown): Settings {
    const validated = settingsPatchSchema.parse(patch);
    const current = this.getSettings();
    const next: Settings = {
      ...current,
      ...validated,
      commandPrefix: "?play",
      rconHost: "127.0.0.1",
      rconPassword: current.rconPassword
    };

    this.store.set("settings", next);
    return next;
  }

  getWindowBounds(): Rectangle | undefined {
    return this.store.get("windowBounds");
  }

  setWindowBounds(bounds: Rectangle): void {
    this.store.set("windowBounds", bounds);
  }
}
