import { createHash } from 'node:crypto';

const EMAIL_RE = /^[^\s@|:]+@[^\s@|:]+\.[^\s@|:]+$/i;

const IMAP_HOSTS = new Map([
  ['gmail.com', { host: 'imap.gmail.com', port: 993, secure: true }],
  ['googlemail.com', { host: 'imap.gmail.com', port: 993, secure: true }],
  ['outlook.com', { host: 'outlook.office365.com', port: 993, secure: true }],
  ['hotmail.com', { host: 'outlook.office365.com', port: 993, secure: true }],
  ['live.com', { host: 'outlook.office365.com', port: 993, secure: true }],
  ['msn.com', { host: 'outlook.office365.com', port: 993, secure: true }],
  ['yahoo.com', { host: 'imap.mail.yahoo.com', port: 993, secure: true }],
  ['icloud.com', { host: 'imap.mail.me.com', port: 993, secure: true }],
  ['me.com', { host: 'imap.mail.me.com', port: 993, secure: true }],
  ['qq.com', { host: 'imap.qq.com', port: 993, secure: true }],
  ['163.com', { host: 'imap.163.com', port: 993, secure: true }],
  ['126.com', { host: 'imap.126.com', port: 993, secure: true }],
  ['yeah.net', { host: 'imap.yeah.net', port: 993, secure: true }],
  ['sina.com', { host: 'imap.sina.com', port: 993, secure: true }],
  ['sina.cn', { host: 'imap.sina.com', port: 993, secure: true }],
]);

export function parseAccountText(text) {
  const seen = new Map();
  const rows = [];
  const invalid = [];
  const duplicates = [];
  const lines = String(text || '').split(/\r?\n/);

  lines.forEach((line, index) => {
    const rawLine = line.trim();
    const lineNumber = index + 1;
    if (!rawLine) {
      return;
    }

    const parsed = parseAccountLine(rawLine, lineNumber);
    if (!parsed.ok) {
      invalid.push({ lineNumber, rawLine, reason: parsed.reason });
      return;
    }

    const key = parsed.row.email.toLowerCase();
    if (seen.has(key)) {
      duplicates.push({ lineNumber, email: parsed.row.email, firstLineNumber: seen.get(key) });
      return;
    }

    seen.set(key, lineNumber);
    rows.push(parsed.row);
  });

  return {
    total: lines.filter((line) => line.trim()).length,
    rows,
    invalid,
    duplicates,
  };
}

export function parseAccountLine(rawLine, lineNumber = 1) {
  const parts = splitAccountLine(rawLine);
  if (!parts) {
    return { ok: false, reason: '格式不支持' };
  }

  const [email, openaiPassword, mailboxEmailOrPassword, mailboxPassword, imapHost, imapPort] = parts;
  if (!isEmail(email)) {
    return { ok: false, reason: 'OpenAI 邮箱格式不正确' };
  }
  if (!openaiPassword) {
    return { ok: false, reason: '缺少 OpenAI 密码' };
  }

  let mailboxEmail = email;
  let resolvedMailboxPassword = '';
  if (parts.length === 3) {
    resolvedMailboxPassword = mailboxEmailOrPassword;
  } else if (parts.length >= 4) {
    mailboxEmail = mailboxEmailOrPassword || email;
    resolvedMailboxPassword = mailboxPassword;
  }

  if (mailboxEmail && !isEmail(mailboxEmail)) {
    return { ok: false, reason: '邮箱账号格式不正确' };
  }

  const port = imapPort ? Number(imapPort) : undefined;
  if (imapPort && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
    return { ok: false, reason: 'IMAP 端口不正确' };
  }

  return {
    ok: true,
    row: {
      id: hashID(`${lineNumber}:${email}:${rawLine}`),
      lineNumber,
      rawLine,
      email,
      openaiPassword,
      mailboxEmail,
      mailboxPassword: resolvedMailboxPassword || '',
      imapHost: imapHost || '',
      imapPort: port,
    },
  };
}

export function toSafeImportedRow(row) {
  return {
    id: row.id,
    lineNumber: row.lineNumber,
    email: row.email,
    mailboxEmail: row.mailboxEmail,
    openaiPasswordMasked: maskSecret(row.openaiPassword),
    mailboxPasswordMasked: row.mailboxPassword ? maskSecret(row.mailboxPassword) : '',
    hasMailboxPassword: Boolean(row.mailboxPassword),
    imapHost: row.imapHost || inferImapConfig(row.mailboxEmail)?.host || '',
    imapPort: row.imapPort || inferImapConfig(row.mailboxEmail)?.port || '',
  };
}

export function inferImapConfig(email) {
  const domain = String(email || '').split('@').pop()?.toLowerCase();
  if (!domain) {
    return null;
  }
  return IMAP_HOSTS.get(domain) || null;
}

export function buildMailboxConfig(account) {
  const mailboxEmail = String(account.mailboxEmail || account.email || '').trim();
  const mailboxPassword = String(account.mailboxPassword || '').trim();
  const inferred = inferImapConfig(mailboxEmail);
  const host = String(account.imapHost || inferred?.host || '').trim();
  const port = Number(account.imapPort || inferred?.port || 993);
  const secure = account.imapSecure === undefined ? true : Boolean(account.imapSecure);

  if (!mailboxEmail || !isEmail(mailboxEmail)) {
    throw Object.assign(new Error('邮箱账号格式不正确'), { code: 'mailbox_invalid_email' });
  }
  if (!mailboxPassword) {
    throw Object.assign(new Error('缺少邮箱密码或 app password'), { code: 'mailbox_password_required' });
  }
  if (!host) {
    throw Object.assign(new Error('无法识别邮箱 IMAP 服务，请提供 imap_host 和 imap_port'), {
      code: 'mailbox_config_required',
    });
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw Object.assign(new Error('IMAP 端口不正确'), { code: 'mailbox_invalid_port' });
  }

  return { email: mailboxEmail, password: mailboxPassword, host, port, secure };
}

export function extractVerificationCode(...values) {
  const text = values
    .map((value) => String(value || ''))
    .join('\n')
    .replace(/\s+/g, ' ');

  const preferredPatterns = [
    /(?:verification|verify|security|login|sign[- ]?in|one[- ]?time|code|验证码|校验码|登录)[^\d]{0,80}(\d{6})(?!\d)/i,
    /(\d{6})(?!\d)[^\d]{0,80}(?:verification|verify|security|login|sign[- ]?in|one[- ]?time|code|验证码|校验码|登录)/i,
  ];

  for (const pattern of preferredPatterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1];
    }
  }

  const fallback = text.match(/(?<!\d)(\d{6})(?!\d)/);
  return fallback?.[1] || '';
}

export function sanitizeAccountForLogin(account) {
  return {
    id: account.id || hashID(`${account.email}:${Date.now()}`),
    lineNumber: account.lineNumber || 0,
    rawLine: account.rawLine || '',
    email: String(account.email || '').trim(),
    openaiPassword: String(account.openaiPassword || '').trim(),
    mailboxEmail: String(account.mailboxEmail || account.email || '').trim(),
    mailboxPassword: String(account.mailboxPassword || '').trim(),
    imapHost: String(account.imapHost || '').trim(),
    imapPort: account.imapPort ? Number(account.imapPort) : undefined,
  };
}

export function maskSecret(value) {
  const text = String(value || '');
  if (!text) {
    return '';
  }
  if (text.length <= 4) {
    return '*'.repeat(text.length);
  }
  return `${text.slice(0, 1)}${'*'.repeat(Math.min(10, text.length - 2))}${text.slice(-1)}`;
}

export function hashID(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function splitAccountLine(rawLine) {
  if (rawLine.includes('|')) {
    const parts = rawLine.split('|').map((part) => part.trim());
    if ([2, 3, 4, 6].includes(parts.length)) {
      return parts;
    }
    return null;
  }

  const colonIndex = rawLine.indexOf(':');
  if (colonIndex > 0) {
    return [rawLine.slice(0, colonIndex).trim(), rawLine.slice(colonIndex + 1).trim()];
  }

  return null;
}

function isEmail(value) {
  return EMAIL_RE.test(String(value || '').trim());
}
