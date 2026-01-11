"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMiddleware = authMiddleware;
const jwt_1 = require("../utils/jwt");
function authMiddleware(prisma, opts) {
    return async (req, res, next) => {
        try {
            const header = req.headers.authorization;
            if (!header?.startsWith("Bearer "))
                return res.status(401).json({ error: "Unauthorized" });
            const token = header.slice(7);
            const payload = (0, jwt_1.verifyToken)(token);
            const user = await prisma.user.findUnique({
                where: { id: payload.userId },
                select: {
                    id: true,
                    role: true,
                    fullName: true,
                    email: true,
                    tip: true,
                    tokenVersion: true,
                    blocked: true,
                    blockedReason: true,
                    blockedAt: true,
                    blockedUntil: true,
                    category: { select: { id: true } },
                },
            });
            if (!user)
                return res.status(401).json({ error: "Unauthorized" });
            // Force-logout support: if tokenVersion changed, the token is invalid.
            const tv = typeof payload.tv === "number" ? payload.tv : 0;
            if (user.tokenVersion !== tv) {
                return res.status(401).json({ error: "Unauthorized", code: "SESSION_EXPIRED" });
            }
            // Block enforcement:
            // - If blockedUntil is in the past => auto-unblock (best effort).
            // - If blockedAt is within the last 60 seconds => allow (grace window so the user can see the notice).
            // - Otherwise => block.
            if (!opts?.allowBlocked && user.blocked) {
                const until = user.blockedUntil ? new Date(user.blockedUntil) : null;
                if (until && until.getTime() <= Date.now()) {
                    try {
                        await prisma.user.update({
                            where: { id: user.id },
                            data: { blocked: false, blockedReason: null, blockedAt: null, blockedUntil: null, blockedById: null },
                        });
                    }
                    catch { }
                }
                else {
                    const blockedAt = user.blockedAt ? new Date(user.blockedAt) : null;
                    const grace = blockedAt ? Date.now() - blockedAt.getTime() < 60000 : false;
                    if (!grace) {
                        return res.status(403).json({
                            error: "Blocked",
                            reason: user.blockedReason,
                            blockedAt: user.blockedAt,
                            blockedUntil: user.blockedUntil,
                        });
                    }
                }
            }
            req.user = {
                id: user.id,
                role: user.role,
                fullName: user.fullName,
                email: user.email,
                tip: user.tip,
                categoryId: user.category?.id ?? null,
            };
            next();
        }
        catch {
            return res.status(401).json({ error: "Unauthorized" });
        }
    };
}
