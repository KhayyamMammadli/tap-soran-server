"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendExpoPush = sendExpoPush;
exports.clip = clip;
function looksLikeExpoToken(token) {
    // Very lightweight validation. Expo tokens typically look like:
    // ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]
    // or sometimes ExpoPushToken[...]
    return token.startsWith("ExponentPushToken[") || token.startsWith("ExpoPushToken[");
}
async function sendExpoPush(to, title, body, data, opts) {
    if (!to)
        return;
    if (!looksLikeExpoToken(to))
        return;
    const msg = {
        to,
        title,
        body,
        sound: opts?.sound ?? undefined,
        channelId: opts?.channelId,
        data,
    };
    try {
        const r = await fetch("https://exp.host/--/api/v2/push/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(msg),
        });
        // Expo returns JSON; we only log on errors.
        if (!r.ok) {
            const txt = await r.text().catch(() => "");
            console.error("Expo push failed", r.status, txt);
        }
    }
    catch (e) {
        console.error("Expo push error", e);
    }
}
function clip(text, max = 120) {
    const t = String(text || "").trim();
    if (t.length <= max)
        return t;
    return t.slice(0, max - 1) + "…";
}
