"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestsRouter = requestsRouter;
const express_1 = require("express");
const zod_1 = require("zod");
const multer_1 = __importDefault(require("multer"));
const upload = (0, multer_1.default)({ dest: process.env.UPLOAD_DIR || "uploads" });
function requestsRouter(prisma) {
    const r = (0, express_1.Router)();
    // Buyer creates request (title + category + scope + optional image)
    r.post("/", upload.single("image"), async (req, res) => {
        if (!req.user)
            return res.status(401).json({ error: "Unauthorized" });
        if (req.user.role !== "BUYER")
            return res.status(403).json({ error: "Only buyers can create requests" });
        const schema = zod_1.z.object({
            title: zod_1.z.string().min(2),
            categoryId: zod_1.z.string(),
            scope: zod_1.z.enum(["ALL_SELLERS", "CATEGORY_SELLERS"]),
        });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ error: parsed.error.flatten() });
        const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
        const request = await prisma.request.create({
            data: {
                title: parsed.data.title,
                categoryId: parsed.data.categoryId,
                scope: parsed.data.scope,
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
            }
            else {
                io.to(`sellers:cat:${request.categoryId}`).emit("new_request", request);
            }
        }
        res.json(request);
    });
    // Seller gets relevant requests feed
    r.get("/feed", async (req, res) => {
        if (!req.user)
            return res.status(401).json({ error: "Unauthorized" });
        if (req.user.role !== "SELLER")
            return res.status(403).json({ error: "Only sellers" });
        // Pagination (lazy load)
        const takeRaw = Array.isArray(req.query.take) ? req.query.take[0] : req.query.take;
        const skipRaw = Array.isArray(req.query.skip) ? req.query.skip[0] : req.query.skip;
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
        if (!req.user)
            return res.status(401).json({ error: "Unauthorized" });
        if (req.user.role !== "SELLER")
            return res.status(403).json({ error: "Only sellers can accept" });
        const requestId = req.params.id;
        const reqRow = await prisma.request.findUnique({
            where: { id: requestId },
            include: { accepted: true },
        });
        if (!reqRow)
            return res.status(404).json({ error: "Not found" });
        if (reqRow.accepted)
            return res.status(409).json({ error: "Already accepted" });
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
        // Notify buyer
        const io = req.app.get("io");
        if (io) {
            io.to(`user:${reqRow.buyerId}`).emit("request_accepted", accepted);
        }
        res.json(accepted);
    });
    return r;
}
