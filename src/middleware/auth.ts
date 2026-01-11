import { PrismaClient } from "@prisma/client";
import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/jwt";

export function authMiddleware(prisma: PrismaClient, opts?: { allowBlocked?: boolean }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });

      const token = header.slice(7);
      const payload = verifyToken(token);
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: {
          id: true,
          role: true,
          fullName: true,
          email: true,
          tip: true,
          tokenVersion: true,
          blocked: true,
          blockedReason: true,
          blockedAt: true,
          blockedUntil: true,
          category: { select: { id: true } },
          sellerCategories: { select: { categoryId: true } },
        },
      });
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      // Force-logout support: if tokenVersion changed, the token is invalid.
      const tv = typeof (payload as any).tv === "number" ? (payload as any).tv : 0;
      if ((user as any).tokenVersion !== tv) {
        return res.status(401).json({ error: "Unauthorized", code: "SESSION_EXPIRED" });
      }

      // Block enforcement:
      // - If blockedUntil is in the past => auto-unblock (best effort).
      // - If blockedAt is within the last 60 seconds => allow (grace window so the user can see the notice).
      // - Otherwise => block.
      if (!opts?.allowBlocked && (user as any).blocked) {
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
          if (!grace) {
            return res.status(403).json({
              error: "Blocked",
              reason: (user as any).blockedReason,
              blockedAt: (user as any).blockedAt,
              blockedUntil: (user as any).blockedUntil,
            });
          }
        }
      }

      req.user = {
        id: user.id,
        role: user.role,
        fullName: user.fullName,
        email: user.email,
        tip: user.tip,
        categoryId: user.category?.id ?? null,
        categoryIds: Array.isArray((user as any).sellerCategories)
          ? (user as any).sellerCategories.map((x: any) => x.categoryId)
          : (user as any).category?.id
            ? [(user as any).category.id]
            : [],
      };

      next();
    } catch {
      return res.status(401).json({ error: "Unauthorized" });
    }
  };
}
