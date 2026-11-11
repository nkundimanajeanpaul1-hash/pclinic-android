# Google Drive — setup checklist

The app is already wired: `GoogleDrivePlugin.java` signs in with `play-services-auth` and
asks for one scope, `https://www.googleapis.com/auth/drive.appdata`. Uploads go to Drive's
hidden per-app folder (`appDataFolder`), which does not appear in the user's Drive list.
Nothing in the code changes, and there is no client ID to paste anywhere — Google matches
the app by **package name + the SHA-1 of the certificate that signed the APK**.

| | |
|---|---|
| package name | `com.nkundimana.pclinic` |
| scope | `https://www.googleapis.com/auth/drive.appdata` (sensitive) |
| signing keys | debug keystore for test builds, `Pclinic-2026.jks` for clinic builds |
| needed in repo | nothing — no `google-services.json`, no client secret |

## 1. Decide who will sign in — do this before touching the console

`drive.appdata` counts as a **sensitive** scope, so Google restricts an unverified app.

| | Internal | External + Testing | External + Production |
|---|---|---|---|
| Who | clinic on Google Workspace (own domain) | personal Gmail accounts, trial phase | many/unknown users, shipped app |
| Google review | none | none | sensitive-scope verification, up to ~10 days |
| User cap | Workspace domain | 100 test users | none |
| Consent lifetime | stays | **expires after 7 days** — users re-approve weekly | stays |
| Pick when | all staff sit in one Workspace domain | you can live with a weekly re-tap | the clinic is past the trial |

If Test users is the answer, remember the 7-day expiry is a *consent* expiry, not a bug:
the next backup asks for "Allow" again. Tell staff to press **Back up now** weekly rather
than assuming the silent path still runs.

## 2. Read both fingerprints

Debug (already read on this machine):
```
88:E7:9D:88:37:7D:6D:45:B5:B9:CC:43:D0:00:83:01:57:31:87:06
```
Release — signed with `Pclinic-2026.jks`, already read:
```
E2:17:F8:E5:64:34:D2:F9:3D:BE:9F:38:4F:09:FE:61:F8:CF:7D:50
```
Re-read it any time from the APK itself:
```
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
"/Users/apple/Library/Android/sdk/build-tools/36.0.0/apksigner" verify --print-certs \
  android/app/build/outputs/apk/release/app-release.apk
```

## 3. Google Cloud console

1. `console.cloud.google.com` → create a project (e.g. `pclinic-drive`).
2. *APIs & Services → Library* → **Google Drive API** → **Enable**. Skipping this gives
   `403` on upload even though sign-in succeeded.
3. *Google Auth platform → Get started* → build the consent screen per step 1.
   App name `PClinic Pro`, your support e-mail.
4. Add the scope `.../auth/drive.appdata` on the consent screen's *Data access* page.
5. *Credentials → Create credentials → OAuth client ID → **Android***:
   package `com.nkundimana.pclinic`, SHA-1 = debug fingerprint.
6. Create a second **Android** client with the release fingerprint. Both must exist while
   you test both builds; deleting the debug one breaks test phones.

The client IDs are not secrets. There is no secret to protect here — appdata files are
encrypted by the app before they are uploaded anyway.

## 4. Prove it on a phone

Install a build signed by the key whose fingerprint you registered — debug APK for the
debug client, release APK for the release client. Then sign in to Drive in the app and run
a backup.

Check which key actually signed what you installed:
```
"/Users/apple/Library/Android/sdk/build-tools/36.0.0/apksigner" verify --print-certs \
  android/app/build/outputs/apk/release/app-release.apk
```
The `SHA-1 digest` it prints must equal what you typed into the console. Change the key
later and every client has to be re-registered (and old installs uninstalled, because
Android refuses to update an app whose signature changed).

## Troubleshooting

- **`DEVELOPER_ERROR (10)`**, or the account picker closes at once — package name or SHA-1
  does not match the APK you installed. Re-read the fingerprint from the APK itself.
- **`403` / "insufficient permissions" on upload** — Drive API not enabled in that project,
  or the scope was never added to the consent screen.
- **"Access blocked: PClinic Pro has not completed verification"** — consent screen is
  Testing and this Gmail address is not in *Test users*.
- **Sign-in works, then fails a week later** — the 7-day test-user consent expiry. Either
  re-approve, finish verification, or move the clinic to an Internal (Workspace) app.
- **File missing from Drive** — it is in `appDataFolder` by design; it is not visible in
  the Drive UI, only to the app that wrote it.
- **`signIn` returns `signedIn:false` with no error** — the user backed out of the picker;
  the app treats that as "not signed in", which is correct.
