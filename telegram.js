// Thin Telegram Bot API client with long polling. No dependencies.

export class Telegram {
  constructor(token) {
    this.base = `https://api.telegram.org/bot${token}/`;
    this.offset = 0;
    this.running = false;
  }

  async api(method, params = {}) {
    const res = await fetch(this.base + method, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(65_000),
    });
    const body = await res.json();
    if (!body.ok) {
      const err = new Error(`Telegram ${method}: ${body.description}`);
      err.code = body.error_code;
      throw err;
    }
    return body.result;
  }

  send(chatId, text, extra = {}) {
    return this.api("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  }

  /** Calls `onUpdate` for every incoming update until stop() is called. */
  async poll(onUpdate) {
    this.running = true;
    while (this.running) {
      try {
        const updates = await this.api("getUpdates", {
          offset: this.offset,
          timeout: 50,
          allowed_updates: ["message", "callback_query"],
        });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          try {
            await onUpdate(u);
          } catch (e) {
            console.error("handler error:", e);
          }
        }
      } catch (e) {
        console.error("poll error:", e.message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  stop() {
    this.running = false;
  }
}
