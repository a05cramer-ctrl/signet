"use strict";
const { HttpError } = require("./errors");

const MAX_IMAGE = 1024 * 1024;
const ADD_URL = "https://rpc.filebase.io/api/v0/add?cid-version=1";
const GATEWAY = "https://ipfs.filebase.io/ipfs/";

/** Sniff the real type from magic bytes; the client's mime is not trusted. */
function sniff(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return { mime: "image/png", ext: "png" };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buf.length > 6 && (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a")) return { mime: "image/gif", ext: "gif" };
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}

const str = (v, max, field, required = false) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (required && !s) throw new HttpError(400, `${field} required`);
  if (Buffer.byteLength(s, "utf8") > max) throw new HttpError(400, `${field} max ${max} bytes`);
  return s;
};
const optUrl = (v, field) => {
  const s = str(v, 200, field);
  if (!s) return undefined;
  let u;
  try { u = new URL(s); } catch { throw new HttpError(400, `${field} must be a URL`); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new HttpError(400, `${field} must be http(s)`);
  return u.toString();
};

function validateUploadInput(body) {
  if (!body || typeof body !== "object") throw new HttpError(400, "JSON body required");
  const name = str(body.name, 32, "name", true);
  const symbol = str(body.symbol, 10, "symbol", true);
  const description = str(body.description, 1000, "description");
  const website = optUrl(body.website, "website");
  let twitter = str(body.twitter, 200, "twitter") || undefined;
  if (twitter && !/^https?:\/\//.test(twitter)) twitter = `https://x.com/${twitter.replace(/^@/, "")}`;
  if (twitter) twitter = optUrl(twitter, "twitter");

  const b64 = typeof body.imageBase64 === "string" ? body.imageBase64.replace(/^data:[^,]*,/, "") : "";
  if (!b64) throw new HttpError(400, "imageBase64 required");
  if (b64.length > Math.ceil((MAX_IMAGE * 4) / 3) + 4) throw new HttpError(413, "image must be ≤ 1 MB");
  const img = Buffer.from(b64, "base64");
  if (!img.length || img.length > MAX_IMAGE) throw new HttpError(413, "image must be ≤ 1 MB");
  const kind = sniff(img);
  if (!kind) throw new HttpError(415, "image must be png, jpg, gif or webp");
  if (body.mime && body.mime !== kind.mime && !(body.mime === "image/jpg" && kind.mime === "image/jpeg"))
    throw new HttpError(415, `mime says ${body.mime} but file is ${kind.mime}`);
  return { name, symbol, description, website, twitter, img, kind };
}

async function ipfsAdd(buf, filename, mime, { fetchImpl = globalThis.fetch, token = process.env.FILEBASE_IPFS_TOKEN } = {}) {
  if (!token) throw new HttpError(500, "FILEBASE_IPFS_TOKEN not set");
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: mime }), filename);
  const r = await fetchImpl(ADD_URL, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
  const text = await r.text();
  if (!r.ok) throw new HttpError(502, `Filebase add failed (HTTP ${r.status})`);
  // Kubo RPC returns one JSON object per line; take the last one.
  const line = text.trim().split("\n").filter(Boolean).pop();
  let j;
  try { j = JSON.parse(line); } catch { throw new HttpError(502, "Filebase returned non-JSON"); }
  if (!j.Hash) throw new HttpError(502, "Filebase response had no Hash");
  return j.Hash;
}

async function uploadCoin(body, deps = {}) {
  const v = validateUploadInput(body);
  const safe = v.symbol.replace(/[^A-Za-z0-9]/g, "") || "coin";
  const imgCid = await ipfsAdd(v.img, `${safe}.${v.kind.ext}`, v.kind.mime, deps);
  const image = GATEWAY + imgCid;
  const meta = { name: v.name, symbol: v.symbol, description: v.description, image, createdOn: "https://www.stonkfun.xyz" };
  if (v.website) meta.website = v.website;
  if (v.twitter) meta.twitter = v.twitter;
  const metaCid = await ipfsAdd(Buffer.from(JSON.stringify(meta)), `${safe}.json`, "application/json", deps);
  return { uri: GATEWAY + metaCid, image, metadata: meta };
}

module.exports = { uploadCoin, validateUploadInput, ipfsAdd, sniff, ADD_URL, GATEWAY };
