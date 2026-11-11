# Google Drive silent sync — one-time Cloud Console setup (≈6 min)

The app syncs vault snapshots to Drive's **appDataFolder**: hidden from the
user's Drive UI, per-app, and quota-free. Scope used: `drive.appdata` only.
No client-id string lives in code — Google matches your app by **package name
+ signing-certificate SHA-1**, so you only register an OAuth Android client.

## Steps

1. https://console.cloud.google.com → create (or pick) a project, e.g. `pclinic`.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen**
   - User type: *External* (Internal if you have a Workspace org).
   - App name: `PClinic`; support email: yours.
   - Scopes: **add** `https://www.googleapis.com/auth/drive.appdata`.
   - Test users: add your Google account(s) while the app is in *Testing*.
     (Publish later to remove the 7-day test-token expiry.)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Type: **Android**.
   - Package name: `com.nkundimana.pclinic`
   - SHA-1 fingerprint: from your **release** keystore:
     ```bash
     keytool -list -v -keystore Pclinic.jks -alias YOUR_ALIAS | grep SHA1
     ```
     Add a second client with the **debug** SHA-1 if you test debug builds:
     `~/.android/debug.keystore` (alias `androiddebugkey`, pass `android`).
5. Wait ~5 min for propagation. Done — no code change, no json file needed.

## What the app does with it

- `Storage & Backup → Sign in to Google Drive` → Google sheet → one tap.
- After **every vault save** (debounced 5 s): records.enc + manifest.json are
  upserted into appDataFolder (`pclinic-vault-snapshot.enc`,
  `pclinic-vault-manifest.json`). Silent, no UI.
- **Reinstall flow:** sign in again → the post-install nudge appears →
  `Restore from Drive` → vault repopulated → old data opens.
- `Sign out` revokes the app's access from your side; snapshots stay in
  appDataFolder until Drive cleanup or app-data removal in Drive settings.

## Verifying

- Drive web UI will NOT show these files (that's correct — appDataFolder).
- https://drive.google.com/drive/settings → *Manage apps* → PClinic shows
  hidden data size.
- In-app: Storage & Backup sheet → *Drive: signed in · last sync …*
