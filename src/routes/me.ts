import { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";

export function meRouter(prisma: PrismaClient) {
  const r = Router();

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
        blocked: true,
        blockedReason: true,
        blockedAt: true,
      },
    });
    return res.json(user);
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
