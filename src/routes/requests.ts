import { PrismaClient, RequestScope } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import { sendExpoPush } from "../utils/push";
import { notifyAdmins } from "../utils/adminNotify";

const upload = multer({ dest: process.env.UPLOAD_DIR || "uploads" });

function pushPrefs(u: {
  pushSoundEnabled?: boolean | null;
  pushSound?: "DEFAULT" | "CHIME" | "DING" | "POP" | null;
}) {
  const enabled = u.pushSoundEnabled !== false;
  const channelId = !enabled
    ? "silent"
    : u.pushSound === "CHIME"
      ? "sound_chime"
      : u.pushSound === "DING"
        ? "sound_ding"
        : u.pushSound === "POP"
          ? "sound_pop"
          : "default";
  const sound = !enabled
    ? null
    : u.pushSound === "CHIME"
      ? "chime.wav"
      : u.pushSound === "DING"
        ? "ding.wav"
        : u.pushSound === "POP"
          ? "pop.wav"
          : "default";
  return { channelId, sound };
}

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
        review: true,
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
      // Optional: used for smart seller matching
      city: z.string().trim().min(1).max(64).optional(),
      district: z.string().trim().min(1).max(64).optional(),
      budget: z.coerce.number().int().positive().optional(),
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

    // Infer location from buyer profile (optional)
    let city: string | null = parsed.data.city?.trim() || null;
    let district: string | null = parsed.data.district?.trim() || null;
    if (!city || !district) {
      try {
        const buyer = await prisma.user.findUnique({
          where: { id: req.user.id },
          select: { city: true, district: true },
        });
        if (!city) city = (buyer as any)?.city ?? null;
        if (!district) district = (buyer as any)?.district ?? null;
      } catch {}
    }

    const budget = typeof (parsed.data as any).budget === "number" ? (parsed.data as any).budget : null;

    const request = await prisma.request.create({
      data: {
        title: parsed.data.title,
        categoryId,
        scope,
        imageUrl,
        city,
        district,
        budget,
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

    // Smart Seller Matching + targeted delivery (reduces spam)
    try {
      const baseWhere: any = { role: "SELLER", blocked: false };
      if (request.scope === "CATEGORY_SELLERS" && request.categoryId) {
        baseWhere.OR = [
          { categoryId: request.categoryId },
          { sellerCategories: { some: { categoryId: request.categoryId } } },
        ];
      }

      const sellers = await prisma.user.findMany({
        where: baseWhere,
        select: {
          id: true,
          city: true,
          district: true,
          sellerMinPrice: true,
          sellerMaxPrice: true,
          expoPushToken: true,
          pushEnabled: true,
          pushSoundEnabled: true,
          pushSound: true,
        },
      });

      const matched = (sellers || []).filter((s: any) => {
        // Location: if seller set a city/district, require match when request location exists.
        if (s.city && request.city && String(s.city).toLowerCase() !== String(request.city).toLowerCase()) return false;
        if (s.district && request.district && String(s.district).toLowerCase() !== String(request.district).toLowerCase()) return false;

        // Budget: if buyer provided budget and seller set min/max, enforce range
        if (typeof request.budget === "number") {
          if (typeof s.sellerMinPrice === "number" && request.budget < s.sellerMinPrice) return false;
          if (typeof s.sellerMaxPrice === "number" && request.budget > s.sellerMaxPrice) return false;
        }
        return true;
      });

      if (matched.length) {
        // Persist targeting for analytics + better feeds
        await prisma.requestTarget.createMany({
          data: matched.map((s: any) => ({ requestId: request.id, sellerId: s.id })),
          skipDuplicates: true,
        });

        // In-app notifications (best-effort)
        try {
          await prisma.notification.createMany({
            data: matched.map((s: any) => ({
              userId: s.id,
              title: "Yeni sorğu",
              body: request.title,
              type: "NEW_REQUEST",
              data: { requestId: request.id },
            })),
          });
        } catch {}

        // Socket delivery (targeted)
        const io = req.app.get("io");
        if (io) {
          for (const s of matched) {
            io.to(`user:${s.id}`).emit("new_request", request);
          }
        }

        // Push (targeted)
        await Promise.all(
          matched
            .filter((s: any) => s.pushEnabled !== false && !!s.expoPushToken)
            .map(async (s: any) => {
              const { channelId, sound } = pushPrefs(s);
              await sendExpoPush(
                s.expoPushToken,
                "Yeni sorğu",
                request.title,
                { type: "NEW_REQUEST", requestId: request.id },
                { sound, channelId }
              );
            })
        );
      }
    } catch (e) {
      console.error("Seller matching/notify failed:", e);
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
          // New behavior: only show requests that targeted this seller.
          { targets: { some: { sellerId: req.user.id } } },

          // Backward-compatible behavior: legacy requests (no targets) follow the old scope rules.
          {
            targets: { none: {} },
            OR: [
              { scope: "ALL_SELLERS" },
              { scope: "CATEGORY_SELLERS", categoryId: req.user.categoryId || "__none__" },
            ],
          },
        ],
      },
      include: { category: true, buyer: { select: { id: true, fullName: true, avatarUrl: true } }, accepted: true, review: true },
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

    // If this request was targeted to sellers, ensure the current seller was one of them.
    try {
      const targetsCount = await prisma.requestTarget.count({ where: { requestId } });
      if (targetsCount > 0) {
        const t = await prisma.requestTarget.findUnique({
          where: { requestId_sellerId: { requestId, sellerId: req.user.id } },
          select: { requestId: true },
        });
        if (!t) return res.status(403).json({ error: "Bu sorğu sizə göndərilməyib" });
      }
    } catch {}

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

  // Buyer completes a request and leaves a review for the seller
  r.post("/:id/complete", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (req.user.role !== "BUYER") return res.status(403).json({ error: "Only buyers" });

    const requestId = req.params.id;

    const schema = z.object({
      rating: z.coerce.number().int().min(1).max(5),
      comment: z.string().trim().max(500).optional().or(z.literal("")),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const row = await prisma.request.findUnique({
      where: { id: requestId },
      include: { accepted: true, review: true, buyer: { select: { id: true, fullName: true } } },
    });
    if (!row) return res.status(404).json({ error: "Not found" });
    if (row.buyerId !== req.user.id) return res.status(403).json({ error: "Forbidden" });
    if (!row.accepted) return res.status(409).json({ error: "Sorğu hələ qəbul edilməyib" });
    if (row.completedAt || row.review) return res.status(409).json({ error: "Sorğu artıq tamamlanıb" });

    const sellerId = row.accepted.sellerId;
    const rating = parsed.data.rating;
    const comment = (parsed.data.comment || "").trim() || null;

    const result = await prisma.$transaction(async (tx) => {
      const updatedReq = await tx.request.update({
        where: { id: requestId },
        data: { completedAt: new Date() },
      });
      const review = await tx.sellerReview.create({
        data: {
          requestId,
          buyerId: req.user!.id,
          sellerId,
          rating,
          comment,
        },
      });
      return { updatedReq, review };
    });

    // Notify seller (in-app) + push
    const notif = await prisma.notification.create({
      data: {
        userId: sellerId,
        title: "Sorğu tamamlandı",
        body: `${row.buyer?.fullName || "Alıcı"} sorğunu tamamladı və sizə ${rating}/5 qiymət verdi`,
        type: "REQUEST_COMPLETED",
        data: { requestId, rating },
      },
    });

    try {
      const seller = await prisma.user.findUnique({
        where: { id: sellerId },
        select: { expoPushToken: true, pushEnabled: true, pushSoundEnabled: true, pushSound: true },
      });
      const pushEnabled = seller?.pushEnabled !== false && !!seller?.expoPushToken;
      if (pushEnabled) {
        const channelId =
          !seller!.pushSoundEnabled
            ? "silent"
            : seller!.pushSound === "CHIME"
              ? "sound_chime"
              : seller!.pushSound === "DING"
                ? "sound_ding"
                : seller!.pushSound === "POP"
                  ? "sound_pop"
                  : "default";
        const sound =
          !seller!.pushSoundEnabled
            ? null
            : seller!.pushSound === "CHIME"
              ? "chime.wav"
              : seller!.pushSound === "DING"
                ? "ding.wav"
                : seller!.pushSound === "POP"
                  ? "pop.wav"
                  : "default";
        await sendExpoPush(
          seller!.expoPushToken,
          notif.title,
          notif.body,
          { type: "REQUEST_COMPLETED", requestId, rating },
          { sound, channelId }
        );
      }
    } catch {}

    const io = req.app.get("io");
    if (io) {
      io.to(`user:${sellerId}`).emit("new_notification", notif);
      io.to(`user:${sellerId}`).emit("request_completed", { requestId, rating });
      io.to(`user:${row.buyerId}`).emit("request_completed", { requestId, rating });
    }

    return res.json({ ok: true, request: result.updatedReq, review: result.review });
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
        review: true,
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
