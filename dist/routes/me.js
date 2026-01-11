"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.meRouter = meRouter;
const express_1 = require("express");
const zod_1 = require("zod");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
function ensureDir(p) {
    if (!fs_1.default.existsSync(p))
        fs_1.default.mkdirSync(p, { recursive: true });
}
function meRouter(prisma) {
    const r = (0, express_1.Router)();
    const uploadRoot = process.env.UPLOAD_DIR || "uploads";
    const avatarDir = path_1.default.join(uploadRoot, "avatars");
    ensureDir(avatarDir);
    const avatarUpload = (0, multer_1.default)({
        storage: multer_1.default.diskStorage({
            destination: (_req, _file, cb) => cb(null, avatarDir),
            filename: (req, file, cb) => {
                const ext = (path_1.default.extname(file.originalname) || "").toLowerCase();
                const safeExt = ext && ext.length <= 10 ? ext : "";
                const rand = Math.random().toString(16).slice(2);
                cb(null, `${req.user.id}-${Date.now()}-${rand}${safeExt}`);
            },
        }),
        limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
        fileFilter: (_req, file, cb) => {
            if (!file.mimetype.startsWith("image/"))
                return cb(new Error("Only image files allowed"));
            cb(null, true);
        },
    });
    r.get("/", async (req, res) => {
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: {
                id: true,
                role: true,
                fullName: true,
                email: true,
                tip: true,
                avatarUrl: true,
                blocked: true,
                blockedReason: true,
                blockedAt: true,
                category: { select: { id: true } },
            },
        });
        if (!user)
            return res.status(404).json({ error: "Not found" });
        return res.json({
            id: user.id,
            role: user.role,
            fullName: user.fullName,
            email: user.email,
            tip: user.tip,
            categoryId: user.category?.id ?? null,
            avatarUrl: user.avatarUrl ?? null,
            blocked: user.blocked,
            blockedReason: user.blockedReason,
            blockedAt: user.blockedAt,
        });
    });
    // Upload / update avatar
    r.post("/avatar", avatarUpload.single("avatar"), async (req, res) => {
        if (!req.file)
            return res.status(400).json({ error: "No file" });
        const existing = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: { avatarUrl: true },
        });
        const file = req.file;
        const url = `/uploads/avatars/${file.filename}`;
        await prisma.user.update({
            where: { id: req.user.id },
            data: { avatarUrl: url },
        });
        // Best-effort: delete old avatar file (only if it was on this server)
        try {
            const old = existing?.avatarUrl;
            if (old && old.startsWith("/uploads/avatars/")) {
                const oldName = old.replace("/uploads/avatars/", "");
                const oldPath = path_1.default.join(avatarDir, oldName);
                if (fs_1.default.existsSync(oldPath))
                    fs_1.default.unlinkSync(oldPath);
            }
        }
        catch {
            // ignore
        }
        return res.json({ avatarUrl: url });
    });
    // Remove avatar
    r.delete("/avatar", async (req, res) => {
        const existing = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: { avatarUrl: true },
        });
        await prisma.user.update({
            where: { id: req.user.id },
            data: { avatarUrl: null },
        });
        try {
            const old = existing?.avatarUrl;
            if (old && old.startsWith("/uploads/avatars/")) {
                const oldName = old.replace("/uploads/avatars/", "");
                const oldPath = path_1.default.join(avatarDir, oldName);
                if (fs_1.default.existsSync(oldPath))
                    fs_1.default.unlinkSync(oldPath);
            }
        }
        catch {
            // ignore
        }
        return res.json({ ok: true });
    });
    // Save/update Expo push token (for push notifications)
    r.post("/push-token", async (req, res) => {
        const schema = zod_1.z.object({ token: zod_1.z.string().min(10) });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ error: parsed.error.flatten() });
        await prisma.user.update({
            where: { id: req.user.id },
            data: { expoPushToken: parsed.data.token },
        });
        return res.json({ ok: true });
    });
    // Save/update Expo push token AND user notification preferences
    r.patch("/push-settings", async (req, res) => {
        const schema = zod_1.z.object({
            token: zod_1.z.string().min(10).nullable().optional(),
            enabled: zod_1.z.boolean().optional(),
            soundEnabled: zod_1.z.boolean().optional(),
            soundKey: zod_1.z.enum(["DEFAULT", "CHIME", "DING", "POP"]).optional(),
        });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ error: parsed.error.flatten() });
        const data = {};
        if (parsed.data.token !== undefined)
            data.expoPushToken = parsed.data.token ?? null;
        if (parsed.data.enabled !== undefined)
            data.pushEnabled = parsed.data.enabled;
        if (parsed.data.soundEnabled !== undefined)
            data.pushSoundEnabled = parsed.data.soundEnabled;
        if (parsed.data.soundKey !== undefined)
            data.pushSound = parsed.data.soundKey;
        await prisma.user.update({
            where: { id: req.user.id },
            data,
        });
        return res.json({ ok: true });
    });
    return r;
}
