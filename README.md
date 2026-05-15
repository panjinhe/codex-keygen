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

- **批量登录辅助器**: import account lines, query mailbox verification codes through IMAP, and run a visible Playwright browser login flow. Login is intentionally serialized so each generated CPA uses an isolated OAuth flow.
- **单账号兼容模式**: click **打开授权页面**, finish login in the isolated browser window, then return to the UI.

The single-account generated channel key is saved as JSON:

```text
E:\codex-keygen\secrets\codex-channel-key.json
```

Every generated credential is also exported as a separate CPA JSON file named by email:

```text
E:\codex-keygen\secrets\cpa-exports\<email>.json
```

This folder is the recommended output when exporting many CPA files. If the same email is generated again, the file for that email is overwritten with the latest rotated refresh token, so you do not keep multiple fighting copies of the same account.

Avoid generating several CPA files in parallel. OAuth refresh tokens can be invalidated by upstream session/device rotation, so the UI opens isolated browser contexts and runs batch logins one at a time.

You can choose a different save path:

```powershell
node .\codex-keygen.mjs --ui --key-file .\secrets\my-codex-key.json
```

You can choose a different per-email export folder:

```powershell
node .\codex-keygen.mjs --ui --export-dir .\secrets\my-cpa-exports
```

Batch login token records are saved to:

```text
E:\codex-keygen\secrets\accounts.json
```

### CPA flat format

CPA imports expect a flat JSON object, not the nested `auth_mode` / `tokens` format. A safe placeholder template is kept in:

```text
E:\codex-keygen\cpa-template.example.json
```

Use the generated Codex key fields as follows:

- `type`: `codex`
- `email`: generated key `email`
- `expired`: generated key `expired`
- `id_token`: OAuth `id_token` when available
- `account_id`: generated key `account_id`
- `access_token`: generated key `access_token`
- `last_refresh`: generated key `last_refresh`
- `refresh_token`: generated key `refresh_token`
- `plan_type`: `plus`
- `recharge_state`: `plus_ready`

Keep real CPA files under `secrets/` or another ignored private location. Tokens are live credentials.

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
