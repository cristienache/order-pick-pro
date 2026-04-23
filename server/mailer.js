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

let cachedTransporter = null;
let cachedNodemailer = null;

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

async function loadNodemailer() {
  if (cachedNodemailer) return cachedNodemailer;
  try {
    const mod = await import("nodemailer");
    cachedNodemailer = mod.default ?? mod;
    return cachedNodemailer;
  } catch (error) {
    const err = new Error("Email transport is unavailable");
    err.cause = error;
    throw err;
  }
}

async function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  const cfg = smtpConfig();
  if (!cfg.configured) throw new Error("SMTP not configured");
  const nodemailer = await loadNodemailer();
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
  const transporter = await getTransporter();
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
