# Running Proshno with sign-in

Sign-in works on **Vercel with Supabase**, or on your own server with `server.mjs` (Dokploy or Docker).
On plain file hosts like GitHub Pages, or on Vercel before a database is connected, the app stays open to everyone.

## How access works

- **Sign-up:** anyone can make an account with their name, mobile, email and password. It works for **2 days**.
- **After 2 days:** the app locks. It shows a "free time is over" screen with your contact number and WhatsApp/Call buttons.
- **Approving:** you approve the person on **/admin** for 1 month, 3 months, 1 year, no end, or until a date you pick.
  They tap "I have permission — check again" and the app opens.
- **One free trial per phone:** making a new email on the same phone gives no new free days.
  The account is still made, and it waits for your approval.
- **Phones per account:** each account works on up to 2 phones. Use "Reset phones" on /admin to let someone move to a new one.
- **Offline use:** the app keeps working offline, but never past the end of a person's access.
  For someone on free time, that is the moment the 2 days end.
- **Removing access:** "Switch off" or "Remove approval" on /admin takes effect the next time their phone is online.

## Deploy on Vercel with Supabase

On Vercel, the sign-in runs as a function (`api/handler.mjs`) and accounts are kept in Supabase.
The tables (`proshno_users`, `proshno_trial_devices`, `proshno_settings`) are created automatically the first time someone uses the app.

1. Connect Supabase to the Vercel project:
   - **Easy way:** Vercel → your project → **Storage** → **Supabase**. This adds `POSTGRES_URL` for you.
   - **If you made the project on supabase.com yourself:** open **Connect** in Supabase and copy the **Transaction pooler** string (port 6543).
     Add it in Vercel as `DATABASE_URL`, with your database password in place of `[YOUR-PASSWORD]`.
2. Add these in Vercel → **Settings → Environment Variables**:
   - `ADMIN_PASSWORD`: your admin password.
   - `CONTACT`: e.g. `WhatsApp 01XXXXXXXXX`.
   - `TRIAL_DAYS`: optional, default `2`.
3. Redeploy. Pushing to GitHub does this automatically.
4. Check `https://your-site.vercel.app/api/healthz`. It should say `"database":true`.
   Then open `/admin`.

You can see every account in Supabase → **Table Editor** → `proshno_users`.
Change accounts from `/admin`, not by editing the table.

## Email codes (optional, with Resend)

When `RESEND_API_KEY` is set, new accounts need a 6-digit code sent to their email.
A "Forgot password?" option also appears on the sign-in screen.
Codes work for 10 minutes and allow 5 tries. A new code can be requested once a minute.

1. Make a free account at resend.com and add your domain (Domains → Add Domain), e.g. `mail.yourdomain.com`.
   Add the DNS records it shows, then wait until the domain is **Verified**.
2. Create an API key with **Sending access**.
3. Add two settings in Vercel (or in Dokploy):
   - `RESEND_API_KEY`: the `re_…` key. Keep it only here, never in the code.
   - `MAIL_FROM`: e.g. `Proshno <no-reply@mail.yourdomain.com>`, using the domain you verified.
4. Redeploy. `/api/healthz` then shows `"emailCodes": true`.

Until the domain is verified, Resend only delivers to the email address of your Resend account.

## Deploy on Dokploy (or any Docker host)

1. Create an **Application** from the GitHub repo `devrifu-debug/proshno-question-paper`, branch `main`.
   Set the build type to **Dockerfile**.
2. Set these environment variables:
   - `ADMIN_PASSWORD`: a long password for /admin. Required, because the admin page is off without it.
   - `CONTACT`: what locked users see, e.g. `WhatsApp 01XXXXXXXXX`. A Bangladeshi mobile number in it gets WhatsApp and Call buttons.
   - `TRIAL_DAYS`: optional, default `2`.
3. Add a **volume mount** at `/data`. Users and the signing key live there.
   Without it, every redeploy deletes all accounts and signs everyone out.
4. Set the container port to **80**, add your domain, and turn on HTTPS. The app needs HTTPS for the camera and for installing it as an app.
5. Deploy. Open `https://your-domain/admin` and enter `ADMIN_PASSWORD`.

## Run on a computer

```
ADMIN_PASSWORD=choose-one CONTACT="WhatsApp 01XXXXXXXXX" node server.mjs
```

Then open http://localhost:5173 for the app and http://localhost:5173/admin for the admin page. Data is kept in `./data`.

## Good to know

- **Back up `/data/users.json`.** Losing `auth-key.json` signs everyone out, though their accounts stay.
- **Limits of the lock:** the lock stops normal users. A technically skilled person could still read the question bank out of the page's code.
  Stopping that would mean sending the bank only after sign-in. That can be added later.
