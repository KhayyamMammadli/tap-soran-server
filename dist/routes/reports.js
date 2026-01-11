"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reportsRouter = reportsRouter;
const express_1 = require("express");
const zod_1 = require("zod");
const adminNotify_1 = require("../utils/adminNotify");
function reportsRouter(prisma) {
    const r = (0, express_1.Router)();
    const createSchema = zod_1.z.object({
        messageId: zod_1.z.string().min(1),
        reason: zod_1.z.string().min(3).max(200),
    });
    // Create a report for a specific message
    r.post("/", async (req, res) => {
        // Narrow req.user once so TS keeps it inside nested callbacks (e.g. $transaction)
        if (!req.user)
            return res.status(401).json({ error: "Unauthorized" });
        const user = req.user;
        const parsed = createSchema.safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ error: parsed.error.flatten() });
        const { messageId, reason } = parsed.data;
        const msg = await prisma.message.findUnique({ where: { id: messageId }, select: { id: true, senderId: true, conversationId: true } });
        if (!msg)
            return res.status(404).json({ error: "Not found" });
        if (msg.senderId === user.id)
            return res.status(400).json({ error: "You can't report your own message" });
        // Ensure reporter is participant
        const conv = await prisma.conversation.findUnique({ where: { id: msg.conversationId }, select: { id: true, userAId: true, userBId: true } });
        if (!conv)
            return res.status(404).json({ error: "Not found" });
        if (conv.userAId !== user.id && conv.userBId !== user.id)
            return res.status(403).json({ error: "Forbidden" });
        try {
            const report = await prisma.$transaction(async (tx) => {
                const created = await tx.messageReport.create({
                    data: {
                        conversationId: msg.conversationId,
                        messageId: msg.id,
                        reporterId: user.id,
                        targetUserId: msg.senderId,
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
                    }
                    catch { }
                }
                else if (count === 5) {
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
                    }
                    catch { }
                }
                else if (count >= 7) {
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
                    }
                    catch { }
                }
            }
            // Notify admins (and Telegram)
            await (0, adminNotify_1.notifyAdmins)(prisma, io, {
                title: "Yeni şikayət",
                body: `${user.fullName} → ${(target?.fullName ?? "istifadəçi")}: ${reason}`,
                type: "ADMIN_REPORT",
                telegramText: `🚨 Yeni şikayət\nReporter: ${user.fullName} (${user.email || "-"})\nTarget: ${(target?.fullName ?? "-")}\nReason: ${reason}`,
            });
            return res.json({ ok: true, report });
        }
        catch (e) {
            if (String(e?.message || "").includes("Unique constraint")) {
                return res.status(409).json({ error: "Already reported" });
            }
            return res.status(400).json({ error: e?.message || "Report failed" });
        }
    });
    // Create a report for a conversation (no need to pick a message on client).
    // Server finds a recent message from the other participant that the reporter hasn't reported yet.
    const convSchema = zod_1.z.object({ reason: zod_1.z.string().min(3).max(200) });
    r.post("/conversation/:id", async (req, res) => {
        if (!req.user)
            return res.status(401).json({ error: "Unauthorized" });
        const user = req.user;
        const parsed = convSchema.safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ error: parsed.error.flatten() });
        const convId = req.params.id;
        const conv = await prisma.conversation.findUnique({ where: { id: convId }, select: { id: true, userAId: true, userBId: true } });
        if (!conv)
            return res.status(404).json({ error: "Not found" });
        if (conv.userAId !== user.id && conv.userBId !== user.id)
            return res.status(403).json({ error: "Forbidden" });
        const targetUserId = conv.userAId === user.id ? conv.userBId : conv.userAId;
        // Find a recent message from target that user hasn't reported yet.
        const recent = await prisma.message.findMany({
            where: { conversationId: convId, senderId: targetUserId },
            orderBy: { createdAt: "desc" },
            take: 30,
            select: { id: true, senderId: true },
        });
        if (!recent.length)
            return res.status(400).json({ error: "No message to report" });
        const recentIds = recent.map((m) => m.id);
        const already = await prisma.messageReport.findMany({
            where: { reporterId: user.id, messageId: { in: recentIds } },
            select: { messageId: true },
        });
        const alreadySet = new Set(already.map((x) => x.messageId));
        const pick = recent.find((m) => !alreadySet.has(m.id));
        if (!pick)
            return res.status(409).json({ error: "Already reported" });
        try {
            const report = await prisma.$transaction(async (tx) => {
                const created = await tx.messageReport.create({
                    data: {
                        conversationId: convId,
                        messageId: pick.id,
                        reporterId: user.id,
                        targetUserId,
                        reason: parsed.data.reason,
                    },
                });
                await tx.user.update({ where: { id: targetUserId }, data: { reportCount: { increment: 1 } } });
                return created;
            });
            const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, fullName: true, email: true, reportCount: true } });
            const io = req.app.get("io");
            await (0, adminNotify_1.notifyAdmins)(prisma, io, {
                title: "Yeni şikayət",
                body: `${user.fullName} → ${(target?.fullName ?? "istifadəçi")}: ${parsed.data.reason}`,
                type: "ADMIN_REPORT",
                telegramText: `🚨 Yeni şikayət\nReporter: ${user.fullName} (${user.email || "-"})\nTarget: ${(target?.fullName ?? "-")}\nReason: ${parsed.data.reason}`,
            });
            return res.json({ ok: true, report });
        }
        catch (e) {
            if (String(e?.message || "").includes("Unique constraint")) {
                return res.status(409).json({ error: "Already reported" });
            }
            return res.status(400).json({ error: e?.message || "Report failed" });
        }
    });
    return r;
}
