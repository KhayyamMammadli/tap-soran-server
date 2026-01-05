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
        categoryId: true,
        avatarUrl: true,
        blocked: true,
        blockedReason: true,
        blockedAt: true,
      },
    });
    return res.json(user);
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

  return r;
}
