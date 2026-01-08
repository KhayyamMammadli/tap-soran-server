import { PrismaClient, RequestScope } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import { sendExpoPush } from "../utils/push";
import { notifyAdmins } from "../utils/adminNotify";

const upload = multer({ dest: process.env.UPLOAD_DIR || "uploads" });

export function requestsRouter(prisma: PrismaClient) {
  const r = Router();

  // Buyer: list own requests (for Buyer panel)
  r.get("/mine", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (req.user.role !== "BUYER") return res.status(403).json({ error: "Only buyers" });

    const takeRaw = Array.isArray(req.query.take) ? req.query.take[0] : (req.query.take as string | undefined);
    const skipRaw = Array.isArray(req.query.skip) ? req.query.skip[0] : (req.query.skip as string | undefined);
    const take = Math.min(Math.max(Number(takeRaw || "20") || 20, 1), 100);
    const skip = Math.max(Number(skipRaw || "0") || 0, 0);

    const requests = await prisma.request.findMany({
      where: { buyerId: req.user.id },
      include: {
        category: true,
        accepted: {
          include: {
            seller: { select: { id: true, fullName: true, avatarUrl: true, phone: true, whatsapp: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take,
      skip,
    });

    res.json(requests);
  });

  // NOTE: `/:id` route is defined at the END of this file.
  // Otherwise Express would treat "/feed" as an id ("feed") and break seller feeds.

  // Buyer creates request (title + scope + optional category + optional image)
  r.post("/", upload.single("image"), async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (req.user.role !== "BUYER") return res.status(403).json({ error: "Only buyers can create requests" });

    const schema = z.object({
      title: z.string().min(2),
      // When scope=CATEGORY_SELLERS, categoryId is required.
      // When scope=ALL_SELLERS, categoryId is optional.
      categoryId: z.string().optional(),
      scope: z.enum(["ALL_SELLERS", "CATEGORY_SELLERS"]),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const imageUrl = (req as any).file ? `/uploads/${(req as any).file.filename}` : null;

    // Validate category rules
    const scope = parsed.data.scope as RequestScope;
    let categoryId: string | null = parsed.data.categoryId ?? null;
    if (scope === "CATEGORY_SELLERS") {
      if (!categoryId) return res.status(400).json({ error: "Kateqoriya seçin" });
      const existsCat = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } });
      if (!existsCat) return res.status(400).json({ error: "Kateqoriya tapılmadı" });
    } else {
      // scope=ALL_SELLERS: category is optional; if provided, validate but keep it optional
      if (categoryId) {
        const existsCat = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } });
        if (!existsCat) categoryId = null;
      }
    }

    const request = await prisma.request.create({
      data: {
        title: parsed.data.title,
        categoryId,
        scope,
        imageUrl,
        buyerId: req.user.id,
      },
      include: { category: true, buyer: { select: { id: true, fullName: true, avatarUrl: true } } },
    });

    // Notify SUPER_ADMIN users (and Telegram) about new requests
    try {
      const ioA = req.app.get("io");
      await notifyAdmins(prisma, ioA, {
        title: "Yeni sorğu",
        body: `${request.buyer?.fullName || "Buyer"}: ${request.title} • ${request.scope}${request.category?.name ? ` • ${request.category.name}` : ""}`,
        type: "ADMIN_NEW_REQUEST",
        telegramText: `📝 Yeni sorğu\nBuyer: ${request.buyer?.fullName || "-"}\nTitle: ${request.title}\nScope: ${request.scope}${request.category?.name ? `\nCategory: ${request.category.name}` : ""}`,
      });
    } catch {}

    // socket notification
    const io = req.app.get("io");
    if (io) {
      if (request.scope === "ALL_SELLERS") {
        io.to("sellers:all").emit("new_request", request);
      } else {
        // CATEGORY_SELLERS must have categoryId
        if (request.categoryId) io.to(`sellers:cat:${request.categoryId}`).emit("new_request", request);
      }
    }

    res.json(request);
  });

  // Seller gets relevant requests feed
  r.get("/feed", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (req.user.role !== "SELLER") return res.status(403).json({ error: "Only sellers" });

    // Pagination (lazy load)
    const takeRaw = Array.isArray(req.query.take) ? req.query.take[0] : (req.query.take as string | undefined);
    const skipRaw = Array.isArray(req.query.skip) ? req.query.skip[0] : (req.query.skip as string | undefined);
    const take = Math.min(Math.max(Number(takeRaw || "5") || 5, 1), 50);
    const skip = Math.max(Number(skipRaw || "0") || 0, 0);

    const requests = await prisma.request.findMany({
      where: {
        OR: [
          { scope: "ALL_SELLERS" },
          { scope: "CATEGORY_SELLERS", categoryId: req.user.categoryId || "__none__" },
        ],
      },
      include: { category: true, buyer: { select: { id: true, fullName: true, avatarUrl: true } }, accepted: true },
      orderBy: { createdAt: "desc" },
      take,
      skip,
    });

    res.json(requests);
  });

  // Seller accepts request (note/description + optional image)
  r.post("/:id/accept", upload.single("image"), async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (req.user.role !== "SELLER") return res.status(403).json({ error: "Only sellers can accept" });

    const requestId = req.params.id;

    const schema = z.object({ note: z.string().trim().min(2).max(500) });
    const parsedBody = schema.safeParse(req.body);
    if (!parsedBody.success) return res.status(400).json({ error: parsedBody.error.flatten() });

    const reqRow = await prisma.request.findUnique({
      where: { id: requestId },
      include: { accepted: true },
    });
    if (!reqRow) return res.status(404).json({ error: "Not found" });
    if (reqRow.accepted) return res.status(409).json({ error: "Already accepted" });

    // Enforce request visibility rules for acceptance
    if (reqRow.scope === "CATEGORY_SELLERS" && reqRow.categoryId !== (req.user.categoryId || "__none__")) {
      return res.status(403).json({ error: "Bu sorğu sizin kateqoriyanıza aid deyil" });
    }

    const accepted = await prisma.acceptedRequest.create({
      data: {
        requestId,
        sellerId: req.user.id,
        sellerNote: parsedBody.data.note,
        sellerImageUrl: (req as any).file ? `/uploads/${(req as any).file.filename}` : null,
      },
      include: { request: true, seller: { select: { id: true, fullName: true, avatarUrl: true, phone: true, whatsapp: true } } },
    });

    // Create notification for buyer (in-app) + push
    const notif = await prisma.notification.create({
      data: {
        userId: reqRow.buyerId,
        title: "Sorğunuz qəbul edildi",
        body: `${req.user.fullName} sorğunuzu qəbul etdi: ${reqRow.title}`,
        type: "REQUEST_ACCEPTED",
        data: { requestId, acceptedRequestId: accepted.id },
      },
    });

    // Send push to buyer (if token exists)
    const buyer = await prisma.user.findUnique({
      where: { id: reqRow.buyerId },
      select: { expoPushToken: true, pushEnabled: true, pushSoundEnabled: true, pushSound: true },
    });
    const pushEnabled = buyer?.pushEnabled !== false && !!buyer?.expoPushToken;
    if (pushEnabled) {
      const channelId =
        !buyer!.pushSoundEnabled
          ? "silent"
          : buyer!.pushSound === "CHIME"
            ? "sound_chime"
            : buyer!.pushSound === "DING"
              ? "sound_ding"
              : buyer!.pushSound === "POP"
                ? "sound_pop"
                : "default";
      const sound =
        !buyer!.pushSoundEnabled
          ? null
          : buyer!.pushSound === "CHIME"
            ? "chime.wav"
            : buyer!.pushSound === "DING"
              ? "ding.wav"
              : buyer!.pushSound === "POP"
                ? "pop.wav"
                : "default";
      await sendExpoPush(
        buyer!.expoPushToken,
        notif.title,
        notif.body,
        {
          type: "REQUEST_ACCEPTED",
          requestId,
          acceptedRequestId: accepted.id,
        },
        { sound, channelId }
      );
    }

    // Notify buyer
    const io = req.app.get("io");
    if (io) {
      io.to(`user:${reqRow.buyerId}`).emit("request_accepted", accepted);
      io.to(`user:${reqRow.buyerId}`).emit("new_notification", notif);
    }

    res.json(accepted);
  });

  // Buyer/Seller: request detail (for notification deep-link)
  // IMPORTANT: keep this route LAST to avoid collisions with "/feed".
  r.get("/:id", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const id = req.params.id;

    const row = await prisma.request.findUnique({
      where: { id },
      include: {
        category: true,
        buyer: { select: { id: true, fullName: true, avatarUrl: true } },
        accepted: {
          include: {
            seller: { select: { id: true, fullName: true, avatarUrl: true, phone: true, whatsapp: true } },
          },
        },
      },
    });
    if (!row) return res.status(404).json({ error: "Not found" });

    // Buyer can only view own requests. Seller can view requests from feed rules.
    if (req.user.role === "BUYER" && row.buyerId !== req.user.id) return res.status(403).json({ error: "Forbidden" });
    if (req.user.role === "SELLER") {
      const allowed =
        row.scope === "ALL_SELLERS" || (row.scope === "CATEGORY_SELLERS" && row.categoryId === (req.user.categoryId || "__none__"));
      if (!allowed) return res.status(403).json({ error: "Forbidden" });
    }

    return res.json(row);
  });

  return r;
}
