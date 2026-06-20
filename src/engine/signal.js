// Alpha Bot Backend — Signal Engine
// Extracted verbatim from App.jsx v34.EL. DO NOT modify trading logic.

import { CONFIG, SESSIONS } from "./config.js";
import {
  calcEMA, calcATR, calcRSI, calcMACD, calcBollingerBands,
  calcADX, calcVolumeProfile, detectSwingPoints, detectBOS_CHoCH,
  detectLiquiditySweep,
} from "./indicators.js";

// ── Session Detection ─────────────────────────────────────
export function detectSession() {
  const hour = new Date().getUTCHours();
  if (hour >= 23 || hour < 8)  return SESSIONS.ASIA;
  if (hour >= 8  && hour < 12) return SESSIONS.LONDON;
  if (hour >= 13 && hour < 22) return SESSIONS.NEW_YORK;
  return SESSIONS.OFF;
}

// ── News Risk ─────────────────────────────────────────────
export function checkNewsRisk(newsData) {
  const now = Date.now();
  const windowMs = CONFIG.NEWS_BLOCK_MINUTES * 60 * 1000;
  if (!newsData || newsData.length === 0) return { blocked: false, score: 0, events: [], reason: "No news data" };
  const relevant = newsData.filter(e => {
    try {
      const t = new Date(e.date).getTime();
      return Math.abs(t - now) < windowMs;
    } catch { return false; }
  });
  if (relevant.length > 0) {
    const high = relevant.filter(e => e.impact?.toLowerCase() === "high");
    if (high.length > 0) {
      return { blocked: true, score: 100, events: relevant, reason: `High-impact event: ${high[0].title}` };
    }
    return { blocked: false, score: 50, events: relevant, reason: `Medium-impact event nearby` };
  }
  return { blocked: false, score: 0, events: [], reason: "No events in window" };
}

// ── Daily Limits ──────────────────────────────────────────
export function checkDailyLimits(trades, accountBalance) {
  const todayUTC = new Date().toISOString().slice(0, 10);
  const todayTrades = trades.filter(t => {
    try { return new Date(t.entryTime).toISOString().slice(0, 10) === todayUTC; } catch { return false; }
  });
  const closedToday = todayTrades.filter(t => t.status === "closed");
  const dailyPnL = closedToday.reduce((s, t) => s + (t.pnl?.netPnL || 0), 0);
  const lossLimit = (accountBalance * CONFIG.DAILY_LOSS_LIMIT) / 100;
  if (dailyPnL < -lossLimit) return { blocked: true, reason: `Daily loss limit hit: ${dailyPnL.toFixed(2)} / -${lossLimit.toFixed(2)}` };
  if (closedToday.length >= CONFIG.MAX_DAILY_TRADES) return { blocked: true, reason: `Max daily trades: ${closedToday.length}/${CONFIG.MAX_DAILY_TRADES}` };
  const consecutive = (() => {
    const recent = [...closedToday].sort((a, b) => (b.entryTime || 0) - (a.entryTime || 0)).slice(0, CONFIG.MAX_CONSECUTIVE_LOSSES);
    return recent.every(t => (t.pnl?.netPnL || 0) < 0) ? recent.length : 0;
  })();
  if (consecutive >= CONFIG.MAX_CONSECUTIVE_LOSSES) return { blocked: true, reason: `${consecutive} consecutive losses` };
  return { blocked: false, todayTrades: todayTrades.length, dailyPnL, reason: null };
}

// ── Risk Levels ───────────────────────────────────────────
export function calcRiskLevels(direction, entryPrice, atr, accountBalance) {
  if (!entryPrice || !atr) return null;
  const slDist = atr * CONFIG.ATR_MULTIPLIER_SL;
  let tpDist = atr * CONFIG.ATR_MULTIPLIER_TP;
  if (tpDist / slDist < CONFIG.MIN_RR) return null;
  const sl = direction === "LONG" ? entryPrice - slDist : entryPrice + slDist;
  const tp = direction === "LONG" ? entryPrice + tpDist : entryPrice - tpDist;
  const rr = tpDist / slDist;
  const riskUSDT = (accountBalance * CONFIG.RISK_PER_TRADE) / 100;
  const btcQty = riskUSDT / slDist;
  const notionalUSDT = entryPrice * btcQty;
  const deltaContracts = Math.max(1, Math.round(btcQty / 0.001));
  const marginUsed = notionalUSDT / CONFIG.LEVERAGE;
  return { sl, tp, slDist, tpDist, rr, riskUSDT, btcQty, notionalUSDT, deltaContracts, marginUsed };
}

// ── Net Expectancy ────────────────────────────────────────
export function calcNetExpectancy(tpDist, slDist, btcQty, entryPrice, feeRate = CONFIG.TAKER_FEE) {
  if (!tpDist || !slDist || !btcQty || !entryPrice) return null;
  const notional = entryPrice * btcQty;
  const grossReward = tpDist * btcQty;
  const estimatedRoundTripFee = notional * feeRate * 2;
  const expectedNetReward = grossReward - estimatedRoundTripFee;
  const expectedSLLoss = slDist * btcQty;
  const netRisk = expectedSLLoss + estimatedRoundTripFee;
  const netRR = netRisk > 0 ? expectedNetReward / netRisk : 0;
  const feePctOfReward = grossReward > 0 ? (estimatedRoundTripFee / grossReward) * 100 : 100;
  return { grossReward, estimatedRoundTripFee, expectedNetReward, expectedSLLoss, netRisk, netRR, feePctOfReward, tpDist, slDist, btcQty, notional };
}

// ── PnL Calc ──────────────────────────────────────────────
export function calcFuturesPnL({ direction, entry, exit, btcQty, leverage = CONFIG.LEVERAGE, fundingRate = 0, holdHours = 0, feeRate = CONFIG.TAKER_FEE }) {
  if (!entry || !exit || !btcQty) return { grossPnL: 0, fees: 0, funding: 0, netPnL: 0, returnPct: 0, roi: 0, entryFee: 0, exitFee: 0 };
  const grossPnL = direction === "LONG" ? (exit - entry) * btcQty : (entry - exit) * btcQty;
  const notionalEntry = entry * btcQty;
  const notionalExit = exit * btcQty;
  const entryFee = notionalEntry * feeRate;
  const exitFee = notionalExit * feeRate;
  const fees = entryFee + exitFee;
  const fundingIntervals = holdHours / CONFIG.FUNDING_INTERVAL_HOURS;
  const fundingCost = direction === "LONG"
    ? notionalEntry * (fundingRate || 0) * fundingIntervals
    : -notionalEntry * (fundingRate || 0) * fundingIntervals;
  const netPnL = grossPnL - fees - fundingCost;
  const margin = notionalEntry / leverage;
  const returnPct = (netPnL / notionalEntry) * 100;
  const roi = margin > 0 ? (netPnL / margin) * 100 : 0;
  return {
    grossPnL: parseFloat(grossPnL.toFixed(8)), fees: parseFloat(fees.toFixed(8)),
    entryFee: parseFloat(entryFee.toFixed(8)), exitFee: parseFloat(exitFee.toFixed(8)),
    funding: parseFloat(fundingCost.toFixed(8)), netPnL: parseFloat(netPnL.toFixed(8)),
    returnPct: parseFloat(returnPct.toFixed(8)), roi: parseFloat(roi.toFixed(8)), feeRate,
  };
}

// ── Duplicate Setup ───────────────────────────────────────
export function checkDuplicateSetup(signalLog, strategy, direction, regime) {
  if (!strategy || !direction || !regime) return false;
  const recent = signalLog.slice(-CONFIG.DUPLICATE_CANDLE_WINDOW);
  return recent.some(s => s.strategy === strategy && s.direction === direction && s.regime === regime && (s.action === "TRADE" || s.action === "WATCH"));
}

// ── Session Performance ───────────────────────────────────
export function calcSessionPerformance(closedTrades) {
  const sessions = ["ASIA", "LONDON", "NEW_YORK", "OFF"];
  return sessions.reduce((acc, sess) => {
    const trades = closedTrades.filter(t => t.session === sess);
    const wins = trades.filter(t => (t.pnl?.netPnL || 0) > 0);
    const pnl = trades.reduce((s, t) => s + (t.pnl?.netPnL || 0), 0);
    const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : null;
    const expectancy = trades.length > 0 ? pnl / trades.length : null;
    acc[sess] = { trades: trades.length, wins: wins.length, losses: trades.length - wins.length, pnl, winRate, expectancy };
    return acc;
  }, {});
}

// ── v34.EL: Emergency Lock Gate Functions ─────────────────

/**
 * Check if a strategy is auto-blocked by poor performance.
 * Blocks if: ≥ STRATEGY_POOR_WR_TRADES trades AND win rate < STRATEGY_POOR_WR_THRESHOLD%
 * Mirrors App.jsx checkStrategyPerformanceBlock exactly.
 */
export function checkStrategyPerformanceBlock(strategy, closedTrades) {
  const strats = closedTrades.filter(t => t.strategy === strategy);
  if (strats.length < CONFIG.STRATEGY_POOR_WR_TRADES) return { blocked: false };
  const wins = strats.filter(t => (t.pnl?.netPnL || 0) > 0).length;
  const wr = (wins / strats.length) * 100;
  if (wr < CONFIG.STRATEGY_POOR_WR_THRESHOLD) {
    return {
      blocked: true,
      reason: `${strategy} auto-blocked: ${strats.length} trades, WR ${wr.toFixed(1)}% < ${CONFIG.STRATEGY_POOR_WR_THRESHOLD}% threshold`,
    };
  }
  return { blocked: false };
}

/**
 * Check if a session is auto-blocked by poor performance.
 * Blocks if: ≥ SESSION_POOR_TRADES trades AND win rate < SESSION_POOR_WR_THRESHOLD%
 * Mirrors App.jsx checkSessionAutoBlock exactly.
 */
export function checkSessionAutoBlock(session, closedTrades) {
  const sessTrades = closedTrades.filter(t => t.session === session);
  if (sessTrades.length < CONFIG.SESSION_POOR_TRADES) return { blocked: false };
  const wins = sessTrades.filter(t => (t.pnl?.netPnL || 0) > 0).length;
  const wr = (wins / sessTrades.length) * 100;
  if (wr < CONFIG.SESSION_POOR_WR_THRESHOLD) {
    return {
      blocked: true,
      reason: `Session ${session} auto-blocked: ${sessTrades.length} trades, WR ${wr.toFixed(1)}% < ${CONFIG.SESSION_POOR_WR_THRESHOLD}% threshold`,
    };
  }
  return { blocked: false };
}

/**
 * v34.EL: TREND loss cooldown — blocks same-direction TREND re-entry
 * for TREND_LOSS_COOLDOWN_CANDLES candles after a loss.
 * Mirrors App.jsx checkTrendLossCooldown exactly.
 */
export function checkTrendLossCooldown(closedTrades, direction, closedCandles) {
  const recentTrendLoss = [...closedTrades]
    .filter(t => t.strategy === "TREND" && t.direction === direction && t.exitTime && (t.pnl?.netPnL || 0) < 0)
    .sort((a, b) => b.exitTime - a.exitTime)[0];
  if (!recentTrendLoss) return { blocked: false };
  const candlesSinceLoss = closedCandles.filter(c => c.t > recentTrendLoss.exitTime).length;
  if (candlesSinceLoss < CONFIG.TREND_LOSS_COOLDOWN_CANDLES) {
    return {
      blocked: true,
      reason: `TREND ${direction} loss cooldown: ${candlesSinceLoss}/${CONFIG.TREND_LOSS_COOLDOWN_CANDLES} candles since last loss`,
    };
  }
  return { blocked: false };
}

/**
 * v34 P4 + EL: TREND overtrading cooldown.
 * Rule 1: max 1 active TREND trade per direction.
 * Rule 2: must wait TREND_COOLDOWN_CANDLES closed candles since last TREND close in same direction.
 * Mirrors App.jsx checkTrendCooldown exactly.
 */
export function checkTrendCooldown(openTrades, closedTrades, direction, closedCandles) {
  // Rule 1: max 1 active TREND trade per direction
  const activeTrend = openTrades.filter(t => t.strategy === "TREND" && t.direction === direction);
  if (activeTrend.length > 0) {
    return { blocked: true, reason: `COOLDOWN: Active TREND ${direction} already open (ID: ${activeTrend[0].id.slice(-8)})` };
  }
  // Rule 2: must wait 5 closed candles since last TREND close in same direction
  const recentTrendClose = [...closedTrades]
    .filter(t => t.strategy === "TREND" && t.direction === direction && t.exitTime)
    .sort((a, b) => b.exitTime - a.exitTime)[0];
  if (recentTrendClose) {
    const candlesSinceClose = closedCandles.filter(c => c.t > recentTrendClose.exitTime).length;
    if (candlesSinceClose < CONFIG.TREND_COOLDOWN_CANDLES) {
      return { blocked: true, reason: `COOLDOWN: Only ${candlesSinceClose}/${CONFIG.TREND_COOLDOWN_CANDLES} candles since last TREND ${direction} close` };
    }
  }
  return { blocked: false, reason: null };
}

/**
 * v34.EL: Strict TREND entry validator.
 * All 5 conditions must pass for TREND to trade.
 * Returns { pass: bool, reason: string }
 * Mirrors App.jsx checkStrictTrendEntry exactly.
 */
export function checkStrictTrendEntry(candles, smcData, signal) {
  const fails = [];
  const lastCandle = candles[candles.length - 1];
  const closes = candles.map(c => c.c);
  const ema21 = calcEMA(closes, 21);
  const e21 = ema21[ema21.length - 1];
  const currentPrice = lastCandle?.c || 0;

  // 1) SMC bias aligned
  const smcBias = smcData.bosChoch?.bias;
  const biasDir = signal.direction === "LONG" ? "BULLISH" : "BEARISH";
  if (smcBias !== biasDir) {
    fails.push(`SMC bias ${smcBias || "NEUTRAL"} ≠ ${biasDir}`);
  }

  // 2) BOS aligned
  const bos = smcData.bosChoch?.bos;
  const bosDir = signal.direction === "LONG" ? "BULLISH" : "BEARISH";
  if (bos !== bosDir) {
    fails.push(`BOS ${bos || "none"} ≠ ${bosDir}`);
  }

  // 3) Price not overextended from EMA21 (max 1.5% away)
  const distFromEma = e21 > 0 ? Math.abs(currentPrice - e21) / e21 : 0;
  if (distFromEma > 0.015) {
    fails.push(`Price ${(distFromEma * 100).toFixed(2)}% from EMA21 (max 1.5%)`);
  }

  // 4) Latest closed candle supports direction
  const closedCandles = candles.filter(c => c.closed);
  const lastClosed = closedCandles[closedCandles.length - 1];
  if (lastClosed) {
    const bullish = lastClosed.c > lastClosed.o;
    const bearish = lastClosed.c < lastClosed.o;
    if (signal.direction === "LONG" && !bullish) {
      fails.push("Last closed candle is bearish");
    } else if (signal.direction === "SHORT" && !bearish) {
      fails.push("Last closed candle is bullish");
    }
  }

  // 5) No opposite CHoCH
  const choch = smcData.bosChoch?.choch;
  if (choch) {
    if (signal.direction === "LONG" && choch === "BEARISH") {
      fails.push("Opposite BEARISH CHoCH present");
    } else if (signal.direction === "SHORT" && choch === "BULLISH") {
      fails.push("Opposite BULLISH CHoCH present");
    }
  }

  // Note: duplicate direction check is enforced separately via checkTrendCooldown
  if (fails.length > 0) {
    return { pass: false, reason: `STRICT_TREND_FAIL: ${fails.join(" | ")}` };
  }
  return { pass: true, reason: null };
}

// ── Order Book Walls ──────────────────────────────────────
export function checkOrderBookWalls(orderBook, price) {
  if (!orderBook || !orderBook.bids?.length || !price) return { largeWall: false };
  const avgBidQty = orderBook.bids.reduce((s, b) => s + b.qty, 0) / orderBook.bids.length;
  const largeBid = orderBook.bids.find(b => b.qty > avgBidQty * 5 && b.price < price);
  const largeAsk = orderBook.asks?.find(a => a.qty > avgBidQty * 5 && a.price > price);
  if (largeBid) return { largeWall: true, wallSide: "BID", level: largeBid.price };
  if (largeAsk) return { largeWall: true, wallSide: "ASK", level: largeAsk.price };
  return { largeWall: false };
}

// ── Strategy Runners ──────────────────────────────────────
export function runTrendStrategy(candles, smcData) {
  const closes = candles.map(c => c.c);
  const ema21 = calcEMA(closes, 21), ema55 = calcEMA(closes, 55);
  const ema200 = closes.length >= 200 ? calcEMA(closes, 200) : null;
  const macd = calcMACD(closes), vol = calcVolumeProfile(candles), adx = calcADX(candles);
  const lastClose = closes[closes.length - 1];
  const e21 = ema21[ema21.length - 1], e55 = ema55[ema55.length - 1];
  const e200 = ema200 ? ema200[ema200.length - 1] : null;
  if (!macd || !adx) return null;
  let longScore = 0, shortScore = 0, factors = [];
  if (lastClose > e21 && e21 > e55) { longScore += 25; factors.push("EMA bullish stack"); }
  else if (lastClose < e21 && e21 < e55) { shortScore += 25; factors.push("EMA bearish stack"); }
  if (e200 && lastClose > e200) { longScore += 10; factors.push("Above EMA200"); }
  else if (e200 && lastClose < e200) { shortScore += 10; factors.push("Below EMA200"); }
  if (macd.hist > 0 && macd.macd > 0) { longScore += 20; factors.push("MACD bullish"); }
  else if (macd.hist < 0 && macd.macd < 0) { shortScore += 20; factors.push("MACD bearish"); }
  if (adx.adx > 30) {
    if (adx.pdi > adx.ndi) { longScore += 15; factors.push(`ADX ${adx.adx.toFixed(0)} bullish`); }
    else { shortScore += 15; factors.push(`ADX ${adx.adx.toFixed(0)} bearish`); }
  }
  if (vol.ratio > 1.2) factors.push(`Vol ${vol.ratio.toFixed(1)}x`);
  if (smcData.bosChoch?.bos === "BULLISH") { longScore += 15; factors.push("Bullish BOS"); }
  else if (smcData.bosChoch?.bos === "BEARISH") { shortScore += 15; factors.push("Bearish BOS"); }
  const direction = longScore > shortScore ? "LONG" : longScore < shortScore ? "SHORT" : null;
  if (!direction) return null;
  const score = direction === "LONG" ? longScore : shortScore;
  return { strategy: "TREND", direction, confidence: Math.min(98, score), factors };
}

export function runRangeStrategy(candles, smcData) {
  const closes = candles.map(c => c.c);
  const rsi = calcRSI(closes), bb = calcBollingerBands(closes);
  const lastClose = closes[closes.length - 1], vol = calcVolumeProfile(candles);
  if (!rsi || !bb) return null;
  let direction = null, confidence = 0, factors = [];
  if (rsi < 35) { direction = "LONG"; confidence += 30; factors.push(`RSI ${rsi.toFixed(0)} oversold`); }
  else if (rsi > 65) { direction = "SHORT"; confidence += 30; factors.push(`RSI ${rsi.toFixed(0)} overbought`); }
  else return null;
  if (direction === "LONG" && lastClose <= bb.lower * 1.001) { confidence += 25; factors.push("At BB lower"); }
  else if (direction === "SHORT" && lastClose >= bb.upper * 0.999) { confidence += 25; factors.push("At BB upper"); }
  else confidence -= 15;
  if (smcData.swings) {
    const nearLow  = smcData.swings.lows.some(l => Math.abs(lastClose - l.price) / lastClose < 0.003);
    const nearHigh = smcData.swings.highs.some(h => Math.abs(lastClose - h.price) / lastClose < 0.003);
    if (direction === "LONG"  && nearLow)  { confidence += 20; factors.push("Near swing low"); }
    if (direction === "SHORT" && nearHigh) { confidence += 20; factors.push("Near swing high"); }
  }
  if (vol.ratio < 0.8) { confidence += 10; factors.push("Low vol range"); }
  return { strategy: "RANGE", direction, confidence: Math.min(98, confidence), factors };
}

export function runBreakoutStrategy(candles, smcData) {
  const closes = candles.map(c => c.c);
  const vol = calcVolumeProfile(candles), atr = calcATR(candles), bb = calcBollingerBands(closes);
  const lastClose = closes[closes.length - 1], prev = closes[closes.length - 2];
  if (!atr || !bb || !vol) return null;
  const swings = smcData.swings || { highs: [], lows: [] };
  const recentHigh = swings.highs.length ? Math.max(...swings.highs.map(h => h.price)) : null;
  const recentLow  = swings.lows.length  ? Math.min(...swings.lows.map(l => l.price))  : null;
  let direction = null, confidence = 0, factors = [];
  if (recentHigh && lastClose > recentHigh && prev <= recentHigh) { direction = "LONG";  confidence += 30; factors.push("Broke swing high"); }
  else if (recentLow && lastClose < recentLow && prev >= recentLow) { direction = "SHORT"; confidence += 30; factors.push("Broke swing low"); }
  else return null;
  if (vol.ratio > 1.8) { confidence += 25; factors.push(`Vol ${vol.ratio.toFixed(1)}x`); }
  else if (vol.ratio > 1.4) { confidence += 15; factors.push(`Vol ${vol.ratio.toFixed(1)}x`); }
  if (atr / lastClose > 0.004) { confidence += 20; factors.push("ATR expanding"); }
  if (direction === "LONG"  && lastClose > bb.upper) { confidence += 15; factors.push("Above BB upper"); }
  else if (direction === "SHORT" && lastClose < bb.lower) { confidence += 15; factors.push("Below BB lower"); }
  return { strategy: "BREAKOUT", direction, confidence: Math.min(98, confidence), factors };
}

export function runReversalStrategy(candles, smcData) {
  if (!smcData.sweep) return null;
  const closes = candles.map(c => c.c);
  const lastClose = closes[closes.length - 1], lastCandle = candles[candles.length - 1];
  let direction = null, confidence = 0, factors = [];
  if (smcData.sweep.type === "BULL_SWEEP") { direction = "LONG";  confidence += 25; factors.push("Bull liquidity sweep"); }
  else if (smcData.sweep.type === "BEAR_SWEEP") { direction = "SHORT"; confidence += 25; factors.push("Bear liquidity sweep"); }
  if (!direction) return null;
  if (smcData.bosChoch?.choch) { confidence += 20; factors.push("CHoCH detected"); }
  const ob = (smcData.orderBlocks || []).find(ob => ob.type === (direction === "LONG" ? "bullish" : "bearish") && lastClose >= ob.low && lastClose <= ob.high);
  if (ob) { confidence += 20; factors.push(`${ob.type} order block`); }
  const fvg = (smcData.fvgs || []).find(f => f.type === (direction === "LONG" ? "bullish" : "bearish") && lastClose >= f.low && lastClose <= f.high);
  if (fvg) { confidence += 15; factors.push("Price in FVG"); }
  const bodySize = Math.abs(lastCandle.c - lastCandle.o);
  const totalRange = lastCandle.h - lastCandle.l;
  const wickRatio = totalRange > 0 ? bodySize / totalRange : 1;
  if (direction === "LONG"  && lastCandle.c > lastCandle.o && wickRatio < 0.5) { confidence += 15; factors.push("Bullish rejection candle"); }
  else if (direction === "SHORT" && lastCandle.c < lastCandle.o && wickRatio < 0.5) { confidence += 15; factors.push("Bearish rejection candle"); }
  if (direction === "LONG"  && smcData.premiumDiscount === "DISCOUNT") { confidence += 10; factors.push("Discount zone"); }
  else if (direction === "SHORT" && smcData.premiumDiscount === "PREMIUM") { confidence += 10; factors.push("Premium zone"); }
  return { strategy: "REVERSAL", direction, confidence: Math.min(98, confidence), factors };
}

// ── Main Signal Generator ─────────────────────────────────
export function generateSignal(candles, regimeData, smcData, orderBook, fundingRate, openInterest, extraCtx = {}) {
  const { regime } = regimeData;
  const lastCandle = candles[candles.length - 1];
  const candleOpenTime = lastCandle ? lastCandle.t : 0;
  const { signalLog = [], closedTrades = [], sessionPerf = {}, currentSession = null } = extraCtx;

  if (regime === "UNCERTAIN" || regime === "HIGH_VOLATILITY") {
    const signalId = `${CONFIG.SYMBOL}_${candleOpenTime}_NONE_WAIT_${regime}`;
    return { action: "WAIT", reason: regimeData.reason, confidence: 0, regime, strategy: null, direction: null, signalId, candleOpenTime };
  }

  let strategyResult = null;
  if (regime === "TRENDING")  strategyResult = runTrendStrategy(candles, smcData);
  else if (regime === "RANGING")   strategyResult = runRangeStrategy(candles, smcData);
  else if (regime === "BREAKOUT")  strategyResult = runBreakoutStrategy(candles, smcData);
  else if (regime === "REVERSAL")  strategyResult = runReversalStrategy(candles, smcData);

  if (!strategyResult) {
    const signalId = `${CONFIG.SYMBOL}_${candleOpenTime}_${regime}_WAIT_NOSETUP`;
    return { action: "WAIT", reason: `No valid ${regime} setup`, confidence: 0, regime, strategy: regime, direction: null, signalId, candleOpenTime };
  }

  let conf = strategyResult.confidence;
  const boosts = [];

  if (fundingRate !== null) {
    if (strategyResult.direction === "SHORT" && fundingRate > 0.0005) { conf += 3; boosts.push("Funding favors short"); }
    else if (strategyResult.direction === "LONG" && fundingRate < -0.0002) { conf += 3; boosts.push("Funding favors long"); }
  }
  const wallResult = checkOrderBookWalls(orderBook, lastCandle?.c);
  if (wallResult.largeWall) {
    if (strategyResult.direction === "LONG"  && wallResult.wallSide === "BID") { conf += 5; boosts.push("Large bid wall"); }
    else if (strategyResult.direction === "SHORT" && wallResult.wallSide === "ASK") { conf += 5; boosts.push("Large ask wall"); }
  }
  conf = Math.min(98, conf);

  const isDuplicateSetup = checkDuplicateSetup(signalLog, strategyResult.strategy, strategyResult.direction, regime);
  if (isDuplicateSetup) { conf = Math.max(0, conf - 15); boosts.push("⚠ Duplicate setup detected (-15 conf)"); }

  let sessionPenaltyApplied = false;
  if (currentSession && sessionPerf[currentSession]) {
    const sp = sessionPerf[currentSession];
    if (sp.trades >= 3 && sp.winRate !== null && sp.winRate < CONFIG.SESSION_PENALTY_WINRATE) {
      conf = Math.max(0, conf - 10); boosts.push(`⚠ Poor ${currentSession} session -10 conf`);
      sessionPenaltyApplied = true;
    }
  }

  const smcBias = smcData.bosChoch?.bias;
  let smcOpposed = false, smcOppositionReason = null;
  if (smcBias === "BULLISH" && strategyResult.direction === "SHORT") {
    smcOpposed = true; smcOppositionReason = "SMC bias BULLISH opposes SHORT — blocked"; conf -= 25;
  } else if (smcBias === "BEARISH" && strategyResult.direction === "LONG") {
    smcOpposed = true; smcOppositionReason = "SMC bias BEARISH opposes LONG — blocked"; conf -= 25;
  }
  conf = Math.max(0, conf);

  if (smcOpposed && conf < CONFIG.CONFIDENCE.WATCH) {
    const signalId = `${CONFIG.SYMBOL}_${candleOpenTime}_${strategyResult.strategy}_${strategyResult.direction}_SMC_OPPOSITION`;
    return { action: "WAIT", reason: smcOppositionReason, confidence: conf, regime, strategy: strategyResult.strategy, direction: strategyResult.direction, factors: [...(strategyResult.factors || []), ...boosts], signalId, candleOpenTime, smcOpposed: true, smcOppositionReason };
  }
  if (conf < CONFIG.CONFIDENCE.WATCH) {
    const signalId = `${CONFIG.SYMBOL}_${candleOpenTime}_${strategyResult.strategy}_${strategyResult.direction}_LOWCONF`;
    return { action: "WAIT", reason: `Confidence ${conf.toFixed(0)} < ${CONFIG.CONFIDENCE.WATCH}`, confidence: conf, regime, strategy: strategyResult.strategy, direction: strategyResult.direction, factors: strategyResult.factors, signalId, candleOpenTime };
  }
  if (smcOpposed && conf < CONFIG.CONFIDENCE.TRADE) {
    const signalId = `${CONFIG.SYMBOL}_${candleOpenTime}_${strategyResult.strategy}_${strategyResult.direction}_SMC_OPPOSED`;
    return { action: "WATCH", reason: smcOppositionReason, confidence: conf, regime, strategy: strategyResult.strategy, direction: strategyResult.direction, factors: [...(strategyResult.factors || []), ...boosts, smcOppositionReason], signalId, candleOpenTime, smcOpposed: true, smcOppositionReason };
  }
  if (conf >= CONFIG.CONFIDENCE.WATCH && conf < CONFIG.CONFIDENCE.TRADE) {
    const signalId = `${CONFIG.SYMBOL}_${candleOpenTime}_${strategyResult.strategy}_${strategyResult.direction}_WATCH`;
    return { action: "WATCH", reason: `Confidence ${conf.toFixed(0)} — WATCH only`, confidence: conf, confidenceLabel: "WATCH", regime, strategy: strategyResult.strategy, direction: strategyResult.direction, factors: [...(strategyResult.factors || []), ...boosts], signalId, candleOpenTime, smcOpposed, duplicateSetup: isDuplicateSetup, sessionPenaltyApplied };
  }
  const confLabel = conf >= CONFIG.CONFIDENCE.STRONG ? "EXCEPTIONAL" : "STRONG";
  const signalId = `${CONFIG.SYMBOL}_${candleOpenTime}_${strategyResult.strategy}_${strategyResult.direction}_${confLabel}`;
  return { action: "TRADE", direction: strategyResult.direction, strategy: strategyResult.strategy, regime, confidence: conf, confidenceLabel: confLabel, factors: [...(strategyResult.factors || []), ...boosts], reason: `${confLabel} ${strategyResult.direction} — ${strategyResult.factors[0] || ""}`, signalId, candleOpenTime, smcOpposed, smcOppositionReason: smcOpposed ? smcOppositionReason : null, duplicateSetup: isDuplicateSetup, sessionPenaltyApplied };
}
