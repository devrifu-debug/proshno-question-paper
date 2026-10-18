// Sends the 6-digit email codes through Resend (https://resend.com). Off when RESEND_API_KEY is not set.
//   RESEND_API_KEY  the re_… key (keep it only in the host's settings, never in the code)
//   MAIL_FROM       e.g. "Proshno <no-reply@mail.yourdomain.com>" — the domain must be verified in Resend
export function resendMailer(env) {
  const key = env.RESEND_API_KEY; if (!key) return null;
  const from = env.MAIL_FROM || 'Proshno <onboarding@resend.dev>';
  const base = (env.RESEND_API_BASE || 'https://api.resend.com').replace(/\/+$/, '');
  return {
    from,
    async sendCode(to, code, kind) {
      const reset = kind === 'reset';
      const subject = `${code} — ${reset ? 'প্রশ্ন পাসওয়ার্ড কোড / Proshno password code' : 'প্রশ্ন যাচাই কোড / Proshno verification code'}`;
      const lineBn = reset ? 'আপনার পাসওয়ার্ড বদলানোর কোড:' : 'আপনার অ্যাকাউন্ট যাচাইয়ের কোড:';
      const lineEn = reset ? 'Your code to set a new password:' : 'Your code to verify your account:';
      const html = `<!doctype html><html><body style="margin:0;background:#f4f5f8;font-family:'Hind Siliguri',Arial,sans-serif;color:#101219">
<div style="max-width:440px;margin:0 auto;padding:28px 16px">
  <div style="background:#fff;border-radius:16px;padding:26px 24px;border:1px solid #e3e6ee">
    <div style="font-size:26px;font-weight:800;color:#06788A;margin-bottom:14px">প্রশ্ন</div>
    <p style="margin:0 0 4px;font-size:16px">${lineBn}</p>
    <p style="margin:0 0 16px;font-size:14px;color:#5b6475">${lineEn}</p>
    <div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#E8FBFD;border:1px solid #9FEAF2;border-radius:12px;padding:14px 0;text-align:center;color:#0B1B4D">${code}</div>
    <p style="margin:16px 0 0;font-size:14px;color:#5b6475">কোডটি ১০ মিনিট কাজ করবে। আপনি অনুরোধ না করে থাকলে এই ইমেইলটি এড়িয়ে যান।<br>The code works for 10 minutes. If you did not ask for it, ignore this email.</p>
  </div>
</div></body></html>`;
      const text = `${lineBn} ${code}\n${lineEn} ${code}\n\nকোডটি ১০ মিনিট কাজ করবে। / The code works for 10 minutes.`;
      const r = await fetch(base + '/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to: [to], subject, html, text }) });
      if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`Resend ${r.status}: ${t.slice(0, 300)}`); }
    },
  };
}
