"use strict";
// POST {imageBase64, mime, name, symbol, description, website?, twitter?} -> {uri, image}
const { uploadCoin } = require("./_lib/ipfs");
const { HttpError } = require("./_lib/errors");
const { readJson, send } = require("./_lib/http");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  try {
    const body = await readJson(req, 1.5 * 1024 * 1024);
    const out = await uploadCoin(body);
    return send(res, 200, out);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) console.error("[upload]", e);
    return send(res, status, { error: e.message || "internal error" });
  }
};
