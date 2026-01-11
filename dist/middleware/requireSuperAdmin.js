"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireSuperAdmin = requireSuperAdmin;
function requireSuperAdmin(req, res, next) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthorized" });
    if (req.user.role !== "SUPER_ADMIN")
        return res.status(403).json({ error: "Forbidden" });
    return next();
}
