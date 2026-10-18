// Sign-in rules shared by server.mjs (own server, accounts in files) and api/handler.mjs (Vercel, accounts in Supabase).
//
// Anyone can make an account. It works for TRIAL_DAYS from sign-up, then stops until the admin approves it
// on /admin. One free trial per phone. After sign-in the phone holds a signed pass (ECDSA P-256), so the app
// keeps working offline — but never past the end of the person's access.
//
// A store is an object with these async methods:
//   getSetting(k) · addSettingIfAbsent(k, v) -> the stored value
//   getUser(email) · saveUser(u) · deleteUser(email) · listUsers() · phoneTaken(phone)
//   hasTrial(device) · addTrial(device)
//   getCode(k) · setCode(k, v) · delCode(k)        (email codes, short-lived)
import crypto from 'node:crypto';

const DAY = 864e5, OFFLINE_DAYS = 30, DEFAULT_MAX_DEVICES = 2;
const b64u = buf => Buffer.from(buf).toString('base64url');
export const normEmail = e => String(e || '').trim().toLowerCase();
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;
const normPhone = p => String(p || '').replace(/[\s\-()]/g, '').replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d));
const validPhone = p => /^(\+?88)?01[3-9]\d{8}$/.test(p);
const validUntil = s => s === '' || s === 'forever' || (/^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)));
const deviceName = s => String(s || 'Phone').slice(0, 80);

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

// until: '' = free trial only · 'YYYY-MM-DD' = to the end of that day (Bangladesh time) · a full ISO time = exactly then · 'forever'
const untilEnd = u => u.until === 'forever' ? Infinity : !u.until ? 0 : u.until.includes('T') ? Date.parse(u.until) : Date.parse(u.until + 'T23:59:59.999+06:00');
const accessEnd = u => Math.max(u.trialEnd || 0, untilEnd(u));
const onTrial = u => !u.until || untilEnd(u) < (u.trialEnd || 0);
const status = u => u.disabled ? 'off' : accessEnd(u) < Date.now() ? (u.until ? 'expired' : 'waiting') : onTrial(u) ? 'trial' : 'approved';
const publicUser = u => ({ email: u.email, name: u.name || '', phone: u.phone || '', until: u.until || '', trialEnd: u.trialEnd || 0,
  untilEnd: untilEnd(u) === Infinity ? 0 : untilEnd(u), end: accessEnd(u) === Infinity ? 0 : accessEnd(u), forever: accessEnd(u) === Infinity,
  approvedAt: u.approvedAt || 0, verified: !!u.verified, status: status(u), disabled: !!u.disabled, maxDevices: u.maxDevices,
  devices: (u.devices || []).map(d => ({ name: d.name, since: d.since, lastSeen: d.lastSeen })), createdAt: u.createdAt, lastSeen: u.lastSeen || null });

/* brute-force limits (per running instance; good enough to slow down guessing) */
const hits = new Map();
function limited(key, max, windowMs) { const now = Date.now(), h = (hits.get(key) || []).filter(t => t > now - windowMs); hits.set(key, h); return h.length >= max; }
const hit = key => { const h = hits.get(key) || []; h.push(Date.now()); hits.set(key, h); if (hits.size > 5000) hits.delete(hits.keys().next().value); };

const CODE_MS = 10 * 6e4, CODE_TRIES = 5, RESEND_WAIT = 60e3;
const codeHash = (email, code) => crypto.createHash('sha256').update(email + ':' + String(code).trim()).digest('hex');
const sameHash = (a, b) => a && b && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createAuth(store, env = {}, mailer = null) {
  const ADMIN_PASSWORD = env.ADMIN_PASSWORD || '';
  const CONTACT = String(env.CONTACT || '').slice(0, 200);
  const TRIAL_MS = Math.max(0, +(env.TRIAL_DAYS ?? 2) || 0) * DAY || (env.TRIAL_DAYS === '0' ? 0 : 2 * DAY);

  /* signing key: made once and kept in the store */
  let keysP = null;
  function keys() {
    return keysP ||= (async () => {
      let k = await store.getSetting('auth-key');
      if (!k) {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
        k = await store.addSettingIfAbsent('auth-key', { private: privateKey.export({ format: 'jwk' }), public: publicKey.export({ format: 'jwk' }) });
      }
      return { priv: crypto.createPrivateKey({ key: k.private, format: 'jwk' }), pub: crypto.createPublicKey({ key: k.public, format: 'jwk' }),
        jwk: { kty: 'EC', crv: 'P-256', x: k.public.x, y: k.public.y } };
    })().catch(e => { keysP = null; throw e; });
  }
  async function sign(payload) {
    const { priv } = await keys(), body = b64u(JSON.stringify(payload));
    return body + '.' + b64u(crypto.sign('sha256', Buffer.from(body), { key: priv, dsaEncoding: 'ieee-p1363' }));
  }
  async function verify(token) {
    const [body, sig] = String(token || '').split('.'); if (!body || !sig) return null;
    try {
      const { pub } = await keys();
      if (!crypto.verify('sha256', Buffer.from(body), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))) return null;
      return JSON.parse(Buffer.from(body, 'base64url').toString());
    } catch { return null; }
  }

  function refusal(u, device) {
    if (!u) return ['signed_out', 'This account no longer exists.'];
    if (u.disabled) return ['disabled', 'This account is switched off.'];
    if (accessEnd(u) < Date.now()) return [u.until ? 'expired' : 'trial_over', u.until ? 'Your access has ended.' : 'Your free time is over.'];
    if (device && !u.devices.some(d => d.id === device)) return ['signed_out', 'You were signed out on this phone. Please sign in again.'];
    return null;
  }
  async function issue(u, device) {
    const now = Date.now(), end = accessEnd(u), exp = Math.min(now + OFFLINE_DAYS * DAY, end);
    const d = u.devices.find(x => x.id === device); if (d) d.lastSeen = now;
    u.lastSeen = now; await store.saveUser(u);
    const p = { e: u.email, n: u.name || '', d: device, v: u.v, iat: now, exp, end: end === Infinity ? 0 : end, t: onTrial(u) ? 1 : 0 };
    return { token: await sign(p), exp, email: u.email, name: u.name || '', end: p.end, trial: !!p.t };
  }
  const R = (status, body) => ({ status, body });
  const fail = (status, error, message, extra) => R(status, { error, message, ...extra });
  const refuse = (status, u, [code, message]) => R(status, { error: code, message, contact: CONTACT, name: u?.name || '' });

  async function authConfig() {
    const { jwk } = await keys();
    return `window.PROSHNO_AUTH = ${JSON.stringify({ key: jwk, offlineDays: OFFLINE_DAYS, trialDays: TRIAL_MS / DAY, contact: CONTACT, verify: !!mailer })};\n`;
  }

  // email codes: one per purpose and address, 10 minutes, 5 tries, at most one new code a minute and 6 an hour
  async function sendCode(key, email, kind, extra, ip) {
    if (limited('mail:' + ip, 20, 36e5) || limited('mailto:' + email, 6, 36e5)) return fail(429, 'too_many', 'Too many codes. Try again later.');
    const old = await store.getCode(key);
    if (old && Date.now() - old.sent < RESEND_WAIT) return fail(429, 'wait', 'Wait a moment before asking for a new code.', { wait: Math.ceil((RESEND_WAIT - (Date.now() - old.sent)) / 1000) });
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    await store.setCode(key, { h: codeHash(email, code), exp: Date.now() + CODE_MS, tries: 0, sent: Date.now(), ...extra });
    try { await mailer.sendCode(email, code, kind); }
    catch (e) { console.error(e.message); await store.delCode(key); return fail(502, 'mail_failed', 'The email could not be sent.'); }
    hit('mail:' + ip); hit('mailto:' + email);
    return R(200, { ok: true, email, wait: RESEND_WAIT / 1000 });
  }
  // null when the code is right (and used up), otherwise the refusal
  async function useCode(key, email, code) {
    const c = await store.getCode(key);
    if (!c) return fail(400, 'no_code', 'Ask for a new code.');
    if (c.exp < Date.now()) { await store.delCode(key); return fail(400, 'code_expired', 'The code has expired. Ask for a new one.'); }
    if (c.tries >= CODE_TRIES) { await store.delCode(key); return fail(400, 'too_many_tries', 'Too many wrong codes. Ask for a new one.'); }
    if (!sameHash(c.h, codeHash(email, code))) { c.tries++; await store.setCode(key, c); return fail(400, 'bad_code', 'That code is not right.', { left: CODE_TRIES - c.tries }); }
    await store.delCode(key);
    return { ok: true, data: c };
  }
  async function signInOn(u, device, name) {
    const no = refusal(u); if (no) { await store.saveUser(u); return refuse(403, u, no); }
    if (!u.devices.some(d => d.id === device)) {
      if (u.devices.length >= u.maxDevices) { await store.saveUser(u); return fail(403, 'devices', `This account is already used on ${u.devices.length} phones.`, { contact: CONTACT }); }
      u.devices.push({ id: device, name: deviceName(name), since: Date.now(), lastSeen: Date.now() });
    }
    return R(200, await issue(u, device));
  }
  async function makeAccount({ email, name, phone, pass, device, deviceName: dn, verified }, ip) {
    const used = await store.hasTrial(device), now = Date.now();
    const u = { email, name, phone, pass, v: 1, trialEnd: used ? now : now + TRIAL_MS, until: '', disabled: false, verified: !!verified,
      maxDevices: DEFAULT_MAX_DEVICES, devices: [{ id: device, name: deviceName(dn), since: now, lastSeen: now }], createdAt: now, signupIp: ip };
    await store.saveUser(u); await store.addTrial(device);
    // the account is made either way, so the admin can approve it; a phone that already had a free trial gets no second one
    if (used) return fail(403, 'trial_used', 'This phone has already used its free time.', { contact: CONTACT, name });
    return R(200, await issue(u, device));
  }

  // route: 'signup-code' | 'signup' | 'login' | 'reset-code' | 'reset' | 'refresh' | 'admin/users' | 'admin/users/<email>'
  async function handle({ route, method, body = {}, headers = {}, ip = '' }) {
    if ((route === 'signup' || route === 'signup-code') && method === 'POST') {
      const email = normEmail(body.email), phone = normPhone(body.phone), name = String(body.name || '').trim().slice(0, 80), device = String(body.device || '').slice(0, 64);
      // with email codes on, the final step only needs the email, the code and the phone's id: the rest was checked when the code was sent
      if (route === 'signup' && mailer) {
        if (!validEmail(email) || !device || !body.code) return fail(400, 'bad_request', 'Enter the code from your email.');
        if (limited('vc:' + ip, 30, 36e5)) return fail(429, 'too_many', 'Too many tries. Try again later.');
        hit('vc:' + ip);
        const ok = await useCode('su:' + email, email, body.code); if (!ok.ok) return ok;
        if (await store.getUser(email)) return fail(409, 'exists', 'This email already has an account. Sign in instead.');
        const d = ok.data; hit('su:' + ip);
        return makeAccount({ email, name: d.name, phone: d.phone, pass: d.pass, device, deviceName: body.deviceName || d.deviceName, verified: true }, ip);
      }
      if (!name || !device) return fail(400, 'bad_request', 'Enter your name.');
      if (!validPhone(phone)) return fail(400, 'bad_phone', 'Enter a valid mobile number.');
      if (!validEmail(email)) return fail(400, 'bad_email', 'Enter a valid email.');
      if (String(body.password || '').length < 6) return fail(400, 'short_password', 'The password needs at least 6 characters.');
      if (limited('su:' + ip, 5, DAY)) return fail(429, 'too_many', 'Too many new accounts from here today.');
      if (await store.getUser(email)) return fail(409, 'exists', 'This email already has an account. Sign in instead.');
      if (await store.phoneTaken(phone)) return fail(409, 'phone_exists', 'This mobile number already has an account. Sign in instead.');
      if (route === 'signup-code') {
        if (!mailer) return fail(400, 'bad_request', 'Email codes are off.');
        return sendCode('su:' + email, email, 'signup', { name, phone, pass: hashPassword(String(body.password)), deviceName: deviceName(body.deviceName) }, ip);
      }
      hit('su:' + ip);
      return makeAccount({ email, name, phone, pass: hashPassword(String(body.password)), device, deviceName: body.deviceName, verified: false }, ip);
    }

    if (route === 'reset-code' && method === 'POST') {
      const email = normEmail(body.email);
      if (!mailer) return fail(400, 'bad_request', 'Email codes are off.');
      if (!validEmail(email)) return fail(400, 'bad_email', 'Enter a valid email.');
      // the answer is the same whether or not the email has an account, so nobody can test which emails are signed up
      if (!(await store.getUser(email))) { hit('mail:' + ip); return limited('mail:' + ip, 20, 36e5) ? fail(429, 'too_many', 'Too many codes. Try again later.') : R(200, { ok: true, email, wait: RESEND_WAIT / 1000 }); }
      return sendCode('rs:' + email, email, 'reset', {}, ip);
    }
    if (route === 'reset' && method === 'POST') {
      const email = normEmail(body.email), device = String(body.device || '').slice(0, 64);
      if (!mailer) return fail(400, 'bad_request', 'Email codes are off.');
      if (!validEmail(email) || !device || !body.code) return fail(400, 'bad_request', 'Enter the code from your email.');
      if (String(body.password || '').length < 6) return fail(400, 'short_password', 'The password needs at least 6 characters.');
      if (limited('vc:' + ip, 30, 36e5)) return fail(429, 'too_many', 'Too many tries. Try again later.');
      hit('vc:' + ip);
      const ok = await useCode('rs:' + email, email, body.code); if (!ok.ok) return ok;
      const u = await store.getUser(email); if (!u) return fail(400, 'no_code', 'Ask for a new code.');
      u.pass = hashPassword(String(body.password)); u.v++; u.verified = true;
      return signInOn(u, device, body.deviceName);
    }

    if (route === 'login' && method === 'POST') {
      const email = normEmail(body.email), device = String(body.device || '').slice(0, 64);
      if (!email || !body.password || !device) return fail(400, 'bad_request', 'Enter your email and password.');
      if (limited('ip:' + ip, 20, 15 * 6e4) || limited('em:' + email, 8, 15 * 6e4)) return fail(429, 'too_many', 'Too many tries. Wait 15 minutes and try again.');
      const u = await store.getUser(email);
      if (!checkPassword(body.password, u ? u.pass : DUMMY_HASH) || !u) { hit('ip:' + ip); hit('em:' + email); return fail(401, 'wrong', 'Wrong email or password.'); }
      return signInOn(u, device, body.deviceName);
    }

    if (route === 'refresh' && method === 'POST') {
      const p = await verify(body.token);
      if (!p || p.iat < Date.now() - 180 * DAY) return fail(401, 'signed_out', 'Please sign in again.');
      const u = await store.getUser(p.e);
      if (u && u.v !== p.v) return fail(401, 'signed_out', 'Your password was changed. Please sign in again.');
      const no = refusal(u, p.d); if (no) return refuse(401, u, no);
      return R(200, await issue(u, p.d));
    }

    if (route.startsWith('admin/')) {
      if (!ADMIN_PASSWORD) return fail(503, 'off', 'The admin page is off: set ADMIN_PASSWORD on the server.');
      if (limited('admin:' + ip, 10, 15 * 6e4)) return fail(429, 'too_many', 'Too many wrong tries. Wait 15 minutes.');
      const given = Buffer.from(String(headers.authorization || '').replace(/^Bearer /, '')), want = Buffer.from(ADMIN_PASSWORD);
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) { hit('admin:' + ip); return fail(401, 'wrong', 'Wrong admin password.'); }
      const sub = route.slice(6);

      if (sub === 'users' && method === 'GET') return R(200, { users: (await store.listUsers()).map(publicUser).sort((a, b) => b.createdAt - a.createdAt), trialDays: TRIAL_MS / DAY });
      if (sub === 'users' && method === 'POST') {
        const email = normEmail(body.email), until = String(body.until ?? '');
        if (!validEmail(email)) return fail(400, 'bad_request', 'Enter a valid email.');
        if (await store.getUser(email)) return fail(409, 'exists', 'That email is already added.');
        if (String(body.password || '').length < 6) return fail(400, 'bad_request', 'The password needs at least 6 characters.');
        if (!validUntil(until)) return fail(400, 'bad_request', 'Access must be a date or "forever".');
        const u = { email, name: String(body.name || '').trim().slice(0, 80), phone: normPhone(body.phone), pass: hashPassword(String(body.password)), v: 1, trialEnd: 0, until, disabled: false,
          maxDevices: Math.max(1, Math.min(10, +body.maxDevices || DEFAULT_MAX_DEVICES)), devices: [], createdAt: Date.now() };
        await store.saveUser(u); return R(200, { user: publicUser(u) });
      }
      const m = sub.match(/^users\/(.+)$/), u = m && await store.getUser(normEmail(decodeURIComponent(m[1])));
      if (m && !u) return fail(404, 'not_found', 'No such user.');
      if (u && method === 'PATCH') {
        if (body.password != null) { if (String(body.password).length < 6) return fail(400, 'bad_request', 'The password needs at least 6 characters.'); u.pass = hashPassword(String(body.password)); u.v++; }
        if (body.until != null) { if (!validUntil(String(body.until))) return fail(400, 'bad_request', 'Access must be a date or "forever".'); u.until = String(body.until); }
        // the admin sets the exact end of access: 'forever' or a time in ms (this replaces any free time left)
        if (body.endAt != null) {
          u.approvedAt = Date.now();
          if (body.endAt === 'forever') u.until = 'forever';
          else { const t = Math.round(+body.endAt); if (!isFinite(t) || t < 0 || t > Date.now() + 50 * 365 * DAY) return fail(400, 'bad_request', 'That end time is not valid.'); u.until = new Date(t).toISOString(); u.trialEnd = Math.min(u.trialEnd || 0, t); }
        }
        if (body.disabled != null) u.disabled = !!body.disabled;
        if (body.maxDevices != null) u.maxDevices = Math.max(1, Math.min(10, +body.maxDevices || DEFAULT_MAX_DEVICES));
        if (body.resetDevices) u.devices = [];
        await store.saveUser(u); return R(200, { user: publicUser(u) });
      }
      if (u && method === 'DELETE') { await store.deleteUser(u.email); return R(200, { ok: true }); }
    }
    return fail(404, 'not_found', 'Not found.');
  }
  return { handle, authConfig, trialDays: TRIAL_MS / DAY, email: !!mailer };
}
