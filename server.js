// Serves the signing page and its public network config. No user data here.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const SOLANA_PUBLIC_RPC = {
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
};

/** Only what the browser needs. Server-side RPC URLs (which may carry API keys) stay private. */
export function publicConfig(config) {
  return {
    evm: (config.evm || []).map((c) => ({
      key: c.key,
      name: c.name,
      chainId: c.chainId,
      locker: c.locker,
      explorer: c.explorer,
      nativeSymbol: c.nativeSymbol || "ETH",
      publicRpc: c.publicRpc || null,
    })),
    solana: config.solana
      ? {
          name: config.solana.name || "Solana",
          cluster: config.solana.cluster || "mainnet-beta",
          programId: config.solana.programId,
          explorer: config.solana.explorer || "https://solscan.io",
          publicRpc: config.solana.publicRpc || SOLANA_PUBLIC_RPC[config.solana.cluster || "mainnet-beta"],
        }
      : null,
  };
}

export function startServer({ config, root }) {
  const page = path.join(root, "page.html");
  const cfgJson = JSON.stringify(publicConfig(config));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const common = {
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-cache",
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, common).end();
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { ...common, "content-type": "text/html; charset=utf-8" });
      fs.createReadStream(page).pipe(res);
    } else if (url.pathname === "/config.json") {
      res.writeHead(200, { ...common, "content-type": "application/json" }).end(cfgJson);
    } else if (url.pathname === "/health") {
      res.writeHead(200, { ...common, "content-type": "text/plain" }).end("ok");
    } else {
      res.writeHead(404, common).end("not found");
    }
  });
  server.listen(config.port, () => console.log("HTTP server on port", config.port));
  return server;
}
