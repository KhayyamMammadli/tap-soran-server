"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.complaintsRouter = complaintsRouter;
const express_1 = require("express");
const zod_1 = require("zod");
const adminNotify_1 = require("../utils/adminNotify");
function complaintsRouter(prisma) {
    const r = (0, express_1.Router)();
    const createSchema = zod_1.z.object({
        targetUserId: zod_1.z.string().min(1),
        reason: zod_1.z.string().trim().min(3).max(200),
        details: zod_1.z.string().trim().max(1000).optional().or(zod_1.z.literal("")),
        requestId: zod_1.z.string().min(1).optional(),
    });
    // Create a general complaint against a user (not tied to chat)
    r.post("/", async (req, res) => {
        if (!req.user)
            return res.status(401).json({ error: "Unauthorized" });
        const reporter = req.user;
        const parsed = createSchema.safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ error: parsed.error.flatten() });
        const { targetUserId, reason, requestId } = parsed.data;
        const details = (parsed.data.details || "").trim() || null;
        if (targetUserId === reporter.id)
            return res.status(400).json({ error: "Özünüzü şikayət edə bilməzsiniz" });
        const target = await prisma.user.findUnique({
            where: { id: targetUserId },
            select: { id: true, fullName: true, email: true, reportCount: true },
        });
        if (!target)
            return res.status(404).json({ error: "İstifadəçi tapılmadı" });
        // If a requestId is provided, validate it exists (optional context)
        if (requestId) {
            const existsReq = await prisma.request.findUnique({ where: { id: requestId }, select: { id: true } });
            if (!existsReq)
                return res.status(400).json({ error: "Sorğu tapılmadı" });
        }
        const complaint = await prisma.$transaction(async (tx) => {
            const created = await tx.userComplaint.create({
                data: {
                    reporterId: reporter.id,
                    targetUserId,
                    requestId: requestId ?? null,
                    reason,
                    details,
                },
                include: {
                    reporter: { select: { id: true, fullName: true, email: true } },
                    targetUser: { select: { id: true, fullName: true, email: true, reportCount: true } },
                    request: { select: { id: true, title: true } },
                },
            });
            // Keep a simple counter for moderation dashboards
            await tx.user.update({ where: { id: targetUserId }, data: { reportCount: { increment: 1 } } });
            return created;
        });
        // Notify admins (and Telegram)
        try {
            const io = req.app.get("io");
            await (0, adminNotify_1.notifyAdmins)(prisma, io, {
                title: "Yeni şikayət",
                body: `${reporter.fullName} → ${target.fullName}: ${reason}`,
                type: "ADMIN_COMPLAINT",
                telegramText: `🚨 Yeni şikayət\nReporter: ${reporter.fullName} (${reporter.email || "-"})\nTarget: ${target.fullName} (${target.email || "-"})\nReason: ${reason}${details ? `\nDetails: ${details}` : ""}${requestId ? `\nRequestId: ${requestId}` : ""}`,
            });
        }
        catch { }
        return res.json({ ok: true, complaint });
    });
    return r;
}
