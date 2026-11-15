# PClinic Pro — account + encrypted-sync server

> **DEPRECATED (2026-11):** the app now uses **Firebase Auth + Firestore**
> directly (see `FIREBASE` config in `www/index.html`). This custom server
> is kept in the repo for reference and as a fallback, but the app no longer
> calls it. The end-to-end encryption model is identical — only the transport
> changed.

A tiny, dependency-free Node.js server that gives the Android app
**Facebook-style accounts**: sign in with e-mail + password on any device and
your records are there.

## What it does (and doesn't)

| | |
|---|---|
| **Does** | Register / sign in with e-mail + password (scrypt-hashed). Store per-user **encrypted** data blobs + the account crypto record. Issue signed tokens (30 days). |
| **Never does** | See patient data. The app encrypts everything on-device with a key derived from the user's password; this server only ever holds ciphertext. |

## Run it

```bash
cd server/api
node index.js          # listens on http://localhost:8787
```

No `npm install` — there are no dependencies. Node ≥ 18.

## Configuration (environment variables)

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `8787` | Listen port |
| `PCLINIC_SECRET` | generated into `.secret` | Token signing secret. **Set this in production.** Rotating it signs everyone out. |
| `PCLINIC_DATA_FILE` | `./data.json` | Where accounts + blobs live. Back this file up. |
| `PCLINIC_CORS` | `*` | CORS origin. Set to your app's origin in production. |

## Production checklist

1. **HTTPS is mandatory.** Passwords travel to this server at sign-in. Put it
   behind Caddy, nginx, or Cloudflare Tunnel — never expose plain HTTP to the
   public internet.
2. **Set `PCLINIC_SECRET`** to a long random string and keep it in your
   environment, not in git.
3. **Back up `data.json`** (and `.secret`). That file *is* the database.
4. **Point the app at it**: in `www/index.html`, set
   `var API_URL = 'https://your-server.example';` (see the config block near
   `SMS_RELAY_URL`). Leave it `''` for local-only mode.
5. **Allow the origin in the app's CSP**: add your server's origin to
   `connect-src` in the `<meta http-equiv="Content-Security-Policy">` tag at
   the top of `www/index.html`, e.g.
   `connect-src 'self' https://api.emailjs.com https://your-server.example …`.
   Without this the browser blocks every call to the server.
6. **Firewall**: only the API port needs to be open.

## API reference

```
GET    /health                  liveness
POST   /api/auth/register       {email, password}        -> {token, user}
POST   /api/auth/login          {email, password}        -> {token, user}
GET    /api/auth/me             Authorization: Bearer …  -> {user}
POST   /api/auth/logout         Authorization: Bearer …  -> {ok:true}
POST   /api/auth/change-password Authorization: Bearer … {currentPassword, newPassword}
POST   /api/auth/reset-password  {email, recoveryCode, newPassword}
POST   /api/auth/change-email    Authorization: Bearer … {newEmail}
GET    /api/data                Authorization: Bearer …  -> {account, blobs}
PUT    /api/account             Authorization: Bearer …  {account}
PUT    /api/data                Authorization: Bearer …  {key, data}
DELETE /api/data/:key           Authorization: Bearer …  -> {ok:true}
```

**Password reset** works without the old password: the client presents the
account's recovery code (shown once at registration/reset). The server
verifies it against the synced verifier (PBKDF2 → HKDF, same derivation the
app uses) and never learns the code. This keeps the server password in step
with the on-device password, so other devices keep working after a reset.

Errors are `{ok:false, error:"…"}` with 400 / 401 / 409 / 429 / 500.
Login failures never reveal whether an e-mail exists.

## Tests

```bash
npm test     # 18 tests: 15 API contracts + 3 end-to-end (device A -> server -> device B)
```

The end-to-end tests replicate the app's exact crypto (PBKDF2 + HKDF +
AES-GCM) and prove a second device can sign in with e-mail + password and
recover the same records — including after a password change and a
recovery-code reset — while the server's disk holds ciphertext only.

## Security notes

- Passwords: scrypt N=16384/r=8/p=1, 16-byte salt, 64-byte hash.
- Tokens: HMAC-SHA256, 30-day expiry, stateless (logout = client discards).
- Rate limits: 10 auth attempts/IP/minute; per-account lockout after 10
  failures in 10 minutes. In-memory — resets on restart. For public-internet
  exposure, add a limiter at the reverse proxy too.
- The server stores **no plaintext patient data, ever**. If `data.json`
  leaks, an attacker gets password hashes and ciphertext — not records.
