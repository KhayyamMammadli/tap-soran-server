"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notificationsRouter = notificationsRouter;
const express_1 = require("express");
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
    return r;
}
