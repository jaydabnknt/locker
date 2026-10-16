// Gathers a user's locks across every linked wallet and configured network.

import * as evm from "./evm.js";
import * as solana from "./solana.js";

export function formatUnits(amount, decimals) {
  const neg = amount < 0n;
  let s = (neg ? -amount : amount).toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals) || "0";
  let frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  if (frac.length > 6) frac = frac.slice(0, 6);
  const intFmt = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + intFmt + (frac ? "." + frac : "");
}

export function formatDuration(seconds) {
  if (seconds <= 0) return "now";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d >= 2) return `${d}d ${h}h`;
  if (d === 1) return `1d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${Math.max(m, 1)}m`;
}

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * @returns {Promise<{locks: Array<object>, errors: string[]}>}
 * Each lock: { key, net, netName, wallet, id, token, symbol, decimals, amount, unlockTime, withdrawn }
 */
export async function collectLocks(config, wallets) {
  const jobs = [];
  for (const w of wallets) {
    if (w.type === "evm") {
      for (const chain of config.evm || []) {
        jobs.push(
          evm.getLocks(chain, w.address).then(async (list) =>
            Promise.all(
              list.map(async (l) => {
                const t = await evm.getTokenInfo(chain, l.token);
                return {
                  key: `evm:${chain.key}:${l.id}`,
                  net: chain.key,
                  netName: chain.name,
                  wallet: w.address,
                  id: l.id,
                  token: l.token,
                  ...t,
                  amount: l.amount,
                  unlockTime: l.unlockTime,
                  withdrawn: l.withdrawn,
                };
              }),
            ),
          ).catch((e) => Promise.reject(new Error(`${chain.name}: ${e.message}`))),
        );
      }
    } else if (w.type === "solana" && config.solana) {
      const sol = config.solana;
      jobs.push(
        solana.getLocks(sol, w.address).then(async (list) =>
          Promise.all(
            list.map(async (l) => {
              const t = await solana.getMintInfo(sol, l.mint);
              return {
                key: `sol:${l.address}`,
                net: "solana",
                netName: sol.name || "Solana",
                wallet: w.address,
                id: l.id,
                token: l.mint,
                ...t,
                amount: l.amount,
                unlockTime: l.unlockTime,
                withdrawn: false,
              };
            }),
          ),
        ).catch((e) => Promise.reject(new Error(`${sol.name || "Solana"}: ${e.message}`))),
      );
    }
  }

  const results = await Promise.allSettled(jobs);
  const locks = [];
  const errors = [];
  for (const r of results) {
    if (r.status === "fulfilled") locks.push(...r.value);
    else errors.push(r.reason.message);
  }
  locks.sort((a, b) => a.unlockTime - b.unlockTime);
  return { locks, errors };
}
