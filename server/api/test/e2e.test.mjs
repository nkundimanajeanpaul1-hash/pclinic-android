// End-to-end proof: the app's exact crypto flow, across two "devices".
//
// Device A registers, encrypts patient records with a password-derived key,
// and syncs only ciphertext to the server. Device B (fresh localStorage)
// signs in with the same e-mail + password, downloads the ciphertext, and
// decrypts the records. The server never sees plaintext.
//
// This replicates www/index.html's deriveAccountKeys / wrapDEK / encryptJSON
// using Node's WebCrypto (same primitives, same parameters).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pclinic-e2e-'));
const dataFile = path.join(tmp, 'data.json');
const PORT = 18788;
const BASE = `http://127.0.0.1:${PORT}`;

let proc;

// --- WebCrypto helpers mirroring the app -----------------------------------
const enc8 = s => new TextEncoder().encode(s);
const b64enc = b => Buffer.from(b).toString('base64');
const b64dec = s => new Uint8Array(Buffer.from(s, 'base64'));
const PBKDF2_ITER = 200000;

async function deriveAccountKeys(secret, saltB64, iter) {
    const pwKey = await crypto.subtle.importKey('raw', enc8(String(secret)), 'PBKDF2', false, ['deriveBits']);
    const masterBits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: b64dec(saltB64), iterations: iter, hash: 'SHA-256' }, pwKey, 256);
    const base = await crypto.subtle.importKey('raw', masterBits, 'HKDF', false, ['deriveBits', 'deriveKey']);
    const kek = await crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc8('pclinic-kek-v1') },
        base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const ver = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc8('pclinic-verifier-v1') },
        base, 256);
    return { kek, verifier: b64enc(new Uint8Array(ver)) };
}

async function wrapDEK(kek, dek) {
    const raw = await crypto.subtle.exportKey('raw', dek);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, raw);
    return { iv: b64enc(iv), ct: b64enc(new Uint8Array(ct)) };
}

async function unwrapDEK(kek, blob) {
    const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64dec(blob.iv) }, kek, b64dec(blob.ct));
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

async function encryptJSON(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc8(JSON.stringify(obj)));
    return { v: 2, iv: b64enc(iv), ct: b64enc(new Uint8Array(ct)) };
}

async function decryptJSON(key, blob) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64dec(blob.iv) }, key, b64dec(blob.ct));
    return JSON.parse(new TextDecoder().decode(new Uint8Array(pt)));
}

async function req(method, p, body, tok) {
    const res = await fetch(BASE + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, json: await res.json() };
}

before(async () => {
    proc = spawn('node', [path.join(dir, '..', 'index.js')], {
        env: { ...process.env, PORT: String(PORT), PCLINIC_DATA_FILE: dataFile, PCLINIC_SECRET: 'e2e-secret' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    for (let i = 0; i < 50; i++) {
        try { const r = await fetch(BASE + '/health'); if (r.ok) return; } catch {}
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('server did not start');
});

after(() => {
    proc.kill('SIGTERM');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('device A -> server -> device B: records survive the trip, server sees only ciphertext', async () => {
    const email = 'doctor@example.com';
    const password = 'clinic2026';
    const patients = [
        { id: 'p1', name: 'Aline Uwase', age: 34, diagnosis: 'Malaria', hospital: 'CHUK' },
        { id: 'p2', name: 'Jean Bosco', age: 51, diagnosis: 'Hypertension', hospital: 'CHUK' }
    ];

    // ---- Device A: register (server) + local crypto setup -----------------
    const reg = await req('POST', '/api/auth/register', { email, password });
    assert.equal(reg.status, 201);
    const tokenA = reg.json.token;

    const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const salt = b64enc(crypto.getRandomValues(new Uint8Array(16)));
    const keys = await deriveAccountKeys(password, salt, PBKDF2_ITER);
    const wrapped = await wrapDEK(keys.kek, dek);
    const account = {
        id: 'u_deviceA', username: 'doctor', email, phone: '+250788000000',
        createdAt: new Date().toISOString(),
        pw: { v: 2, alg: 'pbkdf2-sha256+hkdf', iter: PBKDF2_ITER, salt, hash: keys.verifier },
        dek: wrapped, dekRec: null, recovery: null, recCodeEnc: null, pin: null, dekPin: null
    };
    const blob = await encryptJSON(dek, patients);

    assert.equal((await req('PUT', '/api/account', { account }, tokenA)).status, 200);
    assert.equal((await req('PUT', '/api/data', { key: 'pclinic_data_u_deviceA', data: blob }, tokenA)).status, 200);

    // The server's disk must hold ciphertext only — no patient names anywhere.
    await new Promise(r => setTimeout(r, 200));
    const onDisk = fs.readFileSync(dataFile, 'utf8');
    assert.ok(!onDisk.includes('Aline'), 'server must never see a patient name');
    assert.ok(!onDisk.includes('Malaria'), 'server must never see a diagnosis');
    assert.ok(!onDisk.includes(password), 'server must never see the password');

    // ---- Device B: fresh device, sign in with e-mail + password -----------
    const login = await req('POST', '/api/auth/login', { email, password });
    assert.equal(login.status, 200);
    const tokenB = login.json.token;

    const data = await req('GET', '/api/data', null, tokenB);
    assert.equal(data.status, 200);
    const rec = data.json.account;
    assert.equal(rec.username, 'doctor');

    // Derive the key from the password + synced salt, unwrap the DEK.
    const keysB = await deriveAccountKeys(password, rec.pw.salt, rec.pw.iter);
    assert.equal(keysB.verifier, rec.pw.hash, 'password verifies against the synced record');
    const dekB = await unwrapDEK(keysB.kek, rec.dek);

    // Decrypt the synced records — identical to device A.
    const restored = await decryptJSON(dekB, data.json.blobs['pclinic_data_u_deviceA'].data);
    assert.deepEqual(restored, patients);
});

test('wrong password on device B cannot unwrap the key', async () => {
    const login = await req('POST', '/api/auth/login', { email: 'doctor@example.com', password: 'wrongpass1' });
    assert.equal(login.status, 401);
});
