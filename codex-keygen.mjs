#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  buildMailboxConfig,
  extractVerificationCode,
  hashID,
  parseAccountLine,
  parseAccountText,
  sanitizeAccountForLogin,
  toSafeImportedRow,
} from './lib/account-utils.mjs';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPE = 'openid profile email offline_access';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const CALLBACK_PORT = 1455;
const PROJECT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_KEY_FILE = resolve(PROJECT_DIR, 'secrets', 'codex-channel-key.json');
const DEFAULT_ACCOUNTS_FILE = resolve(PROJECT_DIR, 'secrets', 'accounts.json');
const MAX_LOGIN_WORKERS = 2;

const args = parseArgs(process.argv.slice(2));

try {
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.ui) {
    await runWebUI({
      keyFile: resolveKeyPath(args.keyFile),
      accountsFile: resolveKeyPath(args.accountsFile),
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
    accountsFile: DEFAULT_ACCOUNTS_FILE,
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
    } else if (arg === '--accounts-file') {
      parsed.accountsFile = requireValue(argv, ++i, '--accounts-file');
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
  --accounts-file <path> Batch account store. Default: ${DEFAULT_ACCOUNTS_FILE}
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

async function runWebUI({ keyFile, accountsFile, openBrowser }) {
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
            accounts_file: accountsFile,
            exists: Boolean(key),
            summary: key ? summarizeKey(key) : null,
          },
        });
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/api/accounts') {
        const store = await readAccountsStore(accountsFile);
        sendJson(res, 200, {
          success: true,
          data: {
            accounts_file: accountsFile,
            accounts: store.accounts.map(summarizeStoredAccount),
          },
        });
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/api/import-preview') {
        const body = await readJsonBody(req);
        const parsed = parseAccountText(body.accounts || body.text || '');
        sendJson(res, 200, {
          success: true,
          data: {
            total: parsed.total,
            valid: parsed.rows.length,
            invalid: parsed.invalid,
            duplicates: parsed.duplicates,
            rows: parsed.rows.map(toSafeImportedRow),
          },
        });
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/api/manual_mail') {
        const body = await readJsonBody(req);
        const account = accountFromMailRequest(body);
        const result = await queryMailbox(account);
        sendJson(res, 200, { success: true, data: result });
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/api/delete_accounts') {
        const body = await readJsonBody(req);
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        const emails = Array.isArray(body.emails) ? body.emails.map((email) => String(email).toLowerCase()) : [];
        const deleted = await deleteStoredAccounts(accountsFile, { ids, emails });
        sendJson(res, 200, { success: true, data: { deleted } });
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/api/login') {
        await handleLoginStream(req, res, flows, accountsFile);
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
      if (res.headersSent) {
        if (!res.writableEnded) {
          writeEvent(res, 'error', { error: error?.message || String(error), code: error?.code || 'server_error' });
          res.end();
        }
      } else {
        const status = error?.code?.startsWith?.('mailbox_') ? 400 : 500;
        sendJson(res, status, { success: false, message: error?.message || String(error), code: error?.code || 'server_error' });
      }
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
  console.error(`Accounts file: ${accountsFile}`);
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
  if (flow.mode === 'auto') {
    flow.resolveCallback?.(reqUrl.toString());
    sendCallbackPage(res, true, 'Credential captured. Return to the login window.');
    return;
  }

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
      flow.rejectCallback?.(new Error('OAuth flow expired'));
      flows.delete(state);
    }
  }
}

async function handleLoginStream(req, res, flows, accountsFile) {
  let browser;
  let aborted = false;

  const body = await readJsonBody(req);
  const parsed = parseLoginAccounts(body.accounts || body.text || '');
  const workers = clampInteger(body.workers, 1, MAX_LOGIN_WORKERS, 1);

  startEventStream(res);
  res.on('close', () => {
    aborted = true;
  });
  const emit = (event, data) => {
    if (!res.writableEnded) {
      writeEvent(res, event, data);
    }
  };

  if (parsed.invalid.length > 0) {
    emit('log', { message: `跳过 ${parsed.invalid.length} 行无效账号。` });
  }
  if (parsed.duplicates.length > 0) {
    emit('log', { message: `跳过 ${parsed.duplicates.length} 个重复账号。` });
  }
  if (parsed.rows.length === 0) {
    emit('error', { error: '没有可登录的账号' });
    emit('done', { total: 0, ok: 0, failed: 0 });
    res.end();
    return;
  }

  try {
    const { chromium } = await import('playwright');
    browser = await launchVisibleBrowser(chromium);
  } catch (error) {
    emit('error', {
      error: `无法启动 Playwright Chromium：${error?.message || error}`,
      hint: '请先运行 npm install，并安装 Chromium，或设置 PLAYWRIGHT_EXECUTABLE_PATH 指向 Chrome/Edge。',
    });
    emit('done', { total: parsed.rows.length, ok: 0, failed: parsed.rows.length });
    res.end();
    return;
  }

  emit('log', { message: `批量开始：${parsed.rows.length} 个账号，并发 ${Math.min(workers, parsed.rows.length)}。` });

  let cursor = 0;
  let ok = 0;
  let failed = 0;

  const runWorker = async () => {
    for (;;) {
      if (aborted) {
        return;
      }
      const index = cursor;
      cursor += 1;
      if (index >= parsed.rows.length) {
        return;
      }

      const account = parsed.rows[index];
      emit('log', { email: account.email, message: `开始登录第 ${index + 1}/${parsed.rows.length} 个账号：${account.email}` });
      try {
        const result = await loginAccountWithBrowser(account, { browser, flows, emit });
        await upsertStoredAccount(accountsFile, result.token);
        ok += 1;
        emit('result', {
          email: account.email,
          ok: true,
          token: result.token,
          summary: summarizeKey(result.token),
        });
        emit('log', { email: account.email, message: `${account.email} 登录成功。` });
      } catch (error) {
        failed += 1;
        const message = error?.message || String(error);
        emit('result', {
          email: account.email,
          ok: false,
          error: message,
          failureKind: error?.code || classifyLoginFailure(message),
        });
        emit('log', { email: account.email, message: `${account.email} 登录失败：${message}` });
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(workers, parsed.rows.length) }, () => runWorker()));
  } finally {
    await browser?.close().catch(() => {});
    emit('done', { total: parsed.rows.length, ok, failed });
    res.end();
  }
}

function parseLoginAccounts(input) {
  if (Array.isArray(input)) {
    const rows = [];
    const invalid = [];
    const seen = new Set();

    input.forEach((entry, index) => {
      let account;
      if (typeof entry === 'string') {
        const parsed = parseAccountLine(entry, index + 1);
        if (!parsed.ok) {
          invalid.push({ lineNumber: index + 1, rawLine: entry, reason: parsed.reason });
          return;
        }
        account = parsed.row;
      } else {
        account = sanitizeAccountForLogin(entry);
      }

      if (!account.email || !account.openaiPassword) {
        invalid.push({ lineNumber: index + 1, rawLine: account.rawLine || '', reason: '缺少邮箱或密码' });
        return;
      }

      const emailKey = account.email.toLowerCase();
      if (seen.has(emailKey)) {
        return;
      }
      seen.add(emailKey);
      rows.push(account);
    });

    return { total: input.length, rows, invalid, duplicates: [] };
  }

  return parseAccountText(input);
}

async function launchVisibleBrowser(chromium) {
  const attempts = [{ label: 'bundled chromium', options: { headless: false } }];
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) {
    attempts.unshift({
      label: 'PLAYWRIGHT_EXECUTABLE_PATH',
      options: { headless: false, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH },
    });
  }
  if (process.platform === 'win32') {
    for (const path of [
      `${process.env.ProgramFiles || 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.ProgramFiles || 'C:\\Program Files'}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ]) {
      if (existsSync(path)) {
        attempts.push({ label: path, options: { headless: false, executablePath: path } });
      }
    }
  } else {
    attempts.push({ label: 'chrome channel', options: { headless: false, channel: 'chrome' } });
    attempts.push({ label: 'msedge channel', options: { headless: false, channel: 'msedge' } });
  }

  const errors = [];
  for (const attempt of attempts) {
    try {
      return await chromium.launch(attempt.options);
    } catch (error) {
      errors.push(`${attempt.label}: ${error?.message || error}`);
    }
  }
  throw new Error(errors.join('\n'));
}

async function loginAccountWithBrowser(account, { browser, flows, emit }) {
  const flow = createAuthorizationFlow();
  const callbackPromise = new Promise((resolveCallback, rejectCallback) => {
    flows.set(flow.state, {
      ...flow,
      mode: 'auto',
      email: account.email,
      resolveCallback,
      rejectCallback,
    });
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(flow.authorizeUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const waitForLogin = driveVisibleLogin(page, account, emit);
    waitForLogin.catch(() => {});
    const callbackUrl = await Promise.race([
      callbackPromise,
      waitForLogin.then(() => callbackPromise),
      timeoutAfter(180_000, 'OAuth callback timeout'),
    ]);
    const { code } = parseCallbackInput(callbackUrl, flow.state);
    const token = await exchangeAuthorizationCode({ code, verifier: flow.verifier });
    return { token };
  } finally {
    flows.delete(flow.state);
    await context.close().catch(() => {});
  }
}

async function driveVisibleLogin(page, account, emit) {
  const started = Date.now();
  let emailFilled = false;
  let passwordFilled = false;
  let codeFilled = false;

  while (Date.now() - started < 170_000) {
    if (page.url().startsWith(REDIRECT_URI)) {
      return;
    }

    await throwIfManualRequired(page);

    if (!emailFilled && (await fillFirstVisible(page, [
      'input[type="email"]',
      'input[name="email"]',
      'input[name="username"]',
      'input#username',
      'input[autocomplete="username"]',
    ], account.email))) {
      emailFilled = true;
      await clickPrimaryAction(page);
      await delay(900);
      continue;
    }

    if (!passwordFilled && (await fillFirstVisible(page, [
      'input[type="password"]',
      'input[name="password"]',
      'input[autocomplete="current-password"]',
    ], account.openaiPassword))) {
      passwordFilled = true;
      await clickPrimaryAction(page);
      await delay(1_200);
      continue;
    }

    if (!codeFilled && (await isOtpStep(page))) {
      if (!account.mailboxPassword) {
        throw Object.assign(new Error('需要邮箱验证码，但导入行没有邮箱密码或 app password'), {
          code: 'manual_required',
        });
      }
      emit('log', { email: account.email, message: '检测到邮箱验证码步骤，开始查询邮件。' });
      const mail = await pollMailboxForCode(account, emit);
      if (!mail.code) {
        throw Object.assign(new Error('未查询到邮箱验证码'), { code: 'mail_code_not_found' });
      }
      emit('mail', { email: account.email, code: mail.code, messages: mail.messages });
      await fillOtpCode(page, mail.code);
      codeFilled = true;
      await clickPrimaryAction(page);
      await delay(1_200);
      continue;
    }

    await clickConsentIfPresent(page);
    await delay(900);
  }

  throw Object.assign(new Error('自动登录超时，需要人工处理'), { code: 'manual_required' });
}

async function pollMailboxForCode(account, emit) {
  let lastError = '';
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const result = await queryMailbox(account);
      if (result.code) {
        return result;
      }
      emit('log', { email: account.email, message: `第 ${attempt} 次未找到验证码，继续等待。` });
    } catch (error) {
      lastError = error?.message || String(error);
      emit('log', { email: account.email, message: `邮件查询失败：${lastError}` });
    }
    await delay(5_000);
  }
  throw Object.assign(new Error(lastError || '未查询到邮箱验证码'), { code: 'mail_code_not_found' });
}

async function queryMailbox(account) {
  const config = buildMailboxConfig(account);
  const { ImapFlow } = await import('imapflow');
  const { simpleParser } = await import('mailparser');
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.email,
      pass: config.password,
    },
    logger: false,
  });

  const messages = [];
  const since = new Date(Date.now() - 10 * 60 * 1000);
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    for await (const message of client.fetch({ since }, { envelope: true, source: true, uid: true })) {
      const parsed = await simpleParser(message.source);
      const from = parsed.from?.text || message.envelope?.from?.map((item) => item.address).join(', ') || '';
      const subject = parsed.subject || message.envelope?.subject || '';
      const receivedAt = parsed.date || message.envelope?.date || new Date();
      if (receivedAt < since) {
        continue;
      }
      const text = [parsed.text, parsed.html].filter(Boolean).join('\n');
      const code = extractVerificationCode(subject, text);
      if (!looksLikeAuthMail(from, subject, text) && !code) {
        continue;
      }
      messages.push({
        uid: message.uid,
        time: receivedAt.toISOString(),
        from,
        subject,
        code,
        snippet: makeSnippet(parsed.text || stripHtml(parsed.html || '')),
      });
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }

  messages.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  const recent = messages.slice(0, 10);
  return {
    mailboxEmail: config.email,
    messages: recent,
    code: recent.find((message) => message.code)?.code || '',
  };
}

function accountFromMailRequest(body) {
  if (body.rawLine) {
    const parsed = parseAccountLine(body.rawLine, 1);
    if (parsed.ok) {
      return parsed.row;
    }
  }
  return sanitizeAccountForLogin({
    email: body.email || body.openaiEmail || body.mailboxEmail,
    openaiPassword: body.openaiPassword || 'placeholder',
    mailboxEmail: body.mailboxEmail || body.email,
    mailboxPassword: body.mailboxPassword,
    imapHost: body.imapHost,
    imapPort: body.imapPort,
  });
}

async function readJsonBody(req, maxBytes = 1_000_000) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) {
      throw new Error('request body too large');
    }
  }
  if (!body.trim()) {
    return {};
  }
  return JSON.parse(body);
}

async function readAccountsStore(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.accounts)) {
      return { version: 1, accounts: [] };
    }
    return { version: 1, accounts: parsed.accounts };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { version: 1, accounts: [] };
    }
    throw error;
  }
}

async function writeAccountsStore(filePath, store) {
  const payload = {
    version: 1,
    updated_at: formatRFC3339(new Date()),
    accounts: store.accounts,
  };
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

async function upsertStoredAccount(filePath, token) {
  const store = await readAccountsStore(filePath);
  const now = formatRFC3339(new Date());
  const id = storedAccountID(token);
  const next = {
    id,
    email: token.email || '',
    account_id: token.account_id || '',
    type: token.type || 'codex',
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    last_refresh: token.last_refresh,
    expired: token.expired,
    updated_at: now,
  };
  const index = store.accounts.findIndex((account) => account.id === id || (next.email && account.email === next.email));
  if (index >= 0) {
    store.accounts[index] = { ...store.accounts[index], ...next };
  } else {
    store.accounts.push({ ...next, created_at: now });
  }
  await writeAccountsStore(filePath, store);
}

async function deleteStoredAccounts(filePath, { ids, emails }) {
  const store = await readAccountsStore(filePath);
  const before = store.accounts.length;
  const idSet = new Set(ids);
  const emailSet = new Set(emails);
  store.accounts = store.accounts.filter((account) => !idSet.has(account.id) && !emailSet.has(String(account.email || '').toLowerCase()));
  await writeAccountsStore(filePath, store);
  return before - store.accounts.length;
}

function summarizeStoredAccount(account) {
  return {
    id: account.id,
    email: account.email || '',
    account_id: account.account_id || '',
    type: account.type || '',
    last_refresh: account.last_refresh || '',
    expired: account.expired || '',
    updated_at: account.updated_at || '',
    access_token: maskToken(account.access_token),
    refresh_token: maskToken(account.refresh_token),
  };
}

function storedAccountID(token) {
  return hashID(`${String(token.account_id || '').trim()}:${String(token.email || '').trim().toLowerCase()}`);
}

function startEventStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

function writeEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function clampInteger(value, min, max, fallback) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function timeoutAfter(ms, message) {
  return delay(ms).then(() => {
    throw Object.assign(new Error(message), { code: 'manual_required' });
  });
}

async function fillFirstVisible(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.fill(value);
      return true;
    }
  }
  return false;
}

async function clickPrimaryAction(page) {
  await clickFirstVisible(page, [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Continue")',
    'button:has-text("Next")',
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
    'button:has-text("继续")',
    'button:has-text("下一步")',
    'button:has-text("登录")',
  ]);
}

async function clickConsentIfPresent(page) {
  await clickFirstVisible(page, [
    'button:has-text("Allow")',
    'button:has-text("Authorize")',
    'button:has-text("Continue")',
    'button:has-text("同意")',
    'button:has-text("授权")',
  ]);
}

async function clickFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click();
      return true;
    }
  }
  return false;
}

async function isOtpStep(page) {
  const selectors = [
    'input[autocomplete="one-time-code"]',
    'input[name="code"]',
    'input[inputmode="numeric"]',
    'input[type="tel"]',
    'input[type="text"][maxlength="6"]',
  ];
  for (const selector of selectors) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) {
      return true;
    }
  }
  const text = await bodyText(page);
  return /verification code|one-time code|enter code|验证码|校验码/i.test(text);
}

async function fillOtpCode(page, code) {
  const selectors = [
    'input[autocomplete="one-time-code"]',
    'input[name="code"]',
    'input[inputmode="numeric"]',
    'input[type="tel"]',
    'input[type="text"][maxlength="6"]',
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count >= 6) {
      for (let i = 0; i < 6; i += 1) {
        await locator.nth(i).fill(code[i]);
      }
      return;
    }
    if (count > 0 && (await locator.first().isVisible().catch(() => false))) {
      await locator.first().fill(code);
      return;
    }
  }
  throw Object.assign(new Error('无法识别验证码输入框'), { code: 'manual_required' });
}

async function throwIfManualRequired(page) {
  const text = await bodyText(page);
  const manualPatterns = [
    /captcha|verify you are human|cloudflare|just a moment/i,
    /authenticator|two-factor|multi-factor|mfa/i,
    /suspicious|blocked|locked|too many attempts|unusual activity/i,
    /验证码图片|人机验证|身份验证器|账号已锁定|异常活动/i,
  ];
  if (manualPatterns.some((pattern) => pattern.test(text))) {
    throw Object.assign(new Error('页面要求人工验证，已停止自动登录'), { code: 'manual_required' });
  }
}

async function bodyText(page) {
  return page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
}

function looksLikeAuthMail(from, subject, text) {
  const value = `${from}\n${subject}\n${text}`.toLowerCase();
  return /openai|auth0|login|verification|verify|security|验证码|校验码/.test(value);
}

function makeSnippet(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 220);
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ');
}

function classifyLoginFailure(message) {
  const text = String(message || '').toLowerCase();
  if (/mail|imap|验证码|code/.test(text)) {
    return 'mailbox_unavailable';
  }
  if (/manual|captcha|mfa|passkey|人工|验证/.test(text)) {
    return 'manual_required';
  }
  if (/network|timeout|timed out|fetch failed|econnreset/.test(text)) {
    return 'transient';
  }
  return 'login_failed';
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
