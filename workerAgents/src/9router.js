import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { config, defaultPath, shellBin } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTER_GIT_URL = process.env.ROUTER_GIT_URL || 'https://github.com/decolua/9router.git';
const DEFAULT_HOME = process.env.HOME || process.env.USERPROFILE || (process.getuid?.() === 0 ? '/root' : '/tmp');
const ROUTER_HOME = process.env.WORKER_AGENTS_9ROUTER_DIR || path.join(DEFAULT_HOME, '9router');
const ROUTER_LOG_PATH = '/tmp/9router.log';
const ROUTER_PORT = Number.parseInt(process.env.WORKER_AGENTS_9ROUTER_PORT || '20127', 10);
const ROUTER_API_KEY = process.env.WORKER_AGENTS_9ROUTER_API_KEY || 'local-dev-key';
const ROUTER_MODEL = process.env.WORKER_AGENTS_9ROUTER_MODEL || 'opencode/big-pickle';
const OPEN_ACCESS_PATCH_MARK = 'sshworker: open remote LLM API access when requireApiKey=false';
const OPEN_ACCESS_PATCH_SCRIPT = path.join(__dirname, '..', 'scripts', 'patch-9router-dashboard-guard.mjs');
const HF_ENDPOINT_PROVIDER_NAME = process.env.WORKER_AGENTS_HF_ENDPOINT_PROVIDER_NAME || 'HF DeepSeek V4 Flash';
const HF_ENDPOINT_PROVIDER_PREFIX = process.env.WORKER_AGENTS_HF_ENDPOINT_PROVIDER_PREFIX || 'hf-free';
const HF_ENDPOINT_PROVIDER_ID = process.env.WORKER_AGENTS_HF_ENDPOINT_PROVIDER_ID || `openai-compatible-chat-${HF_ENDPOINT_PROVIDER_PREFIX}`;
const HF_ENDPOINT_CONNECTION_ID = process.env.WORKER_AGENTS_HF_ENDPOINT_CONNECTION_ID || 'worker-agents-hf-endpoint';
const HF_ENDPOINT_BASE_URL = process.env.WORKER_AGENTS_HF_ENDPOINT_BASE_URL || 'https://q5dh1rfszfym23hj.us-east-2.aws.endpoints.huggingface.cloud/v1';
const HF_ENDPOINT_MODEL = process.env.WORKER_AGENTS_HF_ENDPOINT_MODEL || 'deepseek-ai/DeepSeek-V4-Flash-0731';
const HF_ENDPOINT_API_KEY = process.env.WORKER_AGENTS_HF_ENDPOINT_API_KEY || 'no-api-key';
const HEALTH_TIMEOUT_MS = Number.parseInt(process.env.ROUTER_HEALTH_TIMEOUT_MS || '120000', 10);
const HEALTH_POLL_MS = 2000;
let startupPromise = null;
let startupState = 'idle';
let startupError = '';
let providerSeedPromise = null;
let providerSeeded = false;
let providerSeedFailed = false;


function nextBuildArtifacts() {
  return [
    path.join(ROUTER_HOME, '.next', 'BUILD_ID'),
    path.join(ROUTER_HOME, '.next', 'routes-manifest.json'),
    path.join(ROUTER_HOME, '.next', 'prerender-manifest.json'),
  ];
}

function hasCompleteRouterBuild() {
  return nextBuildArtifacts().every((file) => fs.existsSync(file));
}

function clearRouterBuildOutput() {
  fs.rmSync(path.join(ROUTER_HOME, '.next'), { recursive: true, force: true });
}

function execText(command) {
  try {
    return execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60000,
      env: { ...process.env, PATH: defaultPath }
    });
  } catch {
    return '';
  }
}

function execPowerShell(command) {
  try {
    return execSync(`powershell.exe -NoProfile -Command ${JSON.stringify(command)}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60000,
      env: { ...process.env, PATH: defaultPath }
    });
  } catch {
    return '';
  }
}

function execPowerShellStrict(command) {
  return execSync(`powershell.exe -NoProfile -Command ${JSON.stringify(command)}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 600000,
    env: { ...process.env, PATH: defaultPath }
  });
}

function hasCommand(command) {
  try {
    const executable = process.platform === 'win32' ? 'where.exe' : '/bin/sh';
    const args = process.platform === 'win32' ? [command] : ['-c', `command -v "$1"`, 'sh', command];
    execFileSync(executable, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      env: { ...process.env, PATH: defaultPath },
    });
    return true;
  } catch {
    return false;
  }
}

function findRouterPackagePath() {
  const candidates = [
    path.join(DEFAULT_HOME, '.local', 'lib', 'node_modules', '9router'),
    '/usr/local/lib/node_modules/9router',
    '/usr/lib/node_modules/9router',
    ROUTER_HOME,
    process.env.HOME ? path.join(process.env.HOME, '9router') : '',
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '9router') : '',
    '/root/9router',
    path.join('/tmp', '9router'),
  ].filter(Boolean);
  const packagePath = candidates
    .map((candidate) => path.join(candidate, 'package.json'))
    .find((candidate) => fs.existsSync(candidate));
  if (!packagePath) {
    throw new Error(`9Router package.json not found in ${candidates.join(', ')}`);
  }
  return packagePath;
}

function findListenerForPort(port) {
  if (process.platform === 'win32') {
    const ps = [
      `$conn = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`,
      'if ($conn) { Write-Output $conn }'
    ].join('; ');
    const out = execPowerShell(ps).trim();
    if (out) {
      const pid = Number.parseInt(out, 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  }
  const listenerCommand = process.platform === 'win32' ? 'netstat -ano' : 'ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || true';
  const portPattern = new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\*|localhost|\\[::\\]|::|:::|\\.)[:.]${port}(?:\\b|\\s)`);
  const listenerRows = execText(listenerCommand).split('\n').filter(Boolean);
  for (const line of listenerRows) {
    if (!portPattern.test(line)) continue;
    if (!/LISTEN|LISTENING/i.test(line)) continue;
    const match = line.match(/pid=(\d+)/) || line.match(/\s(\d+)\/\S+/) || line.match(/\s(\d+)\s*$/);
    return match ? Number.parseInt(match[1], 10) : -1;
  }
  const lsofRows = execText(`lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null || true`).split('\n').filter(Boolean);
  if (lsofRows.length > 1) {
    const match = lsofRows[1].match(/^\S+\s+(\d+)\s/);
    return match ? Number.parseInt(match[1], 10) : null;
  }
  return null;
}

function killExistingListeners() {
  const pid = findListenerForPort(ROUTER_PORT);
  if (pid && pid > 0) {
    if (process.platform === 'win32') {
      execText(`taskkill /F /PID ${pid} /T`);
    } else {
      execText(`kill ${pid} 2>/dev/null || true`);
      execText(`sleep 1`);
    }
  }
  return pid && pid > 0 ? pid : null;
}

async function relaunchRouterAfterProviderSeed(log) {
  if (log) log('[9router] Restarting to load seeded provider');
  killExistingListeners();
  const logFd = fs.openSync(ROUTER_LOG_PATH, 'a');
  let child;
  if (process.platform === 'win32') {
    child = launchWindowsStandalone(logFd);
  } else {
    child = spawn(shellBin, ['-lc', buildLaunchCommand()], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, PATH: defaultPath },
    });
  }
  child.unref();
  fs.closeSync(logFd);
  const healthy = await waitForHealth();
  if (!healthy) {
    throw new Error(`9Router provider reload failed after ${HEALTH_TIMEOUT_MS / 1000}s`);
  }
  if (log) log('[9router] Provider reload complete');
}

async function ensureHfEndpointProviderLoaded(log) {
  const seeded = await ensureHfEndpointProvider(log);
  if (seeded) {
    await relaunchRouterAfterProviderSeed(log);
  }
  return seeded;
}

async function ensureRepo(log) {
  if (fs.existsSync(path.join(ROUTER_HOME, 'package.json'))) {
    if (log) log('[9router] Repo already exists');
    return false;
  }
  if (log) log(`[9router] Cloning ${ROUTER_GIT_URL}...`);
  if (process.platform === 'win32') {
    execPowerShellStrict([
      '$ErrorActionPreference = "Stop"',
      `if (Test-Path ${JSON.stringify(ROUTER_HOME)}) { Remove-Item -Recurse -Force ${JSON.stringify(ROUTER_HOME)} }`,
      `git clone --depth 1 ${JSON.stringify(ROUTER_GIT_URL)} ${JSON.stringify(ROUTER_HOME)}`
    ].join('; '));
  } else {
    execSync(`rm -rf "${ROUTER_HOME}" && git clone --depth 1 "${ROUTER_GIT_URL}" "${ROUTER_HOME}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
      env: { ...process.env, PATH: defaultPath },
    });
  }
  if (log) log('[9router] Clone complete');
  patchRouterDashboardGuard(log);
  return true;
}

function patchRouterDashboardGuard(log) {
  const guardPath = path.join(ROUTER_HOME, 'src', 'dashboardGuard.js');
  if (!fs.existsSync(guardPath)) {
    if (log) log('[9router] dashboardGuard.js not found, skipping open-access patch');
    return false;
  }
  let source = fs.readFileSync(guardPath, 'utf8');
  if (source.includes(OPEN_ACCESS_PATCH_MARK)) {
    if (log) log('[9router] dashboardGuard.js already open-access patched');
    return false;
  }
  const needle = `async function canAccessPublicLlmApi(request) {
  if (isLocalRequest(request)) return true;
  if (await hasValidCliToken(request)) return true;
  return await hasValidApiKey(request);
}`;
  if (!source.includes(needle)) {
    if (log) log('[9router] canAccessPublicLlmApi shape changed, skipping open-access patch');
    return false;
  }
  const replacement = `async function canAccessPublicLlmApi(request) {
  if (isLocalRequest(request)) return true;
  if (await hasValidCliToken(request)) return true;
  // ${OPEN_ACCESS_PATCH_MARK}
  const settings = await loadSettings();
  if (settings && settings.requireApiKey === false) return true;
  return await hasValidApiKey(request);
}`;
  fs.writeFileSync(guardPath, source.replace(needle, replacement));
  if (log) log('[9router] Patched dashboardGuard.js for open remote API access');
  return true;
}

async function ensureBuilt(log) {
  const standaloneServer = path.join(ROUTER_HOME, '.next', 'standalone', 'server.js');
  if (fs.existsSync(standaloneServer) || hasCompleteRouterBuild()) {
    if (log) log('[9router] Already built');
    return false;
  }
  patchRouterDashboardGuard(log);
  if (fs.existsSync(path.join(ROUTER_HOME, '.next'))) {
    if (log) log('[9router] Incomplete build output detected, cleaning .next before rebuild...');
    clearRouterBuildOutput();
  }
  if (log) log('[9router] Building...');
  if (process.platform === 'win32') {
    execPowerShellStrict([
      '$ErrorActionPreference = "Stop"',
      `Push-Location ${JSON.stringify(ROUTER_HOME)}`,
      'try { npm install; npm run build } finally { Pop-Location }'
    ].join('; '));
  } else {
    const buildCmd = `cd "${ROUTER_HOME}" && npm install && npm run build`;
    execSync(buildCmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000,
      env: { ...process.env, PATH: defaultPath },
    });
  }
  if (log) log('[9router] Build complete');
  if (!fs.existsSync(standaloneServer) && !hasCompleteRouterBuild()) {
    throw new Error('9Router build finished without a complete Next build output');
  }
  return true;
}

function resolveRouterLaunch() {
  const standaloneDir = path.join(ROUTER_HOME, '.next', 'standalone');
  const standaloneServer = path.join(standaloneDir, 'server.js');
  if (fs.existsSync(standaloneServer)) {
    return { mode: 'standalone', cwd: standaloneDir, args: ['server.js'] };
  }
  if (hasCompleteRouterBuild()) {
    return {
      mode: 'next-start',
      cwd: ROUTER_HOME,
      args: [
        path.join(ROUTER_HOME, 'node_modules', 'next', 'dist', 'bin', 'next'),
        'start',
        '--port',
        String(ROUTER_PORT),
        '--hostname',
        '127.0.0.1'
      ]
    };
  }
  throw new Error('9Router build output missing: no standalone server.js and no complete .next build');
}

function launchWindowsStandalone(logFd) {
  const launch = resolveRouterLaunch();
  const standaloneDir = path.join(ROUTER_HOME, '.next', 'standalone');
  const staticSrc = path.join(ROUTER_HOME, '.next', 'static');
  const staticDst = path.join(standaloneDir, '.next', 'static');
  const publicSrc = path.join(ROUTER_HOME, 'public');
  const publicDst = path.join(standaloneDir, 'public');
  const dataDir = path.join(process.env.HOME || process.env.USERPROFILE || 'C:\\Users\\Public', '.9router', 'data');
  if (launch.mode === 'standalone') {
    fs.mkdirSync(path.dirname(staticDst), { recursive: true });
    fs.rmSync(staticDst, { recursive: true, force: true });
    fs.rmSync(publicDst, { recursive: true, force: true });
    if (fs.existsSync(staticSrc)) fs.cpSync(staticSrc, staticDst, { recursive: true });
    if (fs.existsSync(publicSrc)) fs.cpSync(publicSrc, publicDst, { recursive: true });
  }
  fs.mkdirSync(dataDir, { recursive: true });
  return spawn('C:\\Program Files\\nodejs\\node.exe', launch.args, {
    cwd: launch.cwd,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      PATH: defaultPath,
      NODE_ENV: 'production',
      PORT: String(ROUTER_PORT),
      HOSTNAME: '127.0.0.1',
      NEXT_PUBLIC_BASE_URL: `http://127.0.0.1:${ROUTER_PORT}`,
      BASE_URL: `http://127.0.0.1:${ROUTER_PORT}`,
      DATA_DIR: dataDir
    }
  });
}

function prepareStandalone() {
  const standaloneDir = path.join(ROUTER_HOME, '.next', 'standalone');
  const staticSrc = path.join(ROUTER_HOME, '.next', 'static');
  const staticDst = path.join(standaloneDir, '.next', 'static');
  const publicSrc = path.join(ROUTER_HOME, 'public');
  const publicDst = path.join(standaloneDir, 'public');
  execText(`rm -rf "${staticDst}" "${publicDst}"`);
  if (fs.existsSync(staticSrc)) execText(`cp -R "${staticSrc}" "${staticDst}"`);
  if (fs.existsSync(publicSrc)) execText(`cp -R "${publicSrc}" "${publicDst}"`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function buildLaunchCommand(port = ROUTER_PORT) {
  const dataDir = path.join(process.env.HOME || '/tmp', '.9router', 'data');
  const installedPackage = [
    path.join(DEFAULT_HOME, '.local', 'lib', 'node_modules', '9router', 'app', 'server.js'),
    '/usr/local/lib/node_modules/9router/app/server.js',
    '/usr/lib/node_modules/9router/app/server.js',
  ].find((p) => fs.existsSync(p));
  const serverJsPath = installedPackage || path.join(ROUTER_HOME, '.next', 'standalone', 'server.js');
  const workingDir = path.dirname(serverJsPath);
  return [
    `export PATH=${shellQuote(defaultPath)}`,
    'export NODE_ENV=production',
    `export PORT=${port}`,
    'export HOSTNAME=127.0.0.1',
    `export NEXT_PUBLIC_BASE_URL=http://127.0.0.1:${port}`,
    `export BASE_URL=http://127.0.0.1:${port}`,
    `export DATA_DIR=${shellQuote(dataDir)}`,
    'mkdir -p "$DATA_DIR"',
    `cd ${shellQuote(workingDir)}`,
    `exec node ${shellQuote(serverJsPath)}`,
  ].join('; ');
}

function buildBootstrapCommand(port = ROUTER_PORT) {
  if (process.platform === 'win32') {
    return buildBootstrapPowerShellCommand(port);
  }
  const standaloneDir = path.join(ROUTER_HOME, '.next', 'standalone');
  const staticSrc = path.join(ROUTER_HOME, '.next', 'static');
  const staticDst = path.join(standaloneDir, '.next', 'static');
  const publicSrc = path.join(ROUTER_HOME, 'public');
  const publicDst = path.join(standaloneDir, 'public');
  const dataDir = path.join(process.env.HOME || '/tmp', '.9router', 'data');
  return [
    'set -e',
    `export PATH=${shellQuote(defaultPath)}`,
    `ROUTER_HOME=${shellQuote(ROUTER_HOME)}`,
    `ROUTER_GIT_URL=${shellQuote(ROUTER_GIT_URL)}`,
    `ROUTER_PORT=${shellQuote(port)}`,
    `PATCH_SCRIPT=${shellQuote(OPEN_ACCESS_PATCH_SCRIPT)}`,
    `DATA_DIR=${shellQuote(dataDir)}`,
    `STANDALONE_DIR=${shellQuote(standaloneDir)}`,
    `STATIC_SRC=${shellQuote(staticSrc)}`,
    `STATIC_DST=${shellQuote(staticDst)}`,
    `PUBLIC_SRC=${shellQuote(publicSrc)}`,
    `PUBLIC_DST=${shellQuote(publicDst)}`,
    'if ! command -v 9router >/dev/null 2>&1; then',
    '  if [ ! -f "$ROUTER_HOME/package.json" ]; then',
    '    echo "[9router] 9router CLI not found. Installing via npm..."',
    '    npm i -g 9router@latest --prefer-online || {',
    '      echo "[9router] npm install failed, falling back to source clone..."',
    '      rm -rf "$ROUTER_HOME"',
    '      git clone --depth 1 "$ROUTER_GIT_URL" "$ROUTER_HOME"',
    '      echo "[9router] Clone complete"',
    '      node "$PATCH_SCRIPT" "$ROUTER_HOME" || echo "[9router] dashboardGuard open-access patch skipped"',
    '    }',
    '  fi',
    '  if [ -f "$ROUTER_HOME/package.json" ] && [ ! -f "$STANDALONE_DIR/server.js" ]; then',
    '    echo "[9router] Building fallback from source..."',
    '    cd "$ROUTER_HOME"',
    '    npm install',
    '    DATA_DIR="$DATA_DIR" npm run build',
    '    echo "[9router] Build complete"',
    '  fi',
    'fi',
    buildLaunchCommand(port)
  ].join('\n');
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function buildBootstrapPowerShellCommand(port = ROUTER_PORT) {
  const standaloneDir = path.join(ROUTER_HOME, '.next', 'standalone');
  const staticSrc = path.join(ROUTER_HOME, '.next', 'static');
  const staticDst = path.join(standaloneDir, '.next', 'static');
  const publicSrc = path.join(ROUTER_HOME, 'public');
  const publicDst = path.join(standaloneDir, 'public');
  const dataDir = path.join(process.env.HOME || process.env.USERPROFILE || 'C:\\Users\\Public', '.9router', 'data');
  const runtimeLogPath = path.join(process.env.TEMP || 'C:\\tmp', '9router.log');
  return [
    '$ErrorActionPreference = "Stop"',
    `$env:PATH = ${psQuote(defaultPath)}`,
    `$routerHome = ${psQuote(ROUTER_HOME)}`,
    `$routerGitUrl = ${psQuote(ROUTER_GIT_URL)}`,
    `$standaloneDir = ${psQuote(standaloneDir)}`,
    `$staticSrc = ${psQuote(staticSrc)}`,
    `$staticDst = ${psQuote(staticDst)}`,
    `$publicSrc = ${psQuote(publicSrc)}`,
    `$publicDst = ${psQuote(publicDst)}`,
    `$dataDir = ${psQuote(dataDir)}`,
    'if (-not (Test-Path (Join-Path $routerHome "package.json"))) {',
    '  Write-Output "[9router] Cloning $routerGitUrl..."',
    '  if (Test-Path $routerHome) { Remove-Item -Recurse -Force $routerHome }',
    '  git clone --depth 1 $routerGitUrl $routerHome',
    '  Write-Output "[9router] Clone complete"',
    '} else {',
    '  Write-Output "[9router] Repo already exists"',
    '}',
    'if (-not (Test-Path (Join-Path $standaloneDir "server.js"))) {',
    '  Write-Output "[9router] Building..."',
    '  Push-Location $routerHome',
    '  try { npm install; npm run build } finally { Pop-Location }',
    '  Write-Output "[9router] Build complete"',
    '} else {',
    '  Write-Output "[9router] Already built"',
    '}',
    'New-Item -ItemType Directory -Force -Path (Split-Path $staticDst) | Out-Null',
    'if (Test-Path $staticDst) { Remove-Item -Recurse -Force $staticDst }',
    'if (Test-Path $publicDst) { Remove-Item -Recurse -Force $publicDst }',
    'if (Test-Path $staticSrc) { Copy-Item -Recurse -Force $staticSrc $staticDst }',
    'if (Test-Path $publicSrc) { Copy-Item -Recurse -Force $publicSrc $publicDst }',
    '$env:NODE_ENV = "production"',
    `$env:PORT = ${psQuote(String(port))}`,
    '$env:HOSTNAME = "127.0.0.1"',
    `$env:NEXT_PUBLIC_BASE_URL = ${psQuote(`http://127.0.0.1:${port}`)}`,
    `$env:BASE_URL = ${psQuote(`http://127.0.0.1:${port}`)}`,
    '$env:DATA_DIR = $dataDir',
    'New-Item -ItemType Directory -Force -Path $env:DATA_DIR | Out-Null',
    `$runtimeLogPath = ${psQuote(runtimeLogPath)}`,
    '$nodeExe = (Get-Command node).Source',
    'Start-Process -FilePath $nodeExe -WorkingDirectory $standaloneDir -ArgumentList \'server.js\' -RedirectStandardOutput $runtimeLogPath -RedirectStandardError $runtimeLogPath',
  ].join('\n');
}

function writeHermesConfig(port = ROUTER_PORT) {
  const hermesConfigPath = path.join(config.hermesHome, 'config.yaml');
  const current = (() => {
    try { return fs.readFileSync(hermesConfigPath, 'utf8'); } catch { return ''; }
  })();
  const baseUrlLine = `  base_url: http://127.0.0.1:${port}/v1`;
  if (current.includes(baseUrlLine)) return false;
  const next = current
    ? current.replace(/base_url:\s*http:\/\/127\.0\.0\.1:\d+\/v1/, baseUrlLine.trimStart())
    : [
        'model:',
        '  provider: custom',
        '  default: opencode/big-pickle',
        `  base_url: http://127.0.0.1:${port}/v1`,
        `  api_key: ${ROUTER_API_KEY}`,
        '',
      ].join('\n');
  fs.mkdirSync(path.dirname(hermesConfigPath), { recursive: true });
  fs.writeFileSync(hermesConfigPath, next, { mode: 0o600 });
  return true;
}

async function waitForHealth(timeoutMs = HEALTH_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const ok = await new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${ROUTER_PORT}/api/health`, (res) => {
          res.resume();
          resolve((res.statusCode || 500) < 400);
        });
        req.setTimeout(5000, () => {
          req.destroy();
          resolve(false);
        });
        req.on('error', () => resolve(false));
      });
      if (ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  return false;
}

async function ensureHfEndpointProvider(log) {
  if (providerSeeded) return false;
  if (providerSeedPromise) return providerSeedPromise;
  providerSeedPromise = doEnsureHfEndpointProvider(log).finally(() => {
    providerSeedPromise = null;
  });
  return providerSeedPromise;
}

async function doEnsureHfEndpointProvider(log) {
  const dataDirCandidates = [
    process.env.DATA_DIR,
    process.env.HOME ? path.join(process.env.HOME, '.9router', 'data') : '',
    process.env.HOME ? path.join(process.env.HOME, '.9router') : '',
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.9router', 'data') : '',
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.9router') : '',
    '/root/.9router',
    '/root/.9router/data',
    '/tmp/.9router',
    path.join('/tmp', '.9router', 'data'),
  ].filter(Boolean);
  const dbCandidates = dataDirCandidates.map((dataDir) => path.join(dataDir, 'db', 'data.sqlite'));
  const DB_WAIT_MS = 60000;
  const DB_WAIT_STEP_MS = 1000;
  const dbDeadline = Date.now() + DB_WAIT_MS;
  let dbPath = '';
  let dbError = '';
  while (!dbPath) {
    const candidate = dbCandidates.find((path) => fs.existsSync(path));
    if (candidate) {
      try {
        ensureOpenAccess(candidate);
        dbPath = candidate;
      } catch (error) {
        dbError = error.message;
        if (log) log(`[9router] 9Router database not ready yet: ${error.message}`);
      }
    } else if (log) {
      log(`[9router] Waiting for 9Router database file...`);
    }
    if (!dbPath) {
      if (Date.now() >= dbDeadline) {
        throw new Error(`9Router database not ready after ${DB_WAIT_MS / 1000}s${dbError ? `: ${dbError}` : ''}`);
      }
      await new Promise((resolve) => setTimeout(resolve, DB_WAIT_STEP_MS));
    }
  }

  const now = new Date().toISOString();
  const nodeData = JSON.stringify({
    prefix: HF_ENDPOINT_PROVIDER_PREFIX,
    apiType: 'chat',
    baseUrl: HF_ENDPOINT_BASE_URL,
  });
  const connectionData = JSON.stringify({
    apiKey: HF_ENDPOINT_API_KEY,
    defaultModel: HF_ENDPOINT_MODEL,
    testStatus: 'unknown',
    providerSpecificData: {
      prefix: HF_ENDPOINT_PROVIDER_PREFIX,
      apiType: 'chat',
      baseUrl: HF_ENDPOINT_BASE_URL,
      nodeName: HF_ENDPOINT_PROVIDER_NAME,
      connectionProxyEnabled: false,
      connectionProxyUrl: '',
      connectionNoProxy: '',
    },
  });
  const sql = `
INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt)
VALUES($id, 'openai-compatible', $name, $nodeData, $now, $now)
ON CONFLICT(id) DO UPDATE SET
  type=excluded.type,
  name=excluded.name,
  data=excluded.data,
  updatedAt=excluded.updatedAt;

INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
VALUES($connectionId, $id, 'apikey', $name, NULL, 1, 1, $connectionData, $now, $now)
ON CONFLICT(id) DO UPDATE SET
  provider=excluded.provider,
  authType=excluded.authType,
  name=excluded.name,
  priority=excluded.priority,
  isActive=excluded.isActive,
  data=excluded.data,
  updatedAt=excluded.updatedAt;
`;
  if (hasCommand('sqlite3')) {
    execFileSync('sqlite3', [
      dbPath,
      '-cmd', `.parameter set $id ${JSON.stringify(HF_ENDPOINT_PROVIDER_ID)}`,
      '-cmd', `.parameter set $connectionId ${JSON.stringify(HF_ENDPOINT_CONNECTION_ID)}`,
      '-cmd', `.parameter set $name ${JSON.stringify(HF_ENDPOINT_PROVIDER_NAME)}`,
      '-cmd', `.parameter set $nodeData ${JSON.stringify(nodeData)}`,
      '-cmd', `.parameter set $connectionData ${JSON.stringify(connectionData)}`,
      '-cmd', `.parameter set $now ${JSON.stringify(now)}`,
      sql,
    ], {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, PATH: defaultPath },
    });
  } else {
    const routerPackagePath = findRouterPackagePath();
    const seedScript = `
const { createRequire } = require('node:module');
const requireFromRouter = createRequire(process.argv[1]);
const Database = requireFromRouter('better-sqlite3');
const db = new Database(process.argv[2]);
const params = {
  id: process.argv[3],
  connectionId: process.argv[4],
  name: process.argv[5],
  nodeData: process.argv[6],
  connectionData: process.argv[7],
  now: process.argv[8],
};
const nodeSql = \`INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt)
VALUES(@id, 'openai-compatible', @name, @nodeData, @now, @now)
ON CONFLICT(id) DO UPDATE SET type=excluded.type, name=excluded.name, data=excluded.data, updatedAt=excluded.updatedAt\`;
const connSql = \`INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
VALUES(@connectionId, @id, 'apikey', @name, NULL, 1, 1, @connectionData, @now, @now)
ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, authType=excluded.authType, name=excluded.name, priority=excluded.priority, isActive=excluded.isActive, data=excluded.data, updatedAt=excluded.updatedAt\`;
db.transaction(() => {
  db.prepare(nodeSql).run(params);
  db.prepare(connSql).run(params);
})();
db.close();
`;
    execFileSync(process.execPath, [
      '-e',
      seedScript,
      routerPackagePath,
      dbPath,
      HF_ENDPOINT_PROVIDER_ID,
      HF_ENDPOINT_CONNECTION_ID,
      HF_ENDPOINT_PROVIDER_NAME,
      nodeData,
      connectionData,
      now,
    ], {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, PATH: defaultPath },
    });
  }
  if (log) log(`[9router] Added provider ${HF_ENDPOINT_PROVIDER_PREFIX}/${HF_ENDPOINT_MODEL}`);
  providerSeeded = true;
  return true;
}

function ensureOpenAccess(dbPath) {
  const routerPackagePath = findRouterPackagePath();
  const settingsScript = `
const { createRequire } = require('node:module');
const requireFromRouter = createRequire(process.argv[1]);
const Database = requireFromRouter('better-sqlite3');
const db = new Database(process.argv[2]);
db.pragma('busy_timeout = 10000');
let changed = false;
const row = db.prepare('select data from settings where id = 1').get();
const data = row?.data ? JSON.parse(row.data) : {};
if (data.requireLogin !== false) {
  data.requireLogin = false;
  changed = true;
}
if (data.requireApiKey !== false) {
  data.requireApiKey = false;
  changed = true;
}
if (changed) {
  db.prepare('insert into settings(id, data) values(1, ?) on conflict(id) do update set data = excluded.data').run(JSON.stringify(data));
}
const verified = db.prepare('select data from settings where id = 1').get();
const verifiedData = JSON.parse(verified?.data || '{}');
if (verifiedData.requireLogin !== false) {
  throw new Error('9Router requireLogin setting did not persist');
}
if (verifiedData.requireApiKey !== false) {
  throw new Error('9Router requireApiKey setting did not persist');
}
db.close();
process.stdout.write(changed ? 'changed' : 'unchanged');
`;
  const result = execFileSync(process.execPath, [
    '-e',
    settingsScript,
    routerPackagePath,
    dbPath,
  ], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, PATH: defaultPath },
  }).trim();
  return result === 'changed';
}

export async function start(log) {
  const live = findListenerForPort(ROUTER_PORT);
  if (live && live > 0) {
    startupState = 'running';
    startupError = '';
    try {
      await ensureHfEndpointProviderLoaded(log);
    } catch (error) {
      if (log) log(`[9router] HF endpoint provider seed failed: ${error.message}`);
    }
    return getStatus();
  }
  if (startupPromise) return getStatus();
  startupError = '';
  startupState = 'installing';
  startupPromise = new Promise((resolve, reject) => {
    setTimeout(async () => {
      try {
        killExistingListeners();
        const logFd = fs.openSync(ROUTER_LOG_PATH, 'w');
        let child;
        if (process.platform === 'win32') {
          if (log) log(`[9router] Preparing Windows bootstrap on port ${ROUTER_PORT}...`);
          await ensureRepo(log);
          await ensureBuilt(log);
          child = launchWindowsStandalone(logFd);
        } else {
          if (log) log(`[9router] Starting background bootstrap on port ${ROUTER_PORT}...`);
          const cmd = buildBootstrapCommand();
          child = spawn(shellBin, ['-lc', cmd], {
            detached: true,
            stdio: ['ignore', logFd, logFd],
            env: { ...process.env, PATH: defaultPath },
          });
        }
        child.unref();
        fs.closeSync(logFd);
        startupState = 'starting';
        if (log) log(`[9router] Bootstrap process started (pid ${child.pid})`);
        const healthy = await waitForHealth();
        if (healthy) {
          startupState = 'running';
          if (log) log(`[9router] Health check passed on port ${ROUTER_PORT}`);
          try {
            await ensureHfEndpointProviderLoaded(log);
          } catch (error) {
            if (log) log(`[9router] HF endpoint provider seed failed: ${error.message}`);
          }
          writeHermesConfig();
        } else {
          startupState = 'error';
          startupError = `9Router health check failed after ${HEALTH_TIMEOUT_MS / 1000}s.`;
          if (log) log(`[9router] Health check failed after ${HEALTH_TIMEOUT_MS / 1000}s`);
        }
        resolve(getStatus());
      } catch (error) {
        startupState = 'error';
        startupError = error.message;
        if (log) log(`[9router] Startup error: ${error.message}`);
        resolve(getStatus());
      } finally {
        startupPromise = null;
      }
    }, 0);
  });
  return getStatus();
}

export function getStatus() {
  const listenerPid = findListenerForPort(ROUTER_PORT);
  const running = Boolean(listenerPid);
  if (running && !providerSeeded && !providerSeedFailed) {
    ensureHfEndpointProvider().catch((error) => {
      // A failed seed is retried on every status poll otherwise, which churns
      // the event loop on long-running workers. Try once, then stop until a
      // restart explicitly resets the flag.
      providerSeedFailed = true;
      console.warn(`[9router] HF endpoint provider seed failed: ${error.message}`);
    });
  }
  if (running) {
    startupState = 'running';
    startupError = '';
  }
  const pid = listenerPid && listenerPid > 0 ? listenerPid : null;
  let logs = [];
  try {
    // Bounded tail read: status polls run every few seconds and must not
    // load the whole router log into memory each time.
    const fd = fs.openSync(ROUTER_LOG_PATH, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - 65536);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    logs = buf.toString('utf8').trimEnd().split('\n').slice(-120);
  } catch { /* no log yet */ }
  const state = running
    ? 'running'
    : startupState === 'installing'
      ? 'installing'
      : startupState === 'starting'
        ? 'starting'
        : startupState === 'stopped'
          ? 'stopped'
          : 'error';
  const error = running
    ? ''
    : (startupError || (state === 'installing'
      ? '9Router is preparing its local checkout and build.'
      : state === 'starting'
        ? '9Router is starting in the background.'
        : state === 'stopped'
          ? ''
          : `9Router is not listening on port ${ROUTER_PORT}.`));
  return {
    configuredPort: ROUTER_PORT,
    livePort: running ? ROUTER_PORT : null,
    state,
    error,
    pid,
    logs,
    url: `http://127.0.0.1:${ROUTER_PORT}/dashboard/providers`,
    agent: {
      id: '__9router__',
      name: '9Router',
      state,
      port: ROUTER_PORT,
      pid,
      url: `http://127.0.0.1:${ROUTER_PORT}/dashboard/providers`,
      error,
      startedAt: '',
      command: '9router',
      logs,
    },
  };
}

export async function restart(log) {
  startupPromise = null;
  startupState = 'idle';
  startupError = '';
  providerSeeded = false;
  providerSeedFailed = false;
  providerSeedPromise = null;
  killExistingListeners();
  return start(log);
}

export async function stop(log) {
  startupPromise = null;
  startupState = 'stopped';
  startupError = '';
  const pid = killExistingListeners();
  if (log) {
    if (pid) log(`[9router] Stopped pid ${pid}`);
    else log('[9router] Already stopped');
  }
  return getStatus();
}

export { ROUTER_PORT, ROUTER_API_KEY, ROUTER_MODEL, patchRouterDashboardGuard };
