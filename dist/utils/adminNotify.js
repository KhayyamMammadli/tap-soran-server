"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notifyAdmins = notifyAdmins;
const push_1 = require("./push");
const telegram_1 = require("./telegram");
/**
 * Fan-out a notification to ALL SUPER_ADMIN users.
 * Also mirrors the event to Telegram if configured.
 */
async function notifyAdmins(prisma, io, payload) {
    const admins = await prisma.user.findMany({ where: { role: "SUPER_ADMIN" }, select: { id: true } });
    const created = [];
    for (const a of admins) {
        const n = await prisma.notification.create({
            data: {
                userId: a.id,
                title: payload.title,
                body: (0, push_1.clip)(payload.body || "").slice(0, 200),
                type: payload.type || null,
            },
        });
        created.push(n);
        try {
            io?.to?.(`user:${a.id}`)?.emit?.("new_notification", n);
        }
        catch {
            // ignore
        }
    }
    // Telegram mirror (best-effort)
    try {
        const tg = payload.telegramText || `${payload.title}\n${payload.body}`;
        void (0, telegram_1.sendTelegram)(tg);
    }
    catch {
        // ignore
    }
    return created;
}
