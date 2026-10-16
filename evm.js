// Minimal read-only EVM client: raw JSON-RPC + hand-rolled ABI decoding.
// No dependencies; selectors are precomputed (see README "Interface").

const SEL = {
  lockIdsOf: "e5edb818",
  locks: "f4dadc61",
  decimals: "313ce567",
  symbol: "95d89b41",
};

let rpcId = 0;
async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
  return body.result;
}

const pad = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const word = (hex, i) => hex.slice(i * 64, (i + 1) * 64);

async function call(chain, data) {
  const out = await rpc(chain.rpc, "eth_call", [{ to: chain.locker, data: "0x" + data }, "latest"]);
  return out.replace(/^0x/, "");
}

async function callTo(chain, to, data) {
  const out = await rpc(chain.rpc, "eth_call", [{ to, data: "0x" + data }, "latest"]);
  return out.replace(/^0x/, "");
}

export function isEvmAddress(s) {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

/** @returns {Promise<Array<{id:string, token:string, amount:bigint, unlockTime:number, withdrawn:boolean}>>} */
export async function getLocks(chain, owner) {
  const idsHex = await call(chain, SEL.lockIdsOf + pad(owner));
  // dynamic uint256[]: [offset][length][items...]
  const len = Number(BigInt("0x" + word(idsHex, 1)));
  const ids = [];
  for (let i = 0; i < len; i++) ids.push(BigInt("0x" + word(idsHex, 2 + i)));

  const locks = [];
  for (const id of ids) {
    const h = await call(chain, SEL.locks + pad(id.toString(16)));
    // (address owner, address token, uint128 amount, uint64 unlockTime, bool withdrawn)
    locks.push({
      id: id.toString(),
      owner: "0x" + word(h, 0).slice(24),
      token: "0x" + word(h, 1).slice(24),
      amount: BigInt("0x" + word(h, 2)),
      unlockTime: Number(BigInt("0x" + word(h, 3))),
      withdrawn: BigInt("0x" + word(h, 4)) !== 0n,
    });
  }
  return locks;
}

const tokenCache = new Map();

/** Decimals + symbol for a token (native coin when token is the zero address). */
export async function getTokenInfo(chain, token) {
  if (/^0x0{40}$/.test(token)) return { decimals: 18, symbol: chain.nativeSymbol || "ETH" };
  const key = chain.key + ":" + token.toLowerCase();
  if (tokenCache.has(key)) return tokenCache.get(key);

  let decimals = 18;
  let symbol = token.slice(0, 6) + "…" + token.slice(-4);
  try {
    decimals = Number(BigInt("0x" + (await callTo(chain, token, SEL.decimals)).slice(0, 64)));
  } catch {}
  try {
    symbol = decodeString(await callTo(chain, token, SEL.symbol)) || symbol;
  } catch {}
  const info = { decimals, symbol };
  tokenCache.set(key, info);
  return info;
}

function decodeString(h) {
  if (h.length === 64) {
    // some old tokens return bytes32
    return Buffer.from(h, "hex").toString("utf8").replace(/\0+$/, "");
  }
  const len = Number(BigInt("0x" + word(h, 1)));
  return Buffer.from(h.slice(128, 128 + len * 2), "hex").toString("utf8");
}
