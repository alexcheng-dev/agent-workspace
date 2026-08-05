# Worker Agents

A generic local control plane for launching and supervising agent UIs and worker processes.

Worker Agents was forked from the Hermes-on-Android console and stripped down to the reusable Node.js worker supervisor. It is no longer an Android project and does not include APK, Gradle, fastlane, Play Store, rootfs, Shizuku, or device-build workflows.

## What it does

- Starts named agent/workers from one web dashboard.
- Shows status, PID, port, URL, errors, and recent logs.
- Restarts workers without remembering long shell commands.
- Keeps built-in presets for Codex Web Local, OpenCode, OpenWork, Agent Zero, OpenClaw, 9Router, and Hermes WebUI when those tools are installed.
- Includes a vendored File Browser app that serves the entire filesystem from `/` through Windows Explorer, with `/browse/<path>` directory/file routing and `/edit/<path>` text editing.
- Lets you add arbitrary workers with environment variables or `workers.json`.

## Quick start

```bash
npm install
npm start
```

For a clean local 9Router bootstrap from scratch:

```bash
npm run start:clean-9router
```

That command also kills any stale local listener on port `20127` first, so an old deleted 9Router process cannot keep serving broken `500` responses.

For a clean local OpenCode reinstall/bootstrap from scratch:

```bash
npm run start:clean-opencode
```

That command kills any stale local listener on port `18924`, uninstalls the global `opencode-ai` package, removes local `~/.opencode` state, and then starts Worker Agents.

For a clean local reset of both 9Router and OpenCode before boot:

```bash
npm run start:clean-all
```

That command kills stale listeners on ports `20127` and `18924`, removes local 9Router/OpenCode state, uninstalls the global `opencode-ai` package, and then starts Worker Agents.


## Windows quick start

On a new Windows PC, run Worker Agents from PowerShell with the Windows launcher:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-windows.ps1
```

If Node/npm is already installed, this npm alias does the same thing:

```powershell
npm run start:windows
```

The launcher checks for Node.js 20+, npm, Git for Windows, Git Bash, and Python 3.11+. If any of those are missing and `winget` is available, it installs them automatically. It then refreshes `PATH`, runs `npm install`, and starts Worker Agents at:

```text
http://127.0.0.1:1456
```

Clean Windows starts are also available:

```powershell
npm run start:windows:clean-9router
npm run start:windows:clean-opencode
npm run start:windows:clean-all
```

Use `start:windows:clean-9router` when you want a fresh 9Router clone/build. Use `start:windows:clean-all` when both 9Router and OpenCode should be reset before boot.

On Windows, first launch of Hermes WebUI now uses the upstream non-interactive PowerShell installer automatically, then starts `hermes-webui/start.ps1`. OpenClaw is also auto-installed on first start through its npm package, so both should come up on a new Windows machine without manual package prep.

On Linux/macOS, Worker Agents now starts the Hermes gateway daemon before either supported Hermes WebUI launch path: the cloned `bootstrap.py` repo flow and the packaged `hermes-webui` binary flow. Leave `HERMES_WEBUI_START_GATEWAY=0` only if you intentionally want manual-only jobs with no scheduled ticks.


Open the console at:

```text
http://127.0.0.1:1456
```

Override the console port if needed:

```bash
PORT=3000 npm start
```

## Add your own workers

Create `workers.json` in the project root:

```json
[
  {
    "id": "my-agent",
    "name": "My Agent",
    "basePort": 19050,
    "path": "/",
    "command": "my-agent-web --host 127.0.0.1 --port {port}",
    "readyPatterns": ["listening", "http://127.0.0.1:"]
  }
]
```

Then restart the console. `{port}` is replaced with an available port starting at `basePort`.

You can also override built-in commands with environment variables:

```bash
AGENT_CMD_OPENCODE='opencode web --hostname 127.0.0.1 --port {port}' npm start
AGENT_CMD_OPENCLAW='openclaw gateway run --port {port}' npm start
AGENT_CMD_OPENWORK='cd ~/openwork && OPENWORK_REMOTE_ACCESS=1 OPENWORK_WEB_PORT={port} OPENWORK_PORT=18946 pnpm dev:headless-web' npm start
AGENT_CMD_AGENT_ZERO='cd ~/agent-zero && WEB_UI_HOST=127.0.0.1 WEB_UI_PORT={port} .venv/bin/python run_ui.py --host=127.0.0.1 --port={port}' npm start
AGENT_CMD_CODEX_WEB_LOCAL='codexui --port {port} --no-password --no-tunnel' npm start
AGENT_CMD_HERMES_WEBUI='hermes-webui --host 0.0.0.0 {port}' npm start
AGENT_CMD_FILEBROWSER='cd ./filebrowser && PORT={port} node server.js' npm start
```

OpenWork is cloned from `https://github.com/different-ai/openwork` on first start and runs `pnpm dev:headless-web` with OpenCode/OpenAI environment pointed at the local 9Router API (`http://127.0.0.1:20127/v1`). For public worker tunnels, Worker Agents also passes the current `*.agentsweb.space` host as `OPENWORK_PUBLIC_HOST`/`VITE_ALLOWED_HOSTS` so Vite serves the tunneled URL.

Agent Zero is cloned from `https://github.com/agent0ai/agent-zero`, runs directly from a local Python virtualenv with `python run_ui.py`, stores persistent state in `~/agent-zero-usr`, and writes a `_model_config` preset that points chat and utility models at 9Router through `http://127.0.0.1:20127/v1` with the default `opencode/big-pickle` model. Worker Agents does not run Agent Zero in Docker.

OpenClaw is exposed through the console proxy at `/proxy/openclaw/` so the browser talks to the Worker Agents origin while the upstream gateway sees `localhost`.

File Browser lives at [`workerAgents/filebrowser`](/Users/igor/Documents/sshworker/workerAgents/filebrowser) as the single canonical copy, so the standard worker deploy script uploads it to Linux workers. On first start, Worker Agents runs `npm install` in that directory and then serves the full filesystem at `/` with directory browsing at `/browse/<path>` and text editing at `/edit/<path>`. Set `STORAGE_DIR` in `AGENT_CMD_FILEBROWSER` to serve only a subtree.

## Project structure

```text
.
├── src/              # Node.js control plane and worker supervisor
├── public/           # Browser UI
├── scripts/          # Small local helper scripts
├── wiki/             # Operational notes
├── workers.json      # Optional local worker definitions, ignored by git
└── README.md
```

## Notes

This repository is intentionally generic. If a worker command exists on the machine, Worker Agents can supervise it. Android-specific project files and Android build instructions were removed from this fork.
