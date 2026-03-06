import crypto from "node:crypto";

import type { ParsedCommand, Settings } from "../../shared/types.js";

const CHAT_REGEX =
  /^(?:\*DEAD\*\s*)?(?:\((?:TEAM|Spectator)\)\s*)?(.+?)\s:\s{1,}(.*)$/i;

interface DedupEntry {
  key: string;
  at: number;
}

export class CommandParser {
  private readonly settingsProvider: () => Settings;
  private readonly dedupeWindowMs: number;
  private readonly dedupe: DedupEntry[] = [];

  constructor(settingsProvider: () => Settings, dedupeWindowMs = 10_000) {
    this.settingsProvider = settingsProvider;
    this.dedupeWindowMs = dedupeWindowMs;
  }

  parse(line: string, offset: number): ParsedCommand | null {
    const settings = this.settingsProvider();
    const match = line.match(CHAT_REGEX);

    if (!match) {
      return null;
    }

    const speaker = (match[1] ?? "").trim();
    const message = (match[2] ?? "").trim();
    const normalized = message.toLowerCase();

    if (settings.commandScope === "self") {
      if (speaker.toLowerCase() !== settings.playerName.toLowerCase()) {
        return null;
      }
    }

    if (normalized === "?skip") {
      if (!settings.chatSkipCommandEnabled) {
        return null;
      }
      return this.withDedupe({ speaker, kind: "skip" }, line, offset);
    }

    if (normalized === "?stop") {
      if (!settings.chatStopCommandEnabled) {
        return null;
      }
      return this.withDedupe({ speaker, kind: "stop" }, line, offset);
    }

    if (!normalized.startsWith(`${settings.commandPrefix} `)) {
      return null;
    }

    const query = message.slice(settings.commandPrefix.length).trim();
    if (!query) {
      return null;
    }

    return this.withDedupe({ speaker, kind: "play", query }, line, offset);
  }

  private withDedupe(command: ParsedCommand, line: string, offset: number): ParsedCommand | null {
    const hash = crypto.createHash("sha1").update(line).digest("hex");
    const key = `${offset}:${hash}`;
    const now = Date.now();

    this.prune(now);
    if (this.dedupe.some((entry) => entry.key === key)) {
      return null;
    }

    this.dedupe.push({ key, at: now });
    return command;
  }

  private prune(now: number): void {
    while (this.dedupe.length > 0) {
      const oldest = this.dedupe[0];
      if (!oldest || now - oldest.at <= this.dedupeWindowMs) {
        break;
      }

      this.dedupe.shift();
    }
  }
}
