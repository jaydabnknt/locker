// Tiny JSON-file store. Holds only public data: Telegram chat ids, the public
// wallet addresses users linked, and which unlock alerts were already sent.
// The bot never sees or stores private keys.

import fs from "node:fs";
import path from "node:path";

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { users: {} };
    try {
      this.data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    this.data.users ??= {};
  }

  user(chatId) {
    const id = String(chatId);
    this.data.users[id] ??= { wallets: [], notified: {}, alerts: true };
    return this.data.users[id];
  }

  allUsers() {
    return Object.entries(this.data.users);
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file); // atomic replace
  }
}
