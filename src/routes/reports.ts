import { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";

export function reportsRouter(prisma: PrismaClient) {
  const r = Router();

  const createSchema = z.object({
    messageId: z.string().min(1),
    reason: z.string().min(3).max(200),
  });

  // Create a report for a specific message
  r.post("/", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { messageId, reason } = parsed.data;

    const msg = await prisma.message.findUnique({ where: { id: messageId }, select: { id: true, senderId: true, conversationId: true } });
    if (!msg) return res.status(404).json({ error: "Not found" });
    if (msg.senderId === req.user.id) return res.status(400).json({ error: "You can't report your own message" });

    // Ensure reporter is participant
    const conv = await prisma.conversation.findUnique({ where: { id: msg.conversationId }, select: { id: true, userAId: true, userBId: true } });
    if (!conv) return res.status(404).json({ error: "Not found" });
    if (conv.userAId !== req.user.id && conv.userBId !== req.user.id) return res.status(403).json({ error: "Forbidden" });

    try {
      const report = await prisma.$transaction(async (tx) => {
        const created = await tx.messageReport.create({
          data: {
            conversationId: msg.conversationId,
            messageId: msg.id,
            reporterId: req.user.id,
            reportedUserId: msg.senderId,
            reason,
          },
        });

        // Increment cached reportCount
        await tx.user.update({ where: { id: msg.senderId }, data: { reportCount: { increment: 1 } } });

        return created;
      });

      // Escalation based on reportCount
      const target = await prisma.user.findUnique({ where: { id: msg.senderId }, select: { id: true, fullName: true, reportCount: true, blocked: true, chatFrozenUntil: true, blockedReason: true, blockedAt: true } });
      const count = target?.reportCount ?? 0;

      const io = req.app.get("io");

      // 3 -> freeze 24h; 5 -> freeze 7d; 7 -> block
      if (target && !target.blocked) {
        if (count === 3) {
          const until = new Date(Date.now() + 24 * 60 * 60 * 1000);
          await prisma.user.update({ where: { id: target.id }, data: { chatFrozenUntil: until } });
          await prisma.notification.create({
            data: {
              userId: target.id,
              title: "Çat müvəqqəti dayandırıldı",
              body: "Hesabınız şikayətlərə görə 24 saatlıq məhdudlaşdırıldı.",
              type: "CHAT_FROZEN",
            },
          });
          try {
            io?.to?.(`user:${target.id}`)?.emit?.("chatFrozen", { until: until.toISOString(), reason: "Şikayət limiti" });
          } catch {}
        } else if (count === 5) {
          const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
          await prisma.user.update({ where: { id: target.id }, data: { chatFrozenUntil: until } });
          await prisma.notification.create({
            data: {
              userId: target.id,
              title: "Çat müvəqqəti dayandırıldı",
              body: "Hesabınız şikayətlərə görə 7 gün məhdudlaşdırıldı.",
              type: "CHAT_FROZEN",
            },
          });
          try {
            io?.to?.(`user:${target.id}`)?.emit?.("chatFrozen", { until: until.toISOString(), reason: "Şikayət limiti" });
          } catch {}
        } else if (count >= 7) {
          const blockedReason = "Şikayətlərə görə hesab bloklandı";
          await prisma.user.update({
            where: { id: target.id },
            data: { blocked: true, blockedReason, blockedAt: new Date(), tokenVersion: { increment: 1 } },
          });
          await prisma.notification.create({
            data: { userId: target.id, title: "Hesab bloklandı", body: blockedReason, type: "BLOCKED" },
          });
          try {
            io?.to?.(`user:${target.id}`)?.emit?.("userBlocked", { reason: blockedReason, blockedAt: new Date().toISOString() });
            io?.in?.(`user:${target.id}`)?.disconnectSockets?.(true);
          } catch {}
        }
      }

      // Notify admins
      const admins = await prisma.user.findMany({ where: { role: "SUPER_ADMIN" }, select: { id: true } });
      const adminNotifs: Array<{ adminId: string; notif: any }> = [];
      for (const a of admins) {
        const n = await prisma.notification.create({
          data: {
            userId: a.id,
            title: "Yeni şikayət",
            body: `${req.user.fullName} → ${(target?.fullName ?? "istifadəçi")}: ${reason}`.slice(0, 200),
            type: "ADMIN_REPORT",
          },
        });
        adminNotifs.push({ adminId: a.id, notif: n });
      }
      if (io) {
        for (const a of adminNotifs) io.to(`user:${a.adminId}`).emit("new_notification", a.notif);
      }

      return res.json({ ok: true, report });
    } catch (e: any) {
      if (String(e?.message || "").includes("Unique constraint")) {
        return res.status(409).json({ error: "Already reported" });
      }
      return res.status(400).json({ error: e?.message || "Report failed" });
    }
  });

  return r;
}
