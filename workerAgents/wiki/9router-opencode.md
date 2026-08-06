# 9Router and OpenCode notes

Worker Agents can supervise 9Router as a local provider dashboard, OpenCode as an agent UI, and OpenWork as a headless web app backed by 9Router through managed OpenCode, and Agent Zero as a native Python UI backed by 9Router.

Default local ports:

- 9Router provider dashboard: `http://127.0.0.1:20127/dashboard/providers`
- 9Router OpenAI-compatible API: `http://127.0.0.1:20127/v1`

## Worker Agents launch notes

- Current 9Router runs from the repo root, not from an old `/opt/9router/.next/standalone` working directory.
- If `.next/standalone/server.js` is missing, build first with `npm run build`.
- Start the current standalone build with:

```bash
node .next/standalone/server.js
```

- On macOS, 9Router listener detection needs an `lsof`/`netstat` fallback; Linux-only `ss` checks can incorrectly report “not running”.
- OpenCode worker preset: starts near port `18924`
- OpenWork worker preset: starts near port `18945` for the web UI and uses the next port for its server. It passes `OPENAI_BASE_URL=http://127.0.0.1:20127/v1`, `OPENAI_API_KEY`, and `OPENCODE_MODEL=opencode/big-pickle` through to managed OpenCode, plus the current public host in `VITE_ALLOWED_HOSTS` for agentsweb access.
- Agent Zero worker preset: starts near port `18955`, clones `agent0ai/agent-zero` to `~/agent-zero`, creates `.venv`, installs `requirements.txt`, and runs `python run_ui.py` directly on the worker. It writes `~/agent-zero-usr/plugins/_model_config/presets.yaml` so chat and utility use 9Router at `http://127.0.0.1:20127/v1`; do not run this preset in Docker on workers.

Quick probe:

```sh
curl -sS http://127.0.0.1:20127/v1/models
```

Worker Agents seeds a no-key OpenAI-compatible Hugging Face endpoint into 9Router after health checks. The seed writes both `settings.requireLogin=false` and `settings.requireApiKey=false` (9Router 0.5.50 added `requireApiKey` as a separate gate, so disabling only `requireLogin` leaves chat and `/v1` returning `401` without a key):

- Provider prefix: `hf-free`
- Model: `hf-free/deepseek-ai/DeepSeek-V4-Flash-0731`
- Base URL: `https://q5dh1rfszfym23hj.us-east-2.aws.endpoints.huggingface.cloud/v1`

Probe it through 9Router:

```sh
curl -sS http://127.0.0.1:20127/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"hf-free/deepseek-ai/DeepSeek-V4-Flash-0731","messages":[{"role":"user","content":"hi"}],"max_tokens":16}'
```

If your 9Router binary uses a different command, override it when starting Worker Agents:

```sh
AGENT_CMD_OPENCLAW='openclaw gateway run --port {port}' npm start
AGENT_CMD_OPENWORK='cd ~/openwork && OPENWORK_REMOTE_ACCESS=1 OPENWORK_WEB_PORT={port} OPENWORK_PORT=18946 pnpm dev:headless-web' npm start
AGENT_CMD_AGENT_ZERO='cd ~/agent-zero && WEB_UI_HOST=127.0.0.1 WEB_UI_PORT={port} .venv/bin/python run_ui.py --host=127.0.0.1 --port={port}' npm start
```
