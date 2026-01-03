type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  sound?: "default";
  data?: Record<string, any>;
};

function looksLikeExpoToken(token: string) {
  // Very lightweight validation. Expo tokens typically look like:
  // ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]
  // or sometimes ExpoPushToken[...]
  return token.startsWith("ExponentPushToken[") || token.startsWith("ExpoPushToken[");
}

export async function sendExpoPush(to: string | null | undefined, title: string, body: string, data?: Record<string, any>) {
  if (!to) return;
  if (!looksLikeExpoToken(to)) return;

  const msg: ExpoPushMessage = {
    to,
    title,
    body,
    sound: "default",
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
  } catch (e) {
    console.error("Expo push error", e);
  }
}

export function clip(text: string, max = 120) {
  const t = String(text || "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}
