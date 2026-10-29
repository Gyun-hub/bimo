<p align="center"><img src="build/icon.png" width="96" alt="Bimo"></p>

<h1 align="center">Bimo</h1>

<p align="center">A desktop app that lays out your AI coding CLI terminals on one board so you can run them side by side</p>

<p align="center"><a href="README.md">한국어</a> · English</p>

Run Claude Code, Codex and other AI CLIs across several projects at once and the terminal windows pile up fast. Bimo puts those terminals on an infinite board as cards and shows at a glance which session is working and which one has finished answering.

## Features

- **Board** — Place sessions as cards and drag them around. Minimap, zoom, auto-arrange by folder.
- **AI CLI detection** — Only the CLIs you have installed show up in the launcher.
  Claude Code · Codex · Gemini · Qwen Code · OpenCode · Aider · Cursor · Copilot · Amp (PowerShell is always available)
- **Status** — Working / answered / failed shown as card colors. A list of answers you haven't checked yet.
- **Resume sessions** — Drag an AI conversation you started in another terminal onto the board to continue it.
- **Project sidebar** — Group sessions by folder, set project colors, launch on a specific git branch.
- **Send** — Type `@session-name task` to send input straight to that session (`Ctrl+K`).
- **Session collaboration (MCP)** — Sessions connected with a cable can talk to each other through Claude. The app attaches a `bimo` MCP server (`list_sessions`, `send_to_session`). Connections use `127.0.0.1` and a token generated fresh on every launch.
- **File viewer** — Find and open files inside the board, with Markdown preview.
- **Terminal conveniences** — Paste screenshots, open OSC 8 links, drag-select even in mouse-mode apps.
- **Auto update** — Downloads new versions from GitHub Releases.

## Install

Download from [Releases](https://github.com/Gyun-hub/bimo/releases).

| OS | File |
|---|---|
| Windows (x64) | `Bimo-Setup-<version>.exe` |
| macOS (Apple Silicon / Intel) | `.dmg` |

- The Windows installer is not code-signed, so SmartScreen shows a warning. Click "More info → Run anyway".
- The macOS build is not signed or notarized either. The first time, right-click → Open. Auto update does not work on macOS.

Install the AI CLIs separately (for example `npm i -g @anthropic-ai/claude-code`). Bimo finds and uses the CLIs on your PATH.

## Data

| Location | Contents |
|---|---|
| `%APPDATA%\Bimo\board.json` (Windows) / `~/Library/Application Support/Bimo` (macOS) | Board layout and sessions |
| `Local Storage` in the same folder | Settings |

You can change the data folder with the `BIMO_USER_DATA` environment variable (for example to keep a separate test board).

## Development

Built against Node.js 22.

```bash
npm install
npm start                 # run in development
npm run smoke             # launch with the default board, take a screenshot (%TEMP%\bimo-smoke.png) and quit
npm run dist:win          # Windows installer → release/
npm run dist:mac          # macOS dmg/zip (on macOS)
```

The icon is drawn as 16×16 pixel art by `tools/make-icon.py` (requires Pillow).

```bash
python -I tools/make-icon.py   # build/icon.png · icon.ico · icon.icns
```

### Releases

Bump `version` in `package.json` and merge into `main`. `.github/workflows/release.yml` then builds the Windows and Mac installers and publishes them as the `v<version>` Release. If a Release for that version already exists, the build is skipped.

### Stack

Electron · xterm.js · node-pty (`@lydell/node-pty`) · CodeMirror 5 · marked + DOMPurify · electron-builder · electron-updater

## License

[MIT](LICENSE)
