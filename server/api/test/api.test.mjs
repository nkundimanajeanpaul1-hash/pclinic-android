// PClinic API server — contract tests. Run: npm test  (from server/api)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pclinic-api-'));
const dataFile = path.join(tmp, 'data.json');
const PORT = 18787;
const BASE = `http://127.0.0.1:${PORT}`;

let proc;
let token = null;

async function req(method, p, body, tok) {
    const res = await fetch(BASE + p, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(tok ? { Authorization: `Bearer ${tok}` } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, json };
}

before(async () => {
    proc = spawn('node', [path.join(dir, '..', 'index.js')], {
        env: { ...process.env, PORT: String(PORT), PCLINIC_DATA_FILE: dataFile, PCLINIC_SECRET: 'test-secret', PCLINIC_IP_LIMIT: '1000' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    // Wait for the server to accept connections.
    for (let i = 0; i < 50; i++) {
        try {
            const r = await fetch(BASE + '/health');
            if (r.ok) return;
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('server did not start');
});

after(() => {
    proc.kill('SIGTERM');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('health endpoint answers', async () => {
    const { status, json } = await req('GET', '/health');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
});

test('register creates an account and returns a token', async () => {
    const { status, json } = await req('POST', '/api/auth/register', {
        email: 'Nurse@Example.com', password: 'clinic2026'
    });
    assert.equal(status, 201);
    assert.equal(json.ok, true);
    assert.ok(json.token);
    assert.equal(json.user.email, 'nurse@example.com');  // normalized
    token = json.token;
});

test('duplicate e-mail is rejected', async () => {
    const { status } = await req('POST', '/api/auth/register', {
        email: 'nurse@example.com', password: 'clinic2026'
    });
    assert.equal(status, 409);
});

test('weak password is rejected', async () => {
    const { status, json } = await req('POST', '/api/auth/register', {
        email: 'weak@example.com', password: 'short'
    });
    assert.equal(status, 400);
    assert.match(json.error, /at least 8/);
});

test('login with wrong password fails without revealing the account exists', async () => {
    const { status, json } = await req('POST', '/api/auth/login', {
        email: 'nurse@example.com', password: 'wrongpass1'
    });
    assert.equal(status, 401);
    assert.match(json.error, /Incorrect/);
});

test('login with correct password succeeds', async () => {
    const { status, json } = await req('POST', '/api/auth/login', {
        email: 'nurse@example.com', password: 'clinic2026'
    });
    assert.equal(status, 200);
    assert.ok(json.token);
    token = json.token;
});

test('me requires a valid token', async () => {
    const noTok = await req('GET', '/api/auth/me');
    assert.equal(noTok.status, 401);
    const badTok = await req('GET', '/api/auth/me', null, 'garbage.token');
    assert.equal(badTok.status, 401);
    const good = await req('GET', '/api/auth/me', null, token);
    assert.equal(good.status, 200);
    assert.equal(good.json.user.email, 'nurse@example.com');
});

test('encrypted blobs round-trip (server stores ciphertext only)', async () => {
    const blob = { iv: 'abc', ct: 'ENCRYPTED-PATIENT-DATA', v: 2 };
    const put = await req('PUT', '/api/data', { key: 'pclinic_data_u1', data: blob }, token);
    assert.equal(put.status, 200);
    assert.ok(put.json.updatedAt);

    const get = await req('GET', '/api/data', null, token);
    assert.equal(get.status, 200);
    assert.deepEqual(get.json.blobs['pclinic_data_u1'].data, blob);

    // The data file on disk must contain the ciphertext, never plaintext keys.
    // (db.save() debounces ~50ms, so give it a moment to flush.)
    await new Promise(r => setTimeout(r, 200));
    const onDisk = fs.readFileSync(dataFile, 'utf8');
    assert.ok(onDisk.includes('ENCRYPTED-PATIENT-DATA'));
    assert.ok(!onDisk.includes('clinic2026'), 'password must never be stored in plaintext');
});

test('account crypto record round-trips', async () => {
    const account = { pw: { v: 2, salt: 's', hash: 'h' }, dek: 'WRAPPED-KEY' };
    const put = await req('PUT', '/api/account', { account }, token);
    assert.equal(put.status, 200);
    const get = await req('GET', '/api/data', null, token);
    assert.deepEqual(get.json.account, account);
});

test('data endpoints reject unauthenticated requests', async () => {
    assert.equal((await req('GET', '/api/data')).status, 401);
    assert.equal((await req('PUT', '/api/data', { key: 'k', data: 1 })).status, 401);
    assert.equal((await req('DELETE', '/api/data/k')).status, 401);
});

test('delete removes a blob', async () => {
    const del = await req('DELETE', '/api/data/pclinic_data_u1', null, token);
    assert.equal(del.status, 200);
    const get = await req('GET', '/api/data', null, token);
    assert.ok(!('pclinic_data_u1' in get.json.blobs));
});

test('unknown routes 404', async () => {
    const { status } = await req('GET', '/nope');
    assert.equal(status, 404);
});

// --- credential lifecycle: change / reset / e-mail -------------------------
import crypto from 'node:crypto';

const enc8 = s => new TextEncoder().encode(s);
const b64enc = b => Buffer.from(b).toString('base64');

// Mirror of the app's deriveAccountKeys verifier (PBKDF2 -> HKDF).
function recoveryVerifier(code, saltB64, iter) {
    const norm = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const salt = Buffer.from(saltB64, 'base64');
    const master = crypto.pbkdf2Sync(norm, salt, iter, 32, 'sha256');
    return b64enc(Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from('pclinic-verifier-v1'), 32)));
}

test('change-password requires the current password and updates it', async () => {
    // Wrong current password.
    const bad = await req('POST', '/api/auth/change-password', { currentPassword: 'nope1234', newPassword: 'newpass99' }, token);
    assert.equal(bad.status, 401);
    // Weak new password.
    const weak = await req('POST', '/api/auth/change-password', { currentPassword: 'clinic2026', newPassword: 'short' }, token);
    assert.equal(weak.status, 400);
    // Success.
    const ok = await req('POST', '/api/auth/change-password', { currentPassword: 'clinic2026', newPassword: 'newpass99' }, token);
    assert.equal(ok.status, 200);
    // Old password no longer works; new one does.
    assert.equal((await req('POST', '/api/auth/login', { email: 'nurse@example.com', password: 'clinic2026' })).status, 401);
    const relogin = await req('POST', '/api/auth/login', { email: 'nurse@example.com', password: 'newpass99' });
    assert.equal(relogin.status, 200);
    token = relogin.json.token;
});

test('reset-password proves identity with the recovery code', async () => {
    // Sync an account record carrying a real recovery verifier.
    const code = 'ABCDE-FGHIJ-KLMNO-PQRST';
    const salt = b64enc(crypto.randomBytes(16));
    const iter = 50000;
    const account = { id: 'u_x', username: 'nurse', email: 'nurse@example.com', recovery: { v: 2, iter, salt, hash: recoveryVerifier(code, salt, iter) } };
    assert.equal((await req('PUT', '/api/account', { account }, token)).status, 200);

    // Wrong code -> generic 401.
    const wrong = await req('POST', '/api/auth/reset-password', { email: 'nurse@example.com', recoveryCode: 'XXXXX-XXXXX-XXXXX-XXXXX', newPassword: 'resetpass1' });
    assert.equal(wrong.status, 401);
    // Unknown e-mail -> same generic 401 (no enumeration).
    const ghost = await req('POST', '/api/auth/reset-password', { email: 'ghost@example.com', recoveryCode: code, newPassword: 'resetpass1' });
    assert.equal(ghost.status, 401);
    assert.equal(ghost.json.error, wrong.json.error);
    // Correct code (formatting tolerated: lowercase, no dashes) -> reset works.
    const ok = await req('POST', '/api/auth/reset-password', { email: 'nurse@example.com', recoveryCode: code.toLowerCase().replace(/-/g, ''), newPassword: 'resetpass1' });
    assert.equal(ok.status, 200);
    assert.equal((await req('POST', '/api/auth/login', { email: 'nurse@example.com', password: 'resetpass1' })).status, 200);
});

test('change-email moves the sign-in identity', async () => {
    const ok = await req('POST', '/api/auth/change-email', { newEmail: 'nurse2@example.com' }, token);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.user.email, 'nurse2@example.com');
    // Old e-mail no longer signs in; new one does.
    assert.equal((await req('POST', '/api/auth/login', { email: 'nurse@example.com', password: 'resetpass1' })).status, 401);
    assert.equal((await req('POST', '/api/auth/login', { email: 'nurse2@example.com', password: 'resetpass1' })).status, 200);
    // Invalid e-mail rejected.
    assert.equal((await req('POST', '/api/auth/change-email', { newEmail: 'not-an-email' }, token)).status, 400);
});
