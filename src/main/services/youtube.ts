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

export async function resolveYoutubeTrack(query: string, requestedBy: string): Promise<QueueItem> {
  const cacheKey = query.trim().toLowerCase();
  const cached = trackCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TRACK_CACHE_TTL_MS) {
    return buildQueueItem(cached.value, query, requestedBy);
  }

  const raw = await ytdlp(`ytsearch1:${query}`, {
    dumpSingleJson: true,
    noPlaylist: true,
    quiet: true,
    noWarnings: true,
    defaultSearch: "ytsearch1",
    skipDownload: true,
    preferFreeFormats: true
  });

  const entry = extractEntry(raw);
  if (!entry) {
    throw new Error("yt-dlp returned no result entry.");
  }

  const streamUrl = pickStreamUrl(entry);
  if (!streamUrl) {
    throw new Error("Could not resolve a playable stream URL from yt-dlp output.");
  }

  const metadata: CachedTrackMetadata = {
    sourceId: entry.id ?? `${Date.now()}`,
    title: entry.title ?? query,
    channel: entry.channel ?? entry.uploader ?? "Unknown channel",
    durationSec: typeof entry.duration === "number" ? entry.duration : null,
    webpageUrl: entry.webpage_url ?? "",
    streamUrl,
    thumbnailUrl: pickThumbnailUrl(entry)
  };

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
