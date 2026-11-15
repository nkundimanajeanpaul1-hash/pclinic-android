# PClinic Pro — Capacitor Android app

Offline-first clinic backup companion. Single-page app in `www/` (fully vendored:
EmailJS + Capacitor Filesystem live in `www/vendor/`), packaged as a native
Android app via Capacitor 8.

## Structure

```
www/                  single-page app (index.html + vendor/capacitor-filesystem.js,
                      vendor/email.min.js, vendor/capacitor-filesystem.js)
android/              native Android project (signing is properties-gated)
server/api/           account + encrypted-sync server (pure Node, zero deps)
server/sms-relay/     SMS relay for password-recovery codes (Firebase Function)
resources/            icon source for Play assets
tests/                smoke contracts (node --test)
capacitor.config.json app id, webDir, https scheme, splash/statusbar
android/keystore.properties.example  → copy to keystore.properties to sign
```

## Accounts — Facebook-style sign-in (any device)

With `API_URL` set in `www/index.html` (see `server/api/README.md`), users
register and sign in with **e-mail + password** against the account server
(`server/api/`, pure Node, zero dependencies — `node index.js` runs it).
The server holds the account and a replica of the user's **encrypted**
records, so the same account works on any device: sign in on a new phone and
your records download and decrypt locally.

The encryption model is unchanged and end-to-end: the data key is derived
from the password **on the device** (PBKDF2 → HKDF → AES-GCM) and never
leaves it. The server stores only ciphertext + wrapped keys — it cannot read
a patient record. The local vault stays the working copy, so the app keeps
working offline; sync pushes/pulls happen when connectivity allows
(last-write-wins per record, queued while offline).

With `API_URL = ''` (default) the app is local-only: accounts live on the
device, exactly as before. The login field accepts a username **or** an
e-mail; unknown accounts fall through to the server (new-device sign-in).

## Bootstrap (first build)

```bash
npm ci                 # Capacitor CLI + Android platform
npx cap sync android   # regenerates capacitor-cordova-android-plugins,
                       # wires node_modules capacitor-android, copies www → assets
```

`cap sync` must be re-run after ANY change in `www/`.

## Run / develop

```bash
npx cap open android   # Android Studio
npm test               # smoke contracts
```

## Release signing (B2)

The release keystore `Pclinic.jks` lives **outside** this repository
(`../keys/Pclinic.jks` on this machine). To sign:

1. `cp android/keystore.properties.example android/keystore.properties`
2. Fill `storeFile` (absolute path to the .jks) + passwords.
3. `npm run build:release` → signed APK in `android/app/build/outputs/apk/release/`.

`keystore.properties` and `*.jks` are gitignored — they must NEVER be committed
or shipped in a zip. If a keystore ever leaves your machine, **rotate it**
(Play App Signing upload-key reset) before the next release.

## Security posture

- CSP meta pins sources: `'self'` + `https://api.emailjs.com` (connect only);
  EmailJS itself is vendored so the app works with no network.
- No `document.write`, no `eval`; printing via hidden-iframe `srcdoc`.
- "Drive backup" is honest: uploads go through the Android **share sheet**;
  no fake OAuth token is minted or stored.
- `allowBackup=false`, scoped FileProvider, launcher-only exported activity.

## Backups flow (product)

1. Share sheet → Drive / e-mail / USB / Files.
2. Optional email backup via vendored EmailJS (`connect-src` pinned).
3. Restore from a `.json` file picker inside the app.

## Play assets (H4)

`resources/icon.png` is the source. When network is available:

```bash
npx @capacitor/assets generate --android --assetPath resources
```

(regenerates adaptive icon + splash; otherwise Capacitor defaults ship.)

## Device Vault — where the data really lives
The vault is the source of truth: a hidden, app-private folder
`Android/data/com.nkundimana.pclinic/files/pclinic_vault/` holding
`records.enc` (AES-GCM, per-account key) + `manifest.json` (SHA-256, count, time).
`localStorage` is only a legacy source — migrated once into the vault, then purged.

Three durability tiers, all silent after first setup:
1. **Vault** — every save writes the hidden device folder (debounced 700 ms).
2. **Mirror** — user grants a shared-storage folder once (Storage & Backup →
   *Choose mirror folder*); the vault is copied into a hidden `.pclinic-vault`
   dir there. Survives uninstall. Restore: *Restore from device mirror*.
3. **Drive appDataFolder** — after Google sign-in (`drive.appdata` scope),
   every save silently upserts a snapshot. Survives device loss. Restore:
   *Restore from Drive*. One-time Cloud Console setup: `GOOGLE-OAUTH-SETUP.md`.

Native halves: `VaultMirrorPlugin.java` (SAF tree) + `GoogleDrivePlugin.java`
(REST via GoogleAuthUtil token; no client-id string in code — package + SHA-1).
Browser preview has no plugins: everything degrades to the encrypted-localStorage
fallback and the sheet says so honestly.
