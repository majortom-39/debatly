// =============================================================================
// shared/email.mjs  —  transactional email via Resend (https://resend.com).
// =============================================================================
//
// Why Resend: simplest transactional-email API (one POST), generous free tier.
// SETUP (what the operator needs):
//   1. Create a Resend account, verify a sending domain (or use the test sender).
//   2. Set env: RESEND_API_KEY=...  and  EMAIL_FROM="Debatly <reports@yourdomain>"
//      Optionally APP_URL=https://your-app  (used to link to the finished report).
// If RESEND_API_KEY is not set, sending is a no-op (logged) — the app still works.
// =============================================================================

import { config } from "../config.mjs";

export function isEmailConfigured() {
  return Boolean(config.resendApiKey && config.emailFrom);
}

export async function sendEmail({ to, subject, html, text }) {
  if (!isEmailConfigured()) {
    console.log(`[email] skipped (not configured) → would send "${subject}" to ${to}`);
    return { skipped: true };
  }
  if (!to) return { skipped: true };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: config.emailFrom, to: [to], subject, html, text: text || stripHtml(html) })
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[email] send failed: ${res.status} ${body}`);
      return { ok: false, error: body };
    }
    console.log(`[email] sent "${subject}" to ${to}`);
    return { ok: true };
  } catch (error) {
    console.warn(`[email] send error: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, error: String(error) };
  }
}

// Email for a finished import.
export function reportReadyEmail({ title, projectId }) {
  const appUrl = config.appUrl.replace(/\/$/, "");
  const link = projectId ? `${appUrl}/?project=${encodeURIComponent(projectId)}` : appUrl;
  const logoUrl = `${appUrl}/Debatly%20Logo%20Light%20Mode.png`;
  const safeTitle = stripHtml(String(title || "Your debate"));
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  return {
    subject: `Your debate report is ready: ${safeTitle}`,
    html: `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f4;margin:0;padding:32px 12px;font-family:${font};">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e7e5e4;border-radius:16px;">
      <tr><td style="padding:30px 32px 0;">
        <img src="${logoUrl}" alt="Debatly" height="26" style="display:block;height:26px;width:auto;border:0;outline:none;text-decoration:none;" />
      </td></tr>
      <tr><td style="padding:22px 32px 0;">
        <h1 style="margin:0 0 10px;font-size:22px;line-height:1.3;font-weight:700;color:#1c1917;">Your debate report is ready</h1>
        <p style="margin:0;font-size:15px;line-height:1.6;color:#57534e;">We've finished analyzing <strong style="color:#1c1917;">${safeTitle}</strong>. The transcript, fact-checks, scores, and full report are all set.</p>
      </td></tr>
      <tr><td style="padding:24px 32px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td bgcolor="#1c1917" style="border-radius:999px;">
            <a href="${link}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;">Open the report</a>
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:22px 32px 30px;">
        <p style="margin:0;font-size:12px;line-height:1.55;color:#a8a29e;">If the button doesn't work, paste this link into your browser:<br/>
          <a href="${link}" style="color:#78716c;word-break:break-all;">${link}</a></p>
      </td></tr>
    </table>
    <p style="max-width:480px;margin:18px auto 0;font-size:12px;line-height:1.5;color:#a8a29e;text-align:center;font-family:${font};">Debatly — the facts and our reading. You decide who came out ahead.</p>
  </td></tr>
</table>`,
    text: `Your Debatly report is ready: ${safeTitle}\nOpen it: ${link}`
  };
}

function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
