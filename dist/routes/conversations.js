"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.conversationsRouter = conversationsRouter;
const express_1 = require("express");
const zod_1 = require("zod");
function conversationsRouter(prisma) {
    const r = (0, express_1.Router)();
    // List conversations (for current user) with request preview if exists
    r.get("/", async (req, res) => {
        if (!req.user)
            return res.status(401).json({ error: "Unauthorized" });
        const convs = await prisma.conversation.findMany({
            where: { OR: [{ userAId: req.user.id }, { userBId: req.user.id }] },
            orderBy: { createdAt: "desc" },
            include: {
                acceptedRequest: {
                    include: {
                        request: { include: { category: true } },
                    },
                },
            },
        });
        res.json(convs);
    });
    // Conversation details (for showing request image/title in Chat)
    r.get("/:id", async (req, res) => {
        if (!req.user)
            return res.status(401).json({ error: "Unauthorized" });
        const id = req.params.id;
        const conv = await prisma.conversation.findUnique({
            where: { id },
            include: {
                userA: { select: { id: true, fullName: true, role: true } },
                userB: { select: { id: true, fullName: true, role: true } },
                acceptedRequest: {
                    include: {
                        request: { include: { category: true, buyer: { select: { id: true, fullName: true } } } },
                    },
                },
            },
        });
        if (!conv)
            return res.status(404).json({ error: "Not found" });
        if (conv.userAId !== req.user.id && conv.userBId !== req.user.id)
            return res.status(403).json({ error: "Forbidden" });
        res.json(conv);
    });
    // Get messages
    r.get("/:id/messages", async (req, res) => {
        if (!req.user)
            return res.status(401).json({ error: "Unauthorized" });
        const id = req.params.id;
        const conv = await prisma.conversation.findUnique({ where: { id } });
        if (!conv)
            return res.status(404).json({ error: "Not found" });
        if (conv.userAId !== req.user.id && conv.userBId !== req.user.id)
            return res.status(403).json({ error: "Forbidden" });
        const msgs = await prisma.message.findMany({
            where: { conversationId: id },
            orderBy: { createdAt: "asc" },
            take: 500,
        });
        res.json(msgs);
    });
    // Send message
    r.post("/:id/messages", async (req, res) => {
        if (!req.user)
            return res.status(401).json({ error: "Unauthorized" });
        const id = req.params.id;
        const schema = zod_1.z.object({ text: zod_1.z.string().min(1) });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ error: parsed.error.flatten() });
        const conv = await prisma.conversation.findUnique({ where: { id } });
        if (!conv)
            return res.status(404).json({ error: "Not found" });
        if (conv.userAId !== req.user.id && conv.userBId !== req.user.id)
            return res.status(403).json({ error: "Forbidden" });
        const msg = await prisma.message.create({
            data: { conversationId: id, senderId: req.user.id, text: parsed.data.text },
        });
        const io = req.app.get("io");
        if (io) {
            io.to(`user:${conv.userAId}`).to(`user:${conv.userBId}`).emit("new_message", msg);
        }
        res.json(msg);
    });
    return r;
}
