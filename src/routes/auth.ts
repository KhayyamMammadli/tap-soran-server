import { PrismaClient, Role } from "@prisma/client";
import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { signToken } from "../utils/jwt";
import { notifyAdmins } from "../utils/adminNotify";

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
