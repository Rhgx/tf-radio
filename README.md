# TF2 Radio Bot

Electron app for Windows and Linux that listens to TF2 `console.log` for:

- `?play <youtube search query or link>`
- `?skip`
- `?pause`

It resolves tracks with `yt-dlp`, routes audio into your selected output device (VB-CABLE recommended), optionally mirrors audio to speakers, and toggles TF2 voice transmit via RCON (`+voicerecord` / `-voicerecord`).

## Requirements

- Windows 10/11 or a modern Linux desktop
- Team Fortress 2 installed through Steam
- `yt-dlp` and `ffmpeg` available on `PATH`
- A virtual audio cable / sink is recommended for mic injection
- TF2 launch options must include:

```text
-usercon +ip 0.0.0.0 +hostport 21770 +net_start +rcon_password <generated-in-app> +sv_rcon_whitelist_address 127.0.0.1 +con_logfile console.log
```

The app validates this and shows the exact required string in the UI.

## Install

```bash
npm install
```

## Run

```bash
npm start
```

## Build Windows Portable EXE (No Installer)

```bash
npm run dist:win
```

Output goes to `release/` and produces a standalone portable `.exe` (no installer).

If you want the unpacked app folder instead (debug packaging layout):

```bash
npm run dist:win:dir
```

## Build Linux Tarball

```bash
npm run dist:linux
```

Output goes to `release/` and produces a Linux `.tar.gz`.

If you want the unpacked Linux app folder instead:

```bash
npm run dist:linux:dir
```

If you want an AppImage specifically, build it on Linux (or Linux CI):

```bash
npm run dist:linux:appimage
```

## Notes

- Renderer UI is built with **Preact + Vite** (no React runtime).
- Service on/off is controlled by a power toggle in the top bar.
- Default command scope is `anyone` (any player messages can trigger playback).
- Queue mode is FIFO. Tracks can be added from the UI (search or YouTube link) or via `?play` in TF2 chat.
- Individual queue items can be removed from the UI.
- Per-user queue cap is configurable in Settings (default: `1`).
- `Clear logs upon startup` is disabled by default.
- `?skip` and `?pause` chat commands are disabled by default and can be enabled in Settings.
- Skip/Pause keyboard shortcuts are configurable in Settings with click-to-capture buttons (`Esc` cancels capture).
- Shortcuts are registered with Electron global shortcuts and work while the app is unfocused.
- Optional bot chat responses can be enabled in Settings (`say` over RCON).
- Bot playback volume is adjustable from the Settings modal.
- `Minimize/close to tray` is available from Settings (system tray icon support).
- Optional top-left now playing overlay with cover art/current/next song is available from Settings.
