"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notificationsRouter = notificationsRouter;
const express_1 = require("express");
const zod_1 = require("zod");
function notificationsRouter(prisma) {
    const r = (0, express_1.Router)();
    // List my notifications
    r.get("/", async (req, res) => {
        const rows = await prisma.notification.findMany({
            where: { userId: req.user.id },
            orderBy: { createdAt: "desc" },
            take: 100,
        });
        return res.json(rows);
    });
    // Mark all as read
    r.post("/read-all", async (req, res) => {
        await prisma.notification.updateMany({
            where: { userId: req.user.id, readAt: null },
            data: { readAt: new Date() },
        });
        return res.json({ ok: true });
    });
    // Mark notifications of a specific type as read (e.g. MESSAGE)
    r.post("/read-type", async (req, res) => {
        const schema = zod_1.z.object({ type: zod_1.z.string().min(1) });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ error: parsed.error.flatten() });
        await prisma.notification.updateMany({
            where: { userId: req.user.id, type: parsed.data.type, readAt: null },
            data: { readAt: new Date() },
        });
        return res.json({ ok: true });
    });
    return r;
}
