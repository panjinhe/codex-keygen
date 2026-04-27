#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPE = 'openid profile email offline_access';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const CALLBACK_PORT = 1455;
const PROJECT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_KEY_FILE = resolve(PROJECT_DIR, 'secrets', 'codex-channel-key.json');

const args = parseArgs(process.argv.slice(2));

try {
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.ui) {
    await runWebUI({
      keyFile: resolveKeyPath(args.keyFile),
      openBrowser: args.openBrowser,
    });
    process.exit(0);
  }

  const key = args.refresh
    ? await refreshKey(args.refresh)
    : await runAuthorizationFlow({ manual: args.manual, openBrowser: args.openBrowser });

  const json = stableStringify(key);
  if (args.out) {
    await writeKeyFile(args.out, key);
    console.error(`Wrote Codex channel key to ${args.out}`);
  } else {
    console.log(json);
  }
} catch (error) {
  console.error(`Error: ${error?.message || error}`);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = {
    help: false,
    ui: false,
    manual: false,
    openBrowser: true,
    out: '',
    keyFile: DEFAULT_KEY_FILE,
    refresh: '',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
    } else if (arg === '--ui') {
      parsed.ui = true;
    } else if (arg === '--manual') {
      parsed.manual = true;
    } else if (arg === '--no-browser') {
      parsed.openBrowser = false;
    } else if (arg === '--out') {
      parsed.out = requireValue(argv, ++i, '--out');
    } else if (arg === '--key-file') {
      parsed.keyFile = requireValue(argv, ++i, '--key-file');
    } else if (arg === '--refresh') {
      parsed.refresh = requireValue(argv, ++i, '--refresh');
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage:
  node codex-keygen.mjs [options]

Options:
  --ui                  Start the local web UI on http://localhost:1455.
  --manual              Do not listen for the local callback; paste the callback URL manually.
  --no-browser          Print the auth URL without trying to open the browser.
  --out <path>          Write the generated JSON to a file instead of stdout.
  --key-file <path>     Web UI save path. Default: ${DEFAULT_KEY_FILE}
  --refresh <token>     Refresh an existing refresh_token and print a new channel key JSON.
  -h, --help            Show this help.
`);
}

async function runAuthorizationFlow({ manual, openBrowser }) {
  const { state, verifier, authorizeUrl } = createAuthorizationFlow();

  let callbackPromise;
  let server;
  if (!manual) {
    ({ server, callbackPromise } = await startCallbackServer(state));
  }

  console.error('Open this URL and complete login:');
  console.error(authorizeUrl);
  console.error('');

  if (openBrowser) {
    openUrl(authorizeUrl);
  }

  const callbackUrl = manual
    ? await promptForCallbackUrl()
    : await callbackPromise.finally(() => server?.close());

  const { code } = parseCallbackInput(callbackUrl, state);
  const token = await exchangeAuthorizationCode({ code, verifier });
  return buildChannelKey(token);
}

function createAuthorizationFlow() {
  const state = randomBytes(16).toString('hex');
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  const authorizeUrl = buildAuthorizeUrl({ state, challenge });
  return { state, verifier, challenge, authorizeUrl, createdAt: Date.now() };
}

function buildAuthorizeUrl({ state, challenge }) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', 'codex_cli_rs');
  return url.toString();
}

async function startCallbackServer(expectedState) {
  let resolveCallback;
  let rejectCallback;
  const callbackPromise = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = http.createServer((req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', REDIRECT_URI);
      if (reqUrl.pathname !== '/auth/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      const state = reqUrl.searchParams.get('state') || '';
      if (state !== expectedState) {
        throw new Error('state mismatch');
      }

      const code = reqUrl.searchParams.get('code') || '';
      if (!code) {
        throw new Error('missing authorization code');
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>Codex authorized</title><h1>Codex authorization complete</h1><p>You can close this tab and return to the terminal.</p>');
      resolveCallback(reqUrl.toString());
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(error?.message || 'authorization failed');
      rejectCallback(error);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(CALLBACK_PORT, () => {
      server.off('error', reject);
      resolve();
    });
  }).catch((error) => {
    throw new Error(`cannot listen on localhost:${CALLBACK_PORT}; rerun with --manual. ${error.message}`);
  });

  return { server, callbackPromise };
}

async function promptForCallbackUrl() {
  const rl = createInterface({ input, output });
  try {
    const value = await rl.question('Paste the full callback URL: ');
    return value.trim();
  } finally {
    rl.close();
  }
}

function parseCallbackInput(inputValue, expectedState) {
  const raw = inputValue.trim();
  if (!raw) {
    throw new Error('empty callback URL');
  }

  let code = '';
  let state = '';

  if (raw.includes('#') && !raw.includes('code=')) {
    const [rawCode, rawState] = raw.split('#', 2);
    code = rawCode.trim();
    state = rawState.trim();
  } else if (raw.includes('code=')) {
    const parsed = raw.startsWith('http')
      ? new URL(raw)
      : new URL(`http://localhost/?${raw.replace(/^\?/, '')}`);
    code = parsed.searchParams.get('code') || '';
    state = parsed.searchParams.get('state') || '';
  } else {
    code = raw;
  }

  if (!code) {
    throw new Error('missing authorization code');
  }
  if (!state) {
    throw new Error('missing state in callback URL');
  }
  if (state !== expectedState) {
    throw new Error('state mismatch');
  }

  return { code, state };
}

async function exchangeAuthorizationCode({ code, verifier }) {
  const form = new URLSearchParams();
  form.set('grant_type', 'authorization_code');
  form.set('client_id', CLIENT_ID);
  form.set('code', code);
  form.set('code_verifier', verifier);
  form.set('redirect_uri', REDIRECT_URI);
  return postTokenForm(form, 'authorization code exchange');
}

async function refreshKey(refreshToken) {
  const form = new URLSearchParams();
  form.set('grant_type', 'refresh_token');
  form.set('refresh_token', refreshToken.trim());
  form.set('client_id', CLIENT_ID);
  const token = await postTokenForm(form, 'token refresh');
  return buildChannelKey(token);
}

async function runWebUI({ keyFile, openBrowser }) {
  const flows = new Map();
  const publicFiles = new Map([
    ['/', { path: resolve(PROJECT_DIR, 'public', 'index.html'), type: 'text/html; charset=utf-8' }],
    ['/app.js', { path: resolve(PROJECT_DIR, 'public', 'app.js'), type: 'text/javascript; charset=utf-8' }],
    ['/styles.css', { path: resolve(PROJECT_DIR, 'public', 'styles.css'), type: 'text/css; charset=utf-8' }],
  ]);

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', `http://localhost:${CALLBACK_PORT}`);

      if (req.method === 'GET' && publicFiles.has(reqUrl.pathname)) {
        const file = publicFiles.get(reqUrl.pathname);
        const body = await readFile(file.path);
        send(res, 200, file.type, body);
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/api/status') {
        const key = await readSavedKey(keyFile);
        sendJson(res, 200, {
          success: true,
          data: {
            key_file: keyFile,
            exists: Boolean(key),
            summary: key ? summarizeKey(key) : null,
          },
        });
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/api/key') {
        const key = await readSavedKey(keyFile);
        if (!key) {
          sendJson(res, 404, { success: false, message: 'key file not found' });
          return;
        }
        sendJson(res, 200, {
          success: true,
          data: {
            key_file: keyFile,
            key: stableStringify(key),
            summary: summarizeKey(key),
          },
        });
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/api/start') {
        pruneExpiredFlows(flows);
        const flow = createAuthorizationFlow();
        flows.set(flow.state, flow);
        sendJson(res, 200, {
          success: true,
          data: {
            authorize_url: flow.authorizeUrl,
          },
        });
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/api/refresh') {
        const existing = await readSavedKey(keyFile);
        if (!existing?.refresh_token) {
          sendJson(res, 400, { success: false, message: 'saved key has no refresh_token' });
          return;
        }
        const key = await refreshKey(existing.refresh_token);
        await writeKeyFile(keyFile, key);
        sendJson(res, 200, {
          success: true,
          data: {
            key_file: keyFile,
            key: stableStringify(key),
            summary: summarizeKey(key),
          },
        });
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/auth/callback') {
        await handleWebCallback(reqUrl, res, flows, keyFile);
        return;
      }

      sendJson(res, 404, { success: false, message: 'not found' });
    } catch (error) {
      sendJson(res, 500, { success: false, message: error?.message || String(error) });
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(CALLBACK_PORT, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  }).catch((error) => {
    throw new Error(`cannot listen on localhost:${CALLBACK_PORT}. ${error.message}`);
  });

  const uiUrl = `http://localhost:${CALLBACK_PORT}/`;
  console.error(`Codex Keygen UI: ${uiUrl}`);
  console.error(`Key file: ${keyFile}`);
  console.error('Press Ctrl+C to stop.');

  if (openBrowser) {
    openUrl(uiUrl);
  }

  await new Promise((resolveStop) => {
    process.once('SIGINT', () => {
      server.close(() => resolveStop());
    });
    process.once('SIGTERM', () => {
      server.close(() => resolveStop());
    });
  });
}

async function handleWebCallback(reqUrl, res, flows, keyFile) {
  const code = reqUrl.searchParams.get('code') || '';
  const state = reqUrl.searchParams.get('state') || '';

  if (!code || !state) {
    sendCallbackPage(res, false, 'Missing code or state.');
    return;
  }

  const flow = flows.get(state);
  if (!flow) {
    sendCallbackPage(res, false, 'OAuth flow was not found or expired.');
    return;
  }

  flows.delete(state);
  const token = await exchangeAuthorizationCode({ code, verifier: flow.verifier });
  const key = buildChannelKey(token);
  await writeKeyFile(keyFile, key);
  sendCallbackPage(res, true, 'Credential saved. Return to the keygen tab.');
}

function sendCallbackPage(res, success, message) {
  const status = success ? 200 : 400;
  const title = success ? 'Codex credential saved' : 'Codex authorization failed';
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f8fa; color: #1f2328; }
  main { width: min(560px, calc(100vw - 40px)); }
  h1 { margin: 0 0 12px; font-size: 28px; letter-spacing: 0; }
  p { margin: 0 0 22px; color: #59636e; line-height: 1.55; }
  a { color: #0b63ce; font-weight: 650; }
</style>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  <a href="${success ? '/?saved=1' : '/'}">Open Codex Keygen</a>
</main>`;
  send(res, status, 'text/html; charset=utf-8', html);
}

function pruneExpiredFlows(flows) {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [state, flow] of flows) {
    if (!flow?.createdAt || flow.createdAt < cutoff) {
      flows.delete(state);
    }
  }
}

async function readSavedKey(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeKeyFile(filePath, key) {
  const resolved = resolveKeyPath(filePath);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, `${stableStringify(key)}\n`, { mode: 0o600 });
}

function summarizeKey(key) {
  return {
    account_id: key.account_id || '',
    email: key.email || '',
    type: key.type || '',
    last_refresh: key.last_refresh || '',
    expired: key.expired || '',
    access_token: maskToken(key.access_token),
    refresh_token: maskToken(key.refresh_token),
  };
}

function maskToken(token) {
  const value = String(token || '');
  if (!value) {
    return '';
  }
  if (value.length <= 16) {
    return 'present';
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function resolveKeyPath(filePath) {
  return resolve(filePath || DEFAULT_KEY_FILE);
}

function sendJson(res, status, payload) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(payload));
}

function send(res, status, contentType, body) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function postTokenForm(form, label) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error_description || payload.error || response.statusText;
    throw new Error(`Codex OAuth ${label} failed: HTTP ${response.status} ${detail}`);
  }

  if (!payload.access_token || !payload.refresh_token || !payload.expires_in) {
    throw new Error(`Codex OAuth ${label} response missing token fields`);
  }

  return {
    accessToken: String(payload.access_token).trim(),
    refreshToken: String(payload.refresh_token).trim(),
    expiresAt: new Date(Date.now() + Number(payload.expires_in) * 1000),
  };
}

function buildChannelKey(token) {
  const claims = decodeJwtClaims(token.accessToken);
  const authClaim = claims[JWT_CLAIM_PATH] || {};
  const accountID = String(authClaim.chatgpt_account_id || '').trim();
  if (!accountID) {
    throw new Error('failed to extract account_id from access_token');
  }

  const key = {
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    account_id: accountID,
    last_refresh: formatRFC3339(new Date()),
    type: 'codex',
    expired: formatRFC3339(token.expiresAt),
  };

  const email = String(claims.email || '').trim();
  if (email) {
    key.email = email;
  }

  return key;
}

function decodeJwtClaims(token) {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('access_token is not a JWT');
  }
  const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
  return JSON.parse(payload);
}

function stableStringify(key) {
  const ordered = {
    access_token: key.access_token,
    refresh_token: key.refresh_token,
    account_id: key.account_id,
    last_refresh: key.last_refresh,
    email: key.email,
    type: key.type,
    expired: key.expired,
  };
  Object.keys(ordered).forEach((name) => {
    if (ordered[name] === undefined || ordered[name] === '') {
      delete ordered[name];
    }
  });
  return JSON.stringify(ordered, null, 2);
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function formatRFC3339(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function openUrl(url) {
  const platform = process.platform;
  let command;
  let commandArgs;

  if (platform === 'win32') {
    command = 'rundll32.exe';
    commandArgs = ['url.dll,FileProtocolHandler', url];
  } else if (platform === 'darwin') {
    command = 'open';
    commandArgs = [url];
  } else {
    command = 'xdg-open';
    commandArgs = [url];
  }

  const child = spawn(command, commandArgs, {
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => {});
  child.unref();
}
