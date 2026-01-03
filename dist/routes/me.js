"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.meRouter = meRouter;
const express_1 = require("express");
function meRouter(prisma) {
    const r = (0, express_1.Router)();
    r.get("/", async (req, res) => {
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
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
    return r;
}
