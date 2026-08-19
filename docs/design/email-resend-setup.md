# Email (Resend) Setup

## 1. Account + key
- Create a free account at resend.com
- API Keys → Create → copy the `re_...` key

## 2. .env additions

```bash
RESEND_API_KEY=re_your_key_here
MAIL_FROM="onboarding@resend.dev"
```

`onboarding@resend.dev` works immediately but ONLY delivers to your own
Resend account email — ideal for dev testing, useless for real invitees.

## 3. For real delivery: verify a domain
Resend dashboard → Domains → Add Domain → add the DNS records they give you
(SPF + DKIM) at your registrar. Once verified:

```bash
MAIL_FROM="The Reserve <hello@yourdomain.com>"
```

## 4. Files
- `server/utils/mailer.ts` — new
- `server/utils/emailTemplates.ts` — new
- `server/api/invites/index.post.ts` — REPLACES existing (now sends the email;
  inviteUrl returned in dev only)
- Booking route: apply `booking-confirmation-patch.md` by hand (small diff to
  a file you already have; safer than replacing it wholesale)

## 5. Test
1. With MAIL_FROM=onboarding@resend.dev, invite YOUR OWN email from the
   Staff page → the branded invite email arrives in your inbox.
2. Set your test client's email to your own address, book an appointment →
   confirmation email with the service/time/staff details.
3. Server logs show `[mailer]` warnings if env vars are missing — booking
   and invites still succeed (email is deliberately best-effort).

## Env note
RESEND_API_KEY is server-only. It is read via process.env inside Nitro
routes and never exposed to the client bundle. Do not prefix it with
NUXT_PUBLIC_.
