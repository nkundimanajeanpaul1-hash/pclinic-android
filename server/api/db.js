// ============================================================================
// db.js — tiny JSON-file store with atomic writes.
//
// The whole database is one JSON file (data.json next to this file). Writes
// go to data.json.tmp, are fsynced, then renamed over data.json — so a crash
// mid-write can never corrupt the store. A data.json.bak of the previous
// good state is kept as well.
//
// This is deliberately simple: a clinic deployment has a handful of users,
// and a single file means backups are just copying one file. If you outgrow
// it, swap this module for SQLite — the API surface (load/save) stays the
// same.
//
// What is stored per user:
//   - email + scrypt password hash (auth)
//   - account: the client's crypto record (wrapped keys, verifiers — all
//     ciphertext/hashes, safe to hold server-side)
//   - blobs:   { key: { data, updatedAt } } — the client's ENCRYPTED records.
//     The server never sees plaintext patient data.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.PCLINIC_DATA_FILE || path.join(__dirname, 'data.json');
const TMP_FILE = DATA_FILE + '.tmp';
const BAK_FILE = DATA_FILE + '.bak';

function emptyDb() { return { users: {}, byEmail: {} }; }

function load() {
    try {
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        const db = JSON.parse(raw);
        if (db && typeof db === 'object' && db.users && db.byEmail) return db;
    } catch (e) { /* missing or unreadable — start fresh below */ }
    try {
        const bak = JSON.parse(fs.readFileSync(BAK_FILE, 'utf8'));
        if (bak && bak.users && bak.byEmail) {
            console.warn('[db] data.json unreadable — restored from data.json.bak');
            return bak;
        }
    } catch (e) { /* no backup either */ }
    return emptyDb();
}

let db = load();
let saveTimer = null;

function save() {
    // Coalesce bursts of writes (sync pushes) into one disk write.
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            const json = JSON.stringify(db);
            const fd = fs.openSync(TMP_FILE, 'w');
            fs.writeSync(fd, json);
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            try { fs.copyFileSync(DATA_FILE, BAK_FILE); } catch (e) { /* first run */ }
            fs.renameSync(TMP_FILE, DATA_FILE);
        } catch (e) {
            console.error('[db] save failed:', e.message);
        }
    }, 50);
}

// Flush synchronously (used on shutdown and by tests).
function saveNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try {
        const json = JSON.stringify(db);
        const fd = fs.openSync(TMP_FILE, 'w');
        fs.writeSync(fd, json);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        try { fs.copyFileSync(DATA_FILE, BAK_FILE); } catch (e) { /* first run */ }
        fs.renameSync(TMP_FILE, DATA_FILE);
    } catch (e) {
        console.error('[db] save failed:', e.message);
    }
}

function newId() {
    return 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

module.exports = {
    load: () => db,
    save,
    saveNow,
    newId,
    // Test hook: point the store at a temp file and reload.
    _reset(file) {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        db = emptyDb();
        if (file) {
            try { fs.unlinkSync(file); } catch (e) {}
            try { fs.unlinkSync(file + '.bak'); } catch (e) {}
        }
    }
};
