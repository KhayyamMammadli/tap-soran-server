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
      const user = await prisma.user.findUnique({ where: { id: payload.userId } });
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      if (!opts?.allowBlocked && (user as any).blocked) {
        return res.status(403).json({ error: "Blocked", reason: (user as any).blockedReason, blockedAt: (user as any).blockedAt });
      }

      req.user = {
        id: user.id,
        role: user.role,
        fullName: user.fullName,
        email: user.email,
        tip: user.tip,
        categoryId: user.categoryId,
      };

      next();
    } catch {
      return res.status(401).json({ error: "Unauthorized" });
    }
  };
}
