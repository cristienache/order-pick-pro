// SMTP mailer using Gmail Workspace via app password.
//
// Configuration (env vars):
//   SMTP_USER     — full Gmail Workspace address that owns the app password
//                   (e.g. contact@ultrax.work). Becomes the From: address.
//   SMTP_PASS     — 16-character Google App Password (NOT the account password).
//                   Generate at https://myaccount.google.com/apppasswords with
//                   2-Step Verification enabled on the account.
//   CONTACT_TO    — optional override for the inbox that receives form
//                   submissions. Defaults to ADMIN_EMAIL, then SMTP_USER.
//
// We use Gmail's submission relay on port 465 (implicit TLS) — most reliable
// across hosting providers that block port 25.

import nodemailer from "nodemailer";

let cachedTransporter = null;

export function smtpConfig() {
  const user = process.env.SMTP_USER || "";
  const pass = process.env.SMTP_PASS || "";
  const to =
    process.env.CONTACT_TO ||
    process.env.ADMIN_EMAIL ||
    user ||
    "";
  return {
    user,
    pass,
    to,
    configured: Boolean(user && pass && to),
  };
}

function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  const cfg = smtpConfig();
  if (!cfg.configured) throw new Error("SMTP not configured");
  cachedTransporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  return cachedTransporter;
}

/**
 * Send a contact-form submission to the support inbox.
 *   { name, email, phone?, subject?, message }
 *
 * The visitor's email is set as Reply-To so support staff can reply
 * directly from their inbox without exposing the SMTP_USER mailbox.
 */
export async function sendContactEmail({ name, email, phone, subject, message }) {
  const cfg = smtpConfig();
  const transporter = getTransporter();
  const subj = subject?.trim() || `New contact form message from ${name}`;
  const safe = (s) => String(s || "").replace(/[<>]/g, "");

  const text = [
    `Name:    ${safe(name)}`,
    `Email:   ${safe(email)}`,
    phone ? `Phone:   ${safe(phone)}` : null,
    "",
    "Message:",
    safe(message),
  ].filter((l) => l !== null).join("\n");

  const html = `
    <table style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.55;color:#111;border-collapse:collapse;">
      <tr><td style="padding:4px 12px 4px 0;color:#666;">Name</td><td><strong>${safe(name)}</strong></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666;">Email</td><td><a href="mailto:${safe(email)}">${safe(email)}</a></td></tr>
      ${phone ? `<tr><td style="padding:4px 12px 4px 0;color:#666;">Phone</td><td>${safe(phone)}</td></tr>` : ""}
      <tr><td colspan="2" style="padding-top:14px;border-top:1px solid #eee;margin-top:14px;">
        <div style="white-space:pre-wrap;margin-top:14px;">${safe(message)}</div>
      </td></tr>
    </table>`;

  await transporter.sendMail({
    from: `"Ultrax Contact Form" <${cfg.user}>`,
    to: cfg.to,
    replyTo: `"${safe(name)}" <${safe(email)}>`,
    subject: subj,
    text,
    html,
  });
}

/**
 * Notify the master admin (CONTACT_TO / ADMIN_EMAIL) that a new user has
 * signed up and is waiting for approval. Includes Approve / Reject links
 * that can be opened directly from the email.
 */
export async function sendSignupApprovalEmail({ email, approveUrl, rejectUrl }) {
  const cfg = smtpConfig();
  const transporter = getTransporter();
  const safe = (s) => String(s || "").replace(/[<>]/g, "");
  const subj = `New Ultrax signup: ${safe(email)} is awaiting approval`;
  const text = [
    `A new user signed up and is waiting for approval.`,
    ``,
    `Email: ${safe(email)}`,
    ``,
    `Approve: ${approveUrl}`,
    `Reject:  ${rejectUrl}`,
    ``,
    `Approval is single-use. The user cannot sign in until you approve.`,
  ].join("\n");
  const html = `
    <table style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.55;color:#111;border-collapse:collapse;">
      <tr><td style="padding-bottom:14px;"><strong>New Ultrax signup awaiting approval</strong></td></tr>
      <tr><td style="padding:4px 0;"><span style="color:#666;">Email:</span> <strong>${safe(email)}</strong></td></tr>
      <tr><td style="padding:18px 0 6px;">
        <a href="${approveUrl}" style="display:inline-block;padding:10px 18px;background:#0a7d3a;color:#fff;text-decoration:none;border-radius:6px;margin-right:10px;">Approve</a>
        <a href="${rejectUrl}" style="display:inline-block;padding:10px 18px;background:#b00020;color:#fff;text-decoration:none;border-radius:6px;">Reject</a>
      </td></tr>
      <tr><td style="padding-top:14px;color:#666;font-size:12px;">Approval is single-use. The user cannot sign in until you approve.</td></tr>
    </table>`;
  await transporter.sendMail({
    from: `"Ultrax" <${cfg.user}>`,
    to: cfg.to,
    subject: subj,
    text,
    html,
  });
}
