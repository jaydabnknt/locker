// Minimal read-only Solana client for the token_locker program.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const WSOL = "So11111111111111111111111111111111111111112";

// sha256("account:LockAccount")[0..8]
const LOCK_DISCRIMINATOR = Buffer.from("df40477cff5676c0", "hex");
const LOCK_ACCOUNT_SIZE = 8 + 32 + 32 + 8 + 8 + 8 + 1 + 1; // 98

export function base58Encode(buf) {
  let n = BigInt("0x" + (Buffer.from(buf).toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function base58Decode(str) {
  let n = 0n;
  for (const c of str) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(v);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const body = n === 0n ? [] : [...Buffer.from(hex, "hex")];
  const zeros = str.match(/^1*/)[0].length;
  return Buffer.from([...new Array(zeros).fill(0), ...body]);
}

export function isSolanaAddress(s) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return base58Decode(s).length === 32;
  } catch {
    return false;
  }
}

let rpcId = 0;
async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Solana RPC ${method} HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`Solana RPC ${method}: ${body.error.message}`);
  return body.result;
}

/** All open locks owned by `owner`. Withdrawn locks are closed on-chain, so they simply disappear. */
export async function getLocks(sol, owner) {
  const accounts = await rpc(sol.rpc, "getProgramAccounts", [
    sol.programId,
    {
      encoding: "base64",
      filters: [
        { dataSize: LOCK_ACCOUNT_SIZE },
        { memcmp: { offset: 0, bytes: base58Encode(LOCK_DISCRIMINATOR) } },
        { memcmp: { offset: 8, bytes: owner } },
      ],
    },
  ]);

  return accounts.map(({ pubkey, account }) => {
    const d = Buffer.from(account.data[0], "base64");
    return {
      id: d.readBigUInt64LE(72).toString(),
      address: pubkey,
      owner: base58Encode(d.subarray(8, 40)),
      mint: base58Encode(d.subarray(40, 72)),
      amount: d.readBigUInt64LE(80),
      unlockTime: Number(d.readBigInt64LE(88)),
      withdrawn: false,
    };
  });
}

const mintCache = new Map();

export async function getMintInfo(sol, mint) {
  if (mintCache.has(mint)) return mintCache.get(mint);
  let info = { decimals: 0, symbol: mint.slice(0, 4) + "…" + mint.slice(-4) };
  try {
    const r = await rpc(sol.rpc, "getAccountInfo", [mint, { encoding: "jsonParsed" }]);
    info.decimals = r?.value?.data?.parsed?.info?.decimals ?? 0;
  } catch {}
  if (mint === WSOL) info.symbol = "SOL";
  const known = sol.knownMints?.[mint];
  if (known) info.symbol = known;
  mintCache.set(mint, info);
  return info;
}
