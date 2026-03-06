import fs from "node:fs";
import fsp from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

import type { LogLineEvent } from "../../shared/types.js";

export interface LogTailerOptions {
  fromEnd: boolean;
  clearOnStartup: boolean;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  onLine: (event: LogLineEvent) => void;
  onError: (error: Error) => void;
}

export class LogTailer {
  private readonly filePath: string;
  private readonly options: LogTailerOptions;

  private timer: NodeJS.Timeout | null = null;
  private handle: FileHandle | null = null;
  private offset = 0;
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private polling = false;
  private stopped = false;
  private currentPollIntervalMs = 0;

  constructor(filePath: string, options: LogTailerOptions) {
    this.filePath = filePath;
    this.options = options;
  }

  async start(): Promise<void> {
    if (!fs.existsSync(this.filePath)) {
      throw new Error(`Console log does not exist: ${this.filePath}`);
    }

    this.stopped = false;
    this.currentPollIntervalMs = this.options.pollIntervalMs ?? 350;

    if (this.options.clearOnStartup) {
      await fsp.writeFile(this.filePath, "");
      this.offset = 0;
      this.pending = Buffer.alloc(0);
    } else if (this.options.fromEnd) {
      const stat = await fsp.stat(this.filePath);
      this.offset = stat.size;
    }

    this.scheduleNextPoll(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    await this.closeHandle();
    this.pending = Buffer.alloc(0);
    this.polling = false;
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.polling) {
      return;
    }

    this.polling = true;

    try {
      const stat = await fsp.stat(this.filePath);
      if (stat.size < this.offset) {
        this.offset = 0;
        this.pending = Buffer.alloc(0);
        await this.closeHandle();
      }

      if (stat.size === this.offset) {
        this.bumpPollInterval(false);
        return;
      }

      const readStart = this.offset;
      const readLength = stat.size - this.offset;
      const buffer = Buffer.allocUnsafe(readLength);
      const handle = await this.getHandle();
      const { bytesRead } = await handle.read(buffer, 0, readLength, readStart);
      const chunkBuffer = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
      const logicalStart = readStart - this.pending.length;
      const chunk: Buffer<ArrayBufferLike> =
        this.pending.length > 0 ? Buffer.concat([this.pending, chunkBuffer]) : chunkBuffer;

      this.consumeLines(chunk, logicalStart);
      this.offset = readStart + bytesRead;
      this.bumpPollInterval(bytesRead > 0);
    } catch (error) {
      await this.closeHandle();
      this.options.onError(error as Error);
    } finally {
      this.polling = false;
      if (!this.stopped) {
        this.scheduleNextPoll();
      }
    }
  }

  private consumeLines(chunk: Buffer<ArrayBufferLike>, chunkStartOffset: number): void {
    let startIndex = 0;

    for (let i = 0; i < chunk.length; i += 1) {
      if (chunk[i] !== 0x0a) {
        continue;
      }

      const lineStart = startIndex;
      const lineEnd = i > lineStart && chunk[i - 1] === 0x0d ? i - 1 : i;
      const lineBuffer = chunk.subarray(lineStart, lineEnd);
      const line = lineBuffer.toString("utf8");
      const offset = chunkStartOffset + lineStart;

      if (line.trim().length > 0) {
        this.options.onLine({ line, offset });
      }

      startIndex = i + 1;
    }

    this.pending = chunk.subarray(startIndex);
  }

  private scheduleNextPoll(delayMs = this.currentPollIntervalMs): void {
    if (this.stopped) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, delayMs);
  }

  private bumpPollInterval(sawData: boolean): void {
    const minInterval = this.options.pollIntervalMs ?? 350;
    const maxInterval = this.options.maxPollIntervalMs ?? 2000;

    this.currentPollIntervalMs = sawData
      ? minInterval
      : Math.min(maxInterval, Math.max(minInterval, this.currentPollIntervalMs * 2 || minInterval));
  }

  private async getHandle(): Promise<FileHandle> {
    if (!this.handle) {
      this.handle = await fsp.open(this.filePath, "r");
    }

    return this.handle;
  }

  private async closeHandle(): Promise<void> {
    if (!this.handle) {
      return;
    }

    try {
      await this.handle.close();
    } finally {
      this.handle = null;
    }
  }
}
