import { MessageType, PrismaClient } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import path from "path";
import fs from "fs";
import { clip, sendExpoPush } from "../utils/push";
import { censorAzVulgar, hasAzVulgar } from "../utils/moderation";

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

export function conversationsRouter(prisma: PrismaClient) {
  const r = Router();

  // Upload setup for chat media (images/audio)
  const uploadRoot = process.env.UPLOAD_DIR || "uploads";
  const chatRoot = path.join(uploadRoot, "chat");
  const imgDir = path.join(chatRoot, "images");
  const audioDir = path.join(chatRoot, "audio");
  ensureDir(imgDir);
  ensureDir(audioDir);

  const chatUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, file, cb) => {
        if (file.fieldname === "image") return cb(null, imgDir);
        if (file.fieldname === "audio") return cb(null, audioDir);
        return cb(null, chatRoot);
      },
      filename: (req, file, cb) => {
        const ext = (path.extname(file.originalname) || "").toLowerCase();
        const safeExt = ext && ext.length <= 10 ? ext : "";
        const rand = Math.random().toString(16).slice(2);
        cb(null, `${req.user!.id}-${Date.now()}-${rand}${safeExt}`);
      },
    }),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
    fileFilter: (_req, file, cb) => {
      if (file.fieldname === "image") {
        if (!file.mimetype.startsWith("image/")) return cb(new Error("Only image files allowed"));
      }
      if (file.fieldname === "audio") {
        if (!file.mimetype.startsWith("audio/")) return cb(new Error("Only audio files allowed"));
      }
      cb(null, true);
    },
  });

  // List conversations (for current user) with request preview if exists
  r.get("/", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const convs = await prisma.conversation.findMany({
      where: { OR: [{ userAId: req.user.id }, { userBId: req.user.id }] },
      orderBy: { createdAt: "desc" },
      include: {
        userA: { select: { id: true, fullName: true, role: true, avatarUrl: true } },
        userB: { select: { id: true, fullName: true, role: true, avatarUrl: true } },
        acceptedRequest: {
          include: {
            request: { include: { category: true, buyer: { select: { id: true, fullName: true, avatarUrl: true } } } },
            seller: { select: { id: true, fullName: true, avatarUrl: true } },
          },
        },
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });

    res.json(convs);
  });

  // Conversation details (for showing request image/title in Chat)
  r.get("/:id", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const id = req.params.id;

    const conv = await prisma.conversation.findUnique({
      where: { id },
      include: {
        userA: { select: { id: true, fullName: true, role: true, avatarUrl: true } },
        userB: { select: { id: true, fullName: true, role: true, avatarUrl: true } },
        acceptedRequest: {
          include: {
            request: {
              include: {
                category: true,
                buyer: { select: { id: true, fullName: true, avatarUrl: true } },
              },
            },
            seller: { select: { id: true, fullName: true, avatarUrl: true } },
          },
        },
      },
    });

    if (!conv) return res.status(404).json({ error: "Not found" });
    if (conv.userAId !== req.user.id && conv.userBId !== req.user.id) return res.status(403).json({ error: "Forbidden" });

    res.json(conv);
  });

  // Get messages
  r.get("/:id/messages", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const id = req.params.id;

    const conv = await prisma.conversation.findUnique({ where: { id } });
    if (!conv) return res.status(404).json({ error: "Not found" });
    if (conv.userAId !== req.user.id && conv.userBId !== req.user.id) return res.status(403).json({ error: "Forbidden" });

    const msgs = await prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: "asc" },
      take: 500,
    });

    res.json(msgs);
  });

  // Send message (text OR image OR audio)
  r.post(
    "/:id/messages",
    chatUpload.fields([
      { name: "image", maxCount: 1 },
      { name: "audio", maxCount: 1 },
    ]),
    async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const id = req.params.id;

      const conv = await prisma.conversation.findUnique({ where: { id } });
      if (!conv) return res.status(404).json({ error: "Not found" });
      if (conv.userAId !== req.user.id && conv.userBId !== req.user.id) return res.status(403).json({ error: "Forbidden" });

      const files = (req.files || {}) as Record<string, Express.Multer.File[]>;
      const img = files.image?.[0];
      const aud = files.audio?.[0];

      const textRaw = typeof req.body?.text === "string" ? req.body.text : "";
      const text = textRaw.trim();

      let type: MessageType = MessageType.TEXT;
      let mediaUrl: string | null = null;
      let mediaMime: string | null = null;
      let mediaDuration: number | null = null;
      let finalText: string | null = null;

      // Vulgarity moderation (server-side). We store a masked version of the text.
      // Client-side checks can be bypassed, so server enforcement is required.
      let vulgarDetected = false;
      let vulgarOriginal: string | null = null;

      if (img) {
        type = MessageType.IMAGE;
        mediaUrl = `/uploads/chat/images/${img.filename}`;
        mediaMime = img.mimetype || null;
        finalText = text || null; // optional caption
      } else if (aud) {
        type = MessageType.AUDIO;
        mediaUrl = `/uploads/chat/audio/${aud.filename}`;
        mediaMime = aud.mimetype || null;
        const durRaw = typeof req.body?.duration === "string" ? req.body.duration : undefined;
        const dur = durRaw ? Number(durRaw) : NaN;
        mediaDuration = Number.isFinite(dur) && dur > 0 ? Math.floor(dur) : null;
        finalText = text || null;
      } else {
        // Plain text
        const schema = z.object({ text: z.string().min(1) });
        const parsed = schema.safeParse({ text });
        if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
        type = MessageType.TEXT;
        finalText = text;
      }

      // Apply server-side profanity masking for any user-provided text
      // (plain text messages and optional captions).
      if (finalText && hasAzVulgar(finalText)) {
        vulgarDetected = true;
        vulgarOriginal = finalText;
        finalText = censorAzVulgar(finalText);
      }

      const msg = await prisma.message.create({
        data: {
          conversationId: id,
          senderId: req.user.id,
          type,
          text: finalText,
          mediaUrl,
          mediaMime,
          mediaDuration,
        },
      });

      // If we detected vulgarity, create a SYSTEM warning message in the chat
      // and notify SUPER_ADMIN users.
      let systemMsg: any = null;
      const adminNotifs: Array<{ adminId: string; notif: any }> = [];
      if (vulgarDetected) {
        systemMsg = await prisma.message.create({
          data: {
            conversationId: id,
            senderId: req.user.id,
            type: MessageType.SYSTEM,
            text: "⚠️ Vulqar ifadə aşkarlandı. Davam etsəniz hesabınız blok olunacaq.",
          },
        });

        const admins = await prisma.user.findMany({
          where: { role: "SUPER_ADMIN" },
          select: { id: true },
        });

        const offendingPreview = clip(censorAzVulgar(vulgarOriginal || ""));
        for (const a of admins) {
          const n = await prisma.notification.create({
            data: {
              userId: a.id,
              title: "Vulqar söz aşkarlandı",
              body: clip(`${req.user.fullName}: ${offendingPreview}`),
              type: "ADMIN_VULGAR",
            },
          });
          adminNotifs.push({ adminId: a.id, notif: n });
        }
      }

      // Determine receiver
      const receiverId = conv.userAId === req.user.id ? conv.userBId : conv.userAId;

      // Create notification for receiver (in-app) + push
      const preview =
        type === MessageType.TEXT
          ? clip(finalText || "")
          : type === MessageType.IMAGE
            ? "📷 Şəkil"
            : type === MessageType.AUDIO
              ? "🎤 Səs mesajı"
              : "Yeni mesaj";

      const notif = await prisma.notification.create({
        data: {
          userId: receiverId,
          title: "Yeni mesaj",
          body: clip(`${req.user.fullName}: ${preview}`),
          type: "MESSAGE",
        },
      });

      const receiver = await prisma.user.findUnique({
        where: { id: receiverId },
        select: { expoPushToken: true, pushEnabled: true, pushSoundEnabled: true, pushSound: true },
      });

      const pushEnabled = receiver?.pushEnabled !== false && !!receiver?.expoPushToken;
      if (pushEnabled) {
        const channelId =
          !receiver!.pushSoundEnabled
            ? "silent"
            : receiver!.pushSound === "CHIME"
              ? "sound_chime"
              : receiver!.pushSound === "DING"
                ? "sound_ding"
                : receiver!.pushSound === "POP"
                  ? "sound_pop"
                  : "default";
        const sound =
          !receiver!.pushSoundEnabled
            ? null
            : receiver!.pushSound === "CHIME"
              ? "chime.wav"
              : receiver!.pushSound === "DING"
                ? "ding.wav"
                : receiver!.pushSound === "POP"
                  ? "pop.wav"
                  : "default";
        await sendExpoPush(
          receiver!.expoPushToken,
          notif.title,
          notif.body,
          {
            type: "MESSAGE",
            conversationId: id,
            senderId: req.user.id,
          },
          { sound, channelId }
        );
      }

      const io = req.app.get("io");
      if (io) {
        io.to(`user:${conv.userAId}`).to(`user:${conv.userBId}`).emit("new_message", msg);
        if (systemMsg) {
          io.to(`user:${conv.userAId}`).to(`user:${conv.userBId}`).emit("new_message", systemMsg);
        }
        io.to(`user:${receiverId}`).emit("new_notification", notif);

        for (const a of adminNotifs) {
          io.to(`user:${a.adminId}`).emit("new_notification", a.notif);
        }
      }

      res.json(msg);
    }
  );

  return r;
}
