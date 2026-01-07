import { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";

export function adminRouter(prisma: PrismaClient) {
  const r = Router();

  // Legal pages (Privacy Policy / Terms) editable from admin.
  const legalType = z.enum(["PRIVACY", "TERMS"]);
  r.get("/legal/:type", async (req, res) => {
    const parsed = legalType.safeParse(String(req.params.type || "").toUpperCase());
    if (!parsed.success) return res.status(400).json({ error: "Invalid type" });

    const page = await prisma.legalPage.findUnique({ where: { type: parsed.data as any } });
    return res.json(page);
  });

  // NOTE: Admin UI might save content without touching the title (or send empty/whitespace).
  // Keep it robust by accepting an optional title and falling back to an existing/default one.
  const legalUpdateSchema = z.object({
    title: z.string().trim().max(200).optional(),
    content: z.string().min(10),
  });
  r.put("/legal/:type", async (req, res) => {
    const parsedType = legalType.safeParse(String(req.params.type || "").toUpperCase());
    if (!parsedType.success) return res.status(400).json({ error: "Invalid type" });

    const body = legalUpdateSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.flatten() });

    const existing = await prisma.legalPage.findUnique({ where: { type: parsedType.data as any } });
    const incomingTitle = (body.data.title || "").trim();
    const title =
      incomingTitle.length >= 2
        ? incomingTitle
        : existing?.title || (parsedType.data === "TERMS" ? "İstifadəçi qaydaları" : "Məxfilik siyasəti");

    const updated = await prisma.legalPage.upsert({
      where: { type: parsedType.data as any },
      create: {
        type: parsedType.data as any,
        title,
        content: body.data.content,
        updatedById: req.user!.id,
      },
      update: {
        title,
        content: body.data.content,
        updatedById: req.user!.id,
      },
    });

    return res.json(updated);
  });

  // Moderation / safety dashboard
  r.get("/risk-users", async (_req, res) => {
    const users = await prisma.user.findMany({
      orderBy: [{ reportCount: "desc" }, { moderationStrikes: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        role: true,
        fullName: true,
        email: true,
        blocked: true,
        blockedReason: true,
        blockedAt: true,
        reportCount: true,
        moderationStrikes: true,
        chatFrozenUntil: true,
        createdAt: true,
      },
      take: 200,
    });
    return res.json(users);
  });

  r.get("/reports", async (req, res) => {
    const status = String(req.query.status || "OPEN").toUpperCase();
    const rows = await prisma.messageReport.findMany({
      where: status === "ALL" ? {} : { status: status as any },
      orderBy: { createdAt: "desc" },
      include: {
        reporter: { select: { id: true, fullName: true, email: true } },
        targetUser: { select: { id: true, fullName: true, email: true, reportCount: true, blocked: true } },
        message: { select: { id: true, text: true, createdAt: true } },
        conversation: { select: { id: true } },
      },
      take: 500,
    });
    // Backward-compatible shape for older admin UI: expose `reportedUser` too.
    const normalized = rows.map((r: any) => ({ ...r, reportedUser: r.reportedUser ?? r.targetUser }));
    return res.json(normalized);
  });

  const reportStatusSchema = z.object({ status: z.enum(["OPEN", "RESOLVED", "DISMISSED"]) });
  r.patch("/reports/:id/status", async (req, res) => {
    const parsed = reportStatusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      const updated = await prisma.messageReport.update({ where: { id: req.params.id }, data: { status: parsed.data.status as any } });
      return res.json(updated);
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || "Update failed" });
    }
  });

  const freezeSchema = z.object({ hours: z.number().int().min(1).max(24 * 30), reason: z.string().min(3).max(200) });
  r.patch("/users/:id/freeze", async (req, res) => {
    const parsed = freezeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const targetId = req.params.id;
    const until = new Date(Date.now() + parsed.data.hours * 60 * 60 * 1000);
    const user = await prisma.user.update({ where: { id: targetId }, data: { chatFrozenUntil: until } });
    await prisma.notification.create({
      data: {
        userId: targetId,
        title: "Çat dayandırıldı",
        body: `Səbəb: ${parsed.data.reason}. ${parsed.data.hours} saat müddətinə mesaj yaza bilməzsiniz.`,
        type: "CHAT_FROZEN",
      },
    });
    try {
      const io = req.app.get("io");
      io?.to?.(`user:${targetId}`)?.emit?.("chatFrozen", { until: until.toISOString(), reason: parsed.data.reason });
    } catch {}
    return res.json(user);
  });

  r.patch("/users/:id/unfreeze", async (req, res) => {
    const targetId = req.params.id;
    const user = await prisma.user.update({ where: { id: targetId }, data: { chatFrozenUntil: null } });
    await prisma.notification.create({
      data: {
        userId: targetId,
        title: "Çat bərpa olundu",
        body: "Artıq mesaj yaza bilərsiniz.",
        type: "INFO",
      },
    });
    try {
      const io = req.app.get("io");
      io?.to?.(`user:${targetId}`)?.emit?.("chatUnfrozen", { unfreezeAt: new Date().toISOString() });
    } catch {}
    return res.json(user);
  });

  // Stats
  r.get("/stats", async (_req, res) => {
    const [users, categories, requests, conversations] = await Promise.all([
      prisma.user.count(),
      prisma.category.count(),
      prisma.request.count(),
      prisma.conversation.count(),
    ]);
    return res.json({ users, categories, requests, conversations });
  });

  // Users list
  r.get("/users", async (_req, res) => {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        role: true,
        fullName: true,
        email: true,
        tip: true,
        categoryId: true,
        createdAt: true,
        blocked: true,
        blockedReason: true,
        blockedAt: true,
        blockedById: true,
        category: { select: { id: true, name: true } },
      },
    });
    return res.json(users);
  });

  const blockSchema = z.object({ reason: z.string().min(3) });

  r.patch("/users/:id/block", async (req, res) => {
    const parsed = blockSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const targetId = req.params.id;
    if (targetId === req.user!.id) return res.status(400).json({ error: "You can't block yourself" });

    const user = await prisma.user.update({
      where: { id: targetId },
      data: {
        blocked: true,
        blockedReason: parsed.data.reason,
        blockedAt: new Date(),
        blockedById: req.user!.id,
        tokenVersion: { increment: 1 },
      },
      select: {
        id: true,
        role: true,
        fullName: true,
        email: true,
        blocked: true,
        blockedReason: true,
        blockedAt: true,
        blockedById: true,
      },
    });

    await prisma.notification.create({
      data: {
        userId: targetId,
        title: "Hesab bloklandı",
        body: `Səbəb: ${parsed.data.reason}`,
        type: "BLOCKED",
      },
    });

    // Kick the user out immediately (mobile/web)
    try {
      const io = req.app.get("io");
      io?.to?.(`user:${targetId}`)?.emit?.("userBlocked", {
        reason: parsed.data.reason,
        blockedAt: new Date().toISOString(),
      });
      io?.in?.(`user:${targetId}`)?.disconnectSockets?.(true);
    } catch {}

    return res.json(user);
  });

  r.patch("/users/:id/unblock", async (req, res) => {
    const targetId = req.params.id;

    const user = await prisma.user.update({
      where: { id: targetId },
      data: {
        blocked: false,
        blockedReason: null,
        blockedAt: null,
        blockedById: null,
      },
      select: {
        id: true,
        role: true,
        fullName: true,
        email: true,
        blocked: true,
        blockedReason: true,
        blockedAt: true,
        blockedById: true,
      },
    });

    await prisma.notification.create({
      data: {
        userId: targetId,
        title: "Hesab blokdan çıxarıldı",
        body: "Artıq tətbiqdən istifadə edə bilərsiniz.",
        type: "INFO",
      },
    });

    try {
      const io = req.app.get("io");
      io?.to?.(`user:${targetId}`)?.emit?.("userUnblocked", {
        unblockedAt: new Date().toISOString(),
      });
    } catch {}

    return res.json(user);
  });

  // Delete user (hard delete + cleanup dependent records)
  // Our Prisma schema does not define cascading deletes, so we must delete
  // dependent rows in the right order to avoid FK errors.
  r.delete("/users/:id", async (req, res) => {
    const targetId = req.params.id;

    if (targetId === req.user!.id) return res.status(400).json({ error: "You can't delete yourself" });

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, role: true, fullName: true, email: true },
    });

    if (!target) return res.status(404).json({ error: "Not found" });
    if (target.role === "SUPER_ADMIN") return res.status(400).json({ error: "Can't delete SUPER_ADMIN" });

    // Gather dependent ids first
    const [convs, buyerReqs] = await Promise.all([
      prisma.conversation.findMany({
        where: { OR: [{ userAId: targetId }, { userBId: targetId }] },
        select: { id: true },
      }),
      prisma.request.findMany({ where: { buyerId: targetId }, select: { id: true } }),
    ]);

    const convIds = convs.map((c) => c.id);
    const buyerReqIds = buyerReqs.map((r) => r.id);

    try {
      await prisma.$transaction([
        // Delete reports + moderation logs first to avoid FK violations.
        prisma.messageReport.deleteMany({
          where: {
            OR: [
              { reporterId: targetId },
              { targetUserId: targetId },
              ...(convIds.length ? [{ conversationId: { in: convIds } }] : []),
            ],
          },
        }),
        prisma.moderationEvent.deleteMany({ where: { userId: targetId } }),

        // Messages must be deleted before conversations
        ...(convIds.length
          ? [prisma.message.deleteMany({ where: { conversationId: { in: convIds } } })]
          : []),

        ...(convIds.length ? [prisma.conversation.deleteMany({ where: { id: { in: convIds } } })] : []),

        // Notifications are standalone
        prisma.notification.deleteMany({ where: { userId: targetId } }),

        // AcceptedRequests must be deleted before requests (for buyer) and before user (for seller)
        prisma.acceptedRequest.deleteMany({
          where: {
            OR: [
              { sellerId: targetId },
              ...(buyerReqIds.length ? [{ requestId: { in: buyerReqIds } }] : []),
            ],
          },
        }),

        // Buyer requests
        prisma.request.deleteMany({ where: { buyerId: targetId } }),

        // Finally, user
        prisma.user.delete({ where: { id: targetId } }),
      ]);

      return res.json({ ok: true });
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || "User delete failed" });
    }
  });

  // Categories CRUD
  r.get("/categories", async (_req, res) => {
    const categories = await prisma.category.findMany({ orderBy: { name: "asc" } });
    return res.json(categories);
  });

  const catSchema = z.object({ name: z.string().min(2) });

  r.post("/categories", async (req, res) => {
    const parsed = catSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      const created = await prisma.category.create({ data: { name: parsed.data.name } });
      return res.json(created);
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || "Category create failed" });
    }
  });

  r.put("/categories/:id", async (req, res) => {
    const parsed = catSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const updated = await prisma.category.update({
        where: { id: req.params.id },
        data: { name: parsed.data.name },
      });
      return res.json(updated);
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || "Category update failed" });
    }
  });

  r.delete("/categories/:id", async (req, res) => {
    try {
      await prisma.category.delete({ where: { id: req.params.id } });
      return res.json({ ok: true });
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || "Category delete failed" });
    }
  });

  // Requests list (all)
  r.get("/requests", async (_req, res) => {
    const rows = await prisma.request.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        category: true,
        buyer: { select: { id: true, fullName: true, email: true } },
        accepted: {
          include: {
            seller: { select: { id: true, fullName: true, email: true } },
            conversation: true,
          },
        },
      },
    });
    return res.json(rows);
  });

  // Conversations list (all)
  r.get("/conversations", async (_req, res) => {
    const rows = await prisma.conversation.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        userA: { select: { id: true, fullName: true, email: true, role: true, blocked: true } },
        userB: { select: { id: true, fullName: true, email: true, role: true, blocked: true } },
        acceptedRequest: {
          include: {
            request: { include: { category: true, buyer: { select: { id: true, fullName: true } } } },
            seller: { select: { id: true, fullName: true } },
          },
        },
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    return res.json(rows);
  });

  // Conversation messages
  r.get("/conversations/:id/messages", async (req, res) => {
    const conv = await prisma.conversation.findUnique({
      where: { id: req.params.id },
      include: {
        userA: { select: { id: true, fullName: true } },
        userB: { select: { id: true, fullName: true } },
        messages: {
          orderBy: { createdAt: "asc" },
          include: { sender: { select: { id: true, fullName: true } } },
        },
      },
    });

    if (!conv) return res.status(404).json({ error: "Not found" });
    return res.json(conv);
  });

  return r;
}
