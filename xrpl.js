// Minimal, dependency-free XRP Ledger client: keys, addresses, transaction
// encoding, signing and JSON-RPC. Supports only what the bot needs:
// XRP-only Payment, EscrowCreate and EscrowFinish, signed with ed25519 keys.
// Encoding is checked against the official xrpl.js test fixtures (see test/).

import crypto from "node:crypto";

// ---------------------------------------------------------------- base58

const ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const sha512Half = (b) => crypto.createHash("sha512").update(b).digest().subarray(0, 32);
const ripemd160 = (b) => crypto.createHash("ripemd160").update(b).digest();

function b58encode(buf) {
  let n = BigInt("0x" + (Buffer.from(buf).toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of buf) {
    if (byte !== 0) break;
    out = ALPHABET[0] + out;
  }
  return out;
}

function b58decode(str) {
  let n = 0n;
  for (const c of str) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error("Invalid character in address/seed");
    n = n * 58n + BigInt(v);
  }
  let hex = n === 0n ? "" : n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let zeros = 0;
  while (str[zeros] === ALPHABET[0]) zeros++;
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, "hex")]);
}

function encodeCheck(version, payload) {
  const body = Buffer.concat([Buffer.from(version), Buffer.from(payload)]);
  return b58encode(Buffer.concat([body, sha256(sha256(body)).subarray(0, 4)]));
}

function decodeCheck(str, version, payloadLen) {
  const raw = b58decode(str);
  const body = raw.subarray(0, -4);
  const check = raw.subarray(-4);
  if (!sha256(sha256(body)).subarray(0, 4).equals(check)) throw new Error("Bad checksum");
  const v = body.subarray(0, version.length);
  if (!v.equals(Buffer.from(version)) || body.length !== version.length + payloadLen) throw new Error("Wrong type");
  return body.subarray(version.length);
}

// ---------------------------------------------------------------- keys & addresses

const ED25519_SEED_PREFIX = [0x01, 0xe1, 0x4b];
const ACCOUNT_PREFIX = [0x00];
const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

export function isValidAddress(addr) {
  try {
    decodeCheck(String(addr), ACCOUNT_PREFIX, 20);
    return true;
  } catch {
    return false;
  }
}

export function decodeAddress(addr) {
  return decodeCheck(addr, ACCOUNT_PREFIX, 20);
}

export function encodeAddress(accountId) {
  return encodeCheck(ACCOUNT_PREFIX, accountId);
}

/** Create a new random ed25519 family seed ("sEd..."). */
export function generateSeed() {
  return encodeCheck(ED25519_SEED_PREFIX, crypto.randomBytes(16));
}

/** Wallet from an ed25519 family seed. */
export function walletFromSeed(seed) {
  let entropy;
  try {
    entropy = decodeCheck(seed.trim(), ED25519_SEED_PREFIX, 16);
  } catch {
    throw new Error("XRP_SEED must be an ed25519 seed starting with 'sEd'");
  }
  const rawPriv = sha512Half(entropy);
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, rawPriv]), format: "der", type: "pkcs8" });
  const rawPub = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  const publicKey = Buffer.concat([Buffer.from([0xed]), rawPub]);
  const address = encodeAddress(ripemd160(sha256(publicKey)));
  return {
    address,
    publicKeyHex: publicKey.toString("hex").toUpperCase(),
    privateKeyHex: "ED" + rawPriv.toString("hex").toUpperCase(),
    sign: (data) => crypto.sign(null, data, privateKey),
  };
}

// ---------------------------------------------------------------- binary codec (subset)

const T = { UInt16: 1, UInt32: 2, Amount: 6, Blob: 7, AccountID: 8 };
const FIELDS = {
  TransactionType: [T.UInt16, 2],
  NetworkID: [T.UInt32, 1],
  Flags: [T.UInt32, 2],
  SourceTag: [T.UInt32, 3],
  Sequence: [T.UInt32, 4],
  DestinationTag: [T.UInt32, 14],
  OfferSequence: [T.UInt32, 25],
  LastLedgerSequence: [T.UInt32, 27],
  CancelAfter: [T.UInt32, 36],
  FinishAfter: [T.UInt32, 37],
  Amount: [T.Amount, 1],
  Fee: [T.Amount, 8],
  SigningPubKey: [T.Blob, 3],
  TxnSignature: [T.Blob, 4],
  Account: [T.AccountID, 1],
  Owner: [T.AccountID, 2],
  Destination: [T.AccountID, 3],
};
const TX_TYPES = { Payment: 0, EscrowCreate: 1, EscrowFinish: 2 };

function fieldHeader(type, nth) {
  if (type < 16 && nth < 16) return Buffer.from([(type << 4) | nth]);
  if (type >= 16 && nth < 16) return Buffer.from([nth, type]);
  if (type < 16 && nth >= 16) return Buffer.from([type << 4, nth]);
  return Buffer.from([0, type, nth]);
}

function vl(len) {
  if (len <= 192) return Buffer.from([len]);
  if (len <= 12480) {
    const l = len - 193;
    return Buffer.from([193 + (l >> 8), l & 0xff]);
  }
  const l = len - 12481;
  return Buffer.from([241 + (l >> 16), (l >> 8) & 0xff, l & 0xff]);
}

function encodeValue(name, type, value) {
  switch (type) {
    case T.UInt16: {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(name === "TransactionType" ? TX_TYPES[value] ?? (() => { throw new Error("Unsupported tx type " + value); })() : value);
      return b;
    }
    case T.UInt32: {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(Number(value) >>> 0);
      return b;
    }
    case T.Amount: {
      if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`${name}: only XRP amounts in drops are supported`);
      const drops = BigInt(value);
      if (drops > 100000000000000000n) throw new Error(`${name}: amount too large`);
      const b = Buffer.alloc(8);
      b.writeBigUInt64BE(0x4000000000000000n | drops);
      return b;
    }
    case T.Blob: {
      const data = Buffer.from(value, "hex");
      return Buffer.concat([vl(data.length), data]);
    }
    case T.AccountID: {
      const id = decodeAddress(value);
      return Buffer.concat([vl(20), id]);
    }
  }
  throw new Error("Unsupported field type");
}

/** Serialize a transaction. With `forSigning`, non-signing fields (TxnSignature) are left out. */
export function encode(tx, { forSigning = false } = {}) {
  const entries = Object.entries(tx)
    .filter(([k]) => !(forSigning && k === "TxnSignature"))
    .filter(([k]) => k !== "hash")
    .map(([k, v]) => {
      const f = FIELDS[k];
      if (!f) throw new Error("Unsupported field " + k);
      return { k, v, type: f[0], nth: f[1] };
    })
    .sort((a, b) => a.type - b.type || a.nth - b.nth);
  return Buffer.concat(entries.flatMap(({ k, v, type, nth }) => [fieldHeader(type, nth), encodeValue(k, type, v)]));
}

const PREFIX_SIGN = Buffer.from("53545800", "hex");
const PREFIX_TXID = Buffer.from("54584E00", "hex");

export function txHash(blobHex) {
  return sha512Half(Buffer.concat([PREFIX_TXID, Buffer.from(blobHex, "hex")])).toString("hex").toUpperCase();
}

export function sign(tx, wallet) {
  const unsigned = { ...tx, SigningPubKey: wallet.publicKeyHex };
  delete unsigned.TxnSignature;
  const sig = wallet.sign(Buffer.concat([PREFIX_SIGN, encode(unsigned, { forSigning: true })]));
  const signed = { ...unsigned, TxnSignature: sig.toString("hex").toUpperCase() };
  const blob = encode(signed).toString("hex").toUpperCase();
  return { blob, hash: txHash(blob) };
}

// ---------------------------------------------------------------- time & amounts

export const RIPPLE_EPOCH = 946684800;
export const toRippleTime = (unix) => Math.floor(unix) - RIPPLE_EPOCH;
export const fromRippleTime = (rt) => rt + RIPPLE_EPOCH;

export function xrpToDrops(str) {
  const s = String(str).trim().replace(",", ".");
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error("Use a number with up to 6 decimals, e.g. 25 or 12.5");
  const [i, f = ""] = s.split(".");
  return (BigInt(i) * 1000000n + BigInt(f.padEnd(6, "0"))).toString();
}

export function dropsToXrp(drops) {
  const d = BigInt(drops);
  const i = d / 1000000n;
  const f = (d % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return f ? `${i}.${f}` : `${i}`;
}

// ---------------------------------------------------------------- JSON-RPC client

export class XrplClient {
  constructor(url) {
    this.url = url;
  }

  async request(method, params = {}) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params: [params] }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`XRPL ${method}: HTTP ${res.status}`);
    const { result } = await res.json();
    if (result?.status === "error") {
      const err = new Error(`XRPL ${method}: ${result.error_message || result.error}`);
      err.code = result.error;
      throw err;
    }
    return result;
  }

  async accountInfo(address) {
    try {
      return (await this.request("account_info", { account: address, ledger_index: "current" })).account_data;
    } catch (e) {
      if (e.code === "actNotFound") return null;
      throw e;
    }
  }

  async currentLedger() {
    return (await this.request("ledger_current")).ledger_current_index;
  }

  async fee() {
    const r = await this.request("fee");
    // open ledger fee, never below 12 drops, capped so a fee spike can't drain the wallet
    const open = Number(r.drops?.open_ledger_fee || 12);
    return String(Math.min(Math.max(open, 12), 5000));
  }

  /** Fill Sequence, Fee and LastLedgerSequence, sign, submit, and wait for a final result. */
  async submitAndWait(tx, wallet, { onSigned } = {}) {
    const info = await this.accountInfo(wallet.address);
    if (!info) throw new Error(`Bot account ${wallet.address} isn't funded yet`);
    const ledger = await this.currentLedger();
    const full = {
      ...tx,
      Account: wallet.address,
      Sequence: info.Sequence,
      Fee: await this.fee(),
      LastLedgerSequence: ledger + 20,
    };
    if (full.Flags === undefined) full.Flags = 0;
    const { blob, hash } = sign(full, wallet);
    // Let the caller record the hash first, so a crash mid-submit can't cause a double send.
    if (onSigned) await onSigned({ hash, sequence: full.Sequence, lastLedger: full.LastLedgerSequence });
    const sub = await this.request("submit", { tx_blob: blob });
    const prelim = sub.engine_result;
    // tel/tem/tef codes mean it was rejected outright and will never be included.
    if (/^(tem|tef|tel)/.test(prelim)) {
      const err = new Error(`Rejected: ${prelim} ${sub.engine_result_message || ""}`.trim());
      err.rejected = true; // definitely not on the ledger
      throw err;
    }

    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      let t;
      try {
        t = await this.request("tx", { transaction: hash });
      } catch (e) {
        if (e.code !== "txnNotFound") throw e;
      }
      if (t?.validated) {
        const result = t.meta?.TransactionResult;
        if (result !== "tesSUCCESS") {
          const err = new Error(`Failed on ledger: ${result} (tx ${hash})`);
          err.rejected = true; // final: included but failed, nothing moved
          err.result = result;
          throw err;
        }
        return { hash, sequence: full.Sequence, tx: t };
      }
      if ((await this.currentLedger()) > full.LastLedgerSequence + 1) {
        const err = new Error(`Expired without being included (tx ${hash}, first result ${prelim})`);
        err.rejected = true;
        throw err;
      }
    }
    throw new Error(`Timed out waiting for tx ${hash}`);
  }

  /** Incoming validated XRP payments to `address`, newest first. */
  async incomingPayments(address, limit = 100) {
    const r = await this.request("account_tx", { account: address, ledger_index_min: -1, ledger_index_max: -1, limit, forward: false });
    const out = [];
    for (const { tx, tx_json, meta, hash, validated, close_time_iso } of r.transactions || []) {
      const t = tx_json || tx;
      if (!validated || !t || t.TransactionType !== "Payment" || t.Destination !== address) continue;
      if (meta?.TransactionResult !== "tesSUCCESS") continue;
      // Always use delivered_amount: Amount can lie with partial payments.
      const delivered = meta.delivered_amount ?? meta.DeliveredAmount;
      if (typeof delivered !== "string") continue; // not XRP
      out.push({ hash: hash || t.hash, from: t.Account, tag: t.DestinationTag, drops: delivered, time: close_time_iso });
    }
    return out;
  }
}
