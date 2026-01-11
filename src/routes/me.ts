import { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import path from "path";
import fs from "fs";

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

export function meRouter(prisma: PrismaClient) {
  const r = Router();

  const uploadRoot = process.env.UPLOAD_DIR || "uploads";
  const avatarDir = path.join(uploadRoot, "avatars");
  ensureDir(avatarDir);

  const avatarUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, avatarDir),
      filename: (req, file, cb) => {
        const ext = (path.extname(file.originalname) || "").toLowerCase();
        const safeExt = ext && ext.length <= 10 ? ext : "";
        const rand = Math.random().toString(16).slice(2);
        cb(null, `${req.user!.id}-${Date.now()}-${rand}${safeExt}`);
      },
    }),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (_req, file, cb) => {
      if (!file.mimetype.startsWith("image/")) return cb(new Error("Only image files allowed"));
      cb(null, true);
    },
  });

  r.get("/", async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        role: true,
        fullName: true,
        email: true,
        tip: true,
        avatarUrl: true,
        blocked: true,
        blockedReason: true,
        blockedAt: true,
        category: { select: { id: true } },
        sellerCategories: { select: { categoryId: true } },
      },
    });

    if (!user) return res.status(404).json({ error: "Not found" });

    return res.json({
      id: user.id,
      role: user.role,
      fullName: user.fullName,
      email: user.email,
      tip: user.tip,
      categoryId: user.category?.id ?? null,
      categoryIds: (user.sellerCategories || []).map((x) => x.categoryId),
      avatarUrl: user.avatarUrl ?? null,
      blocked: user.blocked,
      blockedReason: user.blockedReason,
      blockedAt: user.blockedAt,
    });
  });

  // Upload / update avatar
  r.post("/avatar", avatarUpload.single("avatar"), async (req, res) => {
    if (!(req as any).file) return res.status(400).json({ error: "No file" });

    const existing = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { avatarUrl: true },
    });

    const file = (req as any).file as Express.Multer.File;
    const url = `/uploads/avatars/${file.filename}`;

    await prisma.user.update({
      where: { id: req.user!.id },
      data: { avatarUrl: url },
    });

    // Best-effort: delete old avatar file (only if it was on this server)
    try {
      const old = existing?.avatarUrl;
      if (old && old.startsWith("/uploads/avatars/")) {
        const oldName = old.replace("/uploads/avatars/", "");
        const oldPath = path.join(avatarDir, oldName);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
    } catch {
      // ignore
    }

    return res.json({ avatarUrl: url });
  });

  // Remove avatar
  r.delete("/avatar", async (req, res) => {
    const existing = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { avatarUrl: true },
    });

    await prisma.user.update({
      where: { id: req.user!.id },
      data: { avatarUrl: null },
    });

    try {
      const old = existing?.avatarUrl;
      if (old && old.startsWith("/uploads/avatars/")) {
        const oldName = old.replace("/uploads/avatars/", "");
        const oldPath = path.join(avatarDir, oldName);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
    } catch {
      // ignore
    }

    return res.json({ ok: true });
  });

  // Save/update Expo push token (for push notifications)
  r.post("/push-token", async (req, res) => {
    const schema = z.object({ token: z.string().min(10) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    await prisma.user.update({
      where: { id: req.user!.id },
      data: { expoPushToken: parsed.data.token },
    });

    return res.json({ ok: true });
  });

  // Save/update Expo push token AND user notification preferences
  r.patch("/push-settings", async (req, res) => {
    const schema = z.object({
      token: z.string().min(10).nullable().optional(),
      enabled: z.boolean().optional(),
      soundEnabled: z.boolean().optional(),
      soundKey: z.enum(["DEFAULT", "CHIME", "DING", "POP"]).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const data: any = {};
    if (parsed.data.token !== undefined) data.expoPushToken = parsed.data.token ?? null;
    if (parsed.data.enabled !== undefined) data.pushEnabled = parsed.data.enabled;
    if (parsed.data.soundEnabled !== undefined) data.pushSoundEnabled = parsed.data.soundEnabled;
    if (parsed.data.soundKey !== undefined) data.pushSound = parsed.data.soundKey;

    await prisma.user.update({
      where: { id: req.user!.id },
      data,
    });

    return res.json({ ok: true });
  });

  // =========================
  // Seller profile (Smart Matching)
  // =========================
  r.get("/seller-profile", async (req, res) => {
    if (req.user!.role !== "SELLER") return res.status(403).json({ error: "Only sellers" });

    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        city: true,
        district: true,
        sellerMinPrice: true,
        sellerMaxPrice: true,
        sellerCondition: true,
        isPremium: true,
        category: { select: { id: true } },
        sellerCategories: { select: { categoryId: true } },
      },
    });

    if (!user) return res.status(404).json({ error: "Not found" });
    const categoryIds = (user.sellerCategories || []).map((x) => x.categoryId);
    return res.json({
      id: user.id,
      city: user.city ?? null,
      district: user.district ?? null,
      sellerMinPrice: user.sellerMinPrice ?? null,
      sellerMaxPrice: user.sellerMaxPrice ?? null,
      sellerCondition: user.sellerCondition ?? "ANY",
      isPremium: user.isPremium ?? false,
      categoryIds: categoryIds.length ? categoryIds : user.category?.id ? [user.category.id] : [],
    });
  });

  r.patch("/seller-profile", async (req, res) => {
    if (req.user!.role !== "SELLER") return res.status(403).json({ error: "Only sellers" });

    const schema = z.object({
      city: z.string().trim().min(1).max(64).optional().nullable(),
      district: z.string().trim().min(1).max(64).optional().nullable(),
      sellerMinPrice: z.coerce.number().int().min(0).optional().nullable(),
      sellerMaxPrice: z.coerce.number().int().min(0).optional().nullable(),
      sellerCondition: z.enum(["ANY", "NEW", "USED"]).optional().nullable(),
      categoryIds: z.array(z.string().min(1)).min(1).optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const data: any = {};
    if (parsed.data.city !== undefined) data.city = parsed.data.city ? String(parsed.data.city).trim() : null;
    if (parsed.data.district !== undefined) data.district = parsed.data.district ? String(parsed.data.district).trim() : null;
    if (parsed.data.sellerMinPrice !== undefined) data.sellerMinPrice = parsed.data.sellerMinPrice === null ? null : parsed.data.sellerMinPrice;
    if (parsed.data.sellerMaxPrice !== undefined) data.sellerMaxPrice = parsed.data.sellerMaxPrice === null ? null : parsed.data.sellerMaxPrice;
    if (parsed.data.sellerCondition !== undefined) data.sellerCondition = parsed.data.sellerCondition ?? null;

    // Validate and update categories (multi-select)
    if (parsed.data.categoryIds) {
      const unique = Array.from(new Set(parsed.data.categoryIds)).filter(Boolean);
      const cats = await prisma.category.findMany({ where: { id: { in: unique } }, select: { id: true } });
      if (cats.length !== unique.length) return res.status(400).json({ error: "Kateqoriya tapılmadı" });

      // Keep backward compatibility: store first selected category in User.categoryId relation
      data.category = { connect: { id: unique[0] } };

      await prisma.$transaction([
        prisma.user.update({ where: { id: req.user!.id }, data }),
        prisma.sellerCategory.deleteMany({ where: { sellerId: req.user!.id } }),
        prisma.sellerCategory.createMany({
          data: unique.map((categoryId) => ({ sellerId: req.user!.id, categoryId })),
          skipDuplicates: true,
        }),
      ]);
    } else {
      await prisma.user.update({ where: { id: req.user!.id }, data });
    }

    return res.json({ ok: true });
  });

  return r;
}
