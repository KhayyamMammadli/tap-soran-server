"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanupOldRequests = cleanupOldRequests;
exports.startRequestRetentionJob = startRequestRetentionJob;
const DAYS_TO_KEEP = 28;
const MS_DAY = 24 * 60 * 60 * 1000;
async function cleanupOldRequests(prisma) {
    const cutoff = new Date(Date.now() - DAYS_TO_KEEP * MS_DAY);
    const old = await prisma.request.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
    });
    if (old.length === 0)
        return { deletedRequests: 0 };
    const requestIds = old.map((x) => x.id);
    // Find dependent rows we must delete explicitly (FKs are not guaranteed to cascade in existing DB)
    const accepted = await prisma.acceptedRequest.findMany({
        where: { requestId: { in: requestIds } },
        select: { id: true },
    });
    const acceptedIds = accepted.map((x) => x.id);
    const convs = acceptedIds.length
        ? await prisma.conversation.findMany({
            where: { acceptedRequestId: { in: acceptedIds } },
            select: { id: true },
        })
        : [];
    const conversationIds = convs.map((x) => x.id);
    await prisma.$transaction(async (tx) => {
        if (conversationIds.length) {
            // Message reports -> messages -> conversations
            await tx.messageReport.deleteMany({ where: { conversationId: { in: conversationIds } } });
            await tx.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
            await tx.conversation.deleteMany({ where: { id: { in: conversationIds } } });
        }
        if (acceptedIds.length) {
            await tx.acceptedRequest.deleteMany({ where: { id: { in: acceptedIds } } });
        }
        // Complaints that reference the request
        await tx.userComplaint.deleteMany({ where: { requestId: { in: requestIds } } });
        // Reviews
        await tx.sellerReview.deleteMany({ where: { requestId: { in: requestIds } } });
        await tx.request.deleteMany({ where: { id: { in: requestIds } } });
    });
    return { deletedRequests: requestIds.length };
}
function startRequestRetentionJob(prisma) {
    const run = async () => {
        try {
            const result = await cleanupOldRequests(prisma);
            if (result.deletedRequests > 0) {
                console.log(`🧹 Request retention: deleted ${result.deletedRequests} request(s) older than ${DAYS_TO_KEEP} days`);
            }
        }
        catch (e) {
            console.error("Request retention cleanup failed:", e);
        }
    };
    // Run once on startup and then daily.
    void run();
    setInterval(run, MS_DAY);
}
