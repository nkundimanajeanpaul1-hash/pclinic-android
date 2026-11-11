# SMS relay — deploy checklist

The app is already wired: `sendResetSms()` in `www/index.html` calls this endpoint and
shows "SMS codes are not switched on in this build yet" while `SMS_RELAY_URL` is empty.
Nothing else needs to change in the app except steps 5 and 6 below.

## 1. Pick a provider and get credentials

| | Twilio | Africa's Talking |
|---|---|---|
| Good for | works worldwide | cheap and reliable in Rwanda (MTN/Airtel/Tigo) |
| Get | Account SID + Auth Token + a Twilio phone number | API key + a sender name/short code |
| Cost | per-message, see their Rwanda rate card | local rates, prepaid USD wallet |

For a clinic app used in Rwanda, start with **Africa's Talking** — its sandbox lets you
test without spending, and delivery to local mobiles is better. Use Twilio if you also
need international numbers.

## 2. Install

This folder has its own `firebase.json` (functions source `.`, codebase `sms-relay`), so
every `firebase` command below must be run from inside it. Running them from the repo root
would target the other, unrelated function set.

```
cd server/sms-relay
npm install
npm install -g firebase-tools   # first time only
firebase login
firebase use pclinic-20d81      # writes .firebaserc here
```

## 3. Enable Cloud Functions and set the secrets (never in git, never in www/index.html)

```
firebase projects:addfunctions pclinic-20d81      # must come BEFORE secrets:set
firebase functions:secrets:set AT_API_KEY         # paste the key when prompted
```

Then create `server/sms-relay/.env` (git-ignored — do not commit it, it is uploaded to the
function's environment and nowhere else):

```
SMS_PROVIDER=africas_talking
AT_SENDER=PClinic
```

Twilio instead: `SMS_PROVIDER=twilio`, and store `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_FROM_NUMBER` with `firebase functions:secrets:set` (one command each).

## 4. Deploy and smoke-test

```
firebase deploy --only functions:sendRecoveryCode

curl -sS -X POST https://us-central1-pclinic-20d81.cloudfunctions.net/sendRecoveryCode \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://localhost' \
  -d '{"to":"+250788XXXXXX","code":"123456","app":"pclinic"}'
```

Expected: `{"ok":true}` and the code arrives on that phone. A second call within two
minutes must return HTTP 429 — that is the abuse guard working.

## 5. Point the app at it

In `www/index.html`, find `//  CONFIGURATION — SMS relay` and set:

```
var SMS_RELAY_URL = 'https://us-central1-pclinic-20d81.cloudfunctions.net/sendRecoveryCode';
```

## 6. The CSP already allows the relay

Nothing to do if you deploy to the project in step 5: line 5 of `www/index.html` already
lists `https://us-central1-pclinic-20d81.cloudfunctions.net` in `connect-src`. If you use a
different project, change that one origin too:

```
connect-src 'self' https://api.emailjs.com https://us-central1-<your-project>.cloudfunctions.net
```

Skip it and the app silently gets "Could not send the SMS" — the browser blocks the
request before it reaches the relay.

## 7. Rebuild and ship

```
npm test
npx cap sync android
cd android && sh gradlew assembleDebug
```

Then test on the phone: **Forgot password → type your number → Send a code by SMS**.

## If something goes wrong

- **403** — the request's `Origin` isn't in `ALLOWED_ORIGINS` in `index.js`.
- **400 `to`** — the number lacks a country code; the relay demands `+` followed by 8–15 digits.
- **502 `provider`** — credentials missing or the provider rejected it; check
  `firebase functions:log`.
- **429** — working as designed: one code per number per 2 minutes, 6 per hour.

## Cost guard

This endpoint is public. The throttle is per-instance and in memory, so a scaled-out
deployment multiplies the budget. Check your provider dashboard once a week early on, and
set a hard monthly spend cap in the provider console before you tell anyone the app is
ready.
