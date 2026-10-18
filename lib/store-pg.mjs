// Accounts kept in Postgres (Supabase). The tables are made on first use, so no SQL needs to be typed by hand.
//   proshno_users          one row per account: email, name, phone, status columns to read at a glance, and the full record in `data`
//   proshno_trial_devices  phones that already had their free time
//   proshno_settings       the signing key
import pg from 'pg';

export function connectionString(env) {
  const raw = env.POSTGRES_URL || env.DATABASE_URL || env.SUPABASE_DB_URL || env.POSTGRES_PRISMA_URL || '';
  if (!raw) return '';
  try { const u = new URL(raw); ['sslmode', 'supa', 'pgbouncer', 'sslrootcert'].forEach(k => u.searchParams.delete(k)); return u.toString(); } catch { return raw; }
}

export function pgStore(conn) {
  const pool = new pg.Pool({ connectionString: conn, ssl: /localhost|127\.0\.0\.1/.test(conn) ? false : { rejectUnauthorized: false }, max: 3, idleTimeoutMillis: 10000 });
  let ready = null;
  const q = async (sql, args) => { await (ready ||= setup().catch(e => { ready = null; throw e; })); return pool.query(sql, args); };
  async function setup() {
    await pool.query(`
      create table if not exists proshno_users (
        email text primary key,
        name text, phone text,
        access_ends timestamptz, approved boolean default false, disabled boolean default false,
        data jsonb not null,
        created_at timestamptz default now(), updated_at timestamptz default now());
      create index if not exists proshno_users_phone on proshno_users (phone);
      create table if not exists proshno_trial_devices (device text primary key, created_at timestamptz default now());
      create table if not exists proshno_settings (k text primary key, v jsonb not null);
      alter table proshno_users enable row level security;
      alter table proshno_trial_devices enable row level security;
      alter table proshno_settings enable row level security;`);
  }
  const untilEnd = u => u.until === 'forever' ? Infinity : !u.until ? 0 : u.until.includes('T') ? Date.parse(u.until) : Date.parse(u.until + 'T23:59:59.999+06:00');
  return {
    async getSetting(k) { const r = await q('select v from proshno_settings where k = $1', [k]); return r.rows[0]?.v ?? null; },
    async addSettingIfAbsent(k, v) {
      await q('insert into proshno_settings (k, v) values ($1, $2) on conflict (k) do nothing', [k, JSON.stringify(v)]);
      return (await q('select v from proshno_settings where k = $1', [k])).rows[0].v;
    },
    async getUser(email) { const r = await q('select data from proshno_users where email = $1', [email]); return r.rows[0]?.data ?? null; },
    async saveUser(u) {
      const end = Math.max(u.trialEnd || 0, untilEnd(u));
      await q(`insert into proshno_users (email, name, phone, access_ends, approved, disabled, data, created_at, updated_at)
               values ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0), now())
               on conflict (email) do update set name = excluded.name, phone = excluded.phone, access_ends = excluded.access_ends,
                 approved = excluded.approved, disabled = excluded.disabled, data = excluded.data, updated_at = now()`,
        [u.email, u.name || '', u.phone || '', end === Infinity ? null : new Date(end).toISOString(), !!u.until, !!u.disabled, JSON.stringify(u), u.createdAt || Date.now()]);
    },
    async deleteUser(email) { await q('delete from proshno_users where email = $1', [email]); },
    async listUsers() { return (await q('select data from proshno_users')).rows.map(r => r.data); },
    async phoneTaken(phone) { return (await q('select 1 from proshno_users where phone = $1 limit 1', [phone])).rowCount > 0; },
    async hasTrial(device) { return (await q('select 1 from proshno_trial_devices where device = $1', [device])).rowCount > 0; },
    async addTrial(device) { await q('insert into proshno_trial_devices (device) values ($1) on conflict do nothing', [device]); },
  };
}
