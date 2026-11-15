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
        env: { ...process.env, PORT: String(PORT), PCLINIC_DATA_FILE: dataFile, PCLINIC_SECRET: 'test-secret' },
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
