"use strict";
/**
 * SIGNET server core: builds an unsigned StonkFun (Raydium LaunchLab) create
 * transaction for a caller-supplied (vanity) mint pubkey.
 *
 * The mint secret never touches the server. The instruction marks the mint as
 * a signer; the browser partially signs with the ground keypair, then the
 * wallet (fee payer + creator) signs and sends.
 */
const { Connection, PublicKey, VersionedTransaction } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require("@solana/spl-token");
const BN = require("bn.js");
const {
  Raydium,
  TxVersion,
  LAUNCHPAD_PROGRAM,
  LaunchpadConfig,
  PlatformConfig,
  CpmmCreatorFeeOn,
} = require("@raydium-io/raydium-sdk-v2");

// ---- StonkFun constants (verified live by the operator) --------------------
const STONKFUN = {
  platformId: new PublicKey("6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt"),
  configId: new PublicKey("4Rb2joMnuDt9zRPuTYxUjQRGQ8oNBbKdXnCJSCojvBsW"),
  mintB: new PublicKey("6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx"), // STONK, classic SPL
  mintBDecimals: 9,
  mintBProgram: TOKEN_PROGRAM_ID,
  decimals: 6,
  transferFeeBasePoints: 300,
  // ASSUMPTION: maxinumFee (sic, SDK spelling). Overridden by the reference row if reachable.
  maxinumFee: "1000000000000000",
  referenceMint: "9b7mM5nbaxPRyTQSQeBMyq3feYGeSvBbTE2M6nojTcqD",
  createdOn: "https://www.stonkfun.xyz",
};

const URLS = {
  stonkPricing: (q) => `https://www.stonkfun.xyz/api/public/v1/launchlab/pricing?quoteMint=${q}`,
  raydiumRow: (m) => `https://launch-mint-v1.raydium.io/get/by/mints?ids=${m}`,
  raydiumConfigs: "https://launch-mint-v1.raydium.io/main/configs",
};

const { HttpError } = require("./errors");

// ---- validation -------------------------------------------------------------
const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
function parsePubkey(field, v) {
  if (typeof v !== "string" || v.length < 32 || v.length > 44 || !B58.test(v))
    throw new HttpError(400, `${field} must be a base58 public key`);
  let pk;
  try {
    pk = new PublicKey(v);
  } catch {
    throw new HttpError(400, `${field} is not a valid public key`);
  }
  if (pk.toBase58() !== v) throw new HttpError(400, `${field} is not canonical base58`);
  return pk;
}

function validateBuildInput(body) {
  if (!body || typeof body !== "object") throw new HttpError(400, "JSON body required");
  const owner = parsePubkey("owner", body.owner);
  const mint = parsePubkey("mint", body.mint);
  if (owner.equals(mint)) throw new HttpError(400, "mint must differ from owner");

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const symbol = typeof body.symbol === "string" ? body.symbol.trim() : "";
  const uri = typeof body.uri === "string" ? body.uri.trim() : "";
  if (!name || Buffer.byteLength(name, "utf8") > 32) throw new HttpError(400, "name required, max 32 bytes");
  if (!symbol || Buffer.byteLength(symbol, "utf8") > 10) throw new HttpError(400, "symbol required, max 10 bytes");
  if (!/^https:\/\/[^\s]+$/.test(uri) || uri.length > 200) throw new HttpError(400, "uri must be https and ≤200 chars");
  try {
    new URL(uri);
  } catch {
    throw new HttpError(400, "uri is not a valid URL");
  }

  // buyStonk: optional initial buy in whole/decimal STONK (string or number), converted to raw (9 dp).
  let buyRaw = new BN(0);
  if (body.buyStonk !== undefined && body.buyStonk !== null && body.buyStonk !== "" && Number(body.buyStonk) !== 0) {
    const s = String(body.buyStonk).trim();
    if (!/^\d+(\.\d{1,9})?$/.test(s)) throw new HttpError(400, "buyStonk must be a positive decimal (≤9 dp)");
    const [i, f = ""] = s.split(".");
    buyRaw = new BN(i + f.padEnd(9, "0"));
    if (buyRaw.lte(new BN(0))) buyRaw = new BN(0);
    if (buyRaw.gt(new BN("1000000000000000000"))) throw new HttpError(400, "buyStonk too large");
  }
  return { owner, mint, name, symbol, uri, buyRaw };
}

// ---- launch shape (supply / totalSellA / totalFundRaisingB) -----------------
async function getJson(fetchImpl, url, timeoutMs = 6000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { signal: ac.signal, headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

const isRawInt = (v) => (typeof v === "string" || typeof v === "number") && /^\d+$/.test(String(v)) && BigInt(String(v)) > 0n;

/** Raydium rows sometimes carry UI amounts (supply: 1000000000). Scale to raw if they look like UI units. */
function toRawA(v, decimals) {
  const s = String(v);
  if (!isRawInt(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return null;
    return new BN(Math.round(n * 10 ** decimals).toString());
  }
  const b = new BN(s);
  return b.lt(new BN(10).pow(new BN(12))) ? b.mul(new BN(10).pow(new BN(decimals))) : b;
}

/**
 * Resolve the exact launch shape StonkFun uses, in priority order:
 *  1. StonkFun's own GET /launchlab/pricing?quoteMint=STONK (curve.supply, curve.totalSellA, raise.raw)
 *  2. Raydium's row for a real StonkFun coin (the reference mint)
 *  3. Raydium configs API defaultParams for the configId
 * Never falls back to the SDK's 85-SOL constant (wrong units for STONK).
 */
async function resolveLaunchShape({ fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  const errors = [];
  // 1. StonkFun pricing
  try {
    const j = await getJson(fetchImpl, URLS.stonkPricing(STONKFUN.mintB.toBase58()));
    const p = j && j.data ? j.data : j;
    if (p && p.curve && p.raise && isRawInt(p.curve.supply) && isRawInt(p.curve.totalSellA) && isRawInt(p.raise.raw)) {
      if (p.curve.configId && p.curve.configId !== STONKFUN.configId.toBase58())
        errors.push(`stonkfun pricing configId ${p.curve.configId} != expected ${STONKFUN.configId.toBase58()}`);
      const modes = p.platform ? Object.keys(p.platform).filter((k) => p.platform[k] === STONKFUN.platformId.toBase58()) : [];
      return {
        source: "stonkfun-pricing",
        supply: new BN(String(p.curve.supply)),
        totalSellA: new BN(String(p.curve.totalSellA)),
        totalFundRaisingB: new BN(String(p.raise.raw)),
        maxinumFee: STONKFUN.maxinumFee,
        platformMode: modes[0] || null,
        allowedFeeBps: (p.modes && p.modes.reward && p.modes.reward.transferFeeBps) || null,
        warnings: errors,
      };
    }
    errors.push("stonkfun pricing: unexpected shape");
  } catch (e) {
    errors.push(`stonkfun pricing: ${e.message}`);
  }
  // 2. Raydium row for the reference coin
  try {
    const j = await getJson(fetchImpl, URLS.raydiumRow(STONKFUN.referenceMint));
    const rows = (j && j.data && (j.data.rows || j.data.data || j.data)) || [];
    const row = Array.isArray(rows) ? rows.find((r) => r && r.mint === STONKFUN.referenceMint) || rows[0] : null;
    if (row && row.totalFundRaisingB && row.totalSellA && row.supply) {
      if (row.configId && row.configId !== STONKFUN.configId.toBase58()) errors.push(`reference row configId ${row.configId} differs`);
      if (row.platformInfo && row.platformInfo.pubKey && row.platformInfo.pubKey !== STONKFUN.platformId.toBase58())
        errors.push(`reference row platformId ${row.platformInfo.pubKey} differs`);
      const supply = toRawA(row.supply, row.decimals ?? STONKFUN.decimals);
      const totalSellA = toRawA(row.totalSellA, row.decimals ?? STONKFUN.decimals);
      if (supply && totalSellA && isRawInt(row.totalFundRaisingB)) {
        return {
          source: "raydium-reference-row",
          supply,
          totalSellA,
          totalFundRaisingB: new BN(String(row.totalFundRaisingB)),
          maxinumFee: isRawInt(row.maxinumFee) ? String(row.maxinumFee) : STONKFUN.maxinumFee,
          transferFeeBasePoints: Number.isInteger(row.transferFeeBasePoints) ? row.transferFeeBasePoints : undefined,
          cpmmCreatorFeeOn: Number.isInteger(row.cpmmCreatorFeeOn) ? row.cpmmCreatorFeeOn : undefined,
          platformMode: null,
          warnings: errors,
        };
      }
    }
    errors.push("raydium reference row: unexpected shape");
  } catch (e) {
    errors.push(`raydium reference row: ${e.message}`);
  }
  // 3. Raydium configs defaultParams
  try {
    const j = await getJson(fetchImpl, URLS.raydiumConfigs);
    const list = (j && j.data && (j.data.data || j.data)) || [];
    const c = Array.isArray(list) ? list.find((x) => x && x.key && x.key.pubKey === STONKFUN.configId.toBase58()) : null;
    const d = c && c.defaultParams;
    if (d && isRawInt(d.supplyInit) && isRawInt(d.totalSellA) && isRawInt(d.totalFundRaisingB)) {
      return {
        source: "raydium-config-defaults",
        supply: new BN(String(d.supplyInit)),
        totalSellA: new BN(String(d.totalSellA)),
        totalFundRaisingB: new BN(String(d.totalFundRaisingB)),
        maxinumFee: STONKFUN.maxinumFee,
        platformMode: null,
        warnings: errors,
      };
    }
    errors.push("raydium configs: StonkFun config not listed");
  } catch (e) {
    errors.push(`raydium configs: ${e.message}`);
  }
  log(errors);
  throw new HttpError(503, `could not resolve StonkFun launch shape: ${errors.join("; ")}`);
}

// ---- tx build ---------------------------------------------------------------
function heliusConnection() {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new HttpError(500, "HELIUS_API_KEY not set");
  return new Connection(`https://mainnet.helius-rpc.com/?api-key=${key}`, "confirmed");
}

/**
 * @param {object} body  {owner, mint, name, symbol, uri, buyStonk?}
 * @param {object} deps  {connection?, fetchImpl?, shape?} — injectable for tests
 */
async function buildLaunchTx(body, deps = {}) {
  const input = validateBuildInput(body);
  const connection = deps.connection || heliusConnection();

  // The mint must be fresh (a reused/collided vanity key would fail on-chain).
  const [mintAcc, cfgAcc, platAcc] = await connection.getMultipleAccountsInfo([
    input.mint,
    STONKFUN.configId,
    STONKFUN.platformId,
  ]);
  if (mintAcc) throw new HttpError(409, "mint account already exists — grind a new key");
  if (!cfgAcc) throw new HttpError(502, "StonkFun LaunchLab config not found on-chain");
  if (!platAcc) throw new HttpError(502, "StonkFun platform account not found on-chain");
  if (!cfgAcc.owner.equals(LAUNCHPAD_PROGRAM) || !platAcc.owner.equals(LAUNCHPAD_PROGRAM))
    throw new HttpError(502, "config/platform not owned by the LaunchLab program");

  const configInfo = LaunchpadConfig.decode(cfgAcc.data);
  if (!configInfo.mintB.equals(STONKFUN.mintB)) throw new HttpError(502, "config mintB is not STONK");
  if (configInfo.curveType !== 0) throw new HttpError(502, "config is not a constant-product curve");
  const platform = PlatformConfig.decode(platAcc.data);

  const shape = deps.shape || (await resolveLaunchShape({ fetchImpl: deps.fetchImpl }));
  const feeBps = shape.transferFeeBasePoints ?? STONKFUN.transferFeeBasePoints;

  const raydium = await Raydium.load({
    connection,
    owner: input.owner,
    cluster: "mainnet",
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: "confirmed",
  });
  // The SDK always calls fetchLaunchConfigs()/getTokenInfo(); we already know the answers,
  // so short-circuit them (no extra HTTP from the function, no dependency on Raydium's API being up).
  raydium.api.fetchLaunchConfigs = async () => [
    {
      key: { pubKey: STONKFUN.configId.toBase58() },
      defaultParams: {
        supplyInit: shape.supply.toString(),
        totalSellA: shape.totalSellA.toString(),
        totalFundRaisingB: shape.totalFundRaisingB.toString(),
      },
    },
  ];
  raydium.token.getTokenInfo = async () => ({
    address: STONKFUN.mintB.toBase58(),
    decimals: STONKFUN.mintBDecimals,
    programId: STONKFUN.mintBProgram.toBase58(),
  });

  const createOnly = input.buyRaw.isZero();
  const priority = Number(process.env.SIGNET_PRIORITY_MICROLAMPORTS || 50000);

  let built;
  try {
    built = await raydium.launchpad.createLaunchpad({
      programId: LAUNCHPAD_PROGRAM,
      mintA: input.mint,
      decimals: STONKFUN.decimals,
      name: input.name,
      symbol: input.symbol,
      uri: input.uri,
      migrateType: "cpmm",
      configId: STONKFUN.configId,
      configInfo,
      platformId: STONKFUN.platformId,
      mintBDecimals: STONKFUN.mintBDecimals,
      mintBProgram: STONKFUN.mintBProgram,
      skipCheckMintB: true,
      token2022: true,
      transferFeeExtensionParams: {
        transferFeeBasePoints: feeBps,
        maxinumFee: new BN(shape.maxinumFee || STONKFUN.maxinumFee),
      },
      creatorFeeOn: shape.cpmmCreatorFeeOn ?? CpmmCreatorFeeOn.OnlyTokenB,
      // remaining accounts the program checks when the platform restricts configs/curves
      platformAllowConfig: platform.restrictGlobalConfig === 1,
      supply: shape.supply,
      totalSellA: shape.totalSellA,
      totalFundRaisingB: shape.totalFundRaisingB,
      totalLockedAmount: new BN(0),
      cliffPeriod: new BN(0),
      unlockPeriod: new BN(0),
      createOnly,
      buyAmount: createOnly ? new BN(0) : input.buyRaw,
      slippage: new BN(300), // 3% on the optional dev buy
      feePayer: input.owner,
      txVersion: TxVersion.V0,
      computeBudgetConfig: { units: createOnly ? 300_000 : 600_000, microLamports: priority },
    });
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/buy token accounts/.test(m)) throw new HttpError(400, "wallet has no STONK token account — drop buyStonk or fund the wallet with STONK");
    throw new HttpError(400, `SDK refused the launch params: ${m}`);
  }

  const txs = built.transactions;
  if (!txs.length) throw new HttpError(500, "SDK returned no transaction");
  if (txs.length > 1) throw new HttpError(400, "create + buy does not fit one transaction — lower or drop buyStonk");
  const tx = txs[0];
  if (!(tx instanceof VersionedTransaction)) throw new HttpError(500, "expected a VersionedTransaction");
  if (!tx.message.staticAccountKeys[0].equals(input.owner)) throw new HttpError(500, "fee payer mismatch");

  const addr = built.extInfo.address;
  return {
    tx: Buffer.from(tx.serialize()).toString("base64"),
    blockhash: tx.message.recentBlockhash,
    poolId: addr.poolId.toBase58(),
    mint: input.mint.toBase58(),
    shapeSource: shape.source,
    warnings: shape.warnings || [],
  };
}

module.exports = {
  STONKFUN,
  URLS,
  HttpError,
  validateBuildInput,
  resolveLaunchShape,
  buildLaunchTx,
  TOKEN_2022_PROGRAM_ID,
};
