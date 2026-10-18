// Accounts kept in small JSON files (for running server.mjs on your own server). Writes are atomic.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export function fileStore(dir) {
  mkdirSync(dir, { recursive: true });
  const f = n => path.join(dir, n);
  const read = (n, d) => existsSync(f(n)) ? JSON.parse(readFileSync(f(n), 'utf8')) : d;
  const write = (n, v) => { const t = f(n) + '.tmp'; writeFileSync(t, JSON.stringify(v, null, 1), { mode: 0o600 }); renameSync(t, f(n)); };
  const users = read('users.json', {});
  const trials = new Set(read('trial-devices.json', []));
  const clone = o => o && JSON.parse(JSON.stringify(o));
  return {
    async getSetting(k) { return k === 'auth-key' ? read('auth-key.json', null) : read('settings.json', {})[k] ?? null; },
    async addSettingIfAbsent(k, v) {
      if (k === 'auth-key') { const have = read('auth-key.json', null); if (have) return have; write('auth-key.json', v); return v; }
      const s = read('settings.json', {}); if (s[k] == null) { s[k] = v; write('settings.json', s); } return s[k];
    },
    async getUser(email) { return clone(users[email]) || null; },
    async saveUser(u) { users[u.email] = clone(u); write('users.json', users); },
    async deleteUser(email) { delete users[email]; write('users.json', users); },
    async listUsers() { return Object.values(users).map(clone); },
    async phoneTaken(phone) { return Object.values(users).some(u => u.phone === phone); },
    async hasTrial(device) { return trials.has(device); },
    async addTrial(device) { trials.add(device); write('trial-devices.json', [...trials]); },
  };
}
