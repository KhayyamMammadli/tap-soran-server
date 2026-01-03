import { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";

export function notificationsRouter(prisma: PrismaClient) {
  const r = Router();

  // List my notifications
  r.get("/", async (req, res) => {
    const rows = await prisma.notification.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return res.json(rows);
  });

  // Mark all as read
  r.post("/read-all", async (req, res) => {
    await prisma.notification.updateMany({
      where: { userId: req.user!.id, readAt: null },
      data: { readAt: new Date() },
    });
    return res.json({ ok: true });
  });

  // Mark notifications of a specific type as read (e.g. MESSAGE)
  r.post("/read-type", async (req, res) => {
    const schema = z.object({ type: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    await prisma.notification.updateMany({
      where: { userId: req.user!.id, type: parsed.data.type, readAt: null },
      data: { readAt: new Date() },
    });

    return res.json({ ok: true });
  });

  return r;
}
