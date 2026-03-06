import { createRequire } from "node:module";

interface RconClient {
  authenticate(password: string): Promise<boolean>;
  execute(command: string): Promise<string | boolean>;
  disconnect?: () => Promise<void> | void;
  close?: () => Promise<void> | void;
}

type RconConstructor = new (options: { host: string; port: number }) => RconClient;

const require = createRequire(import.meta.url);
const rconModule = require("rcon-srcds") as { default: RconConstructor };
const RCON = rconModule.default;

interface ConnectOptions {
  host: string;
  port: number;
  password: string;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class RconService {
  private client: RconClient | null = null;
  private options: ConnectOptions | null = null;

  async connectWithRetry(options: ConnectOptions, attempts = 6): Promise<void> {
    this.options = options;

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.connect(options);
        return;
      } catch (error) {
        lastError = error as Error;
        const delay = Math.min(500 * 2 ** (attempt - 1), 5000);
        await wait(delay);
      }
    }

    throw lastError ?? new Error("Unknown RCON connection failure");
  }

  private async connect(options: ConnectOptions): Promise<void> {
    await this.disconnect();

    const client = new RCON({ host: options.host, port: options.port });
    this.client = client;

    try {
      await client.authenticate(options.password);
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async execute(command: string): Promise<void> {
    if (!this.client) {
      throw new Error("RCON client is not connected.");
    }

    try {
      await this.client!.execute(command);
    } catch (error) {
      this.client = null;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      const closable = this.client as unknown as { disconnect?: () => void; close?: () => void };
      if (typeof closable.disconnect === "function") {
        closable.disconnect();
      } else if (typeof closable.close === "function") {
        closable.close();
      }
    } finally {
      this.client = null;
    }
  }
}
