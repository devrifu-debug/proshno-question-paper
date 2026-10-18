// Vercel: the sign-in API and auth-config.js, with accounts in Supabase (Postgres).
// vercel.json sends /api/* and /auth-config.js here.
// Needs: POSTGRES_URL (added by the Supabase integration) or DATABASE_URL, plus ADMIN_PASSWORD and CONTACT.
import { createAuth } from '../lib/core.mjs';
import { pgStore, connectionString, dbVarName } from '../lib/store-pg.mjs';

let auth = null;
function getAuth() {
  if (auth) return auth;
  const conn = connectionString(process.env);
  if (!conn) return null;
  return auth = createAuth(pgStore(conn), process.env);
}
const send = (res, status, body, type = 'application/json') => {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  // the route comes from the rewrite (?route=…); fall back to the path in case the original URL is passed through
  let q = req.query && req.query.route; if (Array.isArray(q)) q = q.join('/');
  let route = String(q || url.searchParams.get('route') || '');
  if (!route) route = url.pathname.endsWith('auth-config.js') ? 'auth-config' : url.pathname.replace(/^\/api\/(handler\/?)?/, '');
  route = decodeURIComponent(route).replace(/^\/+|\/+$/g, '');
  const a = getAuth();
  try {
    if (route === 'auth-config') {
      // no database yet: the app stays open (same as a plain static copy)
      if (!a) return send(res, 200, '/* sign-in is off: connect a database (POSTGRES_URL) */\n', 'text/javascript; charset=utf-8');
      return send(res, 200, await a.authConfig(), 'text/javascript; charset=utf-8');
    }
    if (route === 'healthz') {
      // names only (never values), so a missing setting is easy to spot
      const names = Object.keys(process.env).filter(k => /POSTGRES|DATABASE|SUPABASE/i.test(k)).sort();
      let db = !!a, error;
      if (a) { try { await a.authConfig(); } catch (e) { db = false; error = String(e.message || e).slice(0, 200); } }
      return send(res, 200, { ok: true, database: db, using: dbVarName(process.env) || null, adminPassword: !!process.env.ADMIN_PASSWORD, contact: !!process.env.CONTACT, databaseSettingsFound: names, ...(error ? { error } : {}) });
    }
    if (!a) return send(res, 503, { error: 'no_database', message: 'The database is not connected yet.' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'bad_request', message: 'Bad request.' }); } }
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';
    const r = await a.handle({ route, method: req.method, body: body || {}, headers: req.headers, ip });
    return send(res, r.status, r.body);
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: 'server', message: 'Something went wrong on the server.' });
  }
}
