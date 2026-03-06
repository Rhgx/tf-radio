import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

import type { AppState } from "./types";
import "./overlay.css";

function initialState(): AppState {
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

function formatTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}:${String(rem).padStart(2, "0")}`;
}

function OverlayApp() {
  const [state, setState] = useState<AppState>(initialState());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let mounted = true;
    let unsubscribe = () => {};

    void (async () => {
      const payload = await window.tfRadio.getSettings();
      if (!mounted) {
        return;
      }

      setState(payload.state);
      unsubscribe = window.tfRadio.onStateUpdate((nextState) => {
        if (mounted) {
          setState(nextState);
        }
      });
    })();

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTick((current) => current + 1);
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  const current = state.current;
  const next = useMemo(() => {
    if (state.queue.length === 0) {
      return null;
    }

    if (!current) {
      return state.queue[0] ?? null;
    }

    return state.queue.length > 1 ? state.queue[1] : null;
  }, [current, state.queue]);

  const coverUrl = current?.thumbnailUrl ?? "";
  const elapsedSec = useMemo(() => {
    if (!current || !state.playbackStartedAt || state.playback !== "playing") {
      return 0;
    }

    return Math.max(0, Math.floor((Date.now() - state.playbackStartedAt) / 1000));
  }, [current, state.playback, state.playbackStartedAt, tick]);
  const durationSec = current?.durationSec ?? null;
  const clampedElapsedSec =
    typeof durationSec === "number" ? Math.min(elapsedSec, Math.max(0, durationSec)) : elapsedSec;
  const progressPercent =
    typeof durationSec === "number" && durationSec > 0
      ? Math.min(100, (clampedElapsedSec / durationSec) * 100)
      : 0;

  return (
    <div class="overlay-shell">
      <div class="cover-wrap">
        {coverUrl ? (
          <img src={coverUrl} alt={current?.title ?? "Cover"} class="cover" />
        ) : (
          <div class="cover placeholder">TF2</div>
        )}
      </div>
      <div class="meta">
        <div class="line now-label">Now Playing</div>
        <div class="line title">{current?.title ?? "No song playing"}</div>
        <div class="line author">{current?.channel ?? "Idle"}</div>
        <div class="line timing">
          {formatTime(clampedElapsedSec)} / {typeof durationSec === "number" ? formatTime(durationSec) : "--:--"}
        </div>
        <div class="progress-track" role="presentation" aria-hidden="true">
          <div class="progress-fill" style={{ width: `${progressPercent}%` }} />
        </div>
        <div class="line next">
          Next: {next ? `${next.title} - ${next.channel}` : "Queue empty"}
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById("overlay");
if (!root) {
  throw new Error("Overlay root not found.");
}

render(<OverlayApp />, root);
