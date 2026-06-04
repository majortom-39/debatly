# Debatly auth email templates

Branded HTML for Supabase Auth emails — same look as the report-ready email
(logo, light editorial card, ink button). All are **standalone** (inline styles,
table layout) so they render across Gmail / Outlook / Apple Mail.

The logo and links use Supabase template variables: the logo is loaded from
`{{ .SiteURL }}/Debatly%20Logo%20Light%20Mode.png`, so **Site URL must be set**
to the deployed app (Auth → URL Configuration) for the logo to appear.

## Files → template → subject

| File | Supabase template | Suggested subject |
|---|---|---|
| `confirmation.html` | Confirm signup | `Confirm your email — Debatly` |
| `magic_link.html` | Magic Link | `Your Debatly sign-in link` |
| `recovery.html` | Reset Password | `Reset your Debatly password` |
| `invite.html` | Invite user | `You're invited to Debatly` |
| `email_change.html` | Change Email Address | `Confirm your new email — Debatly` |
| `reauthentication.html` | Reauthentication (OTP) | `{{ .Token }} is your Debatly code` |

## How to apply

### Hosted project (what Debatly uses) — Dashboard
Supabase **Dashboard → Authentication → Emails → Templates**. For each template,
paste the matching file's HTML into the body and set the subject above. Make sure
**Auth → URL Configuration → Site URL** = `https://debatly.34.46.6.153.nip.io`
(or your domain) so the logo and links resolve.

### Local / CLI (config.toml) — optional
If you manage the project with the Supabase CLI, reference them in
`supabase/config.toml`, e.g.:

```toml
[auth.email.template.confirmation]
subject = "Confirm your email — Debatly"
content_path = "./supabase/templates/confirmation.html"

[auth.email.template.magic_link]
subject = "Your Debatly sign-in link"
content_path = "./supabase/templates/magic_link.html"

[auth.email.template.recovery]
subject = "Reset your Debatly password"
content_path = "./supabase/templates/recovery.html"

[auth.email.template.invite]
subject = "You're invited to Debatly"
content_path = "./supabase/templates/invite.html"

[auth.email.template.email_change]
subject = "Confirm your new email — Debatly"
content_path = "./supabase/templates/email_change.html"

[auth.email.template.reauthentication]
subject = "Your Debatly verification code"
content_path = "./supabase/templates/reauthentication.html"
```

## Notes
- **What's actually sent today:** Debatly signs in via Google / X / Discord +
  guest, so these email-auth templates only fire if you enable email sign-in /
  magic links / password reset. They're branded and ready for when you do.
- **Deliverability:** Supabase's built-in email sender has very low rate limits
  (meant for testing). For production, set a **custom SMTP** (e.g. Resend SMTP
  with a verified domain) in Auth settings.
- Security-notification templates (password_changed, identity_linked, etc.) can
  be branded the same way if you enable those notifications — ask and I'll add them.
