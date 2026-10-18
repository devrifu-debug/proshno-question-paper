// Proshno server: serves the app and handles sign-in, with accounts kept in files. No dependencies.
// (On Vercel the same sign-in runs from api/handler.mjs with accounts in Supabase — see DEPLOY.md.)
//
//   node server.mjs                                   app on http://localhost:5173, data in ./data
//   PORT=80 DATA_DIR=/data ADMIN_PASSWORD=… node server.mjs     (what the Docker image runs)
//
// Environment:
//   ADMIN_PASSWORD  password for the admin page at /admin (the admin page is off when it is empty)
//   DATA_DIR        where the accounts and the signing key live — must survive redeploys (a mounted volume)
//   CONTACT         shown to people whose free time is over, e.g. "WhatsApp 01XXXXXXXXX"
//   TRIAL_DAYS      free time after sign-up (default 2)
//   RESEND_API_KEY  turns on 6-digit email codes for sign-up and forgotten passwords (with MAIL_FROM)
//   PORT            default 5173
import http from 'node:http';
import zlib from 'node:zlib';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth } from './lib/core.mjs';
import { fileStore } from './lib/store-file.mjs';
import { resendMailer } from './lib/mail.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 5173;
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const auth = createAuth(fileStore(DATA), process.env, resendMailer(process.env));

/* ---------- API ---------- */
const clientIp = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 16384) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
async function api(req, res, route) {
  let body = {};
  if (req.method === 'POST' || req.method === 'PATCH') { try { body = await readBody(req); } catch { return json(res, 400, { error: 'bad_request', message: 'Bad request.' }); } }
  const r = await auth.handle({ route, method: req.method, body, headers: req.headers, ip: clientIp(req) });
  json(res, r.status, r.body);
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
put('/auth-config.js', Buffer.from(await auth.authConfig()));

const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()' };
function serve(req, res, pathname) {
  if (pathname === '/admin' || pathname === '/admin/') pathname = '/admin.html';
  if (pathname === '/checker') { res.writeHead(301, { Location: '/checker/' }); return res.end(); }
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
    if (pathname.startsWith('/api/')) return await api(req, res, decodeURIComponent(pathname.slice(5)));
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, SECURITY); return res.end(); }
    serve(req, res, decodeURIComponent(pathname));
  } catch (err) { console.error(err); if (!res.headersSent) json(res, 500, { error: 'server', message: 'Something went wrong on the server.' }); else res.end(); }
}).listen(PORT, () => console.log(`Proshno on http://localhost:${PORT} · data in ${DATA} · free time ${auth.trialDays} days · admin page ${process.env.ADMIN_PASSWORD ? 'on' : 'off (set ADMIN_PASSWORD)'}`));
