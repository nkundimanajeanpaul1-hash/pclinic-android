import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const p = (...x) => join(root, ...x);
const read = async (...x) => readFile(p(...x), 'utf8');

test('www/index.html exists and ships the offline backup app', async () => {
    const html = await read('www', 'index.html');
    assert.ok(html.includes('PClinic Pro'), 'app title present');
});

test('Content-Security-Policy meta is present', async () => {
    const html = await read('www', 'index.html');
    assert.ok(html.includes('Content-Security-Policy'), 'CSP meta tag');
    assert.ok(html.includes("connect-src 'self' https://api.emailjs.com"), 'emailjs endpoint pinned');
});

test('no external CDN scripts remain (offline-first)', async () => {
    const html = await read('www', 'index.html');
    assert.ok(!/src="https?:\/\//.test(html), 'no remote <script src>');
    assert.ok(html.includes('vendor/email.min.js'), 'emailjs vendored');
    assert.ok(html.includes('vendor/capacitor-filesystem.js'), 'filesystem vendored');
});

test('printing uses the iframe helper, not document.write', async () => {
    const html = await read('www', 'index.html');
    assert.ok(html.includes('function printViaFrame'), 'printViaFrame defined');
    assert.ok(!html.includes('document.write'), 'no document.write left');
});

test('Drive state is honest: no pseudo-token persisted', async () => {
    const html = await read('www', 'index.html');
    assert.ok(!html.includes("localStorage.setItem('pclinic_drive_token_'"), 'no fake token stored');
    assert.ok(!html.includes("'shared_' + Date.now()"), 'no pseudo-token minted');
});

test('capacitor config is complete and https-schemed', async () => {
    const cfg = JSON.parse(await read('capacitor.config.json'));
    assert.equal(cfg.webDir, 'www');
    assert.equal(cfg.server.androidScheme, 'https');
    assert.ok(cfg.plugins && cfg.plugins.SplashScreen, 'splash configured');
});

test('release signing is properties-gated, never hard-coded', async () => {
    const gradle = await read('android', 'app', 'build.gradle');
    assert.ok(gradle.includes('keystore.properties'), 'signing reads keystore.properties');
    assert.ok(gradle.includes('signingConfigs.release'), 'release wired to signing config');
    assert.ok(!/storePassword\s+"[^$]/.test(gradle), 'no literal passwords in gradle');
    assert.ok(gradle.indexOf('signingConfigs {') < gradle.indexOf('buildTypes {'),
        'signingConfigs must be declared before buildTypes references it');
    const gi = await read('.gitignore');
    assert.ok(gi.split('\n').includes('android/keystore.properties'),
        'keystore.properties is ignored so a local copy is never committed');
    const example = await read('android', 'keystore.properties.example');
    for (const key of ['storeFile=', 'storePassword=', 'keyAlias=', 'keyPassword=']) {
        assert.ok(example.includes(key), 'example documents ' + key);
    }
});

test('.gitignore protects secrets and junk', async () => {
    const gi = await read('.gitignore');
    for (const needle of ['node_modules/', '*.jks', 'android/keystore.properties', '.DS_Store', '.idea/']) {
        assert.ok(gi.includes(needle), 'gitignore covers ' + needle);
    }
});

test('Device Vault engine present in www', async () => {
    const html = await read('www', 'index.html');
    assert.ok(html.includes('var Vault = (function ()'), 'Vault module defined');
    assert.ok(html.includes('pclinic_vault'), 'vault folder name');
    assert.ok(html.includes('records.enc'), 'encrypted record file');
    assert.ok(html.includes('Vault.migrate()'), 'legacy migration hooked into boot');
});

test('loadPatients is vault-first with legacy fallback', async () => {
    const html = await read('www', 'index.html');
    const i = html.indexOf('function loadPatients()');
    const body = html.slice(i, i + 500);
    assert.ok(body.includes('Vault.load()'), 'vault read first');
    assert.ok(body.includes('secureGet(getPatientKey()'), 'legacy fallback kept until migration');
});

test('vault bridges + storage sheet UI wired', async () => {
    const html = await read('www', 'index.html');
    for (const id of ['vaultModal', 'vaultBtn', 'vaultMirrorGrant', 'vaultMirrorRestore',
                      'vaultDriveSign', 'vaultDriveRestore', 'vaultDriveOut']) {
        assert.ok(html.includes('id="' + id + '"'), 'ui element ' + id);
    }
    assert.ok(html.includes("plug('VaultMirror')"), 'mirror bridge');
    assert.ok(html.includes("plug('GoogleDrive')"), 'drive bridge');
    assert.ok(html.includes('window.mirrorSchedule'), 'auto-mirror hook');
    assert.ok(html.includes('window.driveSchedule'), 'silent drive hook');
});

test('native plugins registered and dependency-present', async () => {
    const main = await read('android', 'app', 'src', 'main', 'java', 'com', 'nkundimana', 'pclinic', 'MainActivity.java');
    assert.ok(main.includes('registerPlugin(VaultMirrorPlugin.class)'));
    assert.ok(main.includes('registerPlugin(GoogleDrivePlugin.class)'));
    const gradle = await read('android', 'app', 'build.gradle');
    assert.ok(gradle.includes('play-services-auth'), 'google auth dependency');
    assert.ok(gradle.includes('documentfile'), 'SAF documentfile dependency');
});

test('drive plugin targets hidden appDataFolder only', async () => {
    const java = await read('android', 'app', 'src', 'main', 'java', 'com', 'nkundimana', 'pclinic', 'GoogleDrivePlugin.java');
    assert.ok(java.includes('drive.appdata'), 'appdata scope');
    assert.ok(java.includes('appDataFolder'), 'appDataFolder parent');
    assert.ok(!/auth\/drive(?!\.appdata)/.test(java) && !java.includes('drive.file'), 'no broad drive scopes');
});

test('vault probe degrades instead of rejecting (sign-in must survive it)', async () => {
    const html = await read('www', 'index.html');

    // The plugin object can be present with no methods at all, so a presence
    // check is not enough — that TypeError used to escape through enterApp().
    assert.ok(html.includes('function resolveFilesystem()'), 'shared lazy plugin resolver');
    assert.ok(/resolveFilesystem\(\)[\s\S]{0,500}typeof fs\.mkdir === 'function'/.test(html), 'resolver checks methods');

    const start = html.indexOf('var Vault = (function ()');
    assert.ok(start > -1, 'Vault module found');
    const init = html.slice(start, start + 4000);
    const body = init.slice(init.indexOf('function init()'), init.indexOf('function sha256hex'));
    assert.ok(body.includes('try {'), 'probe body is guarded');
    assert.ok(body.includes("res('none')"), 'probe failure resolves to none');
    assert.ok(!/FS = (c|window\.CapacitorFilesystem)\.Filesystem/.test(body), 'no unguarded direct plugin read');
});

test('a PIN signs in exactly like a password', async () => {
    const html = await read('www', 'index.html');
    assert.ok(html.includes('function signInWithPin(u, pin)'), 'PIN sign-in path exists');
    assert.ok(html.includes('function hasPin(u)'), 'PIN presence check');

    const start = html.indexOf('function signInLocal(u, password)');
    assert.ok(start > -1, 'signInLocal found');
    const body = html.slice(start, start + 1400);
    // A credential that is not the password verifier is retried as a PIN rather
    // than rejected, and a PIN-only account must still be able to get in.
    assert.ok(body.includes('return signInWithPin(u, password);'), 'password mismatch falls through to PIN');
    assert.ok(body.includes('if (!u.pw && hasPin(u))'), 'PIN-only account accepted');

    // The PIN is a wrapped copy of the same data key: no second set of ciphertext.
    const pinWrap = html.slice(html.indexOf('function setAccountPin'), html.indexOf('function removeAccountPin'));
    assert.ok(pinWrap.includes('wrapDEKWithPassword(pin, sessionDEK)'), 'PIN wraps the live session key');
    assert.ok(!/u\.pin[^;]*=\s*pin\b/.test(pinWrap), 'the PIN itself is never stored');

    // A PIN is short on purpose, so signing in with one must not trip the
    // weak-password nag that the lock path already skips.
    const atLogin = html.indexOf('withBusy(btn, t(\'signingIn\'), signIn(username, password))');
    assert.ok(atLogin > -1, 'login handler found');
    const login = html.slice(atLogin, atLogin + 1200);
    assert.ok(login.includes('if (!res.viaPin && passwordProblem(password'), 'no force-password nag after a PIN sign-in');

    // Profile must still be able to add a password to a PIN-only account.
    const profStart = html.indexOf('// A PIN-only account (its password was replaced by a reset)');
    assert.ok(profStart > -1, 'PIN-only profile path exists');
    const prof = html.slice(profStart, html.indexOf('job = function() { return changePasswordWithRewrap', profStart));
    assert.ok(prof.includes('verifySecret(currentUser, current)'), 'the PIN is proved first');
    assert.ok(prof.includes('if (!current) { profileError.textContent = t(\'proofPinRequired\')'), 'an empty proof is refused, not waved through');
    assert.ok(prof.includes('wrapDEKWithPassword(newPass, sessionDEK)'), 'the new password wraps the live key');

    // Removing the last credential would make the wrapped data key unreachable.
    const rm = html.slice(html.indexOf('var pPinRemove = $id(\'profilePinRemoveBtn\')'), html.indexOf('var pLockNow = $id(\'profileLockNowBtn\')'));
    assert.ok(rm.includes('if (!(currentUser.pw && currentUser.pw.v === 2))'), 'a PIN-only account cannot remove its PIN');
    assert.ok(rm.includes("if (!proof) { pinMsg("), 'an empty proof cannot retire the PIN');
    assert.ok(rm.indexOf('if (!(currentUser.pw') < rm.indexOf('removeAccountPin(currentUser)'), 'the guard runs before the deletion');

    // verifySecret() waves an empty proof through for a password-less account,
    // so the set-PIN handler has to demand one itself.
    const save = html.slice(html.indexOf('var pPinSave = $id(\'profilePinSaveBtn\')'), html.indexOf('var pPinRemove = $id(\'profilePinRemoveBtn\')'));
    assert.ok(save.includes("if (!proof) { pinMsg('Enter your password or PIN to confirm.', true); return; }"), 'replacing a PIN still needs a proof');
});

test('resetting installs one credential and revokes the other', async () => {
    const html = await read('www', 'index.html');
    const start = html.indexOf('function completePasswordReset');
    assert.ok(start > -1, 'completePasswordReset found');
    const body = html.slice(start, start + 2200);
    assert.ok(body.includes("var asPin = kind === 'pin'"), 'reset takes a credential kind');
    assert.ok(/u\.pin = sec\.pw;[\s\S]{0,120}delete u\.pw/.test(body), 'a PIN reset drops the password');
    assert.ok(/u\.pw = sec\.pw;[\s\S]{0,120}delete u\.pin/.test(body), 'a password reset drops the PIN');
    assert.ok(body.includes('u.otp = null;'), 'the one-time code is consumed');
    assert.ok(body.includes('attachRecoveryCode(u, code)'), 'a fresh recovery code is issued');

    // Step 4 validates the secret with the rule that matches the chosen kind.
    const finish = html.slice(html.indexOf("var fFinish = $id('forgotFinishBtn')"), html.indexOf('// -------------------------------------------------- backup password modal'));
    assert.ok(finish.includes("isPin ? pinProblem(p1) : passwordProblem(p1, uname)"), 'validation follows the choice');
    assert.ok(finish.includes("completePasswordReset(p1, isPin ? 'pin' : 'pw')"), 'kind is passed down');
});

test('SMS recovery stays dark until a relay exists, and leaks nothing', async () => {
    const html = await read('www', 'index.html');
    assert.ok(/var SMS_RELAY_URL = '';/.test(html), 'no relay is baked into the shipped app');

    const start = html.indexOf('function sendRecoverySms');
    assert.ok(start > -1, 'sendRecoverySms found');
    const body = html.slice(start, start + 1500);
    assert.ok(body.includes("if (!SMS_RELAY_URL) return Promise.resolve({ ok: false, error: 'smsDisabled' })"),
        'disabled relay short-circuits before any code is minted');
    assert.ok(body.includes("JSON.stringify({ to: to, code: code, app: 'pclinic' })"),
        'the relay payload carries only a number and a code');
    assert.ok(!/to: .*u\.username/.test(body), 'the relay payload is not the username');

    const send = html.slice(html.indexOf('function sendResetSms'), html.indexOf('function verifyResetOTP'));
    assert.ok(send.includes('phoneMatches(entered, u.phone)'), 'a number is checked against the account first');
    assert.ok(/if \(!r\.ok\) \{[\s\S]{0,160}u\.otp = null;/.test(send), 'an undelivered code is removed from the account');
    assert.ok(send.includes("if (to.charAt(0) !== '+' && entered.charAt(0) === '+')"), 'the carrier gets a country-coded number');

    // A local 07… number is undeliverable, so the relay must be refused before any
    // code exists on the account — otherwise the user waits for an SMS that can't come.
    assert.ok(/if \(to\.charAt\(0\) !== '\+'\)[\s\S]{0,200}error: 'needCountryCode'[\s\S]{0,400}var otp = generateOTP\(\)/.test(send),
        'an undeliverable number is rejected before the OTP is minted');
    assert.ok(html.includes("r.error === 'needCountryCode' || r.error === 'badNumber'"), 'and the wizard says why');

    // 0788123456 and +250788123456 are the same line — recovery must not fail on format.
    const match = html.slice(html.indexOf('function phoneMatches'), html.indexOf('function maskEmail'));
    assert.ok(match.includes('na.slice(-9) === nb.slice(-9)'), 'national number comparison');
    assert.ok(match.includes('na.length < 9 || nb.length < 9'), 'short fragments are never enough to match');
    assert.ok(html.includes('if (!phoneMatches(phone, u.phone))'), 'the no-SMS confirmation uses the same rule');

    // No provider secret may sit in client JS — this file ships inside the APK.
    assert.ok(!/account_sid|auth_token|api_key\s*[:=]/i.test(html), 'no SMS provider credentials');
});

test('the translation dicts stay whole', async () => {
    const html = await read('www', 'index.html');

    // A key written twice in one object is silently overridden by the later entry,
    // so the first message is dead code — and the UI shows the wrong wording.
    const open = html.indexOf('{', html.indexOf('var translations = {'));
    const blocks = [];
    for (const lang of ['en', 'fr', 'rw']) {
        const at = html.indexOf('\n            ' + lang + ': {');
        assert.ok(at > open && at > -1, lang + ' dictionary present');
        let depth = 0, p = html.indexOf('{', at);
        for (; p < html.length; p++) {
            if (html[p] === '{') depth++;
            else if (html[p] === '}') { depth--; if (depth === 0) break; }
        }
        blocks.push({ lang: lang, body: html.slice(p, html.length) && html.slice(html.indexOf('{', at), p + 1) });
    }
    for (const b of blocks) {
        const counts = new Map();
        for (const m of b.body.matchAll(/^ {16}([A-Za-z0-9_]+):/gm)) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
        const dupes = [...counts].filter(([, n]) => n > 1).map(([k]) => k);
        assert.deepEqual(dupes, [], 'duplicate keys in ' + b.lang + ' override each other');
    }
    const enKeys = blocks[0].body.match(/^ {16}([A-Za-z0-9_]+):/gm) || [];
    for (const b of blocks.slice(1)) {
        const n = ((b.body.match(/^ {16}([A-Za-z0-9_]+):/gm) || []).length);
        assert.equal(n, enKeys.length, b.lang + ' has the same number of keys as en');
    }

    // Every literal t('key') must exist, or the UI prints the raw key.
    const enBody = blocks[0].body;
    const asked = new Set();
    for (const m of html.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'\s*\)/g)) asked.add(m[1]);
    for (const m of html.matchAll(/data-i18n(?:-placeholder)?="([A-Za-z0-9_]+)"/g)) asked.add(m[1]);
    const undef = [...asked].filter(k => !new RegExp('^ {16}' + k + ':', 'm').test(enBody));
    assert.deepEqual(undef.sort(), [], 'keys asked for but never defined');

    // The proof error and the sign-in error are different sentences; they used to
    // share one key, which made the profile one unreachable.
    assert.equal((html.match(/wrongProof:/g) || []).length, 3, 'wrongProof in all three languages');
    assert.ok(html.includes("error: t('wrongProof')"), 'profile proof failure says "current"');
});

test('a PIN is spoken of correctly everywhere a credential is asked for', async () => {
    const html = await read('www', 'index.html');

    // The hint tells users not to use 1234, so the validator has to mean it — and
    // say so in the language the app is showing, not in English.
    const pin = html.slice(html.indexOf('function pinProblem'), html.indexOf('function setAccountPin'));
    assert.ok(pin.includes('if (up || down)'), 'consecutive runs like 1234/4321 are rejected');
    assert.ok(pin.includes("return t('pinConsecutive')"), 'with a stated reason');
    assert.ok(!/return '[A-Z]/.test(pin), 'no PIN rule returns hardcoded English');

    const pw = html.slice(html.indexOf('function passwordProblem'), html.indexOf('function buildAccountSecret'));
    assert.ok(!/return '[A-Z]/.test(pw), 'no password rule returns hardcoded English');
    for (const k of ['pinConsecutive', 'pinRepeatedDigit', 'pinTooShort', 'pwNeedsLetterNumber', 'pwTooCommon']) {
        assert.equal((html.match(new RegExp('^ {16}' + k + ':', 'gm')) || []).length, 3, k + ' in en, fr and rw');
    }

    // "Passwords do not match" while the user is choosing a PIN reads like a bug.
    assert.ok(html.includes("if (p1 !== p2) { forgotErr(isPin ? t('pinMismatch') : t('passwordMismatch')); return; }"),
        'step 4 names the credential actually being set');
    assert.equal((html.match(/pinMismatch:/g) || []).length, 3, 'pinMismatch in en, fr and rw');

    // Every failure message that can be shown for a wrong PIN must mention a PIN.
    const wrong = (html.match(/wrong(?:Password|Proof): '(?:[^'\\]|\\.)*'/g) || []);
    assert.equal(wrong.length, 6, 'one sign-in and one proof message x three languages');
    assert.ok(wrong.every(w => /PIN|pin/.test(w)), 'all of them say password or PIN: ' + wrong.join(' | '));

    // Credentials change mid-session (a reset, a password added to a PIN-only account),
    // so the section must be rebuilt rather than left as it was at sign-in.
    const open = html.slice(html.indexOf("profileBtnHeader.addEventListener('click'"), html.indexOf('closeProfileBtn.addEventListener'));
    assert.ok(open.indexOf('refreshProfileSecurity()') < open.indexOf('showModal(profileModal)'),
        'profile refreshes its security section on open');
    assert.ok(html.includes("pinTg.textContent = pinOn ? t('btnChange') : t('btnSet');"), 'the PIN button admits a PIN exists');
});

test('nothing the user reads is hardcoded English', async () => {
    const html = await read('www', 'index.html');

    // A sentence written straight into a UI call can never be translated, so the
    // French and Kinyarwanda builds would show English precisely where the app talks
    // about passwords, backups and lost data.
    const at = html.indexOf('var translations = {');
    let depth = 0, end = html.indexOf('{', at);
    for (; end < html.length; end++) {
        if (html[end] === '{') depth++;
        else if (html[end] === '}') { depth--; if (!depth) break; }
    }
    const code = html.slice(0, html.indexOf('{', at)) + html.slice(end + 1);

    const offenders = [];
    const patterns = [
        [/\bshowToast\(\s*'(?:[^'\\]|\\.)*[A-Za-z]/g, 'showToast'],
        [/\b(?:confirm|alert)\(\s*'(?:[^'\\]|\\.)*[A-Za-z]/g, 'confirm/alert'],
        [/\b(?:forgotErr|forgotInfo)\(\s*'(?:[^'\\]|\\.)*[A-Za-z]/g, 'reset wizard'],
        [/\.textContent\s*=\s*'(?:[^'\\]|\\.)*[A-Za-zÀ-ÿ]/g, 'textContent'],
        // withBusy() writes its second argument onto the button while the work runs,
        // so that label is read by the user; the bare '…' spinner carries no words.
        [/withBusy\(\s*[\w$)]+\s*,\s*'(?:[^'\\]|\\.)*[A-Za-zÀ-ÿ]/g, 'withBusy label'],
        // `box.textContent = value || 'No recovery code stored.'` hides the same bug
        // behind an ||, because the assignment is no longer directly followed by '.
        [/\.(?:textContent|innerHTML)\s*=[^;\n]*\|\|\s*'[A-Z][A-Za-z ,.'-]{6,}'/g, 'textContent fallback'],
        [/\.alt\s*=\s*'[A-Za-z]/g, 'image alt']
    ];
    for (const [re, what] of patterns) {
        for (const m of code.matchAll(re)) offenders.push(what + ': ' + m[0].slice(0, 70));
    }
    assert.deepEqual(offenders, [], 'user-facing text must go through t():\n' + offenders.join('\n'));

    // Placeholder copy needs the i18n hook too. Format examples (an e-mail address,
    // a phone number, the XXXXX code mask) read the same in every language.
    const unhooked = [...html.matchAll(/<(?:input|textarea)\b[^>]*>/g)]
        .map(m => m[0])
        .filter(tag => /placeholder=/.test(tag) && !/data-i18n-placeholder/.test(tag))
        .map(tag => /placeholder=(?:"([^"]*)"|'([^']*)')/.exec(tag)[1] || /placeholder=(?:"([^"]*)"|'([^']*)')/.exec(tag)[2])
        .filter(v => !/'/.test(v) && !/^\s*\+/.test(v))
        .filter(v => !/^[\s+X\d.,*_-]+$/.test(v) && !/@|250|0784|9898|CHUK/.test(v));
    assert.deepEqual(unhooked, [], 'placeholder copy with no translation hook: ' + unhooked.join(' | '));

    // A key left identical to English is an unanswered screen, so drift here is a
    // bug — except for tokens that are genuinely the same in all three languages.
    const neutral = new Set(['sortID', 'id', 'word', 'csv', 'pdf', 'exportExcel', 'kindPin',
        'idLabel', 'totalPatients', 'patients', 'date', 'page', 'patient']);
    const values = lang => {
        const at2 = html.indexOf('\n            ' + lang + ': {');
        let d = 0, p2 = html.indexOf('{', at2);
        for (; p2 < html.length; p2++) {
            if (html[p2] === '{') d++;
            else if (html[p2] === '}') { d--; if (!d) break; }
        }
        const out = new Map();
        const re = /^ {16}([A-Za-z0-9_]+): '((?:[^'\\]|\\.)*)',?$/gm;
        for (const m of html.slice(at2, p2).matchAll(re)) out.set(m[1], m[2].replace(/\\(['\\])/g, '$1'));
        return out;
    };
    const en = values('en');
    for (const lang of ['fr', 'rw']) {
        const dict = values(lang);
        const same = [...dict].filter(([k, v]) => en.get(k) === v && !neutral.has(k)).map(([k]) => k);
        assert.deepEqual(same, [], lang + ' fell back to English for: ' + same.join(', '));
    }
});

test('a wrong credential costs more time on every try, and the cost survives a restart', async () => {
    const html = await read('www', 'index.html');

    // The wait used to be a flat 30 s held in a variable, so closing the app erased
    // it and guessing a password cost nothing overnight. This runs the code the app
    // actually ships — the dict, t() and the guard block — against a fake clock,
    // rather than re-deriving the arithmetic in the test.
    const at = html.indexOf('var translations = {');
    let depth = 0, dictEnd = html.indexOf('{', at);
    for (; dictEnd < html.length; dictEnd++) {
        if (html[dictEnd] === '{') depth++;
        else if (html[dictEnd] === '}') { depth--; if (!depth) break; }
    }
    const gStart = html.indexOf('var AUTH_GUARD_KEY =');
    const gEnd = html.indexOf('function withBusy(', gStart);
    assert.ok(at > -1 && gStart > -1 && gEnd > gStart, 'translations dict and auth guard found');
    const body = html.slice(at, dictEnd + 1) + '\n'
        + "function t(key) { return translations[currentLang] && translations[currentLang][key] ? translations[currentLang][key] : key; }\n"
        + html.slice(gStart, gEnd);

    const KEY = 'pclinic_auth_guard';
    const makeStore = () => {
        const m = new Map();
        return {
            getItem: k => (m.has(k) ? m.get(k) : null),
            setItem: (k, v) => m.set(k, String(v)),
            removeItem: k => m.delete(k),
            holds: k => m.has(k),
            text: () => m.get(KEY)
        };
    };
    const boot = (store, lang) => new Function('localStorage', 'Date', 'currentLang',
        body + '\nreturn { fail: noteAuthFailure, ok: noteAuthSuccess, ms: authThrottleMs,' +
        ' msg: authBusyMessage, tries: function () { return authFailures; } };'
    )(store, { now: () => 1700000000000 }, lang || 'en');

    const store = makeStore();
    const app = boot(store);
    assert.equal(app.fail(), 0, 'the first wrong try costs nothing');
    assert.equal(app.fail(), 0);
    assert.equal(app.fail(), 0);
    assert.equal(app.msg(), '', 'and promises no wait');

    const steps = [];
    for (let i = 4; i <= 9; i++) steps.push(app.fail());
    assert.deepEqual(steps, [30000, 60000, 120000, 240000, 480000, 960000],
        'the wait doubles instead of stopping at 30 s: ' + steps.join(', '));
    for (let i = 10; i <= 14; i++) assert.equal(app.fail(), 30 * 60 * 1000, 'capped at half an hour');

    // The two sentences are chosen at 120 s so that no language ever reads "1 minutes".
    const said = makeStore();
    const short = boot(said);
    for (let i = 0; i < 4; i++) short.fail();
    assert.match(short.msg(), /Wait 30s/, 'a short wait is counted in seconds');
    for (let i = 0; i < 2; i++) short.fail();
    assert.match(short.msg(), /Wait 2 minutes/, 'and a long one in minutes');
    assert.doesNotMatch(short.msg(), /1 minutes/);

    assert.equal(JSON.parse(store.text()).f, 14, 'the counter is written to storage');
    const reloaded = boot(store);
    assert.equal(reloaded.tries(), 14, 'a restart remembers how many tries it cost');
    assert.ok(reloaded.ms() > 0, 'and is still inside the wait');
    assert.match(reloaded.msg(), /30 minutes/, 'naming the time left, not a fresh 30 s');

    reloaded.ok();
    assert.equal(reloaded.tries(), 0, 'a correct credential resets the count');
    assert.equal(store.holds(KEY), false, 'and deletes the record it wrote');

    const damaged = makeStore();
    damaged.setItem(KEY, '{ this is not json');
    assert.equal(boot(damaged).tries(), 0, 'unreadable storage must never lock a real user out');

    for (const [lang, re] of [['fr', /Attendez/], ['rw', /Tegereza/]]) {
        const s = makeStore();
        const a = boot(s, lang);
        for (let i = 0; i < 4; i++) a.fail();
        assert.match(a.msg(), re, lang + ' explains the wait in its own words');
    }
});

test('account server config exists and defaults to local-only', async () => {
    const html = await read('www', 'index.html');
    assert.ok(html.includes("var API_URL = '';"), 'API_URL defaults to local-only mode');
    assert.ok(html.includes('server/api'), 'config points at the bundled server');
    assert.ok(html.includes('connect-src'), 'CSP reminder documented next to API_URL');
});

test('API client speaks to the account server with a bearer token', async () => {
    const html = await read('www', 'index.html');
    assert.ok(html.includes('function apiCall(method, path, body)'), 'apiCall defined');
    assert.ok(html.includes("'Bearer ' + tok"), 'bearer token attached');
    assert.ok(html.includes("'/api/auth/register'"), 'register endpoint');
    assert.ok(html.includes("'/api/auth/login'"), 'login endpoint');
    assert.ok(html.includes("'/api/data'"), 'data endpoints');
    assert.ok(html.includes("'/api/account'"), 'account record endpoint');
    assert.ok(html.includes('pclinic_api_token'), 'token persisted');
});

test('every encrypted save is pushed to the server replica', async () => {
    const html = await read('www', 'index.html');
    const start = html.indexOf('function secureSet(key, obj)');
    assert.ok(start > -1, 'secureSet found');
    const body = html.slice(start, start + 1600);
    assert.ok(body.includes('syncPush(key, blob, currentUser.id)'), 'secureSet pushes the ciphertext');
    assert.ok(html.includes('function syncPush(key, blob, userId)'), 'syncPush defined');
    assert.ok(html.includes('function syncPull(user)'), 'syncPull defined');
    assert.ok(html.includes('function flushSyncQueue()'), 'offline queue flush defined');
    assert.ok(html.includes("addEventListener('online'"), 'queue flushes when connectivity returns');
});

test('sign-in is local-first with a server fallthrough for new devices', async () => {
    const html = await read('www', 'index.html');
    assert.ok(html.includes('function signInLocal(u, password)'), 'local sign-in preserved');
    assert.ok(html.includes('function signInFromServer(email, password)'), 'new-device server sign-in');
    assert.ok(html.includes('function serverSyncAfterSignIn(u, password, viaPin)'), 'post-sign-in sync');
    assert.ok(html.includes('findUserByEmail(username)'), 'login accepts an e-mail');
    // New-device flow must unwrap the data key from the synced crypto record.
    const start = html.indexOf('function signInFromServer(email, password)');
    const body = html.slice(start, start + 2600);
    assert.ok(body.includes('deriveAccountKeys(password, user.pw.salt, user.pw.iter)'), 'DEK derived on the new device');
    assert.ok(body.includes('unwrapDEK(k.kek, user.dek)'), 'wrapped DEK unwrapped');
    assert.ok(body.includes('saveUsers(users)'), 'account reconstructed locally');
});

test('registration creates the server account before the local one', async () => {
    const html = await read('www', 'index.html');
    const start = html.indexOf('function registerAccount(username, password, email, phone)');
    assert.ok(start > -1, 'registerAccount found');
    const body = html.slice(start, start + 3200);
    assert.ok(body.includes('apiRegister(emailNorm, password)'), 'server account created first');
    assert.ok(body.includes('apiSetToken(res.token, emailNorm)'), 'token stored');
    assert.ok(body.includes('syncAccount(res.user)'), 'crypto record synced');
    assert.ok(body.includes('syncPushAll(res.user)'), 'initial stores synced');
});

test('logout ends the server session too', async () => {
    const html = await read('www', 'index.html');
    const start = html.indexOf('function logout()');
    const body = html.slice(start, start + 900);
    assert.ok(body.includes('apiLogout()'), 'server notified');
    assert.ok(body.includes('apiClearToken()'), 'token discarded');
});

test('account server ships zero-dependency and tested', async () => {
    const pkg = JSON.parse(await read('server', 'api', 'package.json'));
    assert.deepEqual(pkg.dependencies || {}, {}, 'no runtime dependencies');
    assert.ok(pkg.scripts.start.includes('node index.js'), 'node index.js runs it');
    const server = await read('server', 'api', 'index.js');
    assert.ok(server.includes("'/api/auth/register'"), 'register route');
    assert.ok(server.includes("'/api/auth/login'"), 'login route');
    assert.ok(server.includes("'/api/data'"), 'blob routes');
    const auth = await read('server', 'api', 'auth.js');
    assert.ok(auth.includes('scryptSync'), 'scrypt password hashing');
    assert.ok(auth.includes('timingSafeEqual'), 'constant-time compare');
    const tests = await read('server', 'api', 'test', 'api.test.mjs');
    assert.ok(tests.includes('encrypted blobs round-trip'), 'server contract tests exist');
});

test('auto-lock default is minutes, not days', async () => {
    const html = await read('www', 'index.html');
    const start = html.indexOf('function getLockMs()');
    assert.ok(start > -1, 'getLockMs found');
    const body = html.slice(start, start + 300);
    assert.ok(body.includes('5 * 60 * 1000'), 'default is 5 minutes');
    assert.ok(!body.includes('3 * 24 * 60 * 60 * 1000'), 'the 3-day default is gone');
    // The 3-day choice stays available for users who explicitly want it.
    assert.ok(html.includes('value="259200000"'), '3 days remains a user choice');
});
