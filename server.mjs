// Proshno server: serves the app and handles sign-in. No dependencies — Node's own http, crypto and zlib.
//
//   node server.mjs                                   app on http://localhost:5173, data in ./data
//   PORT=80 DATA_DIR=/data ADMIN_PASSWORD=… node server.mjs     (what the Docker image runs)
//
// Environment:
//   ADMIN_PASSWORD  password for the admin page at /admin (the admin page is off when it is empty)
//   DATA_DIR        where users.json and the signing key live — must survive redeploys (a mounted volume)
//   CONTACT         shown to people whose free time is over, e.g. "WhatsApp 01XXXXXXXXX"
//   TRIAL_DAYS      free time after sign-up (default 2)
//   PORT            default 5173
//
// How access works:
//   Anyone can make an account. It works for TRIAL_DAYS from sign-up, then stops until the admin
//   approves it on /admin (until a date, or with no end). One free trial per phone.
//   After sign-in the phone holds a signed pass (ECDSA P-256), so the app keeps working offline —
//   but never past the end of the person's access. Every time the app is opened online the pass is
//   renewed, or withdrawn if the account was switched off, its password changed or its time is over.
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 5173;
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const CONTACT = String(process.env.CONTACT || '').slice(0, 200);
const DAY = 864e5;
const TRIAL_MS = Math.max(0, +(process.env.TRIAL_DAYS ?? 2)) * DAY;
const OFFLINE_DAYS = 30;
const DEFAULT_MAX_DEVICES = 2;

mkdirSync(DATA, { recursive: true });

/* ---------- signing key: made once, kept in DATA_DIR ---------- */
const keyFile = path.join(DATA, 'auth-key.json');
if (!existsSync(keyFile)) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  writeFileSync(keyFile, JSON.stringify({ private: privateKey.export({ format: 'jwk' }), public: publicKey.export({ format: 'jwk' }) }), { mode: 0o600 });
}
const KEYS = JSON.parse(readFileSync(keyFile, 'utf8'));
const privateKey = crypto.createPrivateKey({ key: KEYS.private, format: 'jwk' });
const publicKey = crypto.createPublicKey({ key: KEYS.public, format: 'jwk' });
const PUBLIC_JWK = { kty: 'EC', crv: 'P-256', x: KEYS.public.x, y: KEYS.public.y };

const b64u = buf => Buffer.from(buf).toString('base64url');
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  return body + '.' + b64u(crypto.sign('sha256', Buffer.from(body), { key: privateKey, dsaEncoding: 'ieee-p1363' }));
}
function verify(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  try {
    if (!crypto.verify('sha256', Buffer.from(body), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))) return null;
    return JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch { return null; }
}

/* ---------- users and used trials: small JSON files, written atomically ---------- */
const usersFile = path.join(DATA, 'users.json'), trialsFile = path.join(DATA, 'trial-devices.json');
let users = existsSync(usersFile) ? JSON.parse(readFileSync(usersFile, 'utf8')) : {};
let trialDevices = new Set(existsSync(trialsFile) ? JSON.parse(readFileSync(trialsFile, 'utf8')) : []);
function writeJson(file, data) { const tmp = file + '.tmp'; writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 }); renameSync(tmp, file); }
const saveUsers = () => writeJson(usersFile, users);
const saveTrials = () => writeJson(trialsFile, [...trialDevices]);
const normEmail = e => String(e || '').trim().toLowerCase();
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;
const normPhone = p => String(p || '').replace(/[\s\-()]/g, '').replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d));
const validPhone = p => /^(\+?88)?01[3-9]\d{8}$/.test(p);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${crypto.scryptSync(pw, salt, 32).toString('base64')}`;
}
function checkPassword(pw, stored) {
  const [, salt, hash] = String(stored || '').split('$');
  if (!salt || !hash) return false;
  const want = Buffer.from(hash, 'base64'), got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length);
  return crypto.timingSafeEqual(want, got);
}
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));   // so a wrong email takes as long as a wrong password

// until: '' = free trial only · 'YYYY-MM-DD' = approved to the end of that day (Bangladesh time) · 'forever'
// until: '' = free trial only · 'YYYY-MM-DD' = to the end of that day (Bangladesh time) · a full ISO time = exactly then · 'forever'
const untilEnd = u => u.until === 'forever' ? Infinity : !u.until ? 0 : u.until.includes('T') ? Date.parse(u.until) : Date.parse(u.until + 'T23:59:59.999+06:00');
const accessEnd = u => Math.max(u.trialEnd || 0, untilEnd(u));
const onTrial = u => !u.until || untilEnd(u) < (u.trialEnd || 0);
function refusal(u, device) {
  if (!u) return ['signed_out', 'This account no longer exists.'];
  if (u.disabled) return ['disabled', 'This account is switched off.'];
  if (accessEnd(u) < Date.now()) return [u.until ? 'expired' : 'trial_over', u.until ? 'Your access has ended.' : 'Your free time is over.'];
  if (device && !u.devices.some(d => d.id === device)) return ['signed_out', 'You were signed out on this phone. Please sign in again.'];
  return null;
}
function issue(u, device) {
  const now = Date.now(), end = accessEnd(u), exp = Math.min(now + OFFLINE_DAYS * DAY, end);
  const d = u.devices.find(x => x.id === device); if (d) d.lastSeen = now;
  u.lastSeen = now; saveUsers();
  const p = { e: u.email, n: u.name || '', d: device, v: u.v, iat: now, exp, end: end === Infinity ? 0 : end, t: onTrial(u) ? 1 : 0 };
  return { token: sign(p), exp, email: u.email, name: u.name || '', end: p.end, trial: !!p.t };
}
const refuseBody = (u, code, message) => ({ error: code, message, contact: CONTACT, name: u?.name || '' });

/* ---------- brute-force limits ---------- */
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(), h = (hits.get(key) || []).filter(t => t > now - windowMs);
  hits.set(key, h);
  return h.length >= max;
}
const hit = key => { const h = hits.get(key) || []; h.push(Date.now()); hits.set(key, h); };
setInterval(() => { const cut = Date.now() - DAY; for (const [k, h] of hits) if (!h.some(t => t > cut)) hits.delete(k); }, 36e5).unref();

/* ---------- API ---------- */
const clientIp = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(obj));
}
const fail = (res, status, error, message, extra) => json(res, status, { error, message, ...extra });
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 16384) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
const status = u => u.disabled ? 'off' : accessEnd(u) < Date.now() ? (u.until ? 'expired' : 'waiting') : onTrial(u) ? 'trial' : 'approved';
const publicUser = u => ({ email: u.email, name: u.name || '', phone: u.phone || '', until: u.until || '', trialEnd: u.trialEnd || 0, untilEnd: untilEnd(u) === Infinity ? 0 : untilEnd(u), end: accessEnd(u) === Infinity ? 0 : accessEnd(u), forever: accessEnd(u) === Infinity, approvedAt: u.approvedAt || 0, status: status(u),
  disabled: !!u.disabled, maxDevices: u.maxDevices, devices: u.devices.map(d => ({ name: d.name, since: d.since, lastSeen: d.lastSeen })), createdAt: u.createdAt, lastSeen: u.lastSeen || null });
const validUntil = s => s === '' || s === 'forever' || (/^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)));
const deviceName = s => String(s || 'Phone').slice(0, 80);

async function api(req, res, route) {
  const ip = clientIp(req);
  let body = {};
  if (req.method === 'POST' || req.method === 'PATCH') { try { body = await readBody(req); } catch { return fail(res, 400, 'bad_request', 'Bad request.'); } }

  if (route === 'signup' && req.method === 'POST') {
    const email = normEmail(body.email), phone = normPhone(body.phone), name = String(body.name || '').trim().slice(0, 80), device = String(body.device || '').slice(0, 64);
    if (!name || !device) return fail(res, 400, 'bad_request', 'Enter your name.');
    if (!validPhone(phone)) return fail(res, 400, 'bad_phone', 'Enter a valid mobile number.');
    if (!validEmail(email)) return fail(res, 400, 'bad_email', 'Enter a valid email.');
    if (String(body.password || '').length < 6) return fail(res, 400, 'short_password', 'The password needs at least 6 characters.');
    if (limited('su:' + ip, 5, DAY)) return fail(res, 429, 'too_many', 'Too many new accounts from here today.');
    if (users[email]) return fail(res, 409, 'exists', 'This email already has an account. Sign in instead.');
    if (Object.values(users).some(u => u.phone === phone)) return fail(res, 409, 'phone_exists', 'This mobile number already has an account. Sign in instead.');
    const used = trialDevices.has(device);
    hit('su:' + ip);
    const now = Date.now();
    users[email] = { email, name, phone, pass: hashPassword(String(body.password)), v: 1, trialEnd: used ? now : now + TRIAL_MS, until: '', disabled: false,
      maxDevices: DEFAULT_MAX_DEVICES, devices: [{ id: device, name: deviceName(body.deviceName), since: now, lastSeen: now }], createdAt: now, signupIp: ip };
    trialDevices.add(device); saveTrials(); saveUsers();
    // the account is made either way, so the admin can approve it; a phone that already had a free trial gets no second one
    if (used) return fail(res, 403, 'trial_used', 'This phone has already used its free time.', { contact: CONTACT, name });
    return json(res, 200, issue(users[email], device));
  }

  if (route === 'login' && req.method === 'POST') {
    const email = normEmail(body.email), device = String(body.device || '').slice(0, 64);
    if (!email || !body.password || !device) return fail(res, 400, 'bad_request', 'Enter your email and password.');
    if (limited('ip:' + ip, 20, 15 * 6e4) || limited('em:' + email, 8, 15 * 6e4)) return fail(res, 429, 'too_many', 'Too many tries. Wait 15 minutes and try again.');
    const u = users[email];
    if (!checkPassword(body.password, u ? u.pass : DUMMY_HASH) || !u) { hit('ip:' + ip); hit('em:' + email); return fail(res, 401, 'wrong', 'Wrong email or password.'); }
    const no = refusal(u); if (no) return json(res, 403, refuseBody(u, ...no));
    if (!u.devices.some(d => d.id === device)) {
      if (u.devices.length >= u.maxDevices) return fail(res, 403, 'devices', `This account is already used on ${u.devices.length} phones.`, { contact: CONTACT });
      u.devices.push({ id: device, name: deviceName(body.deviceName), since: Date.now(), lastSeen: Date.now() });
    }
    return json(res, 200, issue(u, device));
  }

  if (route === 'refresh' && req.method === 'POST') {
    const p = verify(body.token);
    if (!p || p.iat < Date.now() - 180 * DAY) return fail(res, 401, 'signed_out', 'Please sign in again.');
    const u = users[p.e];
    if (u && u.v !== p.v) return fail(res, 401, 'signed_out', 'Your password was changed. Please sign in again.');
    const no = refusal(u, p.d); if (no) return json(res, 401, refuseBody(u, ...no));
    return json(res, 200, issue(u, p.d));
  }

  if (route.startsWith('admin/')) {
    if (!ADMIN_PASSWORD) return fail(res, 503, 'off', 'The admin page is off: set ADMIN_PASSWORD on the server.');
    if (limited('admin:' + ip, 10, 15 * 6e4)) return fail(res, 429, 'too_many', 'Too many wrong tries. Wait 15 minutes.');
    const given = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, '')), want = Buffer.from(ADMIN_PASSWORD);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) { hit('admin:' + ip); return fail(res, 401, 'wrong', 'Wrong admin password.'); }
    const sub = route.slice(6);

    if (sub === 'users' && req.method === 'GET') return json(res, 200, { users: Object.values(users).map(publicUser).sort((a, b) => b.createdAt - a.createdAt), trialDays: TRIAL_MS / DAY });
    if (sub === 'users' && req.method === 'POST') {
      const email = normEmail(body.email), until = String(body.until ?? '');
      if (!validEmail(email)) return fail(res, 400, 'bad_request', 'Enter a valid email.');
      if (users[email]) return fail(res, 409, 'exists', 'That email is already added.');
      if (String(body.password || '').length < 6) return fail(res, 400, 'bad_request', 'The password needs at least 6 characters.');
      if (!validUntil(until)) return fail(res, 400, 'bad_request', 'Access must be a date or "forever".');
      users[email] = { email, name: String(body.name || '').trim().slice(0, 80), phone: normPhone(body.phone), pass: hashPassword(String(body.password)), v: 1, trialEnd: 0, until, disabled: false,
        maxDevices: Math.max(1, Math.min(10, +body.maxDevices || DEFAULT_MAX_DEVICES)), devices: [], createdAt: Date.now() };
      saveUsers(); return json(res, 200, { user: publicUser(users[email]) });
    }
    const m = sub.match(/^users\/(.+)$/), u = m && users[normEmail(decodeURIComponent(m[1]))];
    if (m && !u) return fail(res, 404, 'not_found', 'No such user.');
    if (u && req.method === 'PATCH') {
      if (body.password != null) { if (String(body.password).length < 6) return fail(res, 400, 'bad_request', 'The password needs at least 6 characters.'); u.pass = hashPassword(String(body.password)); u.v++; }
      if (body.until != null) { if (!validUntil(String(body.until))) return fail(res, 400, 'bad_request', 'Access must be a date or "forever".'); u.until = String(body.until); }
      // the admin sets the exact end of access: 'forever' or a time in ms (this replaces any free time left)
      if (body.endAt != null) {
        u.approvedAt = Date.now();
        if (body.endAt === 'forever') u.until = 'forever';
        else { const t = Math.round(+body.endAt); if (!isFinite(t) || t < 0 || t > Date.now() + 50 * 365 * DAY) return fail(res, 400, 'bad_request', 'That end time is not valid.'); u.until = new Date(t).toISOString(); u.trialEnd = Math.min(u.trialEnd || 0, t); }
      }
      if (body.disabled != null) u.disabled = !!body.disabled;
      if (body.maxDevices != null) u.maxDevices = Math.max(1, Math.min(10, +body.maxDevices || DEFAULT_MAX_DEVICES));
      if (body.resetDevices) u.devices = [];
      saveUsers(); return json(res, 200, { user: publicUser(u) });
    }
    if (u && req.method === 'DELETE') { delete users[u.email]; saveUsers(); return json(res, 200, { ok: true }); }
  }
  return fail(res, 404, 'not_found', 'Not found.');
}

/* ---------- static files (loaded once at start) ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.css': 'text/css', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const SHELL = new Set(['/index.html', '/admin.html', '/sw.js', '/manifest.webmanifest', '/auth-config.js', '/checker/index.html', '/checker/sw.js', '/checker/manifest.webmanifest', '/checker/config.js']);
const files = new Map();
function put(rel, buf) {
  const type = TYPES[path.extname(rel)] || 'application/octet-stream', text = !/^(image\/png|font\/)/.test(type);
  files.set(rel, { buf, gz: text && buf.length > 512 ? zlib.gzipSync(buf) : null, type });
}
function load(rel) {
  const full = path.join(ROOT, rel);
  if (!existsSync(full)) return;
  if (statSync(full).isDirectory()) { for (const f of readdirSync(full)) if (!f.startsWith('.')) load(path.posix.join(rel, f)); return; }
  if (!TYPES[path.extname(rel)]) return;
  put('/' + rel, readFileSync(full));
}
['index.html', 'admin.html', 'sw.js', 'manifest.webmanifest', 'icons', 'checker'].forEach(load);
// the app checks sign-in passes offline with this public key
put('/auth-config.js', Buffer.from(`window.PROSHNO_AUTH = ${JSON.stringify({ key: PUBLIC_JWK, offlineDays: OFFLINE_DAYS, trialDays: TRIAL_MS / DAY, contact: CONTACT })};\n`));

const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()' };
function serve(req, res, pathname) {
  if (pathname === '/admin' || pathname === '/admin/') pathname = '/admin.html';
  if (pathname === '/checker' ) { res.writeHead(301, { Location: '/checker/' }); return res.end(); }
  if (pathname.endsWith('/')) pathname += 'index.html';
  let f = files.get(pathname);
  if (!f && path.extname(pathname)) { res.writeHead(404, SECURITY); return res.end('Not found'); }
  if (!f) f = files.get('/index.html');   // app routes fall back to the app
  const gz = f.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.writeHead(200, {
    ...SECURITY, 'Content-Type': f.type, 'Vary': 'Accept-Encoding',
    'Cache-Control': pathname === '/admin.html' ? 'no-store' : SHELL.has(pathname) || pathname.endsWith('.html') ? 'no-cache' : 'public, max-age=604800',
    ...(gz ? { 'Content-Encoding': 'gzip' } : {}), 'Content-Length': (gz ? f.gz : f.buf).length,
  });
  res.end(req.method === 'HEAD' ? undefined : gz ? f.gz : f.buf);
}

http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok\n'); }
    if (pathname.startsWith('/api/')) return await api(req, res, pathname.slice(5));
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, SECURITY); return res.end(); }
    serve(req, res, decodeURIComponent(pathname));
  } catch (err) { console.error(err); if (!res.headersSent) fail(res, 500, 'server', 'Something went wrong on the server.'); else res.end(); }
}).listen(PORT, () => console.log(`Proshno on http://localhost:${PORT} · data in ${DATA} · free time ${TRIAL_MS / DAY} days · admin page ${ADMIN_PASSWORD ? 'on' : 'off (set ADMIN_PASSWORD)'}`));
