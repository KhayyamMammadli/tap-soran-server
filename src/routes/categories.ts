import { PrismaClient } from "@prisma/client";
import { Router } from "express";

export function categoriesRouter(prisma: PrismaClient) {
  const r = Router();

  r.get("/", async (_req, res) => {
    const categories = await prisma.category.findMany({ orderBy: { name: "asc" } });
    res.json(categories);
  });

  return r;
}
