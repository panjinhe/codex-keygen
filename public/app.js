const elements = {
  statusPill: document.querySelector('#status-pill'),
  keyFile: document.querySelector('#key-file'),
  startAuth: document.querySelector('#start-auth'),
  loadKey: document.querySelector('#load-key'),
  refreshKey: document.querySelector('#refresh-key'),
  copyKey: document.querySelector('#copy-key'),
  keyJson: document.querySelector('#key-json'),
  summary: document.querySelector('#summary'),
  openImport: document.querySelector('#open-import'),
  importDialog: document.querySelector('#import-dialog'),
  importText: document.querySelector('#import-text'),
  importMeta: document.querySelector('#import-meta'),
  previewImport: document.querySelector('#preview-import'),
  applyImport: document.querySelector('#apply-import'),
  fillSample: document.querySelector('#fill-sample'),
  accountList: document.querySelector('#account-list'),
  selectAll: document.querySelector('#select-all'),
  workers: document.querySelector('#workers'),
  statusFilter: document.querySelector('#status-filter'),
  search: document.querySelector('#search'),
  loginSelected: document.querySelector('#login-selected'),
  retryFailed: document.querySelector('#retry-failed'),
  deleteSelected: document.querySelector('#delete-selected'),
  logs: document.querySelector('#logs'),
  clearLogs: document.querySelector('#clear-logs'),
  mailDialog: document.querySelector('#mail-dialog'),
  mailTitle: document.querySelector('#mail-title'),
  mailContent: document.querySelector('#mail-content'),
};

const searchParams = new URLSearchParams(window.location.search);
const state = {
  accounts: [],
  importedRawLines: new Map(),
  previewRows: [],
  running: false,
};

elements.startAuth.addEventListener('click', startAuth);
elements.loadKey.addEventListener('click', loadKey);
elements.refreshKey.addEventListener('click', refreshKey);
elements.copyKey.addEventListener('click', copyKey);
elements.openImport.addEventListener('click', () => elements.importDialog.showModal());
elements.previewImport.addEventListener('click', previewImport);
elements.applyImport.addEventListener('click', applyImport);
elements.fillSample.addEventListener('click', fillSample);
elements.selectAll.addEventListener('change', toggleSelectAll);
elements.statusFilter.addEventListener('change', renderAccounts);
elements.search.addEventListener('input', renderAccounts);
elements.loginSelected.addEventListener('click', () => loginRows(selectedRows()));
elements.retryFailed.addEventListener('click', () => loginRows(state.accounts.filter((row) => row.selected && row.status === 'failed')));
elements.deleteSelected.addEventListener('click', deleteSelected);
elements.clearLogs.addEventListener('click', () => {
  elements.logs.textContent = '日志已清空。';
});

await loadStatus();
await loadSavedAccounts();
if (searchParams.get('saved') === '1') {
  await loadKey();
  window.history.replaceState({}, '', '/');
}

async function startAuth() {
  setSingleBusy(true);
  try {
    const payload = await api('/api/start', { method: 'POST' });
    const url = payload.data.authorize_url;
    logLine('授权页面已打开。登录完成后，回调页会自动保存 JSON。');
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch (error) {
    logLine(error.message, true);
  } finally {
    setSingleBusy(false);
  }
}

async function loadStatus() {
  try {
    const payload = await api('/api/status');
    elements.keyFile.textContent = payload.data.key_file;
    updateStatus(payload.data.exists, payload.data.summary);
  } catch (error) {
    logLine(error.message, true);
  }
}

async function loadSavedAccounts() {
  try {
    const payload = await api('/api/accounts');
    const existingEmails = new Set(state.accounts.map((row) => row.email.toLowerCase()));
    for (const account of payload.data.accounts) {
      if (existingEmails.has(account.email.toLowerCase())) {
        continue;
      }
      state.accounts.push({
        ...account,
        selected: false,
        status: 'saved',
        error: '',
        source: 'saved',
      });
    }
    renderAccounts();
  } catch (error) {
    logLine(error.message, true);
  }
}

async function previewImport() {
  const text = elements.importText.value;
  try {
    const payload = await api('/api/import-preview', {
      method: 'POST',
      body: JSON.stringify({ accounts: text }),
    });
    state.previewRows = payload.data.rows;
    const rawByLine = new Map();
    text.split(/\r?\n/).forEach((line, index) => {
      if (line.trim()) {
        rawByLine.set(index + 1, line.trim());
      }
    });
    state.previewRows.forEach((row) => {
      state.importedRawLines.set(row.id, rawByLine.get(row.lineNumber) || '');
    });
    elements.importMeta.textContent = `可导入 ${payload.data.valid} 个，无效 ${payload.data.invalid.length} 行，重复 ${payload.data.duplicates.length} 个。`;
    elements.applyImport.disabled = payload.data.valid === 0;
  } catch (error) {
    elements.importMeta.textContent = error.message;
    elements.applyImport.disabled = true;
  }
}

function applyImport() {
  const existing = new Set(state.accounts.map((row) => row.email.toLowerCase()));
  let added = 0;
  for (const row of state.previewRows) {
    if (existing.has(row.email.toLowerCase())) {
      continue;
    }
    existing.add(row.email.toLowerCase());
    added += 1;
    state.accounts.push({
      id: row.id,
      email: row.email,
      mailboxEmail: row.mailboxEmail,
      openaiPasswordMasked: row.openaiPasswordMasked,
      mailboxPasswordMasked: row.mailboxPasswordMasked,
      hasMailboxPassword: row.hasMailboxPassword,
      imapHost: row.imapHost,
      imapPort: row.imapPort,
      selected: true,
      status: 'pending',
      error: '',
      token: null,
      tokenSummary: '',
      source: 'imported',
    });
  }
  elements.importDialog.close();
  logLine(`已导入 ${added} 个账号。`);
  renderAccounts();
}

function fillSample() {
  elements.importText.value = [
    'alice@example.com | openai-password | mailbox-app-password',
    'bob@example.com | openai-password | bob@example.com | mailbox-app-password',
    'carol@example.com | openai-password | carol@example.com | mailbox-app-password | imap.example.com | 993',
  ].join('\n');
  elements.importMeta.textContent = '示例已填入，请替换为自己的账号。';
  elements.applyImport.disabled = true;
}

async function loginRows(rows) {
  if (rows.length === 0 || state.running) {
    return;
  }
  const loginRows = rows
    .map((row) => ({ row, rawLine: state.importedRawLines.get(row.id) || '' }))
    .filter((entry) => entry.rawLine);

  if (loginRows.length === 0) {
    logLine('选中账号没有本次导入的密码信息，刷新页面后需要重新导入再登录。', true);
    return;
  }

  state.running = true;
  setBatchBusy(true);
  for (const entry of loginRows) {
    Object.assign(entry.row, { status: 'running', error: '' });
  }
  renderAccounts();

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workers: Number(elements.workers.value) || 1,
        accounts: loginRows.map((entry) => entry.rawLine),
      }),
    });
    if (!response.ok || !response.body) {
      throw new Error(await response.text());
    }
    await readEventStream(response.body);
  } catch (error) {
    logLine(error.message, true);
  } finally {
    state.running = false;
    setBatchBusy(false);
    renderAccounts();
  }
}

async function readEventStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() || '';
    chunks.forEach(handleEventChunk);
  }
  if (buffer.trim()) {
    handleEventChunk(buffer);
  }
}

function handleEventChunk(chunk) {
  const event = chunk.match(/^event: (.+)$/m)?.[1] || 'message';
  const data = chunk
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .join('\n');
  let payload = {};
  try {
    payload = data ? JSON.parse(data) : {};
  } catch {
    payload = { message: data };
  }

  if (event === 'log') {
    logLine(payload.message || '');
  } else if (event === 'mail') {
    logLine(`${payload.email} 验证码：${payload.code || '未识别'}`);
    updateMail(payload.email, payload.messages || []);
  } else if (event === 'result') {
    applyLoginResult(payload);
  } else if (event === 'error') {
    logLine(payload.error || payload.message || '登录接口异常', true);
  } else if (event === 'done') {
    logLine(`完成：成功 ${payload.ok || 0}，失败 ${payload.failed || 0}。`);
  }
}

function applyLoginResult(result) {
  const row = state.accounts.find((item) => item.email.toLowerCase() === String(result.email || '').toLowerCase());
  if (!row) {
    return;
  }
  row.status = result.ok ? 'success' : 'failed';
  row.error = result.ok ? '' : result.error || '登录失败';
  row.token = result.ok ? result.token : null;
  row.account_id = result.summary?.account_id || row.account_id || '';
  row.expired = result.summary?.expired || row.expired || '';
  row.tokenSummary = result.ok ? `${result.summary?.access_token || 'token'} / ${result.summary?.refresh_token || 'refresh'}` : '';
  renderAccounts();
}

async function deleteSelected() {
  const rows = selectedRows();
  if (rows.length === 0) {
    return;
  }
  const saved = rows.filter((row) => row.source === 'saved' || row.account_id);
  try {
    if (saved.length > 0) {
      await api('/api/delete_accounts', {
        method: 'POST',
        body: JSON.stringify({
          ids: saved.map((row) => row.id),
          emails: saved.map((row) => row.email),
        }),
      });
    }
    state.accounts = state.accounts.filter((row) => !row.selected);
    logLine(`已删除 ${rows.length} 个账号。`);
    renderAccounts();
  } catch (error) {
    logLine(error.message, true);
  }
}

async function showMail(row) {
  elements.mailTitle.textContent = `${row.email} 的邮件`;
  elements.mailContent.textContent = '查询中...';
  elements.mailDialog.showModal();
  const rawLine = state.importedRawLines.get(row.id);
  if (!rawLine) {
    elements.mailContent.textContent = '刷新页面后不会保留邮箱密码，请重新导入后再查询。';
    return;
  }
  try {
    const payload = await api('/api/manual_mail', {
      method: 'POST',
      body: JSON.stringify({ rawLine }),
    });
    updateMail(row.email, payload.data.messages || []);
  } catch (error) {
    elements.mailContent.textContent = error.message;
  }
}

function updateMail(email, messages) {
  if (elements.mailDialog.open) {
    elements.mailTitle.textContent = `${email} 的邮件`;
  }
  if (messages.length === 0) {
    elements.mailContent.textContent = '没有查询到最近验证码邮件。';
    return;
  }
  elements.mailContent.innerHTML = messages
    .map((message) => `
      <article class="mail-item">
        <div><strong>${escapeHtml(message.code || '未识别')}</strong><span>${escapeHtml(formatTime(message.time))}</span></div>
        <p>${escapeHtml(message.subject || '-')}</p>
        <small>${escapeHtml(message.from || '')}</small>
        <em>${escapeHtml(message.snippet || '')}</em>
      </article>
    `)
    .join('');
}

async function loadKey() {
  setSingleBusy(true);
  try {
    const payload = await api('/api/key');
    elements.keyJson.value = payload.data.key;
    elements.copyKey.disabled = false;
    elements.keyFile.textContent = payload.data.key_file;
    updateStatus(true, payload.data.summary);
    logLine('JSON 已读取。');
  } catch (error) {
    elements.copyKey.disabled = true;
    logLine(error.message, true);
  } finally {
    setSingleBusy(false);
  }
}

async function refreshKey() {
  setSingleBusy(true);
  try {
    const payload = await api('/api/refresh', { method: 'POST' });
    elements.keyJson.value = payload.data.key;
    elements.copyKey.disabled = false;
    updateStatus(true, payload.data.summary);
    logLine('凭证已刷新并覆盖保存。');
  } catch (error) {
    logLine(error.message, true);
  } finally {
    setSingleBusy(false);
  }
}

async function copyKey() {
  const value = elements.keyJson.value.trim();
  if (!value) {
    logLine('没有可复制的 JSON。', true);
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    logLine('JSON 已复制。');
  } catch {
    elements.keyJson.select();
    document.execCommand('copy');
    logLine('JSON 已复制。');
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    ...options,
  });
  const payload = await response.json().catch(() => null);
  if (!payload) {
    throw new Error(`请求失败：HTTP ${response.status}`);
  }
  if (!response.ok || !payload.success) {
    throw new Error(payload.message || `请求失败：HTTP ${response.status}`);
  }
  return payload;
}

function renderAccounts() {
  const rows = filteredRows();
  if (rows.length === 0) {
    elements.accountList.innerHTML = '<div class="empty">没有匹配账号。</div>';
  } else {
    elements.accountList.innerHTML = rows.map(renderRow).join('');
    elements.accountList.querySelectorAll('[data-select]').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const row = state.accounts.find((item) => item.id === checkbox.dataset.select);
        if (row) {
          row.selected = checkbox.checked;
          renderActions();
        }
      });
    });
    elements.accountList.querySelectorAll('[data-login]').forEach((button) => {
      button.addEventListener('click', () => {
        const row = state.accounts.find((item) => item.id === button.dataset.login);
        if (row) loginRows([row]);
      });
    });
    elements.accountList.querySelectorAll('[data-mail]').forEach((button) => {
      button.addEventListener('click', () => {
        const row = state.accounts.find((item) => item.id === button.dataset.mail);
        if (row) showMail(row);
      });
    });
  }
  renderStats();
  renderActions();
}

function renderRow(row) {
  return `
    <div class="table-row">
      <label><input data-select="${row.id}" type="checkbox" ${row.selected ? 'checked' : ''}></label>
      <span class="badge ${row.status}">${statusLabel(row.status)}</span>
      <strong title="${escapeHtml(row.email)}">${escapeHtml(row.email)}</strong>
      <span>${escapeHtml(row.openaiPasswordMasked || (row.source === 'saved' ? '未保留' : '-'))}</span>
      <span title="${escapeHtml(row.mailboxEmail || row.email)}">${escapeHtml(row.mailboxEmail || row.email)}</span>
      <span class="error-cell" title="${escapeHtml(row.error || '')}">${escapeHtml(row.error || '-')}</span>
      <span title="${escapeHtml(row.tokenSummary || row.access_token || '')}">${escapeHtml(row.tokenSummary || row.access_token || '-')}</span>
      <span class="row-actions">
        <button class="button tiny" data-login="${row.id}" ${state.running || !state.importedRawLines.has(row.id) ? 'disabled' : ''}>登录</button>
        <button class="button tiny" data-mail="${row.id}" ${!state.importedRawLines.has(row.id) ? 'disabled' : ''}>邮件</button>
      </span>
    </div>
  `;
}

function filteredRows() {
  const filter = elements.statusFilter.value;
  const query = elements.search.value.trim().toLowerCase();
  return state.accounts.filter((row) => {
    const statusOk = filter === 'all' || row.status === filter;
    const queryOk = !query || row.email.toLowerCase().includes(query) || String(row.mailboxEmail || '').toLowerCase().includes(query);
    return statusOk && queryOk;
  });
}

function selectedRows() {
  return state.accounts.filter((row) => row.selected);
}

function toggleSelectAll() {
  const rows = filteredRows();
  rows.forEach((row) => {
    row.selected = elements.selectAll.checked;
  });
  renderAccounts();
}

function renderStats() {
  const counts = {
    total: state.accounts.length,
    pending: state.accounts.filter((row) => row.status === 'pending').length,
    success: state.accounts.filter((row) => row.status === 'success').length,
    failed: state.accounts.filter((row) => row.status === 'failed').length,
    saved: state.accounts.filter((row) => row.status === 'saved').length,
  };
  Object.entries(counts).forEach(([name, value]) => {
    document.querySelector(`#stat-${name}`).textContent = value;
  });
}

function renderActions() {
  const selected = selectedRows();
  const hasLoginable = selected.some((row) => state.importedRawLines.has(row.id));
  const hasFailed = selected.some((row) => row.status === 'failed' && state.importedRawLines.has(row.id));
  elements.loginSelected.disabled = state.running || !hasLoginable;
  elements.retryFailed.disabled = state.running || !hasFailed;
  elements.deleteSelected.disabled = state.running || selected.length === 0;
  elements.selectAll.checked = filteredRows().length > 0 && filteredRows().every((row) => row.selected);
}

function setSingleBusy(isBusy) {
  elements.startAuth.disabled = isBusy;
  elements.loadKey.disabled = isBusy;
  elements.refreshKey.disabled = isBusy;
}

function setBatchBusy(isBusy) {
  elements.openImport.disabled = isBusy;
  elements.loginSelected.disabled = isBusy;
  elements.retryFailed.disabled = isBusy;
  elements.workers.disabled = isBusy;
}

function updateStatus(exists, summary) {
  elements.statusPill.textContent = exists ? '已保存单账号凭证' : '未检测到单账号凭证';
  elements.statusPill.classList.toggle('ok', exists);
  renderSummary(summary);
}

function renderSummary(summary) {
  const values = [
    summary?.account_id || '-',
    summary?.email || '-',
    summary?.expired || '-',
    summary?.last_refresh || '-',
  ];
  elements.summary.querySelectorAll('dd').forEach((node, index) => {
    node.textContent = values[index];
    node.title = values[index];
  });
}

function logLine(message, isError = false) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`;
  if (elements.logs.textContent === '等待操作。' || elements.logs.textContent === '日志已清空。') {
    elements.logs.textContent = line;
  } else {
    elements.logs.textContent += `\n${line}`;
  }
  elements.logs.classList.toggle('has-error', isError);
  elements.logs.scrollTop = elements.logs.scrollHeight;
}

function statusLabel(status) {
  return {
    pending: '待登录',
    running: '登录中',
    success: '成功',
    failed: '失败',
    saved: '已保存',
  }[status] || status || '-';
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
