import { PrismaClient, RequestScope } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import { sendExpoPush } from "../utils/push";

const upload = multer({ dest: process.env.UPLOAD_DIR || "uploads" });

export function requestsRouter(prisma: PrismaClient) {
  const r = Router();

  // Buyer creates request (title + category + scope + optional image)
  r.post("/", upload.single("image"), async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (req.user.role !== "BUYER") return res.status(403).json({ error: "Only buyers can create requests" });

    const schema = z.object({
      title: z.string().min(2),
      categoryId: z.string(),
      scope: z.enum(["ALL_SELLERS", "CATEGORY_SELLERS"]),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const imageUrl = (req as any).file ? `/uploads/${(req as any).file.filename}` : null;

    const request = await prisma.request.create({
      data: {
        title: parsed.data.title,
        categoryId: parsed.data.categoryId,
        scope: parsed.data.scope as RequestScope,
        imageUrl,
        buyerId: req.user.id,
      },
      include: { category: true, buyer: { select: { id: true, fullName: true } } },
    });

    // socket notification
    const io = req.app.get("io");
    if (io) {
      if (request.scope === "ALL_SELLERS") {
        io.to("sellers:all").emit("new_request", request);
      } else {
        io.to(`sellers:cat:${request.categoryId}`).emit("new_request", request);
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
      include: { category: true, buyer: { select: { id: true, fullName: true } }, accepted: true },
      orderBy: { createdAt: "desc" },
      take,
      skip,
    });

    res.json(requests);
  });

  // Seller accepts request -> creates conversation
  r.post("/:id/accept", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (req.user.role !== "SELLER") return res.status(403).json({ error: "Only sellers can accept" });

    const requestId = req.params.id;

    const reqRow = await prisma.request.findUnique({
      where: { id: requestId },
      include: { accepted: true },
    });
    if (!reqRow) return res.status(404).json({ error: "Not found" });
    if (reqRow.accepted) return res.status(409).json({ error: "Already accepted" });

    const accepted = await prisma.acceptedRequest.create({
      data: {
        requestId,
        sellerId: req.user.id,
        conversation: {
          create: {
            userAId: reqRow.buyerId,
            userBId: req.user.id,
          },
        },
      },
      include: { conversation: true, request: true },
    });

    // Create notification for buyer (in-app) + push
    const notif = await prisma.notification.create({
      data: {
        userId: reqRow.buyerId,
        title: "Sorğunuz qəbul edildi",
        body: `${req.user.fullName} sorğunuzu qəbul etdi: ${reqRow.title}`,
        type: "REQUEST_ACCEPTED",
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
      await sendExpoPush(buyer!.expoPushToken, notif.title, notif.body, {
type: "REQUEST_ACCEPTED",
      requestId,
      conversationId: accepted.conversation?.id,
      }, { sound, channelId });
    }
// Notify buyer
    const io = req.app.get("io");
    if (io) {
      io.to(`user:${reqRow.buyerId}`).emit("request_accepted", accepted);
      io.to(`user:${reqRow.buyerId}`).emit("new_notification", notif);
    }

    res.json(accepted);
  });

  return r;
}
