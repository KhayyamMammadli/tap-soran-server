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

  return r;
}
