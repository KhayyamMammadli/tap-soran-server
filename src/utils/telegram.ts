/**
 * Send a Telegram message if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set.
 * Designed to NEVER crash the request path.
 */
export async function sendTelegram(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  // Keep messages short-ish for Telegram
  const safeText = String(text || "").slice(0, 3500);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000);

  try {
    const body = new URLSearchParams({
      chat_id: chatId,
      text: safeText,
      disable_web_page_preview: "true",
    });

    const init: any = {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      // @ts-ignore
      signal: controller.signal,
    };

    // Node 18+ has global fetch. If not available, just skip.
    // @ts-ignore
    if (typeof fetch !== "function") return;
    // @ts-ignore
    await fetch(url, init);
  } catch {
    // swallow
  } finally {
    clearTimeout(t);
  }
}
