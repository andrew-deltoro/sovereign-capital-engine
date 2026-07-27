/**
 * Mechanical screener for Sovereign Capital Engine.
 *
 * Implements the Universe and Signal layers:
 *
 *   Universe  - a curated list of liquid US symbols, then hard filters on
 *               price and average dollar volume. Anything that fails is
 *               rejected before it can ever reach position sizing.
 *   Signal    - transparent, individually visible metrics (trend, momentum,
 *               relative volume, range position, volatility) combined into a
 *               composite rank.
 *
 * IMPORTANT: this ranks measurable properties. It does not predict returns.
 * Every rule here is one that thousands of other participants also run. Treat
 * the output as a shortlist for human judgement, never as a buy list.
 *
 * Results are cached in Netlify Blobs so repeated dashboard refreshes do not
 * burn the Finnhub free-tier budget (60 calls/minute).
 */

const { getStore } = require("@netlify/blobs");

const STORE_NAME = "tradingview-signals";
const CACHE_KEY = "screener:last";
const CACHE_TTL_MS = 15 * 60 * 1000;

// Concurrency is kept low so a full run stays inside both the Finnhub rate
// limit and the Netlify function execution window.
const CONCURRENCY = 5;

// Hard universe floors, per asset class. These are the Universe layer: a name
// that fails its floor is rejected outright and never reaches scoring, no
// matter how good its trend looks. Liquidity is ALSO scored (20 points below),
// but the floor exists so a strong trend can never buy its way past it.
const CLASS_FLOORS = {
  stock: { minPrice: 5, minAvgDollarVolume: 10000000 },
  bond: { minPrice: 5, minAvgDollarVolume: 5000000 },
  penny: { minPrice: 0.5, minAvgDollarVolume: 5000000 }
};

const MIN_HISTORY_DAYS = 60;

// "Strong Watch" requires THREE things, all of which must hold:
//
//   1. Score of 75 or higher
//   2. Enough liquidity (not merely above the universe floor)
//   3. No special risk rule triggered
//
// The third condition exists because a weighted score can be gamed by its own
// arithmetic: a stock or coin in a violent run earns more in momentum than the
// risk bucket can ever deduct, so without a hard blocker the model would flag
// exactly the setups the risk bucket was meant to catch. Blockers are absolute
// — they do not subtract points, they withhold the label.
const STRONG_WATCH_SCORE = 75;
const STRONG_WATCH_MIN_LIQUIDITY_POINTS = 12; // out of 20

// Per-class blocker thresholds for equities.
const EQUITY_BLOCKERS = {
  stock: { maxRsi: 78, maxRun20d: 40, maxAtrPct: 7, maxDrawdown: 25 },
  bond: { maxRsi: 80, maxRun20d: 12, maxAtrPct: 1.8, maxDrawdown: 20 },
  penny: { maxRsi: 80, maxRun20d: 100, maxAtrPct: 18, maxDrawdown: 50 }
};

/**
 * Returns the list of special risk rules an equity-like asset trips. An empty
 * array means nothing is blocking the Strong Watch label.
 */
function equityBlockers(assetClass, metrics) {
  const limits = EQUITY_BLOCKERS[assetClass] || EQUITY_BLOCKERS.stock;
  const blockers = [];

  if (isFinite(metrics.rsi14) && metrics.rsi14 > limits.maxRsi) {
    blockers.push("RSI " + metrics.rsi14.toFixed(0) + " overbought (>" + limits.maxRsi + ")");
  }

  if (isFinite(metrics.mom20) && metrics.mom20 > limits.maxRun20d) {
    blockers.push(
      "parabolic: +" + metrics.mom20.toFixed(0) + "% in 20d (>" + limits.maxRun20d + "%)"
    );
  }

  if (isFinite(metrics.atrPct) && metrics.atrPct > limits.maxAtrPct) {
    blockers.push(
      "volatility ATR " + metrics.atrPct.toFixed(1) + "% (>" + limits.maxAtrPct + "%)"
    );
  }

  const drawdown = Math.abs(metrics.drawdownFromHigh);

  if (isFinite(drawdown) && drawdown > limits.maxDrawdown) {
    blockers.push(
      "drawdown " + drawdown.toFixed(0) + "% from high (>" + limits.maxDrawdown + "%)"
    );
  }

  // A name below its 200-day average is not in the kind of trend the label is
  // meant to describe, however well the other buckets score.
  if (metrics.hasLongHistory && !metrics.aboveSma200) {
    blockers.push("below 200-day average");
  }

  return blockers;
}

// Bond ETFs are structurally low-volatility, so they would sweep the risk
// bucket if scored on the same ATR scale as equities.
const BOND_SYMBOLS = [
  "TLT", "IEF", "BND", "AGG", "HYG", "LQD", "SHY", "GOVT", "SGOV", "TIP", "MUB", "EMB"
];

/**
 * Curated liquid universe. Deliberately small and hand-picked.
 *
 * A real universe would come from an exchange listing endpoint, but that costs
 * one call per symbol to evaluate, and the free tier cannot screen 5,000 names.
 * Working from a liquid shortlist is the honest trade-off at this budget.
 */
const DEFAULT_UNIVERSE = [
  // Mega-cap tech
  "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "AVGO", "TSLA", "AMD", "NFLX",
  // Semis and hardware
  "MU", "INTC", "QCOM", "TXN", "ARM", "SMCI",
  // Financials
  "JPM", "BAC", "GS", "MS", "V", "MA", "COIN", "HOOD",
  // Healthcare
  "UNH", "LLY", "JNJ", "PFE", "ABBV",
  // Consumer and industrial
  "WMT", "COST", "HD", "NKE", "MCD", "BA", "CAT", "GE", "UBER",
  // Energy
  "XOM", "CVX", "OXY",
  // Broad ETFs
  "SPY", "QQQ", "IWM", "DIA",
  // Sector ETFs (useful for relative strength context)
  "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU",
  // Bonds and commodities
  "TLT", "IEF", "HYG", "GLD", "SLV", "USO"
];

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function openStore() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

// ---------------------------------------------------------------- indicators

function sma(values, period) {
  if (!values || values.length < period) return NaN;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) {
    sum += values[i];
  }
  return sum / period;
}

/**
 * Average True Range, used for a volatility-aware stop suggestion.
 */
function atr(highs, lows, closes, period) {
  if (closes.length < period + 1) return NaN;

  const trueRanges = [];

  for (let i = 1; i < closes.length; i++) {
    trueRanges.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      )
    );
  }

  if (trueRanges.length < period) return NaN;

  let sum = 0;
  for (let i = trueRanges.length - period; i < trueRanges.length; i++) {
    sum += trueRanges[i];
  }

  return sum / period;
}

/**
 * Wilder's RSI. The first average is a simple mean of the initial `period`
 * gains/losses, then smoothed thereafter — this is the standard definition and
 * matches what TradingView plots.
 */
function rsi(closes, period) {
  if (!closes || closes.length < period + 1) return NaN;

  let gainSum = 0;
  let lossSum = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gainSum += change;
    else lossSum -= change;
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Piecewise-linear lookup over [input, output] pairs, clamped at both ends.
 * Used where a single linear scale would misrepresent the shape — dollar
 * volume, for instance, where $10M -> $25M matters far more than $400M -> $415M.
 */
function piecewise(value, points) {
  if (!isFinite(value)) return 0;
  if (value <= points[0][0]) return points[0][1];

  const last = points[points.length - 1];
  if (value >= last[0]) return last[1];

  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];

    if (value >= x0 && value <= x1) {
      const t = (value - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }

  return last[1];
}

/**
 * Maps a value onto 0-100 by linear interpolation, clamped at both ends.
 */
function scale(value, low, high) {
  if (!isFinite(value)) return 0;
  if (value <= low) return 0;
  if (value >= high) return 100;
  return ((value - low) / (high - low)) * 100;
}

// -------------------------------------------------------------- data fetching

async function fetchCandles(symbol, apiKey) {
  // ~14 months of daily bars: enough for a 200-day average plus buffer.
  const to = Math.floor(Date.now() / 1000);
  const from = to - 60 * 60 * 24 * 430;

  const url =
    "https://finnhub.io/api/v1/stock/candle" +
    "?symbol=" + encodeURIComponent(symbol) +
    "&resolution=D" +
    "&from=" + from +
    "&to=" + to +
    "&token=" + encodeURIComponent(apiKey);

  const res = await fetch(url);

  if (res.status === 429) {
    throw new Error("RATE_LIMIT");
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error("NOT_AUTHORIZED");
  }

  if (!res.ok) {
    throw new Error("HTTP_" + res.status);
  }

  const data = await res.json();

  // Finnhub signals an empty series with s:"no_data".
  if (!data || data.s !== "ok" || !Array.isArray(data.c) || !data.c.length) {
    return null;
  }

  return data;
}

/**
 * Runs an async mapper over items with bounded concurrency.
 */
async function pooledMap(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await mapper(items[index]);
      } catch (error) {
        results[index] = { symbol: items[index], error: String(error.message || error) };
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

// ------------------------------------------------------------------ analysis

/**
 * Classifies a symbol for scoring purposes. Penny status is decided by price,
 * not by ticker, so a stock that falls below $5 is scored as a penny stock.
 */
function classify(symbol, price) {
  if (BOND_SYMBOLS.indexOf(symbol) !== -1) return "bond";
  if (price < 5) return "penny";
  return "stock";
}

/**
 * Inverse scaling: LOWER input produces a HIGHER score. Used for risk, where
 * less volatility and shallower drawdown are the desirable direction.
 */
function inverseScale(value, best, worst) {
  if (!isFinite(value)) return 0;
  if (value <= best) return 100;
  if (value >= worst) return 0;
  return ((worst - value) / (worst - best)) * 100;
}

/**
 * Scoring for stocks, bond ETFs and penny stocks. Out of 100:
 *
 *   Trend      35   where price sits against its moving averages
 *   Momentum   25   rate of change over 20 and 60 sessions
 *   Liquidity  20   average dollar volume, plus today's relative volume
 *   Risk       20   INVERSE of volatility and drawdown (calmer scores higher)
 *
 * Every sub-component is returned so a ranking can be audited rather than
 * trusted. The weights are a judgement call, not a fitted model, and the
 * 75-point Strong Watch line is a convention with no backtest behind it.
 */
function scoreEquityLike(assetClass, metrics) {
  const {
    price, sma20, sma50, sma200, mom20,
    avgDollarVolume, rsi14, atrPct, drawdownFromHigh
  } = metrics;

  // ---------------------------------------------------------- Trend (35)
  //
  // Four binary conditions. Binary is deliberate: it is auditable at a glance,
  // and "price is above the 50-day" is either true or it isn't.

  const aboveSma20 = price > sma20;
  const aboveSma50 = price > sma50;
  const sma20AboveSma50 = sma20 > sma50;
  const hasLongHistory = isFinite(sma200);
  const aboveSma200 = hasLongHistory && price > sma200;

  let trend = 0;

  if (aboveSma20) trend += 10;
  if (aboveSma50) trend += 10;
  if (sma20AboveSma50) trend += 8;

  if (hasLongHistory) {
    if (aboveSma200) trend += 7;
  } else if (aboveSma20 && aboveSma50 && sma20AboveSma50) {
    // Without 200 days of data the long-term test cannot run. Award partial
    // credit rather than a silent zero, and flag it on the row.
    trend += 3.5;
  }

  // ------------------------------------------------------- Momentum (25)
  //
  // RSI-led. RSI is scored on a band, not a ramp: the target is firm but not
  // yet stretched. A reading of 80 is not "better" than 60 — it is a worse
  // entry, and the curve reflects that.

  const rsiPoints = piecewise(rsi14, [
    [30, 0],    // deeply oversold: no trend to join
    [45, 6],    // waking up
    [55, 13],   // firm
    [60, 15],   // the sweet spot
    [68, 15],   // still fine
    [72, 11],   // getting extended
    [78, 6],    // stretched
    [85, 2]     // overbought: a poor place to start a position
  ]);

  // 20-day return: 0.75 points per 1%, capped at 10.
  // Penny stocks routinely move several times this, so their scale is widened.
  const returnDivisor = assetClass === "penny" ? 2.5 : 1;
  const bondMultiplier = assetClass === "bond" ? 3 : 1;

  const scaledReturn = (mom20 / returnDivisor) * bondMultiplier;
  const returnPoints = Math.max(0, Math.min(scaledReturn * 0.75, 10));

  const momentum = Math.min(rsiPoints + returnPoints, 25);

  // ------------------------------------------------------ Liquidity (20)
  //
  // Piecewise on log10 of average daily dollar volume. $25M/day scores 15/20,
  // which is the reference point in the spec.

  const logVolume = avgDollarVolume > 0 ? Math.log10(avgDollarVolume) : 0;

  const liquidity = piecewise(logVolume, [
    [6.0, 0],    // $1M/day
    [6.7, 5],    // $5M/day
    [7.0, 10],   // $10M/day
    [7.4, 15],   // $25M/day  <- reference
    [8.0, 20]    // $100M/day and above
  ]);

  // ----------------------------------------------------------- Risk (20)
  //
  // Inverted: MORE points means LESS risk. Volatility carries 12, drawdown 8.

  const atrBands = {
    stock: [[2, 12], [4, 8], [6, 4], [8, 0]],
    bond: [[0.4, 12], [0.9, 8], [1.4, 4], [2, 0]],
    penny: [[5, 12], [9, 8], [14, 4], [20, 0]]
  }[assetClass] || [[2, 12], [4, 8], [6, 4], [8, 0]];

  const volatilityPoints = piecewise(atrPct, atrBands);

  const drawdown = Math.abs(drawdownFromHigh);
  const drawdownBands = assetClass === "penny"
    ? [[0, 8], [20, 5], [40, 2], [60, 0]]
    : [[0, 8], [10, 5], [20, 2], [30, 0]];

  const drawdownPoints = piecewise(drawdown, drawdownBands);

  const risk = Math.min(volatilityPoints + drawdownPoints, 20);

  // ---------------------------------------------------------------- Total

  const total = trend + momentum + liquidity + risk;

  return {
    trend: round(trend, 1),
    momentum: round(momentum, 1),
    liquidity: round(liquidity, 1),
    risk: round(risk, 1),
    total: round(total, 1),

    // Sub-components, so any row can be traced back to its inputs.
    detail: {
      aboveSma20,
      aboveSma50,
      sma20AboveSma50,
      aboveSma200,
      hasLongHistory,
      rsiPoints: round(rsiPoints, 1),
      returnPoints: round(returnPoints, 1),
      volatilityPoints: round(volatilityPoints, 1),
      drawdownPoints: round(drawdownPoints, 1)
    }
  };
}

function analyze(symbol, candles, context) {
  const closes = candles.c;
  const highs = candles.h;
  const lows = candles.l;
  const volumes = candles.v || [];

  if (closes.length < MIN_HISTORY_DAYS) {
    return { symbol, rejected: "insufficient history" };
  }

  const price = closes[closes.length - 1];

  if (!isFinite(price) || price <= 0) {
    return { symbol, rejected: "no valid price" };
  }

  const assetClass = classify(symbol, price);
  const floors = CLASS_FLOORS[assetClass];

  // ---- Universe layer: hard floors, applied before any scoring ----

  if (price < floors.minPrice) {
    return {
      symbol,
      assetClass,
      price: round(price, 4),
      rejected: "price below $" + floors.minPrice + " floor for " + assetClass
    };
  }

  const recentVolumes = volumes.slice(-20);
  const recentCloses = closes.slice(-20);

  let dollarVolumeSum = 0;
  for (let i = 0; i < recentVolumes.length; i++) {
    dollarVolumeSum += recentVolumes[i] * recentCloses[i];
  }

  const avgDollarVolume = recentVolumes.length
    ? dollarVolumeSum / recentVolumes.length
    : 0;

  if (avgDollarVolume < floors.minAvgDollarVolume) {
    return {
      symbol,
      assetClass,
      price: round(price, 4),
      avgDollarVolume: Math.round(avgDollarVolume),
      rejected:
        "avg dollar volume $" + (avgDollarVolume / 1e6).toFixed(1) + "M below $" +
        (floors.minAvgDollarVolume / 1e6).toFixed(0) + "M floor for " + assetClass
    };
  }

  // ---- Signal layer ----

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = closes.length >= 200 ? sma(closes, 200) : NaN;

  const pctFrom20 = ((price - sma20) / sma20) * 100;
  const pctFrom50 = ((price - sma50) / sma50) * 100;
  const pctFrom200 = isFinite(sma200) ? ((price - sma200) / sma200) * 100 : NaN;

  const stackedBullish = isFinite(sma200)
    ? price > sma20 && sma20 > sma50 && sma50 > sma200
    : price > sma20 && sma20 > sma50;

  const close20Ago = closes[closes.length - 21];
  const close60Ago = closes[closes.length - 61];

  const mom20 = isFinite(close20Ago) ? ((price - close20Ago) / close20Ago) * 100 : NaN;
  const mom60 = isFinite(close60Ago) ? ((price - close60Ago) / close60Ago) * 100 : NaN;

  const todayVolume = volumes[volumes.length - 1];
  const avgVolume =
    recentVolumes.reduce((a, b) => a + b, 0) / (recentVolumes.length || 1);
  const rvol = avgVolume > 0 ? todayVolume / avgVolume : NaN;

  const window = closes.slice(-252);
  const rangeHigh = Math.max(...window);
  const rangeLow = Math.min(...window);
  const rangePosition =
    rangeHigh > rangeLow ? ((price - rangeLow) / (rangeHigh - rangeLow)) * 100 : 50;

  const drawdownFromHigh = ((price - rangeHigh) / rangeHigh) * 100;

  const atr14 = atr(highs, lows, closes, 14);
  const atrPct = isFinite(atr14) ? (atr14 / price) * 100 : NaN;

  const rsi14 = rsi(closes, 14);

  const buckets = scoreEquityLike(assetClass, {
    price, sma20, sma50, sma200, mom20,
    avgDollarVolume, rsi14, atrPct, drawdownFromHigh
  });

  // ---- context factors: these gate the label, they do not change the score ----

  context = context || {};
  const benchmarkCloses = context.benchmarkCloses;

  const rs20 = relativeStrength(closes, benchmarkCloses, 20);
  const rs60 = relativeStrength(closes, benchmarkCloses, 60);

  // Risk-adjusted momentum: 60-day return per unit of daily volatility. A 20%
  // move in a name that swings 8% a day is far less meaningful than the same
  // move in one that swings 1.5%.
  const riskAdjMomentum = isFinite(mom60) && isFinite(atrPct) && atrPct > 0
    ? mom60 / atrPct
    : NaN;

  const volQuality = volumeQuality(volumes);

  // Sector strength, measured on the sector ETF rather than the stock.
  const sectorSymbol = SECTOR_MAP[symbol] || null;
  let sector = null;

  if (sectorSymbol && context.sectorMomentum &&
      context.sectorMomentum[sectorSymbol] !== undefined) {
    sector = {
      symbol: sectorSymbol,
      mom60: context.sectorMomentum[sectorSymbol].mom60,
      rs60: context.sectorMomentum[sectorSymbol].rs60,
      aboveSma50: context.sectorMomentum[sectorSymbol].aboveSma50
    };
  }

  // Strong Watch = score >= 75 AND enough liquidity AND no blocking risk rule.
  const liquidityOk = buckets.liquidity >= STRONG_WATCH_MIN_LIQUIDITY_POINTS;

  const blockers = equityBlockers(assetClass, {
    rsi14,
    mom20,
    atrPct,
    drawdownFromHigh,
    hasLongHistory: isFinite(sma200),
    aboveSma200: isFinite(sma200) && price > sma200
  });

  // ---- context blockers ----

  // Relative strength. Benchmarks and sector ETFs are exempt: SPY cannot
  // meaningfully underperform itself, and sector ETFs are the yardstick.
  const isBenchmarkLike =
    symbol === BENCHMARK || Object.values(SECTOR_MAP).indexOf(symbol) !== -1 ||
    ["QQQ", "IWM", "DIA"].indexOf(symbol) !== -1;

  if (!isBenchmarkLike && isFinite(rs60) && rs60 < 0) {
    blockers.push(
      "lagging " + BENCHMARK + " by " + Math.abs(rs60).toFixed(1) + "% over 60d"
    );
  }

  if (sector && sector.aboveSma50 === false) {
    blockers.push("sector " + sector.symbol + " below its 50-day average");
  }

  if (!volQuality.ok) {
    blockers.push(volQuality.note);
  }

  // Risk-adjusted momentum: a positive raw return that vanishes once the
  // asset's own volatility is accounted for is not a trend worth flagging.
  if (assetClass !== "bond" && isFinite(riskAdjMomentum) && riskAdjMomentum < 1.5) {
    blockers.push(
      "risk-adjusted momentum " + riskAdjMomentum.toFixed(1) + " (needs 1.5+)"
    );
  }

  // Macro regime applies to every equity-like row at once.
  if (context.regime && context.regime.state === "risk-off") {
    blockers.push("risk-off regime: " + context.regime.reason);
  }

  const scoreOk = buckets.total >= STRONG_WATCH_SCORE;
  const strongWatch = scoreOk && liquidityOk && blockers.length === 0;

  const suggestedStop = isFinite(atr14) ? price - atr14 * 2 : NaN;

  return {
    symbol,
    assetClass,
    price: round(price, assetClass === "penny" ? 4 : 2),
    avgDollarVolume: Math.round(avgDollarVolume),
    sma20: round(sma20, 2),
    sma50: round(sma50, 2),
    sma200: isFinite(sma200) ? round(sma200, 2) : null,
    pctFrom20: round(pctFrom20, 2),
    pctFrom50: round(pctFrom50, 2),
    pctFrom200: isFinite(pctFrom200) ? round(pctFrom200, 2) : null,
    mom20: round(mom20, 2),
    mom60: round(mom60, 2),
    rvol: round(rvol, 2),
    rangePosition: round(rangePosition, 1),
    pctFromHigh: round(drawdownFromHigh, 2),
    atrPct: round(atrPct, 2),
    rsi14: round(rsi14, 1),
    suggestedStop: isFinite(suggestedStop) ? round(suggestedStop, 2) : null,
    stackedBullish,
    rs20: round(rs20, 2),
    rs60: round(rs60, 2),
    riskAdjMomentum: round(riskAdjMomentum, 2),
    volumeTrend: volQuality.trend,
    volumeConcentration: volQuality.concentration,
    volumeQualityOk: volQuality.ok,
    sector: sector ? sector.symbol : null,
    sectorRs60: sector ? sector.rs60 : null,
    sectorAboveSma50: sector ? sector.aboveSma50 : null,
    liquidityOk,
    scoreOk,
    blockers,
    strongWatch,
    components: buckets,
    score: buckets.total
  };
}

function round(value, places) {
  if (!isFinite(value)) return null;
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}

// ------------------------------------------------- market context & factors
//
// These do NOT change the 100-point score. They are additional conditions on
// the Strong Watch label, which keeps the scoring spec intact while letting
// context veto a label the raw numbers would otherwise award.

const BENCHMARK = "SPY";

// Sector mapping for the curated universe. A real system would pull this from
// a fundamentals endpoint; hardcoding is honest at this universe size.
const SECTOR_MAP = {
  AAPL: "XLK", MSFT: "XLK", NVDA: "XLK", AVGO: "XLK", AMD: "XLK", MU: "XLK",
  INTC: "XLK", QCOM: "XLK", TXN: "XLK", ARM: "XLK", SMCI: "XLK",
  GOOGL: "XLC", META: "XLC", NFLX: "XLC",
  AMZN: "XLY", TSLA: "XLY", HD: "XLY", NKE: "XLY", MCD: "XLY", UBER: "XLY",
  JPM: "XLF", BAC: "XLF", GS: "XLF", MS: "XLF", V: "XLF", MA: "XLF",
  COIN: "XLF", HOOD: "XLF",
  UNH: "XLV", LLY: "XLV", JNJ: "XLV", PFE: "XLV", ABBV: "XLV",
  WMT: "XLP", COST: "XLP",
  BA: "XLI", CAT: "XLI", GE: "XLI",
  XOM: "XLE", CVX: "XLE", OXY: "XLE"
};

/**
 * Determines the market-wide risk regime from the benchmark and credit spreads.
 *
 * This is deliberately crude. A real regime model would use VIX term structure,
 * credit spreads and liquidity measures; what is available here is price action
 * on SPY, HYG and TLT. It answers one question — is this a market where trend
 * following tends to work — and nothing more.
 */
function computeRegime(seriesBySymbol) {
  const spy = seriesBySymbol[BENCHMARK];

  if (!spy || !Array.isArray(spy.c) || spy.c.length < 200) {
    return { state: "unknown", reason: "insufficient benchmark history", riskOn: true };
  }

  const closes = spy.c;
  const price = closes[closes.length - 1];
  const spySma50 = sma(closes, 50);
  const spySma200 = sma(closes, 200);

  const aboveSma200 = price > spySma200;
  const aboveSma50 = price > spySma50;

  // Benchmark drawdown from its 52-week high.
  const window = closes.slice(-252);
  const high = Math.max(...window);
  const drawdown = ((price - high) / high) * 100;

  // Benchmark volatility as a stress read.
  const spyAtr = atr(spy.h, spy.l, closes, 14);
  const spyAtrPct = isFinite(spyAtr) ? (spyAtr / price) * 100 : NaN;

  // Credit appetite: high yield versus treasuries over 60 sessions. When
  // investors prefer treasuries to junk, risk appetite is contracting.
  let creditRatio = null;
  const hyg = seriesBySymbol.HYG;
  const tlt = seriesBySymbol.TLT;

  if (hyg && tlt && hyg.c.length > 61 && tlt.c.length > 61) {
    const hygRet = (hyg.c[hyg.c.length - 1] / hyg.c[hyg.c.length - 61] - 1) * 100;
    const tltRet = (tlt.c[tlt.c.length - 1] / tlt.c[tlt.c.length - 61] - 1) * 100;
    creditRatio = hygRet - tltRet;
  }

  let state;
  const reasons = [];

  if (!aboveSma200) {
    state = "risk-off";
    reasons.push("SPY below its 200-day average");
  } else if (!aboveSma50 || drawdown < -8) {
    state = "caution";
    if (!aboveSma50) reasons.push("SPY below its 50-day average");
    if (drawdown < -8) reasons.push("SPY " + Math.abs(drawdown).toFixed(1) + "% off its high");
  } else {
    state = "risk-on";
    reasons.push("SPY above both the 50 and 200-day averages");
  }

  if (isFinite(spyAtrPct) && spyAtrPct > 2.5) {
    if (state === "risk-on") state = "caution";
    reasons.push("benchmark volatility elevated (ATR " + spyAtrPct.toFixed(1) + "%)");
  }

  if (creditRatio !== null && creditRatio < -3) {
    if (state === "risk-on") state = "caution";
    reasons.push("credit weak: HYG lagging TLT by " + Math.abs(creditRatio).toFixed(1) + "% over 60d");
  }

  return {
    state,
    riskOn: state === "risk-on",
    reason: reasons.join("; "),
    spyAboveSma200: aboveSma200,
    spyAboveSma50: aboveSma50,
    spyDrawdown: round(drawdown, 2),
    spyAtrPct: round(spyAtrPct, 2),
    creditSpread60d: creditRatio === null ? null : round(creditRatio, 2)
  };
}

/**
 * Relative strength: excess return over the benchmark. A stock rising 5% while
 * the index rises 8% is not strong, however good its own chart looks.
 */
function relativeStrength(closes, benchmarkCloses, lookback) {
  if (!closes || !benchmarkCloses) return NaN;
  if (closes.length <= lookback || benchmarkCloses.length <= lookback) return NaN;

  const assetRet =
    (closes[closes.length - 1] / closes[closes.length - 1 - lookback] - 1) * 100;
  const benchRet =
    (benchmarkCloses[benchmarkCloses.length - 1] /
      benchmarkCloses[benchmarkCloses.length - 1 - lookback] - 1) * 100;

  return assetRet - benchRet;
}

/**
 * Volume quality: is participation genuine, or one spike propping up an average?
 *
 * Two checks. First, whether recent volume is holding up against the longer
 * baseline. Second, whether a single day dominates the 20-day average — a name
 * whose liquidity depends on one print is not really liquid.
 */
function volumeQuality(volumes) {
  if (!volumes || volumes.length < 60) {
    return { ok: true, score: null, note: "insufficient volume history" };
  }

  const recent = volumes.slice(-20);
  const baseline = volumes.slice(-60, -20);

  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const baselineAvg = baseline.reduce((a, b) => a + b, 0) / baseline.length;

  const trend = baselineAvg > 0 ? recentAvg / baselineAvg : 1;

  // Concentration: the largest single day as a share of the 20-day total.
  const total = recent.reduce((a, b) => a + b, 0);
  const largest = Math.max(...recent);
  const concentration = total > 0 ? largest / total : 0;

  const notes = [];
  let ok = true;

  if (trend < 0.6) {
    ok = false;
    notes.push("volume fading (" + (trend * 100).toFixed(0) + "% of its 60-day baseline)");
  }

  // One day above 30% of twenty means the other nineteen are thin.
  if (concentration > 0.3) {
    ok = false;
    notes.push("volume concentrated in one session (" + (concentration * 100).toFixed(0) + "%)");
  }

  return {
    ok,
    trend: round(trend, 2),
    concentration: round(concentration, 3),
    note: notes.join("; ")
  };
}

// ----------------------------------------------------------------- crypto
//
// Crypto is scored on a different model because the meaningful inputs are
// different: there is no 200-day moving average convention to lean on, no
// earnings, and market cap rank carries information that has no equity
// equivalent. Buckets are Momentum 40, Liquidity 30, Market cap 15, Risk 15.
//
// Data comes from CoinMarketCap's listings/latest endpoint, which returns the
// whole ranked universe in a single request — no per-symbol rate limiting.

const CRYPTO_MIN_VOLUME = 10000000; // $10M/day
const CRYPTO_MAX_RANK = 500;
const CRYPTO_STRONG_WATCH_MIN_LIQUIDITY = 18; // out of 30

// Special risk rules for crypto. Same principle as equities: these withhold
// the label outright rather than deducting points.
const CRYPTO_BLOCKERS = {
  maxRun7d: 50,
  maxRun30d: 150,
  maxRange24h: 20,
  minRank: 250
};

function cryptoBlockers(metrics) {
  const blockers = [];

  if (isFinite(metrics.ret7d) && metrics.ret7d > CRYPTO_BLOCKERS.maxRun7d) {
    blockers.push(
      "parabolic: +" + metrics.ret7d.toFixed(0) + "% in 7d (>" +
      CRYPTO_BLOCKERS.maxRun7d + "%)"
    );
  }

  if (isFinite(metrics.ret30d) && metrics.ret30d > CRYPTO_BLOCKERS.maxRun30d) {
    blockers.push(
      "parabolic: +" + metrics.ret30d.toFixed(0) + "% in 30d (>" +
      CRYPTO_BLOCKERS.maxRun30d + "%)"
    );
  }

  if (isFinite(metrics.range24hPct) && metrics.range24hPct > CRYPTO_BLOCKERS.maxRange24h) {
    blockers.push(
      "24h range " + metrics.range24hPct.toFixed(0) + "% (>" +
      CRYPTO_BLOCKERS.maxRange24h + "%)"
    );
  }

  if (isFinite(metrics.marketCapRank) && metrics.marketCapRank > CRYPTO_BLOCKERS.minRank) {
    blockers.push("rank " + metrics.marketCapRank + " (>" + CRYPTO_BLOCKERS.minRank + ")");
  }

  return blockers;
}

// Stablecoins are excluded outright: by design they have no momentum, and a
// depeg is the only thing that would ever score — which is not a buy signal.
const STABLECOINS = [
  "USDT", "USDC", "DAI", "BUSD", "TUSD", "USDD", "FDUSD", "PYUSD",
  "USDE", "FRAX", "LUSD", "GUSD", "USDP", "EURS", "EURC"
];

/**
 * Fetches the top coins from CoinMarketCap.
 *
 * Uses the authenticated pro endpoint when CMC_API_KEY is set, and falls back
 * to the keyless public route otherwise so the screener still runs without a
 * key configured.
 *
 * NOTE ON THE FREE TIER: the Basic plan does not include OHLCV, so 24h high and
 * low are NOT available. The Risk bucket needs a 24h range, so it is estimated
 * from the percentage changes instead — see estimateRange24h below. Rows carry
 * `range24hEstimated: true` when this happens, and the dashboard says so.
 * The Basic plan is also licensed for personal use, not commercial use.
 */
async function fetchCryptoMarkets() {
  const apiKey = process.env.CMC_API_KEY;

  const query =
    "?start=1" +
    "&limit=200" +
    "&convert=USD" +
    "&sort=market_cap";

  const url = apiKey
    ? "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest" + query
    : "https://pro-api.coinmarketcap.com/public-api/v3/cryptocurrency/listings/latest" + query;

  const headers = { Accept: "application/json" };

  if (apiKey) {
    headers["X-CMC_PRO_API_KEY"] = apiKey;
  }

  const res = await fetch(url, { headers });

  if (res.status === 429) {
    throw new Error("RATE_LIMIT");
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error("NOT_AUTHORIZED");
  }

  if (!res.ok) {
    throw new Error("HTTP_" + res.status);
  }

  const payload = await res.json();

  // CMC wraps everything in a status envelope and reports errors inside it
  // even on some 200 responses.
  if (payload && payload.status && payload.status.error_code) {
    throw new Error(
      "CMC_" + payload.status.error_code + ": " + payload.status.error_message
    );
  }

  if (!payload || !Array.isArray(payload.data)) {
    throw new Error("UNEXPECTED_RESPONSE");
  }

  return { coins: payload.data, usedKey: Boolean(apiKey) };
}

/**
 * Estimates the 24h high-low range as a percentage, because CoinMarketCap's
 * free tier does not expose OHLCV.
 *
 * The intraday range of a coin is always at least its net 24h move, and in
 * practice runs meaningfully wider because price does not travel in a straight
 * line. The 1h change is included as a read on current choppiness.
 *
 * This is an ESTIMATE and is labelled as one everywhere it surfaces. On a CMC
 * plan that includes OHLCV, pass the real high/low instead and the Risk bucket
 * becomes exact.
 */
function estimateRange24h(pct24h, pct1h) {
  const net = isFinite(pct24h) ? Math.abs(pct24h) : 0;
  const hourly = isFinite(pct1h) ? Math.abs(pct1h) : 0;

  // Net move scaled up for path, plus a choppiness term, with a floor so a
  // dead-flat coin is not scored as zero-risk.
  const estimate = net * 1.5 + hourly * 3;

  return Math.max(estimate, 1.5);
}

/**
 * Crypto scoring, out of 100.
 *
 *   Momentum   40   24h (12) + 7d (15) + 30d (13)
 *   Liquidity  30   24h dollar volume, log-scaled
 *   Market cap 15   market cap rank as a quality proxy
 *   Risk       15   INVERSE of 24h range, with a parabolic penalty
 *
 * As with equities: this ranks properties, it does not forecast. Crypto
 * momentum in particular mean-reverts hard, and a coin scoring 90 is often one
 * that has already made most of its move.
 */
function scoreCrypto(metrics) {
  const { ret24h, ret7d, ret30d, volume24h, marketCapRank, range24hPct } = metrics;

  // -------------------------------------------------------- Momentum (40)

  // 24h: max 12. A 4% daily move is already strong for a large-cap coin.
  const points24h = piecewise(ret24h, [
    [-5, 0], [0, 3], [2, 6], [4, 11], [6, 12], [15, 12]
  ]);

  // 7d: max 15. The reference point in the spec is +18% -> 15.
  const points7d = piecewise(ret7d, [
    [-10, 0], [0, 3], [5, 6], [10, 11], [18, 15], [40, 15]
  ]);

  // 30d: max 13. The reference point is +30% -> 10.
  const points30d = piecewise(ret30d, [
    [-20, 0], [0, 2], [10, 5], [30, 10], [60, 13], [150, 13]
  ]);

  const momentum = Math.min(points24h + points7d + points30d, 40);

  // ------------------------------------------------------- Liquidity (30)

  const logVolume = volume24h > 0 ? Math.log10(volume24h) : 0;

  // $800M/day (log 8.9) -> 24, per the spec.
  const liquidity = piecewise(logVolume, [
    [7.0, 0],    // $10M
    [8.0, 12],   // $100M
    [8.9, 24],   // $800M  <- reference
    [9.7, 30]    // $5B and above
  ]);

  // ------------------------------------------------ Market cap quality (15)

  const marketCap = piecewise(marketCapRank, [
    [1, 15], [10, 15], [25, 12], [50, 9], [100, 6], [200, 3], [500, 0]
  ]);

  // ------------------------------------------------------------ Risk (15)
  //
  // Inverted: a tighter 24h range scores higher. 6% -> 12, per the spec.

  const rangePoints = piecewise(range24hPct, [
    [0, 15], [3, 14], [6, 12], [10, 8], [15, 4], [25, 0]
  ]);

  // Parabolic penalty. A coin up 80% in a week is not "low risk" merely
  // because today happened to be quiet — the risk is the unwind.
  let parabolicPenalty = 0;

  if (ret7d > 80 || ret30d > 200) parabolicPenalty = 8;
  else if (ret7d > 50 || ret30d > 150) parabolicPenalty = 5;
  else if (ret7d > 35 || ret30d > 100) parabolicPenalty = 2;

  const risk = Math.max(0, Math.min(rangePoints - parabolicPenalty, 15));

  const total = momentum + liquidity + marketCap + risk;

  return {
    momentum: round(momentum, 1),
    liquidity: round(liquidity, 1),
    marketCap: round(marketCap, 1),
    risk: round(risk, 1),
    total: round(total, 1),
    detail: {
      points24h: round(points24h, 1),
      points7d: round(points7d, 1),
      points30d: round(points30d, 1),
      rangePoints: round(rangePoints, 1),
      parabolicPenalty
    }
  };
}

function analyzeCrypto(coin) {
  const symbol = String(coin.symbol || "").toUpperCase();

  if (STABLECOINS.indexOf(symbol) !== -1) {
    return { symbol, rejected: "stablecoin" };
  }

  // CMC nests price data under quote.<currency>.
  const quote = coin.quote && coin.quote.USD ? coin.quote.USD : {};

  const volume24h = Number(quote.volume_24h);
  const marketCapRank = Number(coin.cmc_rank);

  if (!isFinite(volume24h) || volume24h < CRYPTO_MIN_VOLUME) {
    return {
      symbol,
      volume24h: isFinite(volume24h) ? volume24h : null,
      rejected:
        "24h volume $" + ((volume24h || 0) / 1e6).toFixed(1) + "M below $" +
        (CRYPTO_MIN_VOLUME / 1e6) + "M floor"
    };
  }

  if (!isFinite(marketCapRank) || marketCapRank > CRYPTO_MAX_RANK) {
    return {
      symbol,
      marketCapRank: isFinite(marketCapRank) ? marketCapRank : null,
      rejected: "market cap rank outside top " + CRYPTO_MAX_RANK
    };
  }

  const price = Number(quote.price);

  const ret1h = Number(quote.percent_change_1h);
  const ret24h = Number(quote.percent_change_24h);
  const ret7d = Number(quote.percent_change_7d);
  const ret30d = Number(quote.percent_change_30d);

  // Use a real high/low if the plan provides one; otherwise estimate.
  const hasRealRange =
    isFinite(Number(coin.high_24h)) && isFinite(Number(coin.low_24h)) &&
    Number(coin.low_24h) > 0;

  const range24hPct = hasRealRange
    ? ((Number(coin.high_24h) - Number(coin.low_24h)) / Number(coin.low_24h)) * 100
    : estimateRange24h(ret24h, ret1h);

  const buckets = scoreCrypto({
    ret24h: isFinite(ret24h) ? ret24h : 0,
    ret7d: isFinite(ret7d) ? ret7d : 0,
    ret30d: isFinite(ret30d) ? ret30d : 0,
    volume24h,
    marketCapRank,
    range24hPct
  });

  const liquidityOk = buckets.liquidity >= CRYPTO_STRONG_WATCH_MIN_LIQUIDITY;

  const blockers = cryptoBlockers({
    ret7d: isFinite(ret7d) ? ret7d : 0,
    ret30d: isFinite(ret30d) ? ret30d : 0,
    range24hPct,
    marketCapRank
  });

  const scoreOk = buckets.total >= STRONG_WATCH_SCORE;
  const strongWatch = scoreOk && liquidityOk && blockers.length === 0;

  const suggestedStop =
    isFinite(range24hPct) && isFinite(price)
      ? price * (1 - (range24hPct * 2) / 100)
      : NaN;

  return {
    symbol,
    name: coin.name,
    assetClass: "crypto",
    price: isFinite(price) ? price : null,
    marketCapRank,
    marketCap: Number(quote.market_cap) || null,
    volume24h,
    ret1h: round(ret1h, 2),
    ret24h: round(ret24h, 2),
    ret7d: round(ret7d, 2),
    ret30d: round(ret30d, 2),
    range24hPct: round(range24hPct, 2),
    range24hEstimated: !hasRealRange,
    suggestedStop: isFinite(suggestedStop) ? round(suggestedStop, 6) : null,
    liquidityOk,
    scoreOk,
    blockers,
    strongWatch,
    components: buckets,
    score: buckets.total
  };
}

// -------------------------------------------------------------------- handler

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }

  if (event.httpMethod !== "GET") {
    return json(405, { error: "Method not allowed" });
  }

  const params0 = event.queryStringParameters || {};

  // Crypto uses a separate data source and scoring model.
  if (params0.market === "crypto") {
    return handleCrypto(params0);
  }

  const apiKey = process.env.FINNHUB_API_KEY;

  if (!apiKey) {
    return json(500, {
      error: "FINNHUB_API_KEY is not configured in Netlify environment variables."
    });
  }

  const params = event.queryStringParameters || {};
  const force = params.force === "1";

  // Serve from cache unless a refresh is explicitly requested.
  if (!force) {
    try {
      const cached = await openStore().get(CACHE_KEY, { type: "json" });

      if (cached && Date.now() - new Date(cached.generatedAt).getTime() < CACHE_TTL_MS) {
        return json(200, { ...cached, cached: true });
      }
    } catch (error) {
      console.error("Screener cache read failed:", error);
    }
  }

  const universe = params.symbols
    ? params.symbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : DEFAULT_UNIVERSE;

  // Context symbols must be fetched first: the benchmark defines relative
  // strength and the regime, and the sector ETFs define sector strength.
  const sectorSymbols = Array.from(new Set(Object.values(SECTOR_MAP)));
  const contextSymbols = Array.from(
    new Set([BENCHMARK, "HYG", "TLT"].concat(sectorSymbols))
  );

  const seriesBySymbol = {};

  const contextResults = await pooledMap(contextSymbols, CONCURRENCY, async (symbol) => {
    const candles = await fetchCandles(symbol, apiKey);
    return { symbol, candles };
  });

  for (const entry of contextResults) {
    if (entry && entry.candles) {
      seriesBySymbol[entry.symbol] = entry.candles;
    }
  }

  const benchmarkSeries = seriesBySymbol[BENCHMARK];
  const benchmarkCloses = benchmarkSeries ? benchmarkSeries.c : null;

  const regime = computeRegime(seriesBySymbol);

  // Sector momentum, computed once and shared across every row in that sector.
  const sectorMomentum = {};

  for (const sectorSymbol of sectorSymbols) {
    const series = seriesBySymbol[sectorSymbol];

    if (!series || !Array.isArray(series.c) || series.c.length < 61) continue;

    const closes = series.c;
    const last = closes[closes.length - 1];

    sectorMomentum[sectorSymbol] = {
      mom60: round((last / closes[closes.length - 61] - 1) * 100, 2),
      rs60: round(relativeStrength(closes, benchmarkCloses, 60), 2),
      aboveSma50: last > sma(closes, 50)
    };
  }

  const context = { benchmarkCloses, regime, sectorMomentum };

  const rows = await pooledMap(universe, CONCURRENCY, async (symbol) => {
    // Reuse anything already fetched as context rather than calling twice.
    const candles = seriesBySymbol[symbol] || (await fetchCandles(symbol, apiKey));

    if (!candles) {
      return { symbol, rejected: "no data returned" };
    }

    return analyze(symbol, candles, context);
  });

  const errors = rows.filter((r) => r && r.error);

  // If everything failed identically, the cause is systemic, not per-symbol.
  if (errors.length === rows.length && rows.length > 0) {
    const first = errors[0].error;

    if (first.includes("NOT_AUTHORIZED")) {
      return json(402, {
        error:
          "Finnhub rejected the candle request. The /stock/candle endpoint may " +
          "require a paid plan on your account, or the API key is invalid.",
        detail: first
      });
    }

    if (first.includes("RATE_LIMIT")) {
      return json(429, {
        error: "Finnhub rate limit hit. Wait a minute and try again.",
        detail: first
      });
    }

    return json(502, { error: "All symbol requests failed.", detail: first });
  }

  const candidates = rows
    .filter((r) => r && !r.rejected && !r.error && isFinite(r.score))
    .sort((a, b) => b.score - a.score);

  const rejected = rows
    .filter((r) => r && r.rejected)
    .map((r) => ({ symbol: r.symbol, reason: r.rejected }));

  const result = {
    generatedAt: new Date().toISOString(),
    regime,
    sectorMomentum,
    universeSize: universe.length,
    passed: candidates.length,
    rejected,
    errors: errors.map((e) => ({ symbol: e.symbol, error: e.error })),
    filters: {
      classFloors: CLASS_FLOORS,
      minHistoryDays: MIN_HISTORY_DAYS,
      strongWatchScore: STRONG_WATCH_SCORE,
      strongWatchMinLiquidityPoints: STRONG_WATCH_MIN_LIQUIDITY_POINTS,
      blockerRules: EQUITY_BLOCKERS
    },
    strongWatchCount: candidates.filter(function (c) { return c.strongWatch; }).length,
    candidates
  };

  try {
    await openStore().setJSON(CACHE_KEY, result);
  } catch (error) {
    console.error("Screener cache write failed:", error);
  }

  return json(200, { ...result, cached: false });
};

/**
 * Crypto screener handler. One upstream request covers the whole universe.
 */
async function handleCrypto(params) {
  const force = params.force === "1";
  const cacheKey = "screener:crypto";

  if (!force) {
    try {
      const cached = await openStore().get(cacheKey, { type: "json" });

      if (cached && Date.now() - new Date(cached.generatedAt).getTime() < CACHE_TTL_MS) {
        return json(200, { ...cached, cached: true });
      }
    } catch (error) {
      console.error("Crypto cache read failed:", error);
    }
  }

  let coins;
  let usedKey = false;

  try {
    const fetched = await fetchCryptoMarkets();
    coins = fetched.coins;
    usedKey = fetched.usedKey;
  } catch (error) {
    const message = String(error.message || error);

    if (message.includes("RATE_LIMIT")) {
      return json(429, {
        error:
          "CoinMarketCap rate limit hit (Basic plan allows 30 calls/minute). " +
          "Wait a minute and try again — results cache for 15 minutes."
      });
    }

    if (message.includes("NOT_AUTHORIZED") || message.includes("CMC_1001") ||
        message.includes("CMC_1002")) {
      return json(402, {
        error:
          "CoinMarketCap rejected the request. Check CMC_API_KEY in your Netlify " +
          "environment variables, or remove it to use the keyless public route.",
        detail: message
      });
    }

    return json(502, { error: "Could not fetch crypto market data.", detail: message });
  }

  const rows = coins.map(analyzeCrypto);

  const candidates = rows
    .filter((r) => r && !r.rejected && isFinite(r.score))
    .sort((a, b) => b.score - a.score);

  const rejected = rows
    .filter((r) => r && r.rejected)
    .map((r) => ({ symbol: r.symbol, reason: r.rejected }));

  const result = {
    market: "crypto",
    source: "coinmarketcap",
    usedApiKey: usedKey,
    rangeEstimated: true,
    generatedAt: new Date().toISOString(),
    universeSize: coins.length,
    passed: candidates.length,
    strongWatchCount: candidates.filter((c) => c.strongWatch).length,
    rejected,
    errors: [],
    filters: {
      minVolume24h: CRYPTO_MIN_VOLUME,
      maxRank: CRYPTO_MAX_RANK,
      strongWatchScore: STRONG_WATCH_SCORE,
      strongWatchMinLiquidityPoints: CRYPTO_STRONG_WATCH_MIN_LIQUIDITY,
      blockerRules: CRYPTO_BLOCKERS
    },
    candidates
  };

  try {
    await openStore().setJSON(cacheKey, result);
  } catch (error) {
    console.error("Crypto cache write failed:", error);
  }

  return json(200, { ...result, cached: false });
}

// Exported for offline testing of the pure logic.
exports._internal = {
  analyze, sma, atr, rsi, scale, inverseScale, piecewise, classify,
  scoreEquityLike, scoreCrypto, analyzeCrypto, estimateRange24h,
  equityBlockers, cryptoBlockers, EQUITY_BLOCKERS, CRYPTO_BLOCKERS,
  computeRegime, relativeStrength, volumeQuality, SECTOR_MAP, BENCHMARK,
  CLASS_FLOORS, DEFAULT_UNIVERSE, STRONG_WATCH_SCORE
};
