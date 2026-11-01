"use strict";
// POST {owner, mint, name, symbol, uri, buyStonk?} -> {tx (base64 unsigned v0), blockhash, poolId, mint}
const { buildLaunchTx, HttpError } = require("./_lib/stonkfun");
const { readJson, send } = require("./_lib/http");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  try {
    const body = await readJson(req, 64 * 1024);
    const out = await buildLaunchTx(body);
    return send(res, 200, out);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) console.error("[build]", e);
    return send(res, status, { error: e.message || "internal error" });
  }
};
