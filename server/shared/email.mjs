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
  const safeTitle = stripHtml(String(title || "Your debate"));
  return {
    subject: `Your debate report is ready: ${safeTitle}`,
    html: `
      <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1c1917">
        <p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#78716c;margin:0 0 8px">Debatly</p>
        <h1 style="font-size:22px;font-weight:600;margin:0 0 12px">Your report is ready</h1>
        <p style="font-size:15px;line-height:1.6;color:#44403c;margin:0 0 20px">We've finished analyzing <strong>${safeTitle}</strong> — the transcript, fact-checks, scores and report are all set.</p>
        <a href="${link}" style="display:inline-block;background:#1c1917;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 22px;border-radius:999px">Open the report</a>
        <p style="font-size:12px;color:#a8a29e;margin:24px 0 0">If the button doesn't work, paste this link: ${link}</p>
      </div>`,
    text: `Your Debatly report is ready: ${safeTitle}\nOpen it: ${link}`
  };
}

function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
