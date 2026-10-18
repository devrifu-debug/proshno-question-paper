// Clerk (https://clerk.com) signs people in: email codes, Google, forgotten passwords.
// The app sends us the Clerk session token; we check it here, read the person's verified email from Clerk,
// and then apply our own rules (free days, approval, phones) exactly as for any other account.
//   CLERK_PUBLISHABLE_KEY  pk_test_… / pk_live_…  (public — the sign-in screen needs it)
//   CLERK_SECRET_KEY       sk_test_… / sk_live_…  (secret — only in the host's settings)
import crypto from 'node:crypto';

// pk_test_<base64("your-app.clerk.accounts.dev$")> → "your-app.clerk.accounts.dev"
export function clerkHost(pk) {
  const m = String(pk || '').match(/^pk_(test|live)_(.+)$/); if (!m) return '';
  try { return Buffer.from(m[2], 'base64').toString('utf8').replace(/\$$/, ''); } catch { return ''; }
}

export function clerkAuth(env) {
  const pk = env.CLERK_PUBLISHABLE_KEY || env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || '', sk = env.CLERK_SECRET_KEY || '';
  const host = clerkHost(pk);
  if (!pk || !sk || !host) return null;
  const api = (env.CLERK_API_BASE || 'https://api.clerk.com').replace(/\/+$/, '');
  const get = async path => {
    const r = await fetch(api + path, { headers: { Authorization: 'Bearer ' + sk } });
    if (!r.ok) throw new Error(`Clerk ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
    return r.json();
  };
  let jwks = null, jwksAt = 0;
  async function key(kid) {
    if (!jwks || Date.now() - jwksAt > 36e5 || !jwks.find(k => k.kid === kid)) { jwks = (await get('/v1/jwks')).keys || []; jwksAt = Date.now(); }
    const k = jwks.find(k => k.kid === kid); return k ? crypto.createPublicKey({ key: k, format: 'jwk' }) : null;
  }
  const b64json = s => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  return {
    publishableKey: pk, host,
    // the Clerk user id (sub) when the token is genuine and current, otherwise null
    async verify(token) {
      const [h, p, s] = String(token || '').split('.'); if (!h || !p || !s) return null;
      try {
        const head = b64json(h), body = b64json(p);
        if (head.alg !== 'RS256') return null;
        const k = await key(head.kid); if (!k) return null;
        if (!crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), k, Buffer.from(s, 'base64url'))) return null;
        const now = Date.now() / 1000;
        if (!body.sub || body.exp < now - 30 || (body.nbf && body.nbf > now + 30)) return null;
        if (body.iss && !String(body.iss).replace(/\/+$/, '').endsWith(host)) return null;
        return body.sub;
      } catch { return null; }
    },
    // the person's verified email and name
    async user(id) {
      const u = await get('/v1/users/' + encodeURIComponent(id));
      const list = u.email_addresses || [];
      const e = list.find(x => x.id === u.primary_email_address_id) || list[0];
      const verified = e && (!e.verification || e.verification.status === 'verified');
      return { id: u.id, email: verified ? String(e.email_address || '').toLowerCase() : '', name: [u.first_name, u.last_name].filter(Boolean).join(' ').trim() };
    },
  };
}
