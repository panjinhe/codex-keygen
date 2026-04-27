const elements = {
  statusPill: document.querySelector('#status-pill'),
  keyFile: document.querySelector('#key-file'),
  message: document.querySelector('#message'),
  startAuth: document.querySelector('#start-auth'),
  loadKey: document.querySelector('#load-key'),
  refreshKey: document.querySelector('#refresh-key'),
  copyKey: document.querySelector('#copy-key'),
  keyJson: document.querySelector('#key-json'),
  summary: document.querySelector('#summary'),
};

const searchParams = new URLSearchParams(window.location.search);

elements.startAuth.addEventListener('click', startAuth);
elements.loadKey.addEventListener('click', loadKey);
elements.refreshKey.addEventListener('click', refreshKey);
elements.copyKey.addEventListener('click', copyKey);

await loadStatus();
if (searchParams.get('saved') === '1') {
  await loadKey();
  window.history.replaceState({}, '', '/');
}

async function startAuth() {
  setBusy(true);
  try {
    const payload = await api('/api/start', { method: 'POST' });
    const url = payload.data.authorize_url;
    setMessage('授权页面已打开。登录完成后，回调页会自动保存 JSON。');
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function loadStatus() {
  try {
    const payload = await api('/api/status');
    elements.keyFile.textContent = payload.data.key_file;
    updateStatus(payload.data.exists, payload.data.summary);
  } catch (error) {
    setMessage(error.message, true);
  }
}

async function loadKey() {
  setBusy(true);
  try {
    const payload = await api('/api/key');
    elements.keyJson.value = payload.data.key;
    elements.copyKey.disabled = false;
    elements.keyFile.textContent = payload.data.key_file;
    updateStatus(true, payload.data.summary);
    setMessage('JSON 已读取。');
  } catch (error) {
    elements.copyKey.disabled = true;
    setMessage(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function refreshKey() {
  setBusy(true);
  try {
    const payload = await api('/api/refresh', { method: 'POST' });
    elements.keyJson.value = payload.data.key;
    elements.copyKey.disabled = false;
    updateStatus(true, payload.data.summary);
    setMessage('凭证已刷新并覆盖保存。');
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function copyKey() {
  const value = elements.keyJson.value.trim();
  if (!value) {
    setMessage('没有可复制的 JSON。', true);
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    setMessage('JSON 已复制。');
  } catch {
    elements.keyJson.select();
    document.execCommand('copy');
    setMessage('JSON 已复制。');
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { Accept: 'application/json' },
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

function updateStatus(exists, summary) {
  elements.statusPill.textContent = exists ? '已保存凭证' : '未检测到凭证';
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

function setBusy(isBusy) {
  elements.startAuth.disabled = isBusy;
  elements.loadKey.disabled = isBusy;
  elements.refreshKey.disabled = isBusy;
}

function setMessage(message, isError = false) {
  elements.message.textContent = message;
  elements.message.classList.toggle('error', isError);
}
