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
    botVolume: z.number().min(0).max(1),
    maxTracksPerUser: z.number().int().min(1).max(20),
    minimizeToTray: z.boolean(),
    overlayEnabled: z.boolean(),
    chatSkipCommandEnabled: z.boolean(),
    chatPauseCommandEnabled: z.boolean(),
    chatStopCommandEnabled: z.boolean(),
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
    botVolume: 1,
    maxTracksPerUser: 1,
    minimizeToTray: true,
    overlayEnabled: false,
    chatSkipCommandEnabled: false,
    chatPauseCommandEnabled: false,
    chatStopCommandEnabled: false,
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

    const existing = this.store.get("settings");
    if (!existing.rconPassword || existing.rconPassword.length < 8) {
      existing.rconPassword = generatePassword();
      this.store.set("settings", existing);
    }

    if (typeof existing.chatResponsesEnabled !== "boolean") {
      existing.chatResponsesEnabled = false;
      this.store.set("settings", existing);
    }

    if (typeof existing.botVolume !== "number" || Number.isNaN(existing.botVolume)) {
      existing.botVolume = 1;
      this.store.set("settings", existing);
    } else if (existing.botVolume < 0 || existing.botVolume > 1) {
      existing.botVolume = Math.max(0, Math.min(1, existing.botVolume));
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
