// ============================================================================
// PClinic Pro — account + encrypted-sync server.
//
// Pure Node.js (node:http + node:crypto). Zero dependencies: `node index.js`
// is the whole install.
//
// ROLE: identity + dumb encrypted-blob storage. Clients (the Android app)
// keep ALL patient data end-to-end encrypted with a key derived from the
// user's password on their device. This server stores:
//   - email + scrypt password hash        (for sign-in)
//   - the account crypto record           (wrapped keys / verifiers)
//   - encrypted data blobs                (ciphertext only)
// It can never read a patient record.
//
// API:
//   GET    /health                  liveness
//   POST   /api/auth/register       {email, password} -> {token, user}
//   POST   /api/auth/login          {email, password} -> {token, user}
//   GET    /api/auth/me             (Bearer) -> {user}
//   POST   /api/auth/logout         (Bearer) -> {ok:true}
//   GET    /api/data                (Bearer) -> {account, blobs}
//   PUT    /api/account             (Bearer) {account} -> {ok:true}
//   PUT    /api/data                (Bearer) {key, data} -> {ok:true, updatedAt}
//   DELETE /api/data/:key           (Bearer) -> {ok:true}
//
// CONFIG (env):
//   PORT              default 8787
//   PCLINIC_SECRET    token signing secret (else generated into .secret)
//   PCLINIC_DATA_FILE data file path (default ./data.json)
//   PCLINIC_CORS      CORS origin, default '*' (set to your app origin in prod)
//
// IMPORTANT: passwords travel to this server at sign-in. Run it behind
// HTTPS (Caddy / nginx / Cloudflare Tunnel) in production — never plain
// HTTP on a public network.
// ============================================================================
'use strict';

const http = require('http');
const auth = require('./auth');
const db = require('./db');

const PORT = parseInt(process.env.PORT || '8787', 10);
const CORS_ORIGIN = process.env.PCLINIC_CORS || '*';
const MAX_BODY = 50 * 1024 * 1024;  // 50 MB — blobs can hold base64 photos

// ------------------------------------------------------------- validation ---
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function passwordProblem(password) {
    const pw = String(password || '');
    if (pw.length < 8) return 'Password must be at least 8 characters.';
    if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password needs a letter and a number.';
    return null;
}

// ------------------------------------------------------------ rate limit ---
// Minimal in-memory throttle: max 10 auth attempts per IP per minute, and a
// per-account lockout after 10 failures within 10 minutes. Resets on restart
// — good enough for a clinic LAN deployment; put a real limiter in front
// (nginx/Caddy) for public internet exposure.
const ipHits = new Map();       // ip -> [timestamps]
const acctFails = new Map();    // email -> {count, firstAt}

function ipAllowed(ip) {
    const now = Date.now();
    const hits = (ipHits.get(ip) || []).filter(t => now - t < 60 * 1000);
    hits.push(now);
    ipHits.set(ip, hits);
    return hits.length <= 10;
}

function acctLocked(email) {
    const rec = acctFails.get(email);
    if (!rec) return false;
    if (Date.now() - rec.firstAt > 10 * 60 * 1000) { acctFails.delete(email); return false; }
    return rec.count >= 10;
}

function acctFail(email) {
    const rec = acctFails.get(email) || { count: 0, firstAt: Date.now() };
    rec.count++;
    acctFails.set(email, rec);
}

function acctClear(email) { acctFails.delete(email); }

// ---------------------------------------------------------------- helpers ---
function send(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Access-Control-Allow-Origin': CORS_ORIGIN,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > MAX_BODY) { reject(new Error('body-too-large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
            catch (e) { reject(new Error('bad-json')); }
        });
        req.on('error', reject);
    });
}

function bearerUser(req) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    const uid = auth.verifyToken(token);
    if (!uid) return null;
    return db.load().users[uid] || null;
}

function publicUser(u) {
    return { id: u.id, email: u.email, createdAt: u.createdAt };
}

// ------------------------------------------------------------------ routes ---
async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const method = req.method;

    if (method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': CORS_ORIGIN,
            'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization'
        });
        return res.end();
    }

    if (method === 'GET' && path === '/health') {
        return send(res, 200, { ok: true, service: 'pclinic-api', time: new Date().toISOString() });
    }

    // ------------------------------------------------------------ register ---
    if (method === 'POST' && path === '/api/auth/register') {
        if (!ipAllowed(clientIp(req))) return send(res, 429, { ok: false, error: 'Too many attempts. Wait a minute.' });
        const body = await readBody(req).catch(() => null);
        if (!body) return send(res, 400, { ok: false, error: 'Invalid request body.' });
        const email = normalizeEmail(body.email);
        if (!EMAIL_RE.test(email)) return send(res, 400, { ok: false, error: 'A valid e-mail address is required.' });
        const problem = passwordProblem(body.password);
        if (problem) return send(res, 400, { ok: false, error: problem });
        const store = db.load();
        if (store.byEmail[email]) return send(res, 409, { ok: false, error: 'An account with this e-mail already exists.' });
        const user = {
            id: db.newId(),
            email,
            pw: auth.hashPassword(String(body.password)),
            createdAt: new Date().toISOString(),
            account: null,
            blobs: {}
        };
        store.users[user.id] = user;
        store.byEmail[email] = user.id;
        db.save();
        return send(res, 201, { ok: true, token: auth.signToken(user.id), user: publicUser(user) });
    }

    // ---------------------------------------------------------------- login ---
    if (method === 'POST' && path === '/api/auth/login') {
        if (!ipAllowed(clientIp(req))) return send(res, 429, { ok: false, error: 'Too many attempts. Wait a minute.' });
        const body = await readBody(req).catch(() => null);
        if (!body) return send(res, 400, { ok: false, error: 'Invalid request body.' });
        const email = normalizeEmail(body.email);
        const store = db.load();
        const id = store.byEmail[email];
        const user = id ? store.users[id] : null;
        if (user && acctLocked(email)) {
            return send(res, 429, { ok: false, error: 'Too many failed attempts. Wait 10 minutes.' });
        }
        // Same message whether the account exists or not (no user enumeration).
        if (!user || !auth.verifyPassword(String(body.password || ''), user.pw)) {
            if (user) acctFail(email);
            return send(res, 401, { ok: false, error: 'Incorrect e-mail or password.' });
        }
        acctClear(email);
        return send(res, 200, { ok: true, token: auth.signToken(user.id), user: publicUser(user) });
    }

    // ------------------------------------------------------------------- me ---
    if (method === 'GET' && path === '/api/auth/me') {
        const user = bearerUser(req);
        if (!user) return send(res, 401, { ok: false, error: 'Not signed in.' });
        return send(res, 200, { ok: true, user: publicUser(user) });
    }

    // --------------------------------------------------------------- logout ---
    if (method === 'POST' && path === '/api/auth/logout') {
        // Tokens are stateless: the client discards its copy. This endpoint
        // exists so the app can confirm the server saw the sign-out.
        return send(res, 200, { ok: true });
    }

    // ------------------------------------------------------------- get data ---
    if (method === 'GET' && path === '/api/data') {
        const user = bearerUser(req);
        if (!user) return send(res, 401, { ok: false, error: 'Not signed in.' });
        return send(res, 200, { ok: true, account: user.account || null, blobs: user.blobs || {} });
    }

    // ------------------------------------------------------- put account ----
    if (method === 'PUT' && path === '/api/account') {
        const user = bearerUser(req);
        if (!user) return send(res, 401, { ok: false, error: 'Not signed in.' });
        const body = await readBody(req).catch(() => null);
        if (!body || typeof body.account === 'undefined') return send(res, 400, { ok: false, error: 'Missing account record.' });
        user.account = body.account;
        db.save();
        return send(res, 200, { ok: true });
    }

    // ------------------------------------------------------------ put blob ----
    if (method === 'PUT' && path === '/api/data') {
        const user = bearerUser(req);
        if (!user) return send(res, 401, { ok: false, error: 'Not signed in.' });
        const body = await readBody(req).catch(() => null);
        if (!body || typeof body.key !== 'string' || !body.key || typeof body.data === 'undefined') {
            return send(res, 400, { ok: false, error: 'Missing key or data.' });
        }
        if (body.key.length > 200) return send(res, 400, { ok: false, error: 'Key too long.' });
        if (!user.blobs) user.blobs = {};
        const updatedAt = new Date().toISOString();
        user.blobs[body.key] = { data: body.data, updatedAt };
        db.save();
        return send(res, 200, { ok: true, updatedAt });
    }

    // --------------------------------------------------------- delete blob ----
    if (method === 'DELETE' && path.startsWith('/api/data/')) {
        const user = bearerUser(req);
        if (!user) return send(res, 401, { ok: false, error: 'Not signed in.' });
        const key = decodeURIComponent(path.slice('/api/data/'.length));
        if (user.blobs) delete user.blobs[key];
        db.save();
        return send(res, 200, { ok: true });
    }

    return send(res, 404, { ok: false, error: 'Not found.' });
}

function clientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
    return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// ------------------------------------------------------------------- start ---
const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
        console.error('[api] error:', err.message);
        if (!res.headersSent) send(res, 500, { ok: false, error: 'Server error.' });
    });
});

if (require.main === module) {
    server.listen(PORT, () => {
        console.log('[api] PClinic account server on http://localhost:' + PORT);
        console.log('[api] Data file: ' + (process.env.PCLINIC_DATA_FILE || './data.json'));
    });
    const shutdown = () => { db.saveNow(); server.close(() => process.exit(0)); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

module.exports = { server, handle };
