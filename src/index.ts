import "dotenv/config";
import express from "express";
import cors, { type CorsOptions } from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import compression from "compression";
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
import { reportsRouter } from "./routes/reports";
import { complaintsRouter } from "./routes/complaints";
import { legalRouter } from "./routes/legal";
import { requireSuperAdmin } from "./middleware/requireSuperAdmin";
import { authMiddleware } from "./middleware/auth";
import { verifyToken } from "./utils/jwt";
import bcrypt from "bcryptjs";
import { startRequestRetentionJob } from "./jobs/requestRetention";

const prisma = new PrismaClient();

function parseCorsOrigins(): string[] | null {
  const raw = (process.env.CORS_ORIGINS || "").trim();
  if (!raw) return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsOptions(): CorsOptions {
  const allowed = parseCorsOrigins();
  // In local development, browsers hit the API from localhost / 127.0.0.1 ports (Vite/Next/etc.)
  // even if CORS_ORIGINS is set for mobile LAN testing. Allow localhost dev origins safely.
  const localhostDev = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
  return {
    // Enable credentials to make CORS robust for both cookie-based and token-based clients.
    // (Token auth still works the same.)
    credentials: true,
    origin: (origin: string | undefined, cb: (err: any, allow?: boolean) => void) => {
      // React Native requests often have no Origin header.
      if (!origin) return cb(null, true);
      // If no allowlist is configured, allow all (dev default).
      if (!allowed) return cb(null, true);

      // Allow explicit allowlist entries.
      if (allowed.includes(origin)) return cb(null, true);

      // Always allow localhost origins for the admin web app during development.
      // This is especially important when the API is hosted (e.g. Render) and the admin runs locally.
      if (localhostDev.test(origin)) return cb(null, true);

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

  const passwordHash = await bcrypt.hash(password, 10);

  if (existing) {
    // IMPORTANT: in prod, this makes your login credentials deterministic.
    // If a SUPER_ADMIN already exists with wrong/unknown passwordHash, we update it to the env password.
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        role: "SUPER_ADMIN" as Role,
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

const app = express();
app.set("trust proxy", 1);

app.use(helmet());
app.use(compression());

// CORS (safe default for mobile + optional allowlist for web/admin)
app.use(cors(corsOptions()));
// Explicitly answer preflight requests for any route.
// (Some proxies/platforms are picky unless OPTIONS is handled explicitly.)
app.options("*", cors(corsOptions()));

// Reasonable body limits for APIs
app.use(express.json({ limit: "1mb" }));

// Basic rate limiting (especially useful for auth endpoints)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/auth", authLimiter);

const uploadDir = process.env.UPLOAD_DIR || "uploads";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
app.use("/uploads", express.static(path.resolve(uploadDir)));

app.get("/health", (_req, res) => {
  return res.json({
    ok: true,
    env: process.env.NODE_ENV || "development",
    time: new Date().toISOString(),
  });
});

app.use("/auth", authRouter(prisma));
app.use("/categories", categoriesRouter(prisma));
app.use("/legal", legalRouter(prisma));

app.use(authMiddleware(prisma));
app.use("/requests", requestsRouter(prisma));
app.use("/conversations", conversationsRouter(prisma));
app.use("/reports", reportsRouter(prisma));
app.use("/complaints", complaintsRouter(prisma));
app.use("/notifications", authMiddleware(prisma, { allowBlocked: true }), notificationsRouter(prisma));
app.use("/me", authMiddleware(prisma, { allowBlocked: true }), meRouter(prisma));
app.use("/admin", requireSuperAdmin, adminRouter(prisma));

const server = http.createServer(app);

// Socket CORS: allow mobile (no Origin) and optional allowlist for web/admin.
// If an allowlist is configured, we still allow localhost origins so the admin panel
// can connect to the hosted API during development.
const ioAllowed = parseCorsOrigins();
const ioLocalhostDev = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const io = new IOServer(server, {
  cors: {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (!ioAllowed) return cb(null, true);
      if (ioAllowed.includes(origin) || ioLocalhostDev.test(origin)) return cb(null, true);
      return cb(new Error("CORS"), false);
    },
    credentials: false,
  },
});

// Minimal error handler to avoid leaking stack traces in production
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = Number(err?.status || err?.statusCode || 500);
  const message = status >= 500 ? "Server xətası" : String(err?.message || "Xəta");
  if (status >= 500) console.error("Unhandled error:", err);
  res.status(status).json({ error: message });
});

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error("No token"));

    const payload = verifyToken(token);
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
    if (!user) return next(new Error("User not found"));
    const tv = typeof (payload as any).tv === "number" ? (payload as any).tv : 0;
    if ((user as any).tokenVersion !== tv) return next(new Error("Unauthorized"));
    if ((user as any).blocked) {
      const until = (user as any).blockedUntil ? new Date((user as any).blockedUntil) : null;
      if (until && until.getTime() <= Date.now()) {
        try {
          await prisma.user.update({
            where: { id: user.id },
            data: { blocked: false, blockedReason: null, blockedAt: null, blockedUntil: null, blockedById: null },
          });
        } catch {}
      } else {
        const blockedAt = (user as any).blockedAt ? new Date((user as any).blockedAt) : null;
        const grace = blockedAt ? Date.now() - blockedAt.getTime() < 60_000 : false;
        if (!grace) return next(new Error("Blocked"));
      }
    }

    (socket as any).user = {
      id: user.id,
      role: user.role,
      tokenVersion: (user as any).tokenVersion ?? 0,
      categoryId: user.category?.id ?? null,
    };
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

  // Keep requests for 28 days (auto-clean older ones)
  startRequestRetentionJob(prisma);

  server.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
}

main();