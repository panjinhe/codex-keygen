# Codex Keygen

Standalone Codex OAuth key generator for new-api Codex channels.

It runs the same Authorization Code + PKCE flow used by Codex CLI, then prints a channel key JSON containing:

- `access_token`
- `refresh_token`
- `account_id`
- `email`
- `type`
- `last_refresh`
- `expired`

## Usage

### Web UI

```powershell
cd E:\codex-keygen
node .\codex-keygen.mjs --ui
```

Open `http://localhost:1455/`. The UI now has two modes:

- **批量登录辅助器**: import account lines, query mailbox verification codes through IMAP, and run a visible Playwright browser login flow.
- **单账号兼容模式**: click **打开授权页面**, finish login manually, then return to the UI.

The single-account generated channel key is saved as JSON:

```text
E:\codex-keygen\secrets\codex-channel-key.json
```

You can choose a different save path:

```powershell
node .\codex-keygen.mjs --ui --key-file .\secrets\my-codex-key.json
```

Batch login token records are saved to:

```text
E:\codex-keygen\secrets\accounts.json
```

The batch importer supports:

```text
openai_email | openai_password
openai_email | openai_password | mailbox_password
openai_email | openai_password | mailbox_email | mailbox_password
openai_email | openai_password | mailbox_email | mailbox_password | imap_host | imap_port
```

OpenAI passwords and mailbox passwords are only used for the current browser-login request and are not written to `secrets/accounts.json`. Gmail, Outlook, iCloud, QQ, 163, and similar mailboxes usually require an app password or enabled IMAP access.

Install the browser runtime before using automatic login:

```powershell
npm install
npx playwright install chromium
```

### CLI

```powershell
cd E:\codex-keygen
node .\codex-keygen.mjs
```

The tool prints an authorization URL and tries to open it in your browser. After login, the browser redirects to `http://localhost:1455/auth/callback`; the local tool catches that callback and prints the JSON.

If the browser cannot reach the local callback, run:

```powershell
node .\codex-keygen.mjs --manual
```

Then paste the full callback URL from the browser address bar.

To write the key to a file:

```powershell
node .\codex-keygen.mjs --out .\codex-key.json
```

The recommended file format is `.json`, because the new-api Codex channel key is itself a JSON object. The `secrets/` directory is ignored by git.

## Security

The generated JSON is a sensitive credential. Do not share it, commit it, paste it into logs, or store it in a synced folder unless you understand the risk.

Refresh tokens can rotate. Avoid using the same credential in multiple tools at the same time, because one refresh may invalidate the older token copy.

The automatic login flow uses a visible browser and stops when it sees CAPTCHA, passkeys, MFA, account locks, or other manual verification. It is intended for accounts and mailboxes you own or are authorized to use.
