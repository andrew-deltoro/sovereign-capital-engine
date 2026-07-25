/**
 * TradingView webhook receiver for Sovereign Capital Engine.
 *
 * TradingView alerts POST here. The request is authenticated with a shared
 * secret (TV_WEBHOOK_SECRET) supplied either as a `?secret=` query parameter
 * or inside the JSON alert payload as `secret`. The secret is compared using a
 * constant-time check and is never persisted alongside the stored signal.
 *
 * Accepted signals are appended to a Netlify Blobs store so the dashboard can
 * read them back through the `signals` function. History is capped so the
 * stored document cannot grow without bound.
 */

const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");

const STORE_NAME = "tradingview-signals";
const SIGNALS_KEY = "signals";
const MAX_SIGNALS = 500;

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

  const signal = {
    id:
      Date.now().toString(36) +
      crypto.randomBytes(4).toString("hex"),
    receivedAt: new Date().toISOString(),
    ...signalData
  };

  try {
    const store = getStore({ name: STORE_NAME, consistency: "strong" });

    const existing = (await store.get(SIGNALS_KEY, { type: "json" })) || [];
    const signals = Array.isArray(existing) ? existing : [];

    signals.unshift(signal);

    if (signals.length > MAX_SIGNALS) {
      signals.length = MAX_SIGNALS;
    }

    await store.setJSON(SIGNALS_KEY, signals);
  } catch (error) {
    return json(502, { error: "Failed to store signal" });
  }

  return json(200, { ok: true, id: signal.id });
};
