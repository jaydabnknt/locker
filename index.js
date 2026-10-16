// Telegram time-lock bot — XRP version.
//
// Flow: /lock → pick coin → amount → lock time → bot gives a deposit address +
// destination tag → user sends XRP → bot puts it in an XRP Ledger Escrow (the
// ledger itself refuses to release it before the unlock time) → at unlock the
// bot finishes the escrow, asks for a withdrawal address, and pays it out.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Telegram } from "./telegram.js";
import { Store } from "./store.js";
import {
  XrplClient, walletFromSeed, generateSeed, isValidAddress, xrpToDrops, dropsToXrp, toRippleTime,
} from "./xrpl.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(process.env.CONFIG_JSON || fs.readFileSync(path.join(root, "config.json"), "utf8"));
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN = process.env.ADMIN_CHAT_ID ? String(process.env.ADMIN_CHAT_ID).trim() : null;
const PORT = Number(process.env.PORT || 8080);
if (!BOT_TOKEN) throw new Error("Set BOT_TOKEN (from @BotFather)");

const xrpCfg = config.xrp;
const isTestnet = config.network !== "mainnet";
const MIN_LOCK_SECS = isTestnet ? 5 * 60 : 60 * 60;
const MAX_LOCK_SECS = 10 * 365 * 86400;
const DEPOSIT_WINDOW_SECS = (config.depositWindowHours || 24) * 3600;
const MIN_LOCK_DROPS = BigInt(xrpToDrops(String(config.minLockXrp ?? 1)));
const ESCROW_RESERVE_DROPS = 200000n; // 0.2 XRP owner reserve per open escrow (paid by the bot, returned on finish)
const REQUIRE_DEST_TAG = 0x00020000;

const tg = new Telegram(BOT_TOKEN);
const store = new Store(path.resolve(root, "data/store.json"));
const xrpl = new XrplClient(xrpCfg.rpc);

await store.init();
const S = store.data;
S.locks ??= {};
S.processedPayments ??= [];
S.users ??= {};
S.unmatched ??= [];

// ---------------------------------------------------------------- wallet setup

let wallet = null;
if (process.env.XRP_SEED) {
  wallet = walletFromSeed(process.env.XRP_SEED);
  console.log("XRP deposit address:", wallet.address);
} else {
  console.log("==================================================================");
  console.log("No XRP_SEED set, so XRP locking is switched off.");
  console.log("Here is a brand-new seed you can use. Add it in Render as XRP_SEED:");
  console.log("   " + generateSeed());
  console.log("Write it on paper too. Whoever has it controls the bot's XRP.");
  console.log("==================================================================");
}

// ---------------------------------------------------------------- helpers

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const now = () => Math.floor(Date.now() / 1000);
const txLink = (hash) => `<a href="${xrpCfg.explorer}/transactions/${hash}">${hash.slice(0, 10)}…</a>`;
const fmtDate = (unix) => new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function fmtDuration(secs) {
  const units = [["year", 365 * 86400], ["month", 30 * 86400], ["week", 7 * 86400], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [name, s] of units) {
    if (secs >= s && secs % s === 0) {
      const n = secs / s;
      return `${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.round((secs % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(" ") || `${secs}s`;
}

function fmtLeft(secs) {
  if (secs <= 0) return "now";
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${Math.max(m, 1)}m`;
}

function parseDuration(text) {
  const m = String(text).trim().toLowerCase().match(/^(\d+)\s*(m|min|mins|minutes?|h|hours?|d|days?|w|weeks?|mo|months?|y|years?)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2];
  const mult = u.startsWith("mo") ? 30 * 86400 : u[0] === "m" ? 60 : u[0] === "h" ? 3600 : u[0] === "d" ? 86400 : u[0] === "w" ? 7 * 86400 : 365 * 86400;
  return n * mult;
}

function user(chatId) {
  const id = String(chatId);
  S.users[id] ??= {};
  return S.users[id];
}

function newTag() {
  const used = new Set(Object.values(S.locks).map((l) => l.tag));
  let t;
  do t = 100000 + Math.floor(Math.random() * 900000); while (used.has(t));
  return t;
}

const send = (chatId, text, extra) => tg.send(chatId, text, extra).catch((e) => console.error("send failed:", e.message));
const kb = (rows) => ({ reply_markup: { inline_keyboard: rows } });

const STATUS_LABEL = {
  awaiting_deposit: "⏳ waiting for deposit",
  deposited: "📥 deposit received, locking…",
  locked: "🔒 locked",
  unlocking: "🔓 unlocking…",
  awaiting_address: "🔓 unlocked: send me a withdrawal address",
  withdrawing: "📤 sending…",
  done: "✅ withdrawn",
  expired: "⌛ expired (no deposit)",
};

function describeLock(l) {
  const amount = dropsToXrp(l.depositDrops || l.amountDrops);
  let line = `<b>${amount} XRP</b> · lock #${l.tag}\n${STATUS_LABEL[l.status] || l.status}`;
  if (l.status === "locked") line += ` · unlocks in ${fmtLeft(l.unlockAt - now())} (${fmtDate(l.unlockAt)})`;
  if (l.status === "awaiting_deposit") line += ` · lock time ${fmtDuration(l.durationSecs)}, send by ${fmtDate(l.expiresAt)}`;
  return line;
}

function depositInstructions(l) {
  return (
    `Send <b>exactly ${dropsToXrp(l.amountDrops)} XRP</b> to:\n\n` +
    `Address:\n<code>${wallet.address}</code>\n\n` +
    `Destination tag:\n<code>${l.tag}</code>\n\n` +
    `⚠️ The <b>destination tag is required</b>. Without it I can't tell the deposit is yours.\n` +
    `⏳ Send within ${fmtDuration(DEPOSIT_WINDOW_SECS)} (by ${fmtDate(l.expiresAt)}).\n` +
    `🔒 Your lock (${fmtDuration(l.durationSecs)}) starts when your deposit arrives.` +
    (isTestnet ? `\n\n🧪 <i>Testnet: use free test XRP only.</i>` : "")
  );
}

// ---------------------------------------------------------------- commands

const HELP = `<b>Crypto Time-Lock</b>

Lock your crypto until a date you choose. Once it's locked, <b>nobody can release it early</b>, not even the bot owner. The ledger itself enforces the time.

/lock: start a new lock
/locks: your locks
/cancel: stop what you're doing
/help: this message

How it works: pick a coin, amount and lock time → send the deposit → I lock it → when time's up I message you and you tell me where to send it.${isTestnet ? "\n\n🧪 <b>Running on TESTNET.</b> Use free test XRP only." : ""}`;

async function onMessage(msg) {
  if (msg.chat.type !== "private") return;
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const u = user(chatId);
  const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, "");

  if (cmd === "/start" || cmd === "/help") {
    if (u.step !== "withdraw_address" && u.step !== "withdraw_tag") u.step = null;
    store.save();
    return send(chatId, HELP);
  }
  if (cmd === "/cancel") {
    const withdrawing = u.step === "withdraw_address" || u.step === "withdraw_tag";
    u.step = withdrawing ? "withdraw_address" : null;
    u.draft = null;
    store.save();
    return send(chatId, withdrawing
      ? "You still have unlocked XRP waiting. Send me an address whenever you're ready."
      : "OK, cancelled. Locks that are already running aren't affected.");
  }
  if (cmd === "/lock") return startLock(chatId);
  if (cmd === "/locks") return listLocks(chatId);
  if (cmd === "/myid") return send(chatId, `Your chat id: <code>${chatId}</code>`);
  if (cmd === "/status") return ADMIN && String(chatId) === ADMIN ? adminStatus(chatId) : send(chatId, "Only the bot owner can use /status.");

  switch (u.step) {
    case "amount": {
      let drops;
      try {
        drops = xrpToDrops(text);
      } catch (e) {
        return send(chatId, e.message);
      }
      if (BigInt(drops) < MIN_LOCK_DROPS) return send(chatId, `The minimum is ${dropsToXrp(MIN_LOCK_DROPS)} XRP.`);
      u.draft = { ...(u.draft || {}), amountDrops: drops };
      u.step = "duration";
      store.save();
      return askDuration(chatId);
    }
    case "duration": {
      const secs = parseDuration(text);
      if (!secs) return send(chatId, "Send it like <code>10m</code>, <code>2h</code>, <code>45d</code>, <code>3mo</code> or <code>1y</code>.");
      return setDuration(chatId, secs);
    }
    case "withdraw_address":
      return onWithdrawAddress(chatId, text);
    case "withdraw_tag":
      return onWithdrawTag(chatId, text);
  }

  if (isValidAddress(text)) return send(chatId, "If that's a withdrawal address, wait until a lock unlocks. I'll ask you for it then.");
  return send(chatId, "Not sure what you mean. Try /lock or /help.");
}

async function startLock(chatId) {
  const u = user(chatId);
  if (u.step === "withdraw_address" || u.step === "withdraw_tag") {
    return send(chatId, "First tell me where to send your unlocked XRP (send an address, starting with <b>r</b>).");
  }
  u.step = null;
  u.draft = {};
  store.save();
  return send(chatId, "Which coin do you want to lock?", kb([
    [{ text: "XRP", callback_data: "coin:XRP" }],
    [{ text: "TRX (coming soon)", callback_data: "coin:TRX" }, { text: "SOL (coming soon)", callback_data: "coin:SOL" }],
  ]));
}

function askDuration(chatId) {
  const opts = [["1 day", 86400], ["1 week", 7 * 86400], ["1 month", 30 * 86400], ["3 months", 90 * 86400], ["6 months", 180 * 86400], ["1 year", 365 * 86400]];
  const rows = [];
  for (let i = 0; i < opts.length; i += 3) rows.push(opts.slice(i, i + 3).map(([t, s]) => ({ text: t, callback_data: `dur:${s}` })));
  return send(chatId, `How long should it stay locked?\nTap one, or type your own (e.g. <code>10m</code>, <code>2h</code>, <code>45d</code>).`, kb(rows));
}

function setDuration(chatId, secs) {
  const u = user(chatId);
  if (!u.draft?.amountDrops) return startLock(chatId);
  if (secs < MIN_LOCK_SECS) return send(chatId, `The shortest lock is ${fmtDuration(MIN_LOCK_SECS)}.`);
  if (secs > MAX_LOCK_SECS) return send(chatId, "The longest lock is 10 years.");
  u.draft.durationSecs = secs;
  u.step = null;
  store.save();
  return send(
    chatId,
    `Please check:\n\n• Coin: <b>XRP</b>\n• Amount: <b>${dropsToXrp(u.draft.amountDrops)} XRP</b>\n• Lock time: <b>${fmtDuration(secs)}</b> from when your deposit arrives\n\n` +
      `⚠️ Once locked it <b>can't be cancelled or released early</b>.`,
    kb([[{ text: "✅ Create lock", callback_data: "confirm" }, { text: "✖ Cancel", callback_data: "cancel" }]]),
  );
}

async function onCallback(q) {
  const chatId = q.message?.chat.id;
  if (!chatId) return;
  const u = user(chatId);
  const [kind, arg] = (q.data || "").split(":");
  const answer = (text) => tg.api("answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text } : {}) }).catch(() => {});

  if (kind === "coin") {
    await answer(arg === "XRP" ? undefined : "Coming soon");
    if (arg !== "XRP") return send(chatId, `${arg} locking isn't ready yet. XRP works now.`);
    if (!wallet) return send(chatId, "XRP locking isn't set up yet. The bot owner needs to add the wallet seed.");
    u.draft = { coin: "XRP" };
    u.step = "amount";
    store.save();
    return send(chatId, `How much XRP do you want to lock? (minimum ${dropsToXrp(MIN_LOCK_DROPS)})\nJust send the number, e.g. <code>25</code>`);
  }
  if (kind === "dur") {
    await answer();
    return setDuration(chatId, Number(arg));
  }
  if (kind === "confirm") {
    await answer();
    if (!u.draft?.amountDrops || !u.draft?.durationSecs) return send(chatId, "That lock request expired. Start again with /lock.");
    const l = {
      id: `${Date.now()}-${chatId}`,
      chatId: String(chatId),
      coin: "XRP",
      tag: newTag(),
      amountDrops: u.draft.amountDrops,
      durationSecs: u.draft.durationSecs,
      status: "awaiting_deposit",
      createdAt: now(),
      expiresAt: now() + DEPOSIT_WINDOW_SECS,
    };
    S.locks[l.id] = l;
    u.draft = null;
    store.save();
    return send(chatId, depositInstructions(l));
  }
  if (kind === "cancel") {
    await answer("Cancelled");
    u.draft = null;
    u.step = null;
    store.save();
    return send(chatId, "Cancelled.");
  }
  if (kind === "wtag") {
    await answer();
    return onWithdrawTag(chatId, "none");
  }
  if (kind === "wconfirm") {
    await answer();
    const l = S.locks[arg];
    if (!l || l.chatId !== String(chatId) || l.status !== "awaiting_address" || !l.withdrawTo) return send(chatId, "Nothing to confirm.");
    l.status = "withdrawing";
    u.step = null;
    store.save();
    return send(chatId, "Sending… I'll confirm when it's done (usually under 10 seconds).");
  }
  if (kind === "wchange") {
    await answer();
    const l = S.locks[arg];
    if (!l || l.chatId !== String(chatId) || l.status !== "awaiting_address") return;
    l.withdrawTo = null;
    l.withdrawTag = null;
    u.step = "withdraw_address";
    u.withdrawLock = l.id;
    store.save();
    return send(chatId, "OK, send me the XRP address to withdraw to.");
  }
  return answer();
}

async function listLocks(chatId) {
  const mine = Object.values(S.locks)
    .filter((l) => l.chatId === String(chatId) && l.status !== "expired")
    .sort((a, b) => (a.unlockAt || a.createdAt) - (b.unlockAt || b.createdAt));
  if (!mine.length) return send(chatId, "You have no locks yet. Start one with /lock.");
  let text = `<b>Your locks</b>\n\n${mine.slice(-20).map(describeLock).join("\n\n")}`;
  if (mine.some((l) => l.status === "awaiting_deposit")) {
    text += `\n\nDeposit address: <code>${wallet?.address}</code>\nUse the lock number as the destination tag.`;
  }
  return send(chatId, text);
}

async function adminStatus(chatId) {
  const info = wallet ? await xrpl.accountInfo(wallet.address).catch(() => null) : null;
  const counts = {};
  for (const l of Object.values(S.locks)) counts[l.status] = (counts[l.status] || 0) + 1;
  const inEscrow = Object.values(S.locks).filter((l) => ["locked", "unlocking"].includes(l.status)).reduce((a, l) => a + BigInt(l.depositDrops), 0n);
  const owed = Object.values(S.locks).filter((l) => ["deposited", "awaiting_address", "withdrawing"].includes(l.status)).reduce((a, l) => a + BigInt(l.depositDrops), 0n);
  return send(
    chatId,
    `<b>Bot status</b> (${isTestnet ? "testnet" : "MAINNET"})\n` +
      `Address: <code>${wallet?.address || "not set"}</code>\n` +
      `Wallet balance: ${info ? dropsToXrp(info.Balance) : "?"} XRP\n` +
      `Owed to users, not in escrow: ${dropsToXrp(owed)} XRP\n` +
      `In escrow: ${dropsToXrp(inEscrow)} XRP\n` +
      `Locks: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}\n` +
      `Deposits without a lock: ${S.unmatched.length}`,
  );
}

// ---------------------------------------------------------------- withdrawal conversation

async function onWithdrawAddress(chatId, text) {
  const u = user(chatId);
  const l = S.locks[u.withdrawLock];
  if (!l || l.status !== "awaiting_address") {
    u.step = null;
    store.save();
    return send(chatId, "There's no unlocked lock waiting for an address.");
  }
  const addr = text.trim();
  if (addr.startsWith("X")) return send(chatId, "Please send the classic address (starts with <b>r</b>). I'll ask for the tag next.");
  if (!isValidAddress(addr)) return send(chatId, "That doesn't look like a valid XRP address (starts with <b>r</b>). Check it and send again.");
  if (addr === wallet.address) return send(chatId, "That's the bot's own address. Send your own wallet or exchange address.");
  let requireTag = false;
  try {
    const info = await xrpl.accountInfo(addr);
    requireTag = !!(info && info.Flags & REQUIRE_DEST_TAG);
    if (!info && BigInt(l.depositDrops) < 1000000n) {
      return send(chatId, "That address isn't activated yet, and new XRP addresses need at least 1 XRP to activate. Send an address that already exists.");
    }
  } catch {}
  l.withdrawTo = addr;
  u.step = "withdraw_tag";
  store.save();
  return send(
    chatId,
    (requireTag ? "⚠️ This address <b>requires</b> a destination tag (it's probably an exchange).\n" : "") +
      "Does it need a destination tag? Exchanges usually do. Send the tag number" + (requireTag ? "." : ", or tap <b>No tag</b>."),
    requireTag ? {} : kb([[{ text: "No tag", callback_data: "wtag:none" }]]),
  );
}

async function onWithdrawTag(chatId, text) {
  const u = user(chatId);
  const l = S.locks[u.withdrawLock];
  if (!l || l.status !== "awaiting_address" || !l.withdrawTo) return;
  if (text !== "none") {
    if (!/^\d{1,10}$/.test(text) || Number(text) > 4294967295) return send(chatId, "A destination tag is a whole number. Send it again, or tap No tag.");
    l.withdrawTag = Number(text);
  } else {
    try {
      const info = await xrpl.accountInfo(l.withdrawTo);
      if (info && info.Flags & REQUIRE_DEST_TAG) return send(chatId, "This address requires a tag. Please send the tag number.");
    } catch {}
    l.withdrawTag = null;
  }
  u.step = null;
  store.save();
  return send(
    chatId,
    `Send <b>${dropsToXrp(l.depositDrops)} XRP</b> to:\n<code>${l.withdrawTo}</code>\n` +
      (l.withdrawTag != null ? `Destination tag: <code>${l.withdrawTag}</code>\n` : "No destination tag\n") +
      `\nDouble-check it. Payments can't be reversed.`,
    kb([[{ text: "✅ Send", callback_data: `wconfirm:${l.id}` }, { text: "✏️ Change", callback_data: `wchange:${l.id}` }]]),
  );
}

// ---------------------------------------------------------------- ledger worker

let faucetTried = false;
async function ensureFunded() {
  const info = await xrpl.accountInfo(wallet.address);
  if (info) return info;
  if (isTestnet && xrpCfg.faucet && !faucetTried) {
    faucetTried = true;
    console.log("Bot account not funded, asking the testnet faucet…");
    const r = await fetch(xrpCfg.faucet, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ destination: wallet.address }),
    }).catch((e) => ({ ok: false, statusText: e.message }));
    console.log("Faucet:", r.ok ? "funded" : "failed " + (r.status || "") + " " + r.statusText);
  } else if (!isTestnet) {
    console.log(`Bot account ${wallet.address} isn't activated. Send it at least 5 XRP.`);
  }
  return null;
}

/** Submit a transaction for a lock, recording it first so a crash can't make it run twice. */
async function runTx(l, tx) {
  try {
    const res = await xrpl.submitAndWait(tx, wallet, {
      onSigned: ({ hash, sequence, lastLedger }) => {
        l.pending = { hash, sequence, lastLedger };
        store.save();
      },
    });
    l.pending = null;
    store.save();
    return res;
  } catch (e) {
    if (e.rejected) {
      l.pending = null; // definitely didn't happen
      store.save();
    }
    throw e;
  }
}

/** After a restart: settle a transaction that was sent but whose result we never saw. */
async function resolvePending(l) {
  const p = l.pending;
  let t = null;
  try {
    t = await xrpl.request("tx", { transaction: p.hash });
  } catch (e) {
    if (e.code !== "txnNotFound") throw e;
  }
  if (t?.validated) {
    l.pending = null;
    store.save();
    const ok = t.meta?.TransactionResult === "tesSUCCESS";
    return ok ? { done: true, hash: p.hash, sequence: p.sequence } : { failed: t.meta?.TransactionResult };
  }
  if ((await xrpl.currentLedger()) > p.lastLedger + 1) {
    l.pending = null; // never made it in; safe to try again
    store.save();
    return { retry: true };
  }
  return { wait: true };
}

async function onEscrowCreated(l, hash, sequence) {
  l.escrowSeq = sequence;
  l.escrowHash = hash;
  l.status = "locked";
  store.save();
  await send(
    l.chatId,
    `🔒 <b>Locked ${dropsToXrp(l.depositDrops)} XRP</b> (lock #${l.tag})\n` +
      `Unlocks: <b>${fmtDate(l.unlockAt)}</b> (in ${fmtLeft(l.unlockAt - now())})\n\n` +
      `It's held in an XRP Ledger escrow that can't be opened before then. Proof: ${txLink(hash)}\n` +
      `I'll message you when it unlocks.`,
  );
}

async function onEscrowFinished(l, hash) {
  l.finishHash = hash;
  l.status = "awaiting_address";
  const u = user(l.chatId);
  u.step = "withdraw_address";
  u.withdrawLock = l.id;
  store.save();
  await send(
    l.chatId,
    `🔓 <b>Your ${dropsToXrp(l.depositDrops)} XRP is unlocked!</b> (lock #${l.tag})\n\nSend me the <b>XRP address</b> you want it sent to (starts with <b>r</b>).`,
  );
}

async function onWithdrawn(l, hash) {
  l.withdrawHash = hash;
  l.status = "done";
  store.save();
  await send(l.chatId, `✅ <b>Sent ${dropsToXrp(l.depositDrops)} XRP</b> to <code>${short(l.withdrawTo)}</code>.\nTransaction: ${txLink(hash)}`);
}

async function onWithdrawFailed(l, reason) {
  l.status = "awaiting_address";
  l.withdrawTo = null;
  l.withdrawTag = null;
  const u = user(l.chatId);
  u.step = "withdraw_address";
  u.withdrawLock = l.id;
  store.save();
  await send(l.chatId, `❌ The payment didn't go through (${esc(reason)}). Your XRP is safe. Send me the address again, or a different one.`);
}

async function processDeposits() {
  const payments = await xrpl.incomingPayments(wallet.address, 200);
  const seen = new Set(S.processedPayments);
  for (const p of payments.reverse()) { // oldest first
    if (seen.has(p.hash)) continue;
    S.processedPayments.push(p.hash);
    seen.add(p.hash);
    if (p.from === wallet.address) continue;
    const l = Object.values(S.locks).find((x) => x.tag === p.tag && x.status === "awaiting_deposit");
    if (!l) {
      S.unmatched.push(p);
      store.save();
      console.log("Unmatched deposit", p);
      if (ADMIN) {
        await send(ADMIN, `⚠️ Deposit without a matching lock: ${dropsToXrp(p.drops)} XRP from <code>${p.from}</code>, tag ${p.tag ?? "none"}. Tx ${txLink(p.hash)}. It's in the bot wallet; refund it manually.`);
      }
      continue;
    }
    l.depositHash = p.hash;
    l.depositFrom = p.from;
    l.depositDrops = p.drops;
    l.unlockAt = now() + l.durationSecs;
    l.status = "deposited";
    store.save();
    const diff = BigInt(p.drops) !== BigInt(l.amountDrops);
    await send(
      l.chatId,
      `📥 Deposit received: <b>${dropsToXrp(p.drops)} XRP</b> (lock #${l.tag})` +
        (diff ? `\nThat's different from the ${dropsToXrp(l.amountDrops)} XRP you planned. I'll lock what arrived.` : "") +
        `\nLocking it now…`,
    );
  }
  if (S.processedPayments.length > 2000) S.processedPayments = S.processedPayments.slice(-1000);
  store.save();
}

async function stepLock(l) {
  if (l.pending) {
    const r = await resolvePending(l);
    if (r.wait) return;
    if (r.done) {
      if (l.status === "deposited") return onEscrowCreated(l, r.hash, r.sequence);
      if (l.status === "unlocking") return onEscrowFinished(l, r.hash);
      if (l.status === "withdrawing") return onWithdrawn(l, r.hash);
      return;
    }
    if (r.failed) {
      if (l.status === "withdrawing") return onWithdrawFailed(l, r.failed);
      if (l.status === "unlocking") { l.status = "locked"; store.save(); }
      l.error = r.failed;
      return;
    }
    // r.retry: fall through and try again
  }

  switch (l.status) {
    case "awaiting_deposit":
      if (now() > l.expiresAt) {
        l.status = "expired";
        store.save();
        await send(l.chatId, `⌛ Lock #${l.tag} expired because no deposit arrived. <b>Don't send anything for it now.</b> Start a new one with /lock.`);
      }
      return;

    case "deposited": {
      const info = await xrpl.accountInfo(wallet.address);
      if (info && BigInt(info.Balance) < BigInt(l.depositDrops) + ESCROW_RESERVE_DROPS + 1000000n) {
        if (!l.lowFundsWarned && ADMIN) await send(ADMIN, "⚠️ Bot wallet is too low on XRP to cover escrow reserves. Top it up with a few XRP.");
        l.lowFundsWarned = true;
        store.save();
        return;
      }
      // If the deposit sat waiting past its unlock time, lock for at least a few minutes.
      if (l.unlockAt < now() + 120) l.unlockAt = now() + 120;
      const { hash, sequence } = await runTx(l, {
        TransactionType: "EscrowCreate",
        Destination: wallet.address,
        Amount: l.depositDrops,
        FinishAfter: toRippleTime(l.unlockAt),
        SourceTag: l.tag,
        DestinationTag: l.tag,
      });
      return onEscrowCreated(l, hash, sequence);
    }

    case "locked":
      if (now() < l.unlockAt + 10) return;
      l.status = "unlocking";
      store.save();
    // falls through
    case "unlocking":
      try {
        const { hash } = await runTx(l, { TransactionType: "EscrowFinish", Owner: wallet.address, OfferSequence: l.escrowSeq });
        return onEscrowFinished(l, hash);
      } catch (e) {
        if (e.rejected) { l.status = "locked"; store.save(); } // e.g. ledger clock not past FinishAfter yet; retry next round
        throw e;
      }

    case "withdrawing": {
      const tx = { TransactionType: "Payment", Destination: l.withdrawTo, Amount: l.depositDrops };
      if (l.withdrawTag != null) tx.DestinationTag = l.withdrawTag;
      try {
        const { hash } = await runTx(l, tx);
        return onWithdrawn(l, hash);
      } catch (e) {
        if (e.rejected) return onWithdrawFailed(l, e.result || e.message);
        throw e; // unknown outcome; resolved next round
      }
    }
  }
}

let working = false;
async function tick() {
  if (working || !wallet) return;
  working = true;
  try {
    if (!(await ensureFunded())) return;
    await processDeposits();
    for (const l of Object.values(S.locks)) {
      try {
        await stepLock(l);
      } catch (e) {
        console.error(`lock #${l.tag} (${l.status}):`, e.message);
      }
    }
  } catch (e) {
    console.error("worker:", e.message);
  } finally {
    working = false;
  }
}

// ---------------------------------------------------------------- boot

http
  .createServer((req, res) => {
    const ok = req.url === "/health" || req.url === "/";
    res.writeHead(ok ? 200 : 404, { "content-type": "text/plain" }).end(ok ? "ok" : "not found");
  })
  .listen(PORT, () => console.log("HTTP server on port", PORT));

await tg.api("setMyCommands", {
  commands: [
    { command: "lock", description: "Start a new lock" },
    { command: "locks", description: "Your locks" },
    { command: "cancel", description: "Stop the current step" },
    { command: "help", description: "How it works" },
  ],
}).catch((e) => console.error(e.message));

if (wallet) {
  // On the very first start, treat payments already in the wallet as handled.
  if (!S.processedPayments.length && !S.initialized) {
    try {
      S.processedPayments = (await xrpl.incomingPayments(wallet.address, 200)).map((p) => p.hash);
    } catch {}
    S.initialized = true;
    store.save();
  }
  setInterval(tick, (config.pollSeconds || 15) * 1000);
  tick();
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    tg.stop();
    store.save();
    store.flush().finally(() => process.exit(0));
  });
}

console.log(`Bot running (${isTestnet ? "testnet" : "mainnet"})`);
tg.poll(async (u) => {
  if (u.message) await onMessage(u.message);
  else if (u.callback_query) await onCallback(u.callback_query);
});
