"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRouter = authRouter;
const express_1 = require("express");
const bcrypt_1 = __importDefault(require("bcrypt"));
const zod_1 = require("zod");
const jwt_1 = require("../utils/jwt");
function authRouter(prisma) {
    const r = (0, express_1.Router)();
    const registerSchema = zod_1.z
        .object({
        role: zod_1.z.enum(["BUYER", "SELLER"]),
        fullName: zod_1.z.string().min(3),
        email: zod_1.z.string().email(),
        password: zod_1.z.string().min(6),
        categoryId: zod_1.z.string().optional(),
    })
        .superRefine((val, ctx) => {
        if (val.role === "SELLER" && !val.categoryId) {
            ctx.addIssue({
                code: zod_1.z.ZodIssueCode.custom,
                path: ["categoryId"],
                message: "Seller üçün kateqoriya seçilməlidir",
            });
        }
    });
    r.post("/register", async (req, res) => {
        const parsed = registerSchema.safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ error: parsed.error.flatten() });
        const { role, fullName, email, password, categoryId } = parsed.data;
        const exists = await prisma.user.findUnique({ where: { email } });
        if (exists)
            return res.status(409).json({ error: "Email already used" });
        const passwordHash = await bcrypt_1.default.hash(password, 10);
        const user = await prisma.user.create({
            data: {
                role: role,
                fullName,
                email,
                passwordHash,
                categoryId: role === "SELLER" ? categoryId : null,
            },
            select: { id: true, role: true, fullName: true, email: true, tip: true, categoryId: true },
        });
        const token = (0, jwt_1.signToken)(user.id);
        res.json({ user, token });
    });
    const loginSchema = zod_1.z.object({
        email: zod_1.z.string().email(),
        password: zod_1.z.string().min(1),
        role: zod_1.z.enum(["BUYER", "SELLER", "SUPER_ADMIN"]).optional(),
    });
    r.post("/login", async (req, res) => {
        const parsed = loginSchema.safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ error: parsed.error.flatten() });
        const { email, password, role } = parsed.data;
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user)
            return res.status(401).json({ error: "Invalid credentials" });
        if (user.blocked)
            return res.status(403).json({ error: "Blocked", reason: user.blockedReason, blockedAt: user.blockedAt });
        // Role enforcement: buyer/seller cannot login as the other role.
        // Super admin is allowed regardless (admin panel has separate login).
        if (user.role !== "SUPER_ADMIN") {
            if (!role)
                return res.status(400).json({ error: "Role required" });
            if (role !== user.role)
                return res.status(403).json({ error: "Role mismatch" });
        }
        const ok = await bcrypt_1.default.compare(password, user.passwordHash);
        if (!ok)
            return res.status(401).json({ error: "Invalid credentials" });
        const token = (0, jwt_1.signToken)(user.id);
        res.json({
            user: {
                id: user.id,
                role: user.role,
                fullName: user.fullName,
                email: user.email,
                tip: user.tip,
                categoryId: user.categoryId,
            },
            token,
        });
    });
    return r;
}
