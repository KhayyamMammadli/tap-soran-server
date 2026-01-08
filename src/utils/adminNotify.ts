import type { PrismaClient } from "@prisma/client";
import { clip } from "./push";
import { sendTelegram } from "./telegram";

export type AdminNotifyPayload = {
  title: string;
  body: string;
  type?: string | null;
  telegramText?: string;
};

/**
 * Fan-out a notification to ALL SUPER_ADMIN users.
 * Also mirrors the event to Telegram if configured.
 */
export async function notifyAdmins(prisma: PrismaClient, io: any, payload: AdminNotifyPayload) {
  const admins = await prisma.user.findMany({ where: { role: "SUPER_ADMIN" }, select: { id: true } });
  const created: any[] = [];

  for (const a of admins) {
    const n = await prisma.notification.create({
      data: {
        userId: a.id,
        title: payload.title,
        body: clip(payload.body || "").slice(0, 200),
        type: payload.type || null,
      },
    });
    created.push(n);
    try {
      io?.to?.(`user:${a.id}`)?.emit?.("new_notification", n);
    } catch {
      // ignore
    }
  }

  // Telegram mirror (best-effort)
  try {
    const tg = payload.telegramText || `${payload.title}\n${payload.body}`;
    void sendTelegram(tg);
  } catch {
    // ignore
  }

  return created;
}
