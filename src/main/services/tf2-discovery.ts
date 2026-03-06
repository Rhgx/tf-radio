import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { Settings } from "../../shared/types.js";

export interface Tf2DiscoveryResult {
  tf2Path: string | null;
  consoleLogPath: string | null;
  playerName: string | null;
  steamRoots: string[];
}

export interface LaunchOptionsValidationResult {
  isValid: boolean;
  currentLaunchOptions: string | null;
  launchOptionsFile: string | null;
  missingTokens: string[];
  requiredLaunchOptions: string;
}

const execFileAsync = promisify(execFile);

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of paths) {
    const normalized = path.normalize(value);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }

  return out;
}

function getDefaultSteamRoots(): string[] {
  if (process.platform === "win32") {
    return [
      path.join(process.env["ProgramFiles(x86)"] ?? "", "Steam"),
      path.join(process.env.ProgramFiles ?? "", "Steam"),
      path.join(os.homedir(), "AppData", "Local", "Steam")
    ].filter(Boolean);
  }

  if (process.platform === "linux") {
    const xdgDataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");

    return [
      path.join(xdgDataHome, "Steam"),
      path.join(os.homedir(), ".steam", "steam"),
      path.join(os.homedir(), ".steam", "root"),
      path.join(
        os.homedir(),
        ".var",
        "app",
        "com.valvesoftware.Steam",
        ".local",
        "share",
        "Steam"
      )
    ].filter(Boolean);
  }

  return [];
}

async function getWindowsSteamRootsFromRegistry(): Promise<string[]> {
  if (process.platform !== "win32") {
    return [];
  }

  const queries: Array<{ key: string; value: string }> = [
    { key: "HKCU\\Software\\Valve\\Steam", value: "SteamPath" },
    { key: "HKCU\\Software\\Valve\\Steam", value: "SteamExe" },
    { key: "HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", value: "InstallPath" },
    { key: "HKLM\\SOFTWARE\\Valve\\Steam", value: "InstallPath" }
  ];
  const roots = new Set<string>();

  for (const query of queries) {
    try {
      const { stdout } = await execFileAsync("reg.exe", ["query", query.key, "/v", query.value], {
        windowsHide: true
      });
      const match = stdout.match(new RegExp(`${query.value}\\s+REG_\\w+\\s+(.+)$`, "mi"));
      const value = match?.[1]?.trim();
      if (!value) {
        continue;
      }

      const normalized =
        query.value === "SteamExe" ? path.dirname(value.replace(/^"|"$/g, "")) : value.replace(/^"|"$/g, "");
      if (normalized) {
        roots.add(normalized);
      }
    } catch {
      // Fall back to known default locations if the registry query fails.
    }
  }

  return [...roots];
}

function decodeVdfPath(value: string): string {
  return value.replace(/\\\\/g, "\\");
}

function countChar(str: string, char: string): number {
  let total = 0;
  for (const c of str) {
    if (c === char) {
      total += 1;
    }
  }
  return total;
}

async function findTf2ByLibraryManifest(steamRoots: string[]): Promise<string | null> {
  for (const steamRoot of steamRoots) {
    const libraryFolders = path.join(steamRoot, "steamapps", "libraryfolders.vdf");
    if (!fs.existsSync(libraryFolders)) {
      continue;
    }

    const content = await fsp.readFile(libraryFolders, "utf8");
    const libraries = new Set<string>([steamRoot]);

    const regex = /"path"\s+"([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      if (match[1]) {
        libraries.add(decodeVdfPath(match[1]));
      }
    }

    for (const libraryPath of libraries) {
      const manifestPath = path.join(libraryPath, "steamapps", "appmanifest_440.acf");
      if (!fs.existsSync(manifestPath)) {
        continue;
      }

      const manifest = await fsp.readFile(manifestPath, "utf8");
      const dirMatch = manifest.match(/"installdir"\s+"([^"]+)"/);
      if (!dirMatch) {
        continue;
      }

      const installDir = dirMatch[1];
      if (!installDir) {
        continue;
      }

      const candidate = path.join(libraryPath, "steamapps", "common", installDir);
      if (fs.existsSync(path.join(candidate, "tf", "gameinfo.txt"))) {
        return candidate;
      }
    }
  }

  return null;
}

async function detectPlayerName(tf2Path: string | null): Promise<string | null> {
  if (!tf2Path) {
    return null;
  }

  const cfgPath = path.join(tf2Path, "tf", "cfg", "config.cfg");
  if (!fs.existsSync(cfgPath)) {
    return null;
  }

  const content = await fsp.readFile(cfgPath, "utf8");
  const match = content.match(/^name\s+"([^"]+)"/m);
  return match?.[1] ?? null;
}

export async function discoverTf2Context(): Promise<Tf2DiscoveryResult> {
  const registryRoots = await getWindowsSteamRootsFromRegistry();
  const steamRoots = uniquePaths(
    [...registryRoots, ...getDefaultSteamRoots()].filter((value): value is string => Boolean(value))
  );

  const tf2Path = await findTf2ByLibraryManifest(steamRoots);

  const consoleLogPath = tf2Path ? path.join(tf2Path, "tf", "console.log") : null;
  const playerName = await detectPlayerName(tf2Path);

  return {
    tf2Path,
    consoleLogPath,
    playerName,
    steamRoots
  };
}

function extractLaunchOptionsFromFile(content: string): string | null {
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const markerLine = lines[i] ?? "";
    if (!/^\s*"440"\s*$/.test(markerLine)) {
      continue;
    }

    let openBraceSeen = false;
    let depth = 0;

    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j] ?? "";
      depth += countChar(line, "{");
      depth -= countChar(line, "}");

      if (countChar(line, "{") > 0) {
        openBraceSeen = true;
      }

      const launchMatch = line.match(/"LaunchOptions"\s+"([^"]*)"/);
      if (launchMatch) {
        return launchMatch[1] ?? null;
      }

      if (openBraceSeen && depth <= 0) {
        break;
      }
    }
  }

  return null;
}

export async function findCurrentLaunchOptions(
  steamRoots: string[]
): Promise<{ launchOptions: string | null; filePath: string | null }> {
  for (const steamRoot of steamRoots) {
    const userdataDir = path.join(steamRoot, "userdata");
    if (!fs.existsSync(userdataDir)) {
      continue;
    }

    const userDirs = await fsp.readdir(userdataDir, { withFileTypes: true });
    for (const dirent of userDirs) {
      if (!dirent.isDirectory()) {
        continue;
      }

      const localConfig = path.join(userdataDir, dirent.name, "config", "localconfig.vdf");
      if (!fs.existsSync(localConfig)) {
        continue;
      }

      const content = await fsp.readFile(localConfig, "utf8");
      const launchOptions = extractLaunchOptionsFromFile(content);

      if (launchOptions !== null) {
        return { launchOptions, filePath: localConfig };
      }
    }
  }

  return { launchOptions: null, filePath: null };
}

export function buildRequiredLaunchOptions(settings: Settings): string {
  return `-usercon +ip 0.0.0.0 +hostport ${settings.rconPort} +net_start +rcon_password ${settings.rconPassword} +sv_rcon_whitelist_address 127.0.0.1 +con_logfile console.log`;
}

export function resolveRconPort(settings: Settings, launchOptions: string | null): number {
  const portPatterns = [/\+hostport\s+(\d+)/i, /-port\s+(\d+)/i, /\+clientport\s+(\d+)/i];

  for (const pattern of portPatterns) {
    const match = launchOptions?.match(pattern);
    const parsed = Number(match?.[1]);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
      return parsed;
    }
  }

  // Older app builds defaulted to 21770. If no port is specified in TF2 launch options,
  // use Source's default RCON port instead of a stale persisted value.
  if (settings.rconPort === 21770) {
    return 27015;
  }

  return settings.rconPort;
}

export function validateLaunchOptions(settings: Settings, launchOptions: string | null): string[] {
  const missing: string[] = [];
  const normalized = (launchOptions ?? "").toLowerCase();

  const requiredTokens = [
    "-usercon",
    "+ip 0.0.0.0",
    `+hostport ${settings.rconPort}`,
    "+net_start",
    "+sv_rcon_whitelist_address 127.0.0.1",
    "+con_logfile console.log"
  ];

  for (const token of requiredTokens) {
    if (!normalized.includes(token)) {
      missing.push(token);
    }
  }

  const pwdMatch = launchOptions?.match(/\+rcon_password\s+("[^"]+"|\S+)/i);
  const suppliedPwd = pwdMatch?.[1]?.replace(/^"|"$/g, "");

  if (!suppliedPwd) {
    missing.push("+rcon_password <generated>");
  } else if (suppliedPwd !== settings.rconPassword) {
    missing.push("+rcon_password (must match generated password in app)");
  }

  return missing;
}

export async function validateRconLaunchOptions(
  settings: Settings,
  steamRoots: string[]
): Promise<LaunchOptionsValidationResult> {
  const current = await findCurrentLaunchOptions(steamRoots);
  const missingTokens = validateLaunchOptions(settings, current.launchOptions);

  return {
    isValid: missingTokens.length === 0,
    currentLaunchOptions: current.launchOptions,
    launchOptionsFile: current.filePath,
    missingTokens,
    requiredLaunchOptions: buildRequiredLaunchOptions(settings)
  };
}
