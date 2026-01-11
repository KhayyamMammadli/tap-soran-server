"use strict";
/**
 * Chat safety moderation utilities.
 * Deterministic (no external AI) server-side checks.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkChatSafety = checkChatSafety;
exports.humanizeSafetyReason = humanizeSafetyReason;
const DRUG_KEYWORDS = [
    // AZ/TR/RU/EN common keywords (non-exhaustive)
    "narkotik",
    "narko",
    "ot",
    "weed",
    "hash",
    "haş",
    "koka",
    "kokain",
    "cocaine",
    "heroin",
    "met",
    "meth",
    "mdma",
    "ekstazi",
    "ecstasy",
    "şüşə",
    "shisha", // often abused as code word
    "tiryək",
];
const TRADE_KEYWORDS = [
    "satiram",
    "satıram",
    "aliram",
    "alıram",
    "verirem",
    "verərəm",
    "qiymet",
    "qiymət",
    "nece",
    "neçə",
    "gram",
    "qram",
    "mg",
    "kq",
    "kg",
    "paket",
    "çatdır",
    "catdir",
    "kuryer",
    "dostavka",
    "delivery",
];
const CONTACT_KEYWORDS = [
    "telegram",
    "whatsapp",
    "watsap",
    "insta",
    "instagram",
    "snap",
    "snapchat",
    "tiktok",
    "zeng",
    "zəng",
    "nomre",
    "nömrə",
    "nomreni",
    "nömrəni",
];
const URL_RE = /(https?:\/\/|www\.)/i;
const TG_RE = /(t\.me\/|telegram\.me\/)/i;
const WA_RE = /(wa\.me\/|chat\.whatsapp\.com\/)/i;
// Azerbaijan phone patterns (best-effort, catches spaced variants)
const PHONE_RE = /(?:\+?994\s?)?(?:\(\s?0\s?\))?\s?(?:50|51|55|70|77|99)\s?\d{3}\s?\d{2}\s?\d{2}/;
function norm(s) {
    return String(s || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}
function hasAny(text, words) {
    for (const w of words) {
        if (text.includes(w))
            return true;
    }
    return false;
}
function checkChatSafety(text) {
    const t = norm(text);
    if (!t)
        return { ok: true };
    // External links
    if (URL_RE.test(t) || TG_RE.test(t) || WA_RE.test(t)) {
        return { ok: false, code: "EXTERNAL_LINK", evidence: "link" };
    }
    // Phone number
    if (PHONE_RE.test(text)) {
        return { ok: false, code: "CONTACT_INFO", evidence: "phone" };
    }
    // Contact redirect keywords
    if (hasAny(t, CONTACT_KEYWORDS)) {
        return { ok: false, code: "CONTACT_INFO", evidence: "contact_kw" };
    }
    // Drug trade: drug keyword + trade intent keyword (strong signal)
    const hasDrug = hasAny(t, DRUG_KEYWORDS);
    const hasTrade = hasAny(t, TRADE_KEYWORDS);
    if (hasDrug && hasTrade) {
        return { ok: false, code: "DRUG_TRADE", evidence: "drug+trade" };
    }
    // Suspicious trade phrases (price/gram etc) even without explicit drug mention
    if (hasTrade && (t.includes("gram") || t.includes("qram") || t.includes("mg") || t.includes("qiym") || t.includes("₼") || t.includes("azn") || t.includes("manat"))) {
        return { ok: false, code: "SUSPICIOUS_TRADE", evidence: "trade_like" };
    }
    return { ok: true };
}
function humanizeSafetyReason(code) {
    switch (code) {
        case "DRUG_TRADE":
            return "Qanunsuz maddə alqı-satqısı";
        case "CONTACT_INFO":
            return "Əlaqə məlumatı paylaşımı";
        case "EXTERNAL_LINK":
            return "Xarici link paylaşımı";
        case "SUSPICIOUS_TRADE":
            return "Şübhəli alqı-satqı məzmunu";
        default:
            return "Qadağan olunmuş məzmun";
    }
}
