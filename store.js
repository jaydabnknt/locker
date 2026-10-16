// Bot state: Telegram chat ids, the public wallet addresses users linked, and
// which unlock alerts were already sent. The bot never sees or stores private keys.
//
// Saved to a local JSON file, and — when UPSTASH_REDIS_REST_URL and
// UPSTASH_REDIS_REST_TOKEN are set — also to a free Upstash Redis database, so
// nothing is lost when the host restarts (free Render wipes local files).

import fs from "node:fs";
import path from "node:path";

const KEY = "timelock-bot:store";

export class Store {
  constructor(file, { url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN } = {}) {
    this.file = file;
    this.remote = url && token ? { url: url.replace(/\/$/, ""), token } : null;
    this.data = { users: {} };
    this.lastPushed = null;
    this.pushing = Promise.resolve();
    try {
      this.data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    this.data.users ??= {};
  }

  /** Load the saved state from the online database (if configured). Call once at startup. */
  async init() {
    if (!this.remote) {
      console.log("Storage: local file only (set UPSTASH_REDIS_REST_URL/TOKEN to keep data across restarts)");
      return;
    }
    try {
      const raw = await this.redis(["GET", KEY]);
      if (raw) {
        this.data = JSON.parse(raw);
        this.data.users ??= {};
        this.lastPushed = raw;
        this.writeFile();
      }
      console.log(`Storage: Upstash connected, ${Object.keys(this.data.users).length} user(s) loaded`);
    } catch (e) {
      // Don't start with an empty state and overwrite good remote data.
      throw new Error("Couldn't load data from Upstash: " + e.message);
    }
  }

  async redis(command) {
    const res = await fetch(this.remote.url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.remote.token}`, "content-type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
    return body.result;
  }

  user(chatId) {
    const id = String(chatId);
    this.data.users[id] ??= { wallets: [], notified: {}, alerts: true };
    return this.data.users[id];
  }

  allUsers() {
    return Object.entries(this.data.users);
  }

  writeFile() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file); // atomic replace
  }

  save() {
    this.writeFile();
    if (!this.remote) return;
    const raw = JSON.stringify(this.data);
    if (raw === this.lastPushed) return; // nothing changed, save a request
    // Queue pushes so they land in order.
    this.pushing = this.pushing
      .then(() => this.redis(["SET", KEY, raw]))
      .then(() => { this.lastPushed = raw; })
      .catch((e) => console.error("Upstash save failed:", e.message));
  }

  /** Wait for pending online saves (used on shutdown). */
  flush() {
    return this.pushing;
  }
}
