import nodemailer from "nodemailer";

function env(name: string) {
  return (process.env[name] || "").trim();
}

export type SendMailResult =
  | { sent: true }
  | { sent: false; skipped: true; reason: string }
  | { sent: false; skipped: false; reason: string };

/**
 * SMTP sender.
 * Env:
 *  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 */
export async function sendMail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<SendMailResult> {
  const host = env("SMTP_HOST");
  const port = Number(env("SMTP_PORT") || "0");
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");
  const from = env("SMTP_FROM") || user;

  if (!host || !port || !from) {
    return {
      sent: false,
      skipped: true,
      reason: "SMTP env tapilmadi (SMTP_HOST/SMTP_PORT/SMTP_FROM)" ,
    };
  }

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
    return { sent: true };
  } catch (e: any) {
    console.error("sendMail failed", e);
    return {
      sent: false,
      skipped: false,
      reason: e?.message || "sendMail failed",
    };
  }
}
