"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.categoriesRouter = categoriesRouter;
const express_1 = require("express");
function categoriesRouter(prisma) {
    const r = (0, express_1.Router)();
    r.get("/", async (_req, res) => {
        const categories = await prisma.category.findMany({ orderBy: { name: "asc" } });
        res.json(categories);
    });
    return r;
}
