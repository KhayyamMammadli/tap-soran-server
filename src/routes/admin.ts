import { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { sendExpoPush } from "../utils/push";
import { sendMail } from "../utils/mail";

export function adminRouter(prisma: PrismaClient) {
  const r = Router();

  async function deleteRequestCascade(requestId: string) {
    await prisma.$transaction(async (tx) => {
      const reqRow = await tx.request.findUnique({
        where: { id: requestId },
        select: { id: true, accepted: { select: { id: true } } },
      });
      if (!reqRow) return;

      if (reqRow.accepted?.id) {
        const conv = await tx.conversation.findFirst({
          where: { acceptedRequestId: reqRow.accepted.id },
          select: { id: true },
        });

        if (conv?.id) {
          // Must delete reports first (FKs to message + conversation)
          await tx.messageReport.deleteMany({ where: { conversationId: conv.id } });
          await tx.message.deleteMany({ where: { conversationId: conv.id } });
          await tx.conversation.deleteMany({ where: { id: conv.id } });
        }

        await tx.acceptedRequest.deleteMany({ where: { id: reqRow.accepted.id } });
      }

      await tx.request.deleteMany({ where: { id: requestId } });
    });
  }

  // Legal pages (Privacy Policy / Terms) editable from admin.
  const legalType = z.enum(["PRIVACY", "TERMS"]);
  r.get("/legal/:type", async (req, res) => {
    const parsed = legalType.safeParse(String(req.params.type || "").toUpperCase());
    if (!parsed.success) return res.status(400).json({ error: "Invalid type" });

    const page = await prisma.legalPage.findUnique({ where: { type: parsed.data as any } });
    return res.json(page);
  });

  const legalUpdateSchema = z.object({ title: z.string().min(2).max(200), content: z.string().min(10) });
  r.put("/legal/:type", async (req, res) => {
    const parsedType = legalType.safeParse(String(req.params.type || "").toUpperCase());
    if (!parsedType.success) return res.status(400).json({ error: "Invalid type" });

    const body = legalUpdateSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.flatten() });

    const updated = await prisma.legalPage.upsert({
      where: { type: parsedType.data as any },
      create: {
        type: parsedType.data as any,
        title: body.data.title,
        content: body.data.content,
        updatedById: req.user!.id,
      },
      update: {
        title: body.data.title,
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
        blockedUntil: true,
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

  // Complaints (general user complaints, not tied to chat)
  r.get("/complaints", async (req, res) => {
    const status = String(req.query.status || "OPEN").toUpperCase();
    const rows = await prisma.userComplaint.findMany({
      where: status === "ALL" ? {} : { status: status as any },
      orderBy: { createdAt: "desc" },
      include: {
        reporter: { select: { id: true, fullName: true, email: true } },
        targetUser: { select: { id: true, fullName: true, email: true, reportCount: true, blocked: true } },
        request: { select: { id: true, title: true } },
      },
      take: 500,
    });
    return res.json(rows);
  });

  const complaintStatusSchema = z.object({ status: z.enum(["OPEN", "RESOLVED", "DISMISSED"]) });
  r.patch("/complaints/:id/status", async (req, res) => {
    const parsed = complaintStatusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      const updated = await prisma.userComplaint.update({ where: { id: req.params.id }, data: { status: parsed.data.status as any } });
      return res.json(updated);
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || "Update failed" });
    }
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
        createdAt: true,
        blocked: true,
        blockedReason: true,
        blockedAt: true,
        blockedUntil: true,
        blockedById: true,
        category: { select: { id: true, name: true } },
      },
    });

    // Keep backward-compatible shape for clients that expect `categoryId`.
    return res.json(
      users.map((u) => ({
        ...u,
        categoryId: u.category?.id ?? null,
      }))
    );
  });

  const blockSchema = z.object({ reason: z.string().min(3) });

  const blockWithUntilSchema = z.object({
    reason: z.string().min(3).max(500),
    blockedUntil: z.string().datetime().optional().or(z.literal("")),
  });

  // Block a user (optionally until a specific date/time).
  // Note: we do NOT force-invalidate the token immediately. Instead, the app will log out ~1 minute later.
  // The API enforces a 60s grace window (auth middleware) so the user can see the notice.
  r.patch("/users/:id/block", async (req, res) => {
    const parsed = blockWithUntilSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const targetId = req.params.id;
    if (targetId === req.user!.id) return res.status(400).json({ error: "You can't block yourself" });

    const until = parsed.data.blockedUntil ? new Date(parsed.data.blockedUntil) : null;

    const user = await prisma.user.update({
      where: { id: targetId },
      data: {
        blocked: true,
        blockedReason: parsed.data.reason,
        blockedAt: new Date(),
        blockedUntil: until,
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
        blockedUntil: true,
        blockedById: true,
      },
    });

    const blockedUntilText = until ? `\nBlok müddəti: ${until.toLocaleString()}` : "";
    const notif = await prisma.notification.create({
      data: {
        userId: targetId,
        title: "Hesab bloklandı",
        body: `Səbəb: ${parsed.data.reason}${blockedUntilText}`,
        type: "ACCOUNT_BLOCKED",
        data: {
          reason: parsed.data.reason,
          blockedAt: user.blockedAt?.toISOString?.() ?? new Date().toISOString(),
          blockedUntil: until ? until.toISOString() : null,
        },
      },
    });

    // Push + socket notify (best-effort)
    try {
      const u = await prisma.user.findUnique({
        where: { id: targetId },
        select: {
          expoPushToken: true,
          pushEnabled: true,
          pushSoundEnabled: true,
          pushSound: true,
          email: true,
          fullName: true,
        },
      });
      if (u?.pushEnabled) {
        await sendExpoPush(
          u.expoPushToken,
          "Hesab bloklandı",
          `Səbəb: ${parsed.data.reason}`,
          {
            type: "ACCOUNT_BLOCKED",
            reason: parsed.data.reason,
            blockedUntil: until ? until.toISOString() : null,
          },
          { sound: u.pushSoundEnabled ? (u.pushSound === "DEFAULT" ? undefined : String(u.pushSound).toLowerCase()) : null }
        );
      }

      if (u?.email) {
        await sendMail({
          to: u.email,
          subject: "Tap-Soran • Hesab bloklandı",
          text: `Salam ${u.fullName || ""}!\n\nHesabınız admin tərəfindən bloklandı.\nSəbəb: ${parsed.data.reason}${blockedUntilText}\n\nƏgər bunun səhv olduğunu düşünürsünüzsə, dəstək ilə əlaqə saxlayın.`,
        });
      }
    } catch {}

    try {
      const io = req.app.get("io");
      io?.to?.(`user:${targetId}`)?.emit?.("accountBlocked", {
        reason: parsed.data.reason,
        blockedAt: user.blockedAt?.toISOString?.() ?? new Date().toISOString(),
        blockedUntil: until ? until.toISOString() : null,
        notificationId: notif.id,
      });
      // Backward compatibility for older clients
      io?.to?.(`user:${targetId}`)?.emit?.("userBlocked", {
        reason: parsed.data.reason,
        blockedAt: user.blockedAt?.toISOString?.() ?? new Date().toISOString(),
        blockedUntil: until ? until.toISOString() : null,
      });
    } catch {}

    return res.json(user);
  });

  // Block the target user of a complaint with a note + until date.
  r.post("/complaints/:id/block", async (req, res) => {
    const parsed = blockWithUntilSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const complaint = await prisma.userComplaint.findUnique({
      where: { id: req.params.id },
      include: {
        reporter: { select: { id: true, fullName: true, email: true } },
        targetUser: { select: { id: true, fullName: true, email: true, blocked: true } },
        request: { select: { id: true, title: true } },
      },
    });
    if (!complaint) return res.status(404).json({ error: "Not found" });

    const targetId = complaint.targetUserId;
    if (targetId === req.user!.id) return res.status(400).json({ error: "You can't block yourself" });

    const until = parsed.data.blockedUntil ? new Date(parsed.data.blockedUntil) : null;

    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: targetId },
        data: {
          blocked: true,
          blockedReason: parsed.data.reason,
          blockedAt: new Date(),
          blockedUntil: until,
          blockedById: req.user!.id,
        },
        select: {
          id: true,
          fullName: true,
          email: true,
          blocked: true,
          blockedReason: true,
          blockedAt: true,
          blockedUntil: true,
        },
      });

      await tx.userComplaint.update({ where: { id: complaint.id }, data: { status: "RESOLVED" as any } });

      await tx.notification.create({
        data: {
          userId: targetId,
          title: "Hesab bloklandı",
          body: `Səbəb: ${parsed.data.reason}${until ? `\nBlok müddəti: ${until.toLocaleString()}` : ""}`,
          type: "ACCOUNT_BLOCKED",
          data: {
            type: "ACCOUNT_BLOCKED",
            reason: parsed.data.reason,
            blockedUntil: until ? until.toISOString() : null,
            complaintId: complaint.id,
            requestId: complaint.requestId ?? null,
          },
        },
      });

      return u;
    });

    // Push/email/socket best-effort (reuse the logic by calling the /users/:id/block handler in code)
    try {
      const u = await prisma.user.findUnique({
        where: { id: targetId },
        select: {
          expoPushToken: true,
          pushEnabled: true,
          pushSoundEnabled: true,
          pushSound: true,
          email: true,
          fullName: true,
        },
      });
      if (u?.pushEnabled) {
        await sendExpoPush(
          u.expoPushToken,
          "Hesab bloklandı",
          `Səbəb: ${parsed.data.reason}`,
          {
            type: "ACCOUNT_BLOCKED",
            reason: parsed.data.reason,
            blockedUntil: until ? until.toISOString() : null,
            complaintId: complaint.id,
          },
          { sound: u.pushSoundEnabled ? (u.pushSound === "DEFAULT" ? undefined : String(u.pushSound).toLowerCase()) : null }
        );
      }
      if (u?.email) {
        await sendMail({
          to: u.email,
          subject: "Tap-Soran • Hesab bloklandı",
          text: `Salam ${u.fullName || ""}!\n\nHesabınız admin tərəfindən bloklandı.\nSəbəb: ${parsed.data.reason}${until ? `\nBlok müddəti: ${until.toLocaleString()}` : ""}\n\nƏgər bunun səhv olduğunu düşünürsünüzsə, dəstək ilə əlaqə saxlayın.`,
        });
      }
    } catch {}

    try {
      const io = req.app.get("io");
      io?.to?.(`user:${targetId}`)?.emit?.("accountBlocked", {
        reason: parsed.data.reason,
        blockedAt: updated.blockedAt?.toISOString?.() ?? new Date().toISOString(),
        blockedUntil: until ? until.toISOString() : null,
        complaintId: complaint.id,
      });
      io?.to?.(`user:${targetId}`)?.emit?.("userBlocked", {
        reason: parsed.data.reason,
        blockedAt: updated.blockedAt?.toISOString?.() ?? new Date().toISOString(),
        blockedUntil: until ? until.toISOString() : null,
      });
    } catch {}

    return res.json({ ok: true, user: updated });
  });

  r.patch("/users/:id/unblock", async (req, res) => {
    const targetId = req.params.id;

    const user = await prisma.user.update({
      where: { id: targetId },
      data: {
        blocked: false,
        blockedReason: null,
        blockedAt: null,
        blockedUntil: null,
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
        blockedUntil: true,
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

  // Delete a single request (cascade)
  r.delete("/requests/:id", async (req, res) => {
    try {
      await deleteRequestCascade(req.params.id);
      return res.json({ ok: true });
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || "Request delete failed" });
    }
  });

  // Delete all requests (cascade)
  r.delete("/requests", async (_req, res) => {
    try {
      const ids = await prisma.request.findMany({ select: { id: true } });
      for (const row of ids) {
        await deleteRequestCascade(row.id);
      }
      return res.json({ ok: true, deleted: ids.length });
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || "Bulk delete failed" });
    }
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
