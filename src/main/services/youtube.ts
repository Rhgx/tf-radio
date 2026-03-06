import { createRequire } from "node:module";

import type { QueueItem } from "../../shared/types.js";

type YoutubeDlCallable = typeof import("youtube-dl-exec").default;

const require = createRequire(import.meta.url);
const ytdlp = require("youtube-dl-exec") as YoutubeDlCallable;

interface YtEntry {
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  webpage_url?: string;
  url?: string;
  thumbnail?: string;
  thumbnails?: Array<{ url?: string; preference?: number }>;
  entries?: YtEntry[];
  formats?: Array<{
    url?: string;
    acodec?: string;
    vcodec?: string;
    ext?: string;
    audio_ext?: string;
    protocol?: string;
  }>;
}

interface CachedTrackMetadata {
  sourceId: string;
  title: string;
  channel: string;
  durationSec: number | null;
  webpageUrl: string;
  streamUrl: string;
  thumbnailUrl: string | null;
}

const TRACK_CACHE_TTL_MS = 10 * 60 * 1000;
const trackCache = new Map<string, { at: number; value: CachedTrackMetadata }>();

const YOUTUBE_URL_PREFIX = "https://www.youtube.com/watch?v=";

export class TrackDurationLimitError extends Error {
  readonly code = "track_duration_limit";
  readonly maxDurationSec: number;

  constructor(maxDurationSec: number) {
    super(`Songs are too long for the current ${formatDuration(maxDurationSec)} limit.`);
    this.name = "TrackDurationLimitError";
    this.maxDurationSec = maxDurationSec;
  }
}

function extractEntry(raw: unknown): YtEntry | null {
  if (!raw) {
    return null;
  }

  let parsed = raw;
  if (typeof raw === "string") {
    parsed = JSON.parse(raw) as YtEntry;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const entry = parsed as YtEntry;
  if (Array.isArray(entry.entries) && entry.entries.length > 0) {
    return entry.entries[0] ?? null;
  }

  return entry;
}

function extractEntries(raw: unknown): YtEntry[] {
  if (!raw) {
    return [];
  }

  let parsed = raw;
  if (typeof raw === "string") {
    parsed = JSON.parse(raw) as YtEntry;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }

  const entry = parsed as YtEntry;
  if (Array.isArray(entry.entries)) {
    return entry.entries.filter((candidate) => typeof candidate === "object" && candidate !== null);
  }

  return [entry];
}

function pickStreamUrl(entry: YtEntry): string | null {
  if (Array.isArray(entry.formats)) {
    const ranked = entry.formats
      .filter((format) => Boolean(format.url))
      .sort((left, right) => scoreFormat(right) - scoreFormat(left));

    const best = ranked[0];
    if (best?.url) {
      return best.url;
    }
  }

  return entry.url ?? null;
}

function pickThumbnailUrl(entry: YtEntry): string | null {
  if (entry.thumbnail) {
    return entry.thumbnail;
  }

  if (Array.isArray(entry.thumbnails) && entry.thumbnails.length > 0) {
    const sorted = [...entry.thumbnails].sort((a, b) => (b.preference ?? 0) - (a.preference ?? 0));
    const first = sorted.find((item) => Boolean(item.url));
    if (first?.url) {
      return first.url;
    }
  }

  return null;
}

function looksLikeDirectYoutubeUrl(query: string): boolean {
  const trimmed = query.trim();
  return /^(https?:\/\/|www\.|(?:music\.)?youtube\.com\/|youtu\.be\/)/i.test(trimmed);
}

function formatDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function candidateSource(entry: YtEntry): string | null {
  if (entry.webpage_url) {
    return entry.webpage_url;
  }

  if (entry.id) {
    return `${YOUTUBE_URL_PREFIX}${entry.id}`;
  }

  return null;
}

function withinDurationLimit(durationSec: number | null, maxDurationSec: number): boolean {
  return typeof durationSec === "number" && durationSec <= maxDurationSec;
}

async function queryYtDlp(target: string, options?: { defaultSearch?: string }): Promise<unknown> {
  return ytdlp(target, {
    dumpSingleJson: true,
    noPlaylist: true,
    quiet: true,
    noWarnings: true,
    defaultSearch: options?.defaultSearch,
    skipDownload: true,
    preferFreeFormats: true
  });
}

function buildMetadata(entry: YtEntry, fallbackQuery: string): CachedTrackMetadata {
  const streamUrl = pickStreamUrl(entry);
  if (!streamUrl) {
    throw new Error("Could not resolve a playable stream URL from yt-dlp output.");
  }

  return {
    sourceId: entry.id ?? `${Date.now()}`,
    title: entry.title ?? fallbackQuery,
    channel: entry.channel ?? entry.uploader ?? "Unknown channel",
    durationSec: typeof entry.duration === "number" ? entry.duration : null,
    webpageUrl: entry.webpage_url ?? "",
    streamUrl,
    thumbnailUrl: pickThumbnailUrl(entry)
  };
}

async function resolveEntryFromSource(source: string): Promise<YtEntry | null> {
  const raw = await queryYtDlp(source);
  return extractEntry(raw);
}

async function resolveSearchTrack(query: string, maxDurationSec: number): Promise<CachedTrackMetadata> {
  const raw = await queryYtDlp(`ytsearch5:${query}`, { defaultSearch: "ytsearch5" });
  const entries = extractEntries(raw).slice(0, 5);
  if (entries.length === 0) {
    throw new Error("yt-dlp returned no result entry.");
  }

  let rejectedByDuration = false;

  for (const candidate of entries) {
    const initialDuration = typeof candidate.duration === "number" ? candidate.duration : null;
    if (initialDuration !== null && initialDuration > maxDurationSec) {
      rejectedByDuration = true;
      continue;
    }

    const source = candidateSource(candidate);
    if (!source) {
      continue;
    }

    const resolvedEntry = await resolveEntryFromSource(source);
    if (!resolvedEntry) {
      continue;
    }

    const resolvedDuration = typeof resolvedEntry.duration === "number" ? resolvedEntry.duration : null;
    if (!withinDurationLimit(resolvedDuration, maxDurationSec)) {
      rejectedByDuration = true;
      continue;
    }

    return buildMetadata(resolvedEntry, query);
  }

  if (rejectedByDuration) {
    throw new TrackDurationLimitError(maxDurationSec);
  }

  throw new Error("Could not resolve a playable stream URL from yt-dlp output.");
}

async function resolveDirectTrack(query: string, maxDurationSec: number): Promise<CachedTrackMetadata> {
  const entry = await resolveEntryFromSource(query);
  if (!entry) {
    throw new Error("yt-dlp returned no result entry.");
  }

  const durationSec = typeof entry.duration === "number" ? entry.duration : null;
  if (!withinDurationLimit(durationSec, maxDurationSec)) {
    throw new TrackDurationLimitError(maxDurationSec);
  }

  return buildMetadata(entry, query);
}

export async function resolveYoutubeTrack(
  query: string,
  requestedBy: string,
  maxDurationSec: number
): Promise<QueueItem> {
  const cacheKey = JSON.stringify([query.trim().toLowerCase(), Math.max(1, Math.floor(maxDurationSec))]);
  const cached = trackCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TRACK_CACHE_TTL_MS) {
    return buildQueueItem(cached.value, query, requestedBy);
  }

  const metadata = looksLikeDirectYoutubeUrl(query)
    ? await resolveDirectTrack(query, maxDurationSec)
    : await resolveSearchTrack(query, maxDurationSec);

  trackCache.set(cacheKey, { at: Date.now(), value: metadata });
  pruneTrackCache();
  return buildQueueItem(metadata, query, requestedBy);
}

function scoreFormat(format: NonNullable<YtEntry["formats"]>[number]): number {
  let score = 0;

  const audioCodec = format.acodec?.toLowerCase() ?? "";
  const videoCodec = format.vcodec?.toLowerCase() ?? "";
  const ext = format.ext?.toLowerCase() ?? "";
  const audioExt = format.audio_ext?.toLowerCase() ?? "";
  const protocol = format.protocol?.toLowerCase() ?? "";
  const audioOnly = audioCodec !== "" && audioCodec !== "none" && videoCodec === "none";

  if (audioOnly) {
    score += 100;
  }

  if (ext === "m4a" || audioExt === "m4a" || audioCodec.startsWith("mp4a")) {
    score += 40;
  } else if (audioCodec !== "" && audioCodec !== "none") {
    score += 20;
  }

  if (protocol.startsWith("http")) {
    score += 10;
  }

  return score;
}

function buildQueueItem(
  metadata: CachedTrackMetadata,
  query: string,
  requestedBy: string
): QueueItem {
  return {
    id: `${metadata.sourceId}-${Date.now()}`,
    requestedBy,
    query,
    title: metadata.title,
    channel: metadata.channel,
    durationSec: metadata.durationSec,
    webpageUrl: metadata.webpageUrl,
    streamUrl: metadata.streamUrl,
    thumbnailUrl: metadata.thumbnailUrl
  };
}

function pruneTrackCache(): void {
  const cutoff = Date.now() - TRACK_CACHE_TTL_MS;

  for (const [key, entry] of trackCache) {
    if (entry.at < cutoff) {
      trackCache.delete(key);
    }
  }
}
