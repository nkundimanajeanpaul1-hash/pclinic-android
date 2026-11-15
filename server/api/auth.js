// ============================================================================
// auth.js — password hashing + signed tokens. Pure Node crypto, no deps.
//
// Passwords: scrypt (OWASP-recommended interactive parameters). The hash and
// salt are stored server-side; the plaintext password is never stored.
//
// Tokens: stateless HMAC-SHA256. Format: base64url(payload).base64url(sig)
// where payload = { uid, exp }. The secret comes from PCLINIC_SECRET env or
// is generated once and persisted to .secret (gitignored). Rotating the
// secret invalidates every outstanding token (everyone signs in again).
// ============================================================================
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCRYPT_N = 16384;   // CPU/memory cost (OWASP interactive minimum)
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days

// ---------------------------------------------------------------- secret ---
function loadSecret() {
    if (process.env.PCLINIC_SECRET) return process.env.PCLINIC_SECRET;
    const file = path.join(__dirname, '.secret');
    try {
        const existing = fs.readFileSync(file, 'utf8').trim();
        if (existing) return existing;
    } catch (e) { /* not created yet */ }
    const generated = crypto.randomBytes(48).toString('base64url');
    fs.writeFileSync(file, generated, { mode: 0o600 });
    console.warn('[auth] PCLINIC_SECRET not set — generated one and saved to .secret.');
    console.warn('[auth] Set PCLINIC_SECRET in production and keep .secret out of git.');
    return generated;
}
const SECRET = loadSecret();

// -------------------------------------------------------------- passwords ---
function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
    return {
        alg: 'scrypt',
        N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
        salt: salt.toString('base64'),
        hash: hash.toString('base64')
    };
}

function verifyPassword(password, record) {
    if (!record || record.alg !== 'scrypt') return false;
    try {
        const salt = Buffer.from(record.salt, 'base64');
        const expected = Buffer.from(record.hash, 'base64');
        const actual = crypto.scryptSync(String(password), salt, expected.length, {
            N: record.N, r: record.r, p: record.p
        });
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    } catch (e) {
        return false;
    }
}

// ------------------------------------------------------- recovery codes ---
// The app wraps each account's data key with a 100-bit recovery code, using
// the same PBKDF2 -> HKDF derivation as passwords (see deriveAccountKeys in
// www/index.html). The synced account record carries the code's verifier
// (salt + hash), so the server can verify a presented code WITHOUT ever
// knowing it — that is what makes server-side password reset safe.
function normalizeRecoveryCode(code) {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function verifyRecoveryCode(code, record) {
    if (!record || !record.salt || !record.hash) return false;
    try {
        const salt = Buffer.from(record.salt, 'base64');
        const expected = Buffer.from(record.hash, 'base64');
        const master = crypto.pbkdf2Sync(normalizeRecoveryCode(code), salt, record.iter, 32, 'sha256');
        const verifier = Buffer.from(crypto.hkdfSync(
            'sha256', master, Buffer.alloc(0), Buffer.from('pclinic-verifier-v1'), 32));
        return verifier.length === expected.length && crypto.timingSafeEqual(verifier, expected);
    } catch (e) {
        return false;
    }
}

// ----------------------------------------------------------------- tokens ---
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

function signToken(uid) {
    const payload = b64url(JSON.stringify({ uid, exp: Date.now() + TOKEN_TTL_MS }));
    const sig = b64url(crypto.createHmac('sha256', SECRET).update(payload).digest());
    return payload + '.' + sig;
}

function verifyToken(token) {
    if (typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot < 0) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = b64url(crypto.createHmac('sha256', SECRET).update(payload).digest());
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let data;
    try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
    catch (e) { return null; }
    if (!data || !data.uid || !data.exp || Date.now() > data.exp) return null;
    return data.uid;
}

module.exports = { hashPassword, verifyPassword, verifyRecoveryCode, normalizeRecoveryCode, signToken, verifyToken, TOKEN_TTL_MS };
