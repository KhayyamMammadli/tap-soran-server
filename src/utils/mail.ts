import nodemailer from "nodemailer";

function env(name: string) {
  return (process.env[name] || "").trim();
}

/**
 * Best-effort SMTP sender.
 *
 * Env:
 *  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 *
 * If SMTP is not configured, this will silently skip sending.
 */
export async function sendMail(opts: { to: string; subject: string; text: string; html?: string }) {
  const host = env("SMTP_HOST");
  const port = Number(env("SMTP_PORT") || "0");
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");
  const from = env("SMTP_FROM") || user;

  if (!host || !port || !from) return;

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user && pass ? { user, pass } : undefined,
  });

  try {
    await transporter.sendMail({
      from,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
  } catch (e) {
    console.error("sendMail failed", e);
  }
}
