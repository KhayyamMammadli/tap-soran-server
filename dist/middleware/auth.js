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
            const user = await prisma.user.findUnique({ where: { id: payload.userId } });
            if (!user)
                return res.status(401).json({ error: "Unauthorized" });
            if (!opts?.allowBlocked && user.blocked) {
                return res.status(403).json({ error: "Blocked", reason: user.blockedReason, blockedAt: user.blockedAt });
            }
            req.user = {
                id: user.id,
                role: user.role,
                fullName: user.fullName,
                email: user.email,
                tip: user.tip,
                categoryId: user.categoryId,
            };
            next();
        }
        catch {
            return res.status(401).json({ error: "Unauthorized" });
        }
    };
}
