"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const compression_1 = __importDefault(require("compression"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const client_1 = require("@prisma/client");
const auth_1 = require("./routes/auth");
const categories_1 = require("./routes/categories");
const requests_1 = require("./routes/requests");
const conversations_1 = require("./routes/conversations");
const notifications_1 = require("./routes/notifications");
const me_1 = require("./routes/me");
const admin_1 = require("./routes/admin");
const reports_1 = require("./routes/reports");
const complaints_1 = require("./routes/complaints");
const legal_1 = require("./routes/legal");
const requireSuperAdmin_1 = require("./middleware/requireSuperAdmin");
const auth_2 = require("./middleware/auth");
const jwt_1 = require("./utils/jwt");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const requestRetention_1 = require("./jobs/requestRetention");
const prisma = new client_1.PrismaClient();
function parseCorsOrigins() {
    const raw = (process.env.CORS_ORIGINS || "").trim();
    if (!raw)
        return null;
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}
function corsOptions() {
    const allowed = parseCorsOrigins();
    // In local development, browsers hit the API from localhost / 127.0.0.1 ports (Vite/Next/etc.)
    // even if CORS_ORIGINS is set for mobile LAN testing. Allow localhost dev origins safely.
    const localhostDev = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
    return {
        // Enable credentials to make CORS robust for both cookie-based and token-based clients.
        // (Token auth still works the same.)
        credentials: true,
        origin: (origin, cb) => {
            // React Native requests often have no Origin header.
            if (!origin)
                return cb(null, true);
            // If no allowlist is configured, allow all (dev default).
            if (!allowed)
                return cb(null, true);
            // Allow explicit allowlist entries.
            if (allowed.includes(origin))
                return cb(null, true);
            // Always allow localhost origins for the admin web app during development.
            // This is especially important when the API is hosted (e.g. Render) and the admin runs locally.
            if (localhostDev.test(origin))
                return cb(null, true);
            return cb(null, false);
        },
        // Make preflight responses predictable across platforms/proxies.
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
        optionsSuccessStatus: 204,
    };
}
async function ensureSuperAdmin() {
    if (String(process.env.SEED_SUPERADMIN || "").toLowerCase() !== "true") {
        return;
    }
    // Normalize email (trim + lowercase) to avoid login issues caused by mixed-case emails in DB
    const email = (process.env.SUPER_ADMIN_EMAIL || "superadmin@tapsoran.az").trim().toLowerCase();
    const password = process.env.SUPER_ADMIN_PASSWORD || "TapSoran@12345";
    const fullName = process.env.SUPER_ADMIN_NAME || "TapSoran Super Admin";
    // Use case-insensitive lookup so we can repair existing mixed-case rows in production
    const existing = await prisma.user.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
    });
    const passwordHash = await bcryptjs_1.default.hash(password, 10);
    if (existing) {
        // IMPORTANT: in prod, this makes your login credentials deterministic.
        // If a SUPER_ADMIN already exists with wrong/unknown passwordHash, we update it to the env password.
        await prisma.user.update({
            where: { id: existing.id },
            data: {
                role: "SUPER_ADMIN",
                fullName,
                email,
                passwordHash,
                tip: "Super Admin",
            },
        });
        console.log("\n✅ Super Admin yeniləndi (ensure):");
        console.log("   Email:", email);
        console.log("   Password:", password);
        console.log("");
        return;
    }
    await prisma.user.create({
        data: {
            role: "SUPER_ADMIN",
            fullName,
            email,
            passwordHash,
            tip: "Super Admin",
        },
    });
    console.log("\n✅ Super Admin yaradıldı:");
    console.log("   Email:", email);
    console.log("   Password:", password);
    console.log("");
}
const app = (0, express_1.default)();
app.set("trust proxy", 1);
app.use((0, helmet_1.default)());
app.use((0, compression_1.default)());
// CORS (safe default for mobile + optional allowlist for web/admin)
app.use((0, cors_1.default)(corsOptions()));
// Explicitly answer preflight requests for any route.
// (Some proxies/platforms are picky unless OPTIONS is handled explicitly.)
app.options("*", (0, cors_1.default)(corsOptions()));
// Reasonable body limits for APIs
app.use(express_1.default.json({ limit: "1mb" }));
// Basic rate limiting (especially useful for auth endpoints)
const authLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use("/auth", authLimiter);
const uploadDir = process.env.UPLOAD_DIR || "uploads";
if (!fs_1.default.existsSync(uploadDir))
    fs_1.default.mkdirSync(uploadDir);
app.use("/uploads", express_1.default.static(path_1.default.resolve(uploadDir)));
app.get("/health", (_req, res) => {
    return res.json({
        ok: true,
        env: process.env.NODE_ENV || "development",
        time: new Date().toISOString(),
    });
});
app.use("/auth", (0, auth_1.authRouter)(prisma));
app.use("/categories", (0, categories_1.categoriesRouter)(prisma));
app.use("/legal", (0, legal_1.legalRouter)(prisma));
app.use((0, auth_2.authMiddleware)(prisma));
app.use("/requests", (0, requests_1.requestsRouter)(prisma));
app.use("/conversations", (0, conversations_1.conversationsRouter)(prisma));
app.use("/reports", (0, reports_1.reportsRouter)(prisma));
app.use("/complaints", (0, complaints_1.complaintsRouter)(prisma));
app.use("/notifications", (0, auth_2.authMiddleware)(prisma, { allowBlocked: true }), (0, notifications_1.notificationsRouter)(prisma));
app.use("/me", (0, auth_2.authMiddleware)(prisma, { allowBlocked: true }), (0, me_1.meRouter)(prisma));
app.use("/admin", requireSuperAdmin_1.requireSuperAdmin, (0, admin_1.adminRouter)(prisma));
const server = http_1.default.createServer(app);
// Socket CORS: allow mobile (no Origin) and optional allowlist for web/admin.
// If an allowlist is configured, we still allow localhost origins so the admin panel
// can connect to the hosted API during development.
const ioAllowed = parseCorsOrigins();
const ioLocalhostDev = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const io = new socket_io_1.Server(server, {
    cors: {
        origin: (origin, cb) => {
            if (!origin)
                return cb(null, true);
            if (!ioAllowed)
                return cb(null, true);
            if (ioAllowed.includes(origin) || ioLocalhostDev.test(origin))
                return cb(null, true);
            return cb(new Error("CORS"), false);
        },
        credentials: false,
    },
});
// Minimal error handler to avoid leaking stack traces in production
app.use((err, _req, res, _next) => {
    const status = Number(err?.status || err?.statusCode || 500);
    const message = status >= 500 ? "Server xətası" : String(err?.message || "Xəta");
    if (status >= 500)
        console.error("Unhandled error:", err);
    res.status(status).json({ error: message });
});
io.use(async (socket, next) => {
    try {
        const token = socket.handshake.auth?.token;
        if (!token)
            return next(new Error("No token"));
        const payload = (0, jwt_1.verifyToken)(token);
        const user = await prisma.user.findUnique({
            where: { id: payload.userId },
            select: {
                id: true,
                role: true,
                tokenVersion: true,
                blocked: true,
                blockedAt: true,
                blockedUntil: true,
                category: { select: { id: true } },
            },
        });
        if (!user)
            return next(new Error("User not found"));
        const tv = typeof payload.tv === "number" ? payload.tv : 0;
        if (user.tokenVersion !== tv)
            return next(new Error("Unauthorized"));
        if (user.blocked) {
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
                if (!grace)
                    return next(new Error("Blocked"));
            }
        }
        socket.user = {
            id: user.id,
            role: user.role,
            tokenVersion: user.tokenVersion ?? 0,
            categoryId: user.category?.id ?? null,
        };
        next();
    }
    catch {
        next(new Error("Unauthorized"));
    }
});
io.on("connection", (socket) => {
    const user = socket.user;
    socket.join(`user:${user.id}`);
    if (user.role === "SELLER") {
        socket.join("sellers:all");
        if (user.categoryId)
            socket.join(`sellers:cat:${user.categoryId}`);
    }
    socket.on("disconnect", () => { });
});
app.set("io", io);
const PORT = Number(process.env.PORT || 4000);
async function main() {
    try {
        await ensureSuperAdmin();
    }
    catch (e) {
        console.error("Super admin seed error:", e);
    }
    // Keep requests for 28 days (auto-clean older ones)
    (0, requestRetention_1.startRequestRetentionJob)(prisma);
    server.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
}
main();
