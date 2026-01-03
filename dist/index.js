"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
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
const requireSuperAdmin_1 = require("./middleware/requireSuperAdmin");
const auth_2 = require("./middleware/auth");
const jwt_1 = require("./utils/jwt");
const bcrypt_1 = __importDefault(require("bcrypt"));
const prisma = new client_1.PrismaClient();
async function ensureSuperAdmin() {
    const email = process.env.SUPER_ADMIN_EMAIL || "superadmin@tapsoran.az";
    const password = process.env.SUPER_ADMIN_PASSWORD || "TapSoran@12345";
    const fullName = process.env.SUPER_ADMIN_NAME || "TapSoran Super Admin";
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing)
        return;
    const passwordHash = await bcrypt_1.default.hash(password, 10);
    await prisma.user.create({
        data: {
            role: "SUPER_ADMIN",
            fullName,
            email,
            passwordHash,
            tip: "Super Admin",
            categoryId: null,
        },
    });
    console.log("\n✅ Super Admin yaradıldı:");
    console.log("   Email:", email);
    console.log("   Password:", password);
    console.log("");
}
const app = (0, express_1.default)();
app.use((0, cors_1.default)({ origin: true, credentials: true }));
app.use(express_1.default.json());
const uploadDir = process.env.UPLOAD_DIR || "uploads";
if (!fs_1.default.existsSync(uploadDir))
    fs_1.default.mkdirSync(uploadDir);
app.use("/uploads", express_1.default.static(path_1.default.resolve(uploadDir)));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/auth", (0, auth_1.authRouter)(prisma));
app.use("/categories", (0, categories_1.categoriesRouter)(prisma));
app.use((0, auth_2.authMiddleware)(prisma));
app.use("/requests", (0, requests_1.requestsRouter)(prisma));
app.use("/conversations", (0, conversations_1.conversationsRouter)(prisma));
app.use("/notifications", (0, auth_2.authMiddleware)(prisma, { allowBlocked: true }), (0, notifications_1.notificationsRouter)(prisma));
app.use("/me", (0, auth_2.authMiddleware)(prisma, { allowBlocked: true }), (0, me_1.meRouter)(prisma));
app.use("/admin", requireSuperAdmin_1.requireSuperAdmin, (0, admin_1.adminRouter)(prisma));
const server = http_1.default.createServer(app);
const io = new socket_io_1.Server(server, { cors: { origin: true, credentials: true } });
io.use(async (socket, next) => {
    try {
        const token = socket.handshake.auth?.token;
        if (!token)
            return next(new Error("No token"));
        const payload = (0, jwt_1.verifyToken)(token);
        const user = await prisma.user.findUnique({ where: { id: payload.userId } });
        if (!user)
            return next(new Error("User not found"));
        socket.user = user;
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
    server.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
}
main();
