import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import http from "http";
import { Server as IOServer } from "socket.io";
import { PrismaClient, Role } from "@prisma/client";
import { authRouter } from "./routes/auth";
import { categoriesRouter } from "./routes/categories";
import { requestsRouter } from "./routes/requests";
import { conversationsRouter } from "./routes/conversations";
import { notificationsRouter } from "./routes/notifications";
import { meRouter } from "./routes/me";
import { adminRouter } from "./routes/admin";
import { requireSuperAdmin } from "./middleware/requireSuperAdmin";
import { authMiddleware } from "./middleware/auth";
import { verifyToken } from "./utils/jwt";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function ensureSuperAdmin() {
  const email = process.env.SUPER_ADMIN_EMAIL || "superadmin@tapsoran.az";
  const password = process.env.SUPER_ADMIN_PASSWORD || "TapSoran@12345";
  const fullName = process.env.SUPER_ADMIN_NAME || "TapSoran Super Admin";

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return;

  const passwordHash = await bcrypt.hash(password, 10);

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

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

const uploadDir = process.env.UPLOAD_DIR || "uploads";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
app.use("/uploads", express.static(path.resolve(uploadDir)));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/auth", authRouter(prisma));
app.use("/categories", categoriesRouter(prisma));

app.use(authMiddleware(prisma));
app.use("/requests", requestsRouter(prisma));
app.use("/conversations", conversationsRouter(prisma));
app.use("/notifications", authMiddleware(prisma, { allowBlocked: true }), notificationsRouter(prisma));
app.use("/me", authMiddleware(prisma, { allowBlocked: true }), meRouter(prisma));
app.use("/admin", requireSuperAdmin, adminRouter(prisma));

const server = http.createServer(app);

const io = new IOServer(server, { cors: { origin: true, credentials: true } });

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error("No token"));

    const payload = verifyToken(token);
    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) return next(new Error("User not found"));

    (socket as any).user = user;
    next();
  } catch {
    next(new Error("Unauthorized"));
  }
});

io.on("connection", (socket) => {
  const user = (socket as any).user as { id: string; role: Role; categoryId?: string | null };
  socket.join(`user:${user.id}`);

  if (user.role === "SELLER") {
    socket.join("sellers:all");
    if (user.categoryId) socket.join(`sellers:cat:${user.categoryId}`);
  }

  socket.on("disconnect", () => {});
});

app.set("io", io);

const PORT = Number(process.env.PORT || 4000);

async function main() {
  try {
    await ensureSuperAdmin();
  } catch (e) {
    console.error("Super admin seed error:", e);
  }
  server.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
}

main();