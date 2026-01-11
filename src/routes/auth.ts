import { PrismaClient, Role } from "@prisma/client";
import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { signToken } from "../utils/jwt";
import { notifyAdmins } from "../utils/adminNotify";
import { sendMail } from "../utils/mail";

function env(name: string) {
  return (process.env[name] || "").trim();
}

function isSmtpConfigured() {
  return !!env("SMTP_HOST") && !!env("SMTP_PORT") && (!!env("SMTP_FROM") || !!env("SMTP_USER"));
}

function genOtpCode() {
  // 6-digit numeric
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function authRouter(prisma: PrismaClient) {
  const r = Router();

  const registerSchema = z
  .object({
    role: z.enum(["BUYER", "SELLER"]),
    fullName: z.string().min(3),
    email: z.string().email(),
    password: z.string().min(6),
    categoryId: z.string().optional(),
    phone: z.string().trim().min(3).optional(),
    whatsapp: z.string().trim().min(3).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.role === "SELLER" && !val.categoryId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["categoryId"],
        message: "Seller üçün kateqoriya seçilməlidir",
      });
    }

    // Seller must provide at least one contact method
    if (val.role === "SELLER") {
      const hasPhone = !!val.phone && val.phone.trim().length > 0;
      const hasWa = !!val.whatsapp && val.whatsapp.trim().length > 0;
      if (!hasPhone && !hasWa) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["phone"],
          message: "Satıcı üçün əlaqə nömrəsi və ya WhatsApp nömrəsi yazılmalıdır",
        });
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["whatsapp"],
          message: "Satıcı üçün əlaqə nömrəsi və ya WhatsApp nömrəsi yazılmalıdır",
        });
      }
    }
  });

  // =========================
  // Email OTP registration flow
  // =========================
  // 1) Client sends registration payload -> we send OTP code to email and store a hashed code + payload.
  // 2) Client verifies OTP -> we create the user and return token.
  //
  // NOTE: This is backwards-compatible with the old /register endpoint (kept below).

  r.post("/register/request-otp", async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { role, fullName, email, password, categoryId, phone, whatsapp } = parsed.data;
    const emailNorm = email.trim().toLowerCase();

    const exists = await prisma.user.findFirst({
      where: { email: { equals: emailNorm, mode: "insensitive" } },
      select: { id: true },
    });
    if (exists) return res.status(409).json({ error: "Email already used" });

    const code = genOtpCode();
    const codeHash = await bcrypt.hash(code, 10);
    const passwordHash = await bcrypt.hash(password, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const payload = {
      role,
      fullName,
      email: emailNorm,
      passwordHash,
      categoryId: role === "SELLER" ? categoryId : undefined,
      phone: role === "SELLER" ? (phone?.trim() || null) : null,
      whatsapp: role === "SELLER" ? (whatsapp?.trim() || null) : null,
    };

    // Upsert (allows re-requesting OTP for the same email)
    await prisma.emailOtp.upsert({
      where: { email: emailNorm },
      create: {
        email: emailNorm,
        codeHash,
        payload,
        expiresAt,
        attempts: 0,
      },
      update: {
        codeHash,
        payload,
        expiresAt,
        attempts: 0,
      },
    });

    // Send email (best-effort)
    const subject = "TapTəklif • Təsdiq kodu";
    const text = `TapTəklif qeydiyyatı üçün təsdiq kodunuz: ${code}\n\nKod 10 dəqiqə keçərlidir.`;
    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.5;">
        <h2 style="margin:0 0 8px 0;">TapTəklif</h2>
        <p>Qeydiyyatı tamamlamaq üçün təsdiq kodunuz:</p>
        <div style="font-size: 28px; font-weight: 800; letter-spacing: 4px; margin: 12px 0;">${code}</div>
        <p style="color:#555">Kod 10 dəqiqə keçərlidir.</p>
        <p style="color:#777; font-size: 12px;">Əgər bunu siz etməmisinizsə, bu emaili nəzərə almayın.</p>
      </div>
    `;
const mail = await sendMail({ to: emailNorm, subject, text, html });

// Debug mode: return code for testing (disable in production!).
const debug =
  process.env.OTP_DEBUG_RETURN_CODE === "1" || (!isSmtpConfigured() && process.env.NODE_ENV !== "production");

if (!mail.sent) {
  if (debug) {
    return res.json({
      ok: true,
      expiresAt,
      debugCode: code,
      mailSkipped: "skipped" in mail ? mail.skipped : false,
      mailReason: "reason" in mail ? mail.reason : undefined,
    });
  }
  return res.status(500).json({
    error: mail.skipped
      ? "SMTP quraşdırılmayıb. Render Environment-də SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM əlavə edin."
      : "OTP email göndərmək alınmadı. SMTP məlumatlarını yoxlayın (Render logs-da sendMail failed).",
  });
}

res.json({ ok: true, expiresAt });
  });

  r.post("/register/resend-otp", async (req, res) => {
    const schema = z.object({ email: z.string().email() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const emailNorm = parsed.data.email.trim().toLowerCase();

    const existing = await prisma.emailOtp.findUnique({ where: { email: emailNorm } });
    if (!existing) return res.status(400).json({ error: "OTP not requested" });

    const code = genOtpCode();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await prisma.emailOtp.update({
      where: { email: emailNorm },
      data: { codeHash, expiresAt, attempts: 0 },
    });

    const subject = "TapTəklif • Təsdiq kodu";
    const text = `TapTəklif qeydiyyatı üçün yeni təsdiq kodunuz: ${code}\n\nKod 10 dəqiqə keçərlidir.`;
    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.5;">
        <h2 style="margin:0 0 8px 0;">TapTəklif</h2>
        <p>Yeni təsdiq kodunuz:</p>
        <div style="font-size: 28px; font-weight: 800; letter-spacing: 4px; margin: 12px 0;">${code}</div>
        <p style="color:#555">Kod 10 dəqiqə keçərlidir.</p>
      </div>
    `;
const mail = await sendMail({ to: emailNorm, subject, text, html });

const debug =
  process.env.OTP_DEBUG_RETURN_CODE === "1" || (!isSmtpConfigured() && process.env.NODE_ENV !== "production");

if (!mail.sent) {
  if (debug) {
    return res.json({
      ok: true,
      expiresAt,
      debugCode: code,
      mailSkipped: "skipped" in mail ? mail.skipped : false,
      mailReason: "reason" in mail ? mail.reason : undefined,
    });
  }
  return res.status(500).json({
    error: mail.skipped
      ? "SMTP quraşdırılmayıb. Render Environment-də SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM əlavə edin."
      : "OTP email göndərmək alınmadı. SMTP məlumatlarını yoxlayın (Render logs-da sendMail failed).",
  });
}

res.json({ ok: true, expiresAt });
  });

  r.post("/register/verify-otp", async (req, res) => {
    const schema = z.object({ email: z.string().email(), code: z.string().min(4).max(12) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const emailNorm = parsed.data.email.trim().toLowerCase();
    const code = parsed.data.code.trim();

    const rec = await prisma.emailOtp.findUnique({ where: { email: emailNorm } });
    if (!rec) return res.status(400).json({ error: "OTP not found" });

    if (rec.expiresAt && new Date(rec.expiresAt).getTime() < Date.now()) {
      try {
        await prisma.emailOtp.delete({ where: { email: emailNorm } });
      } catch {}
      return res.status(400).json({ error: "OTP expired" });
    }

    if ((rec.attempts || 0) >= 5) {
      try {
        await prisma.emailOtp.delete({ where: { email: emailNorm } });
      } catch {}
      return res.status(429).json({ error: "Too many attempts" });
    }

    const ok = await bcrypt.compare(code, rec.codeHash);
    if (!ok) {
      await prisma.emailOtp.update({
        where: { email: emailNorm },
        data: { attempts: (rec.attempts || 0) + 1 },
      });
      return res.status(400).json({ error: "Invalid code" });
    }

    // Create user from stored payload
    // Prisma stores Json as JsonValue, so we validate/parse it before reading fields.
    const storedSchema = z.object({
      role: z.enum(["BUYER", "SELLER"]).transform((v) => v as Role),
      fullName: z.string().default(""),
      email: z.string().email().optional(),
      passwordHash: z.string().min(1),
      categoryId: z.string().optional().nullable(),
      phone: z.string().optional().nullable(),
      whatsapp: z.string().optional().nullable(),
    });

    const storedParsed = storedSchema.safeParse(rec.payload);
    if (!storedParsed.success) {
      try {
        await prisma.emailOtp.delete({ where: { email: emailNorm } });
      } catch {}
      return res.status(400).json({ error: "OTP payload invalid" });
    }

    const payload = storedParsed.data;
    const role = payload.role;
    const fullName = payload.fullName || "";
    const passwordHash = payload.passwordHash;
    const categoryId = payload.categoryId ?? undefined;
    const phone = payload.phone ?? undefined;
    const whatsapp = payload.whatsapp ?? undefined;

    // One more check to avoid race
    const exists = await prisma.user.findFirst({
      where: { email: { equals: emailNorm, mode: "insensitive" } },
      select: { id: true },
    });
    if (exists) {
      try {
        await prisma.emailOtp.delete({ where: { email: emailNorm } });
      } catch {}
      return res.status(409).json({ error: "Email already used" });
    }

    const created = await prisma.user.create({
      data: {
        role: role as Role,
        fullName,
        email: emailNorm,
        passwordHash,
        ...(role === "SELLER" ? { category: { connect: { id: categoryId! } } } : {}),
        phone: role === "SELLER" ? (phone?.toString().trim() || null) : null,
        whatsapp: role === "SELLER" ? (whatsapp?.toString().trim() || null) : null,
      },
      select: {
        id: true,
        role: true,
        fullName: true,
        email: true,
        tip: true,
        avatarUrl: true,
        tokenVersion: true,
        category: { select: { id: true } },
      },
    });

    try {
      await prisma.emailOtp.delete({ where: { email: emailNorm } });
    } catch {}

    const user = {
      id: created.id,
      role: created.role,
      fullName: created.fullName,
      email: created.email,
      tip: created.tip,
      categoryId: created.category?.id ?? null,
      avatarUrl: created.avatarUrl ?? null,
      tokenVersion: created.tokenVersion,
    };

    // Notify admins about new registration
    try {
      const io = req.app.get("io");
      await notifyAdmins(prisma, io, {
        title: "Yeni istifadəçi",
        body: `${user.fullName} (${user.email}) • role=${user.role}${user.role === "SELLER" ? ` • categoryId=${user.categoryId || "-"}` : ""}`,
        type: "ADMIN_NEW_USER",
        telegramText: `🆕 Yeni istifadəçi\n${user.fullName} (${user.email})\nRole: ${user.role}${user.role === "SELLER" ? `\nCategoryId: ${user.categoryId || "-"}` : ""}`,
      });
    } catch {}

    const token = signToken(user.id, user.tokenVersion);
    res.json({ user, token });
  });

r.post("/register", async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { role, fullName, email, password, categoryId, phone, whatsapp } = parsed.data;

    // Normalize email to avoid case/whitespace issues (common in prod)
    const emailNorm = email.trim().toLowerCase();

    const exists = await prisma.user.findFirst({
      where: { email: { equals: emailNorm, mode: "insensitive" } },
      select: { id: true },
    });
    if (exists) return res.status(409).json({ error: "Email already used" });

    const passwordHash = await bcrypt.hash(password, 10);
    // NOTE: Use the relation field (`category`) instead of `categoryId`.
    // This avoids PrismaClientValidationError in projects where the scalar foreign key field
    // is not exposed in the Prisma schema, while still keeping the same API response shape.
    const created = await prisma.user.create({
      data: {
        role: role as Role,
        fullName,
        email: emailNorm,
        passwordHash,
        ...(role === "SELLER" ? { category: { connect: { id: categoryId! } } } : {}),
        phone: role === "SELLER" ? (phone?.trim() || null) : null,
        whatsapp: role === "SELLER" ? (whatsapp?.trim() || null) : null,
      },
      select: {
        id: true,
        role: true,
        fullName: true,
        email: true,
        tip: true,
        avatarUrl: true,
        tokenVersion: true,
        category: { select: { id: true } },
      },
    });

    const user = {
      id: created.id,
      role: created.role,
      fullName: created.fullName,
      email: created.email,
      tip: created.tip,
      categoryId: created.category?.id ?? null,
      avatarUrl: created.avatarUrl ?? null,
      tokenVersion: created.tokenVersion,
    };

    // Notify SUPER_ADMIN users about new registrations (and mirror to Telegram)
    try {
      const io = req.app.get("io");
      await notifyAdmins(prisma, io, {
        title: "Yeni istifadəçi",
        body: `${user.fullName} (${user.email}) • role=${user.role}${user.role === "SELLER" ? ` • categoryId=${user.categoryId || "-"}` : ""}`,
        type: "ADMIN_NEW_USER",
        telegramText: `🆕 Yeni istifadəçi\n${user.fullName} (${user.email})\nRole: ${user.role}${user.role === "SELLER" ? `\nCategoryId: ${user.categoryId || "-"}` : ""}`,
      });
    } catch {}

    const token = signToken(user.id, user.tokenVersion);
    res.json({ user, token });
  });

  const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  role: z.enum(["BUYER", "SELLER", "SUPER_ADMIN"]).optional(),
});

r.post("/login", async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { email, password, role } = parsed.data;
    const emailNorm = email.trim().toLowerCase();

    // Case-insensitive email lookup (protects against DB rows created with mixed-case email)
    const user = await prisma.user.findFirst({
      where: { email: { equals: emailNorm, mode: "insensitive" } },
      select: {
        id: true,
        role: true,
        fullName: true,
        email: true,
        tip: true,
        avatarUrl: true,
        passwordHash: true,
        tokenVersion: true,
        blocked: true,
        blockedReason: true,
        blockedAt: true,
        blockedUntil: true,
        category: { select: { id: true } },
      },
    });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    // Block enforcement: if blockedUntil is in the past, auto-unblock (best-effort).
    if ((user as any).blocked) {
      const until = (user as any).blockedUntil ? new Date((user as any).blockedUntil) : null;
      if (until && until.getTime() <= Date.now()) {
        try {
          await prisma.user.update({
            where: { id: user.id },
            data: { blocked: false, blockedReason: null, blockedAt: null, blockedUntil: null, blockedById: null },
          });
        } catch {}
      } else {
        return res.status(403).json({
          error: "Blocked",
          reason: (user as any).blockedReason,
          blockedAt: (user as any).blockedAt,
          blockedUntil: (user as any).blockedUntil,
        });
      }
    }

// Role enforcement: buyer/seller cannot login as the other role.
// Super admin is allowed regardless (admin panel has separate login).
if (user.role !== "SUPER_ADMIN") {
  if (!role) return res.status(400).json({ error: "Role required" });
  if (role !== user.role) return res.status(403).json({ error: "Role mismatch" });
}


    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const token = signToken(user.id, (user as any).tokenVersion || 0);
    res.json({
      user: {
        id: user.id,
        role: user.role,
        fullName: user.fullName,
        email: user.email,
        tip: user.tip,
        categoryId: user.category?.id ?? null,
        avatarUrl: (user as any).avatarUrl ?? null,
      },
      token,
    });
  });

  return r;
}
