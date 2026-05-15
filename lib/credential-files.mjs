export function credentialFilename(key) {
  const identity = String(key?.email || key?.account_id || 'codex-credential').trim();
  return `${safeCredentialBasename(identity)}.json`;
}

export function safeCredentialBasename(value) {
  const cleaned = String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
  return cleaned || 'codex-credential';
}
