export const IPC_CHANNELS = {
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  listAudioOutputs: "devices:list-audio-output",
  serviceStart: "service:start",
  serviceStop: "service:stop",
  queueSkip: "queue:skip",
  queueClear: "queue:clear",
  stateUpdate: "state:update",
  playbackStart: "playback:start",
  playbackStop: "playback:stop",
  setupRconRequired: "setup:rcon-required",
  playbackReady: "playback:ready",
  playbackEnded: "playback:ended",
  playbackError: "playback:error",
  logAppend: "log:append"
} as const;
