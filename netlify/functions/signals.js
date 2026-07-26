/**
 * Read-only signals endpoint for Sovereign Capital Engine.
 *
 * Returns the TradingView signals captured by the `tv-webhook` function,
 * newest first, for display on the dashboard.
 *
 * Signals are stored one per blob key (`sig:<ISO timestamp>:<random>`). Any
 * records written by the earlier single-array version are still read from the
 * legacy `signals` key and merged in, so no history is lost after upgrading.
 */

const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");

const STORE_NAME = "tradingview-signals";
const SIGNAL_PREFIX = "sig:";
const LEGACY_SIGNALS_KEY = "signals";

/**
 * Constant-time comparison of two secrets.
 */
function safeEqual(a, b) {
  const aBuf = crypto.createHash("sha256").update(String(a)).digest();
  const bBuf = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  };
}

/**
 * Opens the blob store.
 *
 * Netlify normally injects Blobs credentials automatically. When that
 * injection does not happen, `getStore` throws MissingBlobsEnvironmentError,
 * so we fall back to explicit credentials supplied through environment
 * variables.
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

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  // Optional read key. If SIGNALS_READ_KEY is set, callers must supply ?key=.
  // If it is unset the endpoint stays open, so existing deploys do not break.
  const expectedKey = process.env.SIGNALS_READ_KEY;

  if (expectedKey) {
    const providedKey = (event.queryStringParameters || {}).key;

    if (!providedKey || !safeEqual(providedKey, expectedKey)) {
      return {
        statusCode: 401,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Unauthorized" })
      };
    }
  }

  // Honour ?limit= (the dashboard has always sent it; it used to be ignored).
  const rawLimit = Number((event.queryStringParameters || {}).limit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), 500)
      : 500;

  try {
    const store = openStore();

    // Newest keys sort last, so take from the end and reverse for newest-first.
    const { blobs } = await store.list({ prefix: SIGNAL_PREFIX });

    const keys = (Array.isArray(blobs) ? blobs.map((blob) => blob.key) : [])
      .sort()
      .slice(-limit)
      .reverse();

    const fetched = await Promise.all(
      keys.map((key) =>
        store.get(key, { type: "json" }).catch((error) => {
          // A key deleted by a concurrent prune between list and get is
          // expected, not an error worth failing the whole request over.
          console.error("Could not read " + key + ":", error);
          return null;
        })
      )
    );

    const signals = fetched.filter(Boolean);

    // Merge anything left over from the pre-migration array format.
    if (signals.length < limit) {
      try {
        const legacy = await store.get(LEGACY_SIGNALS_KEY, { type: "json" });

        if (Array.isArray(legacy) && legacy.length) {
          const seen = new Set(signals.map((signal) => signal && signal.id));

          for (const record of legacy) {
            if (signals.length >= limit) break;
            if (record && seen.has(record.id)) continue;
            signals.push(record);
          }
        }
      } catch (error) {
        console.error("Legacy signals read failed:", error);
      }
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ signals })
    };
  } catch (error) {
    console.error("Signals function error:", error);

    return {
      statusCode: 502,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Failed to read signals",
        detail: String(error)
      })
    };
  }
};
