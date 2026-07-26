/**
 * TradingView webhook receiver for Sovereign Capital Engine.
 *
 * TradingView alerts POST here. The request is authenticated with a shared
 * secret (TV_WEBHOOK_SECRET) supplied either as a `?secret=` query parameter
 * or inside the JSON alert payload as `secret`. The secret is compared using a
 * constant-time check and is never persisted alongside the stored signal.
 *
 * Each accepted signal is written to its OWN blob key. Earlier versions read
 * a single array, mutated it and wrote it back, which meant two alerts firing
 * in the same moment could silently overwrite one another. Writing one key per
 * signal removes the read-modify-write entirely, so concurrent alerts cannot
 * clobber each other.
 *
 * Keys are `sig:<ISO timestamp>:<random>`, so a plain lexicographic sort of the
 * key list is also a chronological sort.
 */

const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");

const STORE_NAME = "tradingview-signals";
const SIGNAL_PREFIX = "sig:";
const MAX_SIGNALS = 500;

// Listing every key on each webhook adds latency to a request TradingView
// expects to finish quickly, so pruning runs on a fraction of writes instead
// of every one. History drifts slightly above MAX_SIGNALS between prunes.
const PRUNE_PROBABILITY = 0.1;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  };
}

/**
 * Constant-time string comparison that does not leak length through early
 * return timing beyond what the digest already normalizes.
 */
function safeEqual(a, b) {
  const aBuf = crypto.createHash("sha256").update(String(a)).digest();
  const bBuf = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Opens the blob store, falling back to explicit credentials when Netlify
 * does not inject the Blobs environment automatically.
 */
function openStore() {
  const siteID = process.env.BLOBS_SITE_ID || process.env.SITE_ID;
  const token = process.env.BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;

  const options = { name: STORE_NAME, consistency: "strong" };

  if (siteID && token) {
    options.siteID = siteID;
    options.token = token;
  }

  return getStore(options);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const expectedSecret = process.env.TV_WEBHOOK_SECRET;

  if (!expectedSecret) {
    return json(500, { error: "TV_WEBHOOK_SECRET is not configured" });
  }

  let payload = {};

  if (event.body) {
    try {
      payload = JSON.parse(event.body);
    } catch (error) {
      return json(400, { error: "Invalid JSON body" });
    }
  }

  const queryParams = event.queryStringParameters || {};
  const providedSecret = queryParams.secret || payload.secret;

  if (!providedSecret || !safeEqual(providedSecret, expectedSecret)) {
    return json(401, { error: "Unauthorized" });
  }

  // Strip the secret before persisting so it is never stored with the signal.
  const { secret, ...signalData } = payload;

  const receivedAt = new Date().toISOString();

  const signal = {
    id:
      Date.now().toString(36) +
      crypto.randomBytes(4).toString("hex"),
    receivedAt,
    ...signalData
  };

  // Timestamp first so lexicographic key order equals chronological order.
  // The random suffix keeps two signals in the same millisecond distinct.
  const key =
    SIGNAL_PREFIX + receivedAt + ":" + crypto.randomBytes(4).toString("hex");

  try {
    const store = openStore();

    // Single write, no prior read. Nothing to overwrite, nothing to race.
    await store.setJSON(key, signal);
  } catch (error) {
    console.error("TV webhook store error:", error);
    return json(502, { error: "Failed to store signal", detail: String(error) });
  }

  // Pruning is best-effort and must never fail the webhook: TradingView marks
  // a non-200 as a failed delivery, and the signal is already safely stored.
  if (Math.random() < PRUNE_PROBABILITY) {
    try {
      await pruneOldSignals();
    } catch (error) {
      console.error("Prune failed (signal was still stored):", error);
    }
  }

  return json(200, { ok: true, id: signal.id, key });
};

/**
 * Deletes the oldest keys beyond MAX_SIGNALS.
 *
 * Deletes are idempotent, so two concurrent prunes targeting the same key are
 * harmless — the second is a no-op rather than a conflict.
 */
async function pruneOldSignals() {
  const store = openStore();

  const { blobs } = await store.list({ prefix: SIGNAL_PREFIX });

  if (!Array.isArray(blobs) || blobs.length <= MAX_SIGNALS) {
    return;
  }

  // Ascending key order is ascending time order, so the oldest sort first.
  const keys = blobs.map((blob) => blob.key).sort();
  const excess = keys.slice(0, keys.length - MAX_SIGNALS);

  await Promise.all(
    excess.map((oldKey) =>
      store.delete(oldKey).catch((error) => {
        console.error("Could not delete " + oldKey + ":", error);
      })
    )
  );
}
