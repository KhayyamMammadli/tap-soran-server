"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendMail = sendMail;
const nodemailer_1 = __importDefault(require("nodemailer"));
function env(name) {
    return (process.env[name] || "").trim();
}
/**
 * SMTP sender.
 * Env:
 *  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 */
async function sendMail(opts) {
    const host = env("SMTP_HOST");
    const port = Number(env("SMTP_PORT") || "0");
    const user = env("SMTP_USER");
    const pass = env("SMTP_PASS");
    const from = env("SMTP_FROM") || user;
    if (!host || !port || !from) {
        return {
            sent: false,
            skipped: true,
            reason: "SMTP env tapilmadi (SMTP_HOST/SMTP_PORT/SMTP_FROM)",
        };
    }
    const transporter = nodemailer_1.default.createTransport({
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
    }
    catch (e) {
        console.error("sendMail failed", e);
        return {
            sent: false,
            skipped: false,
            reason: e?.message || "sendMail failed",
        };
    }
}
