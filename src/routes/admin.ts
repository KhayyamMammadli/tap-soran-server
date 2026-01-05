import { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";

export function adminRouter(prisma: PrismaClient) {
  const r = Router();

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
        blockedById: req.user!.id,
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
