/**
 * Read-only signals endpoint for Sovereign Capital Engine.
 *
 * Returns the TradingView signals captured by the `tv-webhook` function,
 * newest first, for display on the dashboard.
 */

const { getStore } = require("@netlify/blobs");

const STORE_NAME = "tradingview-signals";
const SIGNALS_KEY = "signals";

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

  try {
    const store = openStore();
    const signals = (await store.get(SIGNALS_KEY, { type: "json" })) || [];

    return {
      statusCode: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ signals: Array.isArray(signals) ? signals : [] })
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
