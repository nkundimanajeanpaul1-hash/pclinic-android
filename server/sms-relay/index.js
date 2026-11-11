// PClinic Pro — SMS relay for password-recovery codes.
//
// WHY THIS EXISTS: the app is 100% client-side, so a Twilio / Africa's Talking
// key placed in www/index.html ships inside the APK and is public. The key lives
// here instead, on the server, and the app only ever sees this URL.
//
// CONTRACT (matches sendRecoverySms() in www/index.html):
//   POST {to:"+250788123456", code:"482913", app:"pclinic"}
//   -> 200 {ok:true}            delivered
//   -> 4xx {ok:false, error:…}  refused (the app then shows "could not send")
//
// The code is a 6-digit string generated on the user's device. This relay never
// sees a username, a password, or a patient record.
//
// DEPLOY — do NOT drop this into ../functions without merging: a Firebase deploy
// replaces the whole function set of its source directory, so pointing it at a
// second project would delete the functions you already ship. Either deploy this
// folder as its own project/dir, or copy sendRecoveryCode into your existing
// functions/index.js.
//
//   cd server/sms-relay && npm install && firebase deploy --only functions
//
// SECRETS (never commit these):
//   firebase functions:secrets:set TWILIO_ACCOUNT_SID
//   firebase functions:secrets:set TWILIO_AUTH_TOKEN
//   firebase functions:secrets:set TWILIO_FROM_NUMBER        e.g. +1xxxxxxxxxx
//   export SMS_PROVIDER=twilio                               or: africas_talking
//   # Africa's Talking instead: SMS_PROVIDER=africas_talking,
//   # AT_API_KEY, AT_SENDER (e.g. "PClinic")
//
// AFTER DEPLOYING, in www/index.html:
//   1. var SMS_RELAY_URL = 'https://us-central1-<project>.cloudfunctions.net/sendRecoveryCode';
//   2. add https://us-central1-<project>.cloudfunctions.net to connect-src in the
//      CSP meta tag at the top of the file, or the app blocks its own request.
//   3. add the same origin to ALLOWED_ORIGINS below.

const { onRequest } = require('firebase-functions/v2/https');

const ALLOWED_ORIGINS = new Set([
    'https://localhost',            // the Capacitor Android WebView
    'https://pclinic-20d81.web.app',
    'https://pclinic-20d81.firebaseapp.com'
]);

// One code per number per 2 minutes, and 6 per number per hour. Without this a
// public endpoint becomes a free SMS bomb and a bill you did not plan for.
const MIN_INTERVAL_MS = 2 * 60 * 1000;
const HOUR_BUDGET = 6;
const sends = new Map(); // number -> [timestamps]; per instance, good enough for a
                         // single-region trial. Move to Firestore if you scale out.

function throttleOk(now, to) {
    const hits = (sends.get(to) || []).filter((t) => now - t < 3600 * 1000);
    if (hits.some((t) => now - t < MIN_INTERVAL_MS)) return false;
    if (hits.length >= HOUR_BUDGET) return false;
    hits.push(now);
    sends.set(to, hits);
    return true;
}

function readJson(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    return {};
}

function validTarget(to) {
    return typeof to === 'string' && /^\+\d{8,15}$/.test(to);
}

function validCode(code) {
    return typeof code === 'string' && /^\d{6}$/.test(code);
}

async function viaTwilio(to, code) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM_NUMBER;
    if (!sid || !token || !from) throw new Error('twilio credentials missing');
    const body = new URLSearchParams({ To: to, From: from, Body: code });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
            Authorization: 'Basic ' + Buffer.from(sid + ':' + token).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
    });
    if (!res.ok) throw new Error('twilio rejected the send: HTTP ' + res.status);
}

async function viaAfricasTalking(to, code) {
    const key = process.env.AT_API_KEY;
    const sender = process.env.AT_SENDER || 'PClinic';
    if (!key) throw new Error('AT_API_KEY missing');
    const res = await fetch('https://api.africastalking.com/version1/messaging', {
        method: 'POST',
        headers: { apiKey: key, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ To: to, From: sender, Message: code })
    });
    if (!res.ok) throw new Error('africas talking rejected the send: HTTP ' + res.status);
}

exports.sendRecoveryCode = onRequest(
    { cors: false, timeoutSeconds: 16, memory: '128MB' },
    async (req, res) => {
        const origin = req.headers.origin || '';
        if (origin && !ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ ok: false, error: 'origin' });
        if (req.method === 'OPTIONS') {
            res.set('Access-Control-Allow-Origin', ALLOWED_ORIGINS.has(origin) ? origin : '');
            res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
            res.set('Access-Control-Allow-Headers', 'Content-Type');
            return res.status(204).end();
        }
        if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method' });

        const { to, code, app } = readJson(req);
        if (app !== 'pclinic') return res.status(400).json({ ok: false, error: 'app' });
        if (!validTarget(to)) return res.status(400).json({ ok: false, error: 'to' });
        if (!validCode(code)) return res.status(400).json({ ok: false, error: 'code' });
        if (!throttleOk(Date.now(), to)) return res.status(429).json({ ok: false, error: 'rate' });

        try {
            if (process.env.SMS_PROVIDER === 'africas_talking') await viaAfricasTalking(to, code);
            else await viaTwilio(to, code);
            // Log the delivery, never the code.
            console.log('sms sent', { to: to.slice(0, 7) + '•••' });
            res.set('Access-Control-Allow-Origin', ALLOWED_ORIGINS.has(origin) ? origin : '');
            return res.json({ ok: true });
        } catch (e) {
            console.warn('sms send failed', e && e.message);
            return res.status(502).json({ ok: false, error: 'provider' });
        }
    }
);
