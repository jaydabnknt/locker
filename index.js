// Telegram bot for non-custodial crypto time-locks on EVM chains and Solana.
//
// The bot is read-only on-chain: it watches public addresses, lists locks and
// sends unlock alerts. Locking and withdrawing are signed by the user in their
// own wallet on the web page this process also serves.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Telegram } from "./telegram.js";
import { Store } from "./store.js";
import { startServer } from "./server.js";
import { collectLocks, formatUnits, formatDuration, escapeHtml } from "./locks.js";
import { isEvmAddress } from "./evm.js";
import { isSolanaAddress } from "./solana.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.env.CONFIG || path.join(root, "config.json");
// Config comes from the CONFIG_JSON env var (handy on hosting dashboards) or config.json.
const config = JSON.parse(process.env.CONFIG_JSON || fs.readFileSync(configPath, "utf8"));
config.botToken = process.env.BOT_TOKEN || config.botToken;
config.publicUrl = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || config.publicUrl || "").replace(/\/$/, "");
config.port = Number(process.env.PORT || config.port || 8080);

if (!config.botToken) throw new Error("Set BOT_TOKEN (from @BotFather)");
if (!config.publicUrl.startsWith("https://")) {
  console.warn("PUBLIC_URL must be an https:// URL for Telegram web app buttons to work.");
}

const MAX_WALLETS = 10;
const tg = new Telegram(config.botToken);
const store = new Store(path.resolve(root, config.dataFile || "data/store.json"));

const networks = () => [
  ...(config.evm || []).map((c) => ({ key: c.key, name: c.name })),
  ...(config.solana ? [{ key: "solana", name: config.solana.name || "Solana" }] : []),
];

const webAppUrl = (params) => `${config.publicUrl}/?${new URLSearchParams(params)}`;
const webAppButton = (text, params) => ({ text, web_app: { url: webAppUrl(params) } });

function withdrawParams(l) {
  return l.net === "solana"
    ? { net: "solana", action: "withdraw", id: l.id, mint: l.token }
    : { net: l.net, action: "withdraw", id: l.id };
}

function shortAddr(a) {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function describeLock(l, now) {
  const amount = `${formatUnits(l.amount, l.decimals)} ${escapeHtml(l.symbol)}`;
  const when = new Date(l.unlockTime * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  let status;
  if (l.withdrawn) status = "✅ withdrawn";
  else if (l.unlockTime <= now) status = "🔓 <b>unlocked — ready to withdraw</b>";
  else status = `🔒 unlocks in ${formatDuration(l.unlockTime - now)} (${when})`;
  return `<b>${amount}</b> · ${escapeHtml(l.netName)} #${escapeHtml(l.id)}\n${status}\n<code>${escapeHtml(shortAddr(l.wallet))}</code>`;
}

// ---------------- commands ----------------

const HELP = `<b>Crypto Time-Lock Bot</b>

Lock your own tokens until a date you choose, on EVM chains or Solana. Funds sit in an open-source smart contract — this bot never holds your keys or your coins, and nobody (including the bot owner) can release them early.

/lock — lock tokens (opens a page to sign in your wallet)
/locks — see your locks and withdraw unlocked ones
/wallet &lt;address&gt; — watch a wallet for unlock alerts
/wallets — list or remove watched wallets
/alerts on|off — unlock notifications
/help — this message

⚠️ A lock cannot be cancelled. Double-check the amount and date before you sign.`;

async function onMessage(msg) {
  if (msg.chat.type !== "private") return; // web app buttons only work in private chats
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const [cmdRaw, ...args] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@.*$/, "");
  const user = store.user(chatId);

  switch (cmd) {
    case "/start":
    case "/help":
      return tg.send(chatId, HELP);

    case "/lock": {
      const rows = networks().map((n) => [webAppButton(`🔒 Lock on ${n.name}`, { net: n.key, action: "lock" })]);
      if (!rows.length) return tg.send(chatId, "No networks are configured yet.");
      return tg.send(chatId, "Pick a network. You'll confirm everything in your own wallet.", {
        reply_markup: { inline_keyboard: rows },
      });
    }

    case "/wallet": {
      const addr = args[0];
      if (!addr) return tg.send(chatId, "Send it like this:\n<code>/wallet 0xYourAddress</code>\nor a Solana address.");
      const type = isEvmAddress(addr) ? "evm" : isSolanaAddress(addr) ? "solana" : null;
      if (!type) return tg.send(chatId, "That doesn't look like an EVM (0x…) or Solana address.");
      const norm = type === "evm" ? addr.toLowerCase() : addr;
      if (user.wallets.some((w) => w.address === norm)) return tg.send(chatId, "Already watching that wallet.");
      if (user.wallets.length >= MAX_WALLETS) return tg.send(chatId, `You can watch up to ${MAX_WALLETS} wallets.`);
      user.wallets.push({ address: norm, type });
      store.save();
      return tg.send(
        chatId,
        `👀 Watching <code>${escapeHtml(norm)}</code> (${type === "evm" ? "EVM" : "Solana"}). Use /locks to see its locks.`,
      );
    }

    case "/wallets": {
      if (!user.wallets.length) return tg.send(chatId, "No wallets yet. Add one with /wallet &lt;address&gt;.");
      const rows = user.wallets.map((w, i) => [{ text: `✖ Remove ${shortAddr(w.address)}`, callback_data: `rm:${i}` }]);
      const list = user.wallets.map((w) => `• <code>${escapeHtml(w.address)}</code> (${w.type})`).join("\n");
      return tg.send(chatId, `Watched wallets:\n${list}`, { reply_markup: { inline_keyboard: rows } });
    }

    case "/locks":
      return showLocks(chatId, user);

    case "/alerts": {
      const v = (args[0] || "").toLowerCase();
      if (v !== "on" && v !== "off") return tg.send(chatId, `Alerts are <b>${user.alerts ? "on" : "off"}</b>. Use /alerts on or /alerts off.`);
      user.alerts = v === "on";
      store.save();
      return tg.send(chatId, `Unlock alerts turned <b>${v}</b>.`);
    }

    default:
      // A bare address is a handy shortcut for /wallet.
      if (isEvmAddress(text) || isSolanaAddress(text)) return onMessage({ ...msg, text: `/wallet ${text}` });
      return tg.send(chatId, "I didn't get that. Try /help.");
  }
}

async function showLocks(chatId, user) {
  if (!user.wallets.length) {
    return tg.send(chatId, "Add the wallet you lock from first:\n<code>/wallet 0xYourAddress</code>");
  }
  await tg.api("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  const { locks, errors } = await collectLocks(config, user.wallets);
  const now = Math.floor(Date.now() / 1000);
  const open = locks.filter((l) => !l.withdrawn);

  let text = open.length
    ? `<b>Your locks</b>\n\n${open.map((l) => describeLock(l, now)).join("\n\n")}`
    : "No active locks found for your watched wallets.";
  if (errors.length) text += `\n\n⚠️ Couldn't reach: ${errors.map(escapeHtml).join("; ")}`;

  const rows = open
    .filter((l) => l.unlockTime <= now)
    .slice(0, 20)
    .map((l) => [webAppButton(`🔓 Withdraw ${l.symbol} (${l.netName} #${l.id})`, withdrawParams(l))]);

  return tg.send(chatId, text.slice(0, 4000), rows.length ? { reply_markup: { inline_keyboard: rows } } : {});
}

async function onCallback(q) {
  const chatId = q.message?.chat.id;
  const user = store.user(chatId);
  const [kind, arg] = (q.data || "").split(":");
  if (kind === "rm") {
    const removed = user.wallets.splice(Number(arg), 1)[0];
    store.save();
    await tg.api("answerCallbackQuery", { callback_query_id: q.id, text: removed ? "Removed" : "Already gone" });
    return tg.send(chatId, removed ? `Stopped watching <code>${escapeHtml(removed.address)}</code>.` : "Nothing to remove.");
  }
  return tg.api("answerCallbackQuery", { callback_query_id: q.id });
}

// ---------------- unlock alerts ----------------

const DAY = 86400;

async function checkAlerts() {
  const now = Math.floor(Date.now() / 1000);
  for (const [chatId, user] of store.allUsers()) {
    if (!user.alerts || !user.wallets.length) continue;
    let locks;
    try {
      ({ locks } = await collectLocks(config, user.wallets));
    } catch (e) {
      console.error("alert check failed for", chatId, e.message);
      continue;
    }
    const live = new Set();
    for (const l of locks) {
      if (l.withdrawn) continue;
      live.add(l.key);
      const n = (user.notified[l.key] ??= {});
      const left = l.unlockTime - now;
      try {
        if (left <= 0 && !n.ready) {
          await tg.send(chatId, `🔓 <b>Unlocked!</b>\n\n${describeLock(l, now)}`, {
            reply_markup: { inline_keyboard: [[webAppButton("Withdraw now", withdrawParams(l))]] },
          });
          n.ready = true;
        } else if (left > 0 && left <= DAY && !n.soon) {
          await tg.send(chatId, `⏰ Unlocking within 24 hours:\n\n${describeLock(l, now)}`);
          n.soon = true;
        }
      } catch (e) {
        if (e.code === 403) user.alerts = false; // user blocked the bot
        console.error("send failed:", e.message);
      }
    }
    // Forget alert state for locks that were withdrawn/closed.
    for (const key of Object.keys(user.notified)) if (!live.has(key)) delete user.notified[key];
  }
  store.save();
}

// ---------------- boot ----------------

startServer({ config, root });

await tg.api("setMyCommands", {
  commands: [
    { command: "lock", description: "Lock tokens until a date" },
    { command: "locks", description: "Your locks & withdrawals" },
    { command: "wallet", description: "Watch a wallet address" },
    { command: "wallets", description: "List / remove wallets" },
    { command: "alerts", description: "Unlock alerts on/off" },
    { command: "help", description: "How it works" },
  ],
}).catch((e) => console.error(e.message));

const intervalMs = Math.max(1, Number(config.checkIntervalMinutes || 5)) * 60_000;
let checking = false;
setInterval(async () => {
  if (checking) return;
  checking = true;
  try {
    await checkAlerts();
  } finally {
    checking = false;
  }
}, intervalMs);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    tg.stop();
    store.save();
    process.exit(0);
  });
}

console.log("Bot running. Web page at", config.publicUrl || `http://localhost:${config.port}`);
tg.poll(async (u) => {
  if (u.message) await onMessage(u.message);
  else if (u.callback_query) await onCallback(u.callback_query);
});
