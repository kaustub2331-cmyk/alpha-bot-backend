// Alpha Bot Backend — Paper Trade Engine
// Extracted from App.jsx v34.EL. DO NOT modify trading logic.
// No browser APIs used. Runs entirely in Node.js.

import { CONFIG } from "./config.js";
import { calcATR, calcEMA, detectSwingPoints, detectBOS_CHoCH } from "./indicators.js";
import { calcFuturesPnL, calcNetExpectancy } from "./signal.js";

// ── Trade Health Engine ────────────────────────────────────
export function calcTradeHealth(trade, currentPrice, candles, smcData, patienceMode = "PATIENT") {
  if (!trade || !currentPrice) return { score: 100, action: "HOLD", phase: "OBSERVE" };
  const atr = calcATR(candles) || 1;
  const elapsed = (Date.now() - trade.entryTime) / 1000;
  const closedCandles = candles.filter(c => c.closed);
  const closedCandlesSinceEntry = closedCandles.filter(c => c.t > trade.entryTime).length;

  const minHoldCandles = {
    CONSERVATIVE: CONFIG.MIN_HOLD_CANDLES,
    NORMAL:       CONFIG.MIN_HOLD_CANDLES,
    PATIENT:      CONFIG.PATIENT_MIN_CANDLES,
    SWING_TEST:   9999,
  }[patienceMode] || CONFIG.PATIENT_MIN_CANDLES;

  if (elapsed < CONFIG.MIN_HOLD_SECONDS) {
    const adverseMove = trade.direction === "LONG" ? (trade.entry - currentPrice) / atr : (currentPrice - trade.entry) / atr;
    if (adverseMove > 3) return { score: 0, action: "CLOSE", reason: "Emergency: 3x ATR adverse", phase: "EMERGENCY" };
    return { score: 100, action: "OBSERVE", reason: `Phase 1: Observation ${elapsed.toFixed(0)}s/60s`, phase: "OBSERVE" };
  }

  if (trade.direction === "LONG"  && currentPrice <= trade.sl) return { score: 0,   action: "CLOSE", reason: "Stop loss hit", phase: "SL" };
  if (trade.direction === "SHORT" && currentPrice >= trade.sl) return { score: 0,   action: "CLOSE", reason: "Stop loss hit", phase: "SL" };
  if (trade.direction === "LONG"  && currentPrice >= trade.tp) return { score: 100, action: "CLOSE", reason: "Take profit reached", phase: "TP" };
  if (trade.direction === "SHORT" && currentPrice <= trade.tp) return { score: 100, action: "CLOSE", reason: "Take profit reached", phase: "TP" };

  if (patienceMode === "SWING_TEST") {
    return { score: 90, action: "HOLD", reason: "Swing Test — hold until SL/TP", phase: "SWING_TEST" };
  }
  if (closedCandlesSinceEntry < minHoldCandles) {
    return { score: 90, action: "HOLD", reason: `Patience hold: ${closedCandlesSinceEntry}/${minHoldCandles} candles`, phase: "PATIENCE" };
  }

  let score = 100;
  const factors = [], weaknessSignals = [];
  const recentClosed = closedCandles.filter(c => c.t > trade.entryTime).slice(-5);
  recentClosed.forEach(c => {
    const body = Math.abs(c.c - c.o);
    const atrRatio = body / atr;
    const isOpposite = trade.direction === "LONG" ? c.c < c.o : c.c > c.o;
    if (isOpposite) {
      if      (atrRatio < 0.25) {}
      else if (atrRatio < 0.5)  weaknessSignals.push({ level: "minor",    msg: `Minor opposite (${atrRatio.toFixed(2)}x ATR)` });
      else if (atrRatio < 1.0)  weaknessSignals.push({ level: "moderate", msg: `Moderate opposite (${atrRatio.toFixed(2)}x ATR)` });
      else                       weaknessSignals.push({ level: "strong",   msg: `Strong opposite (${atrRatio.toFixed(2)}x ATR)` });
    }
  });

  const strongCount   = weaknessSignals.filter(s => s.level === "strong").length;
  const moderateCount = weaknessSignals.filter(s => s.level === "moderate").length;
  if (strongCount >= 2)                       { score -= 35; factors.push(`${strongCount} strong opposite candles`); }
  else if (strongCount === 1 && moderateCount >= 1) { score -= 20; factors.push("Mixed opposite pressure"); }
  else if (moderateCount >= 2)                { score -= 15; factors.push(`${moderateCount} moderate opposite candles`); }
  else if (weaknessSignals.length > 0)        { score -= 5;  factors.push("Minor opposite pressure"); }

  const bosDir = smcData?.bosChoch?.bos;
  if (bosDir) {
    if (trade.direction === "LONG"  && bosDir === "BEARISH") { score -= 25; factors.push("Bearish BOS — structural invalidation"); }
    if (trade.direction === "SHORT" && bosDir === "BULLISH") { score -= 25; factors.push("Bullish BOS — structural invalidation"); }
  }
  const chochDir = smcData?.bosChoch?.choch;
  if (chochDir) {
    if (trade.direction === "LONG"  && chochDir === "BEARISH") { score -= 20; factors.push("Bearish CHoCH"); }
    if (trade.direction === "SHORT" && chochDir === "BULLISH") { score -= 20; factors.push("Bullish CHoCH"); }
  }

  const closes = closedCandles.map(c => c.c);
  if (closes.length >= 21) {
    const ema21 = calcEMA(closes, 21);
    const lastEMA = ema21[ema21.length - 1];
    if (trade.direction === "LONG"  && currentPrice < lastEMA * 0.997) { score -= 15; factors.push("Confirmed EMA21 loss"); }
    else if (trade.direction === "SHORT" && currentPrice > lastEMA * 1.003) { score -= 15; factors.push("Confirmed EMA21 reclaim"); }
  }

  const adverseMove = trade.direction === "LONG" ? (trade.entry - currentPrice) / atr : (currentPrice - trade.entry) / atr;
  if (adverseMove > 2) { score -= 25; factors.push(`Adverse move ${adverseMove.toFixed(1)}x ATR`); }
  else if (adverseMove > 1) { score -= 10; factors.push(`Mild adverse ${adverseMove.toFixed(1)}x ATR`); }

  let closeThreshold = 30;
  if (patienceMode === "CONSERVATIVE") closeThreshold = 45;
  else if (patienceMode === "NORMAL")  closeThreshold = 35;
  else if (patienceMode === "PATIENT") closeThreshold = 25;

  if (score <= closeThreshold) return { score, action: "CLOSE", reason: `Health critical: ${factors.join(", ") || "multiple invalidations"}`, phase: "ACTIVE" };
  if (score <= 55) return { score, action: "WARN",  reason: factors.join(", ") || "Monitoring weakness", phase: "ACTIVE" };
  return { score, action: "HOLD", reason: factors.join(", ") || "Trade valid", phase: "ACTIVE" };
}

// ── Paper Trade Engine ─────────────────────────────────────
export class PaperTradeEngine {
  constructor() {
    this.positions  = [];
    this.trades     = [];
    this.signalLog  = [];
    this.seenSignalIds = new Set();
    this.counter    = 0;
  }

  hasPosition(signalId) { return this.seenSignalIds.has(signalId); }

  logSignal(signal, filteredBy = null) {
    if (!signal?.signalId) return;
    if (this.signalLog.some(s => s.signalId === signal.signalId)) return;
    this.signalLog.push({
      signalId: signal.signalId, action: signal.action, direction: signal.direction || null,
      strategy: signal.strategy || null, regime: signal.regime || null, confidence: signal.confidence || 0,
      confidenceLabel: signal.confidenceLabel || null, factors: signal.factors || [],
      reason: signal.reason || null, filteredBy, smcOpposed: signal.smcOpposed || false,
      smcOppositionReason: signal.smcOppositionReason || null, loggedAt: Date.now(),
      candleOpenTime: signal.candleOpenTime || null, tradedAs: null,
    });
  }

  updateSignalLog(signalId, { filteredBy, tradedAs, blockedDetails } = {}) {
    const entry = this.signalLog.find(s => s.signalId === signalId);
    if (!entry) return;
    if (filteredBy !== undefined) entry.filteredBy = filteredBy;
    if (tradedAs  !== undefined) entry.tradedAs   = tradedAs;
    if (blockedDetails !== undefined) entry.blockedDetails = blockedDetails;
  }

  enter(signal, riskLevels, currentPrice, regime, smcData, newsRisk, session, fundingRate, sizingSettings = null) {
    if (!riskLevels || !signal.signalId) return null;
    if (this.seenSignalIds.has(signal.signalId)) return null;
    this.seenSignalIds.add(signal.signalId);
    const id = `paper_${Date.now()}_${++this.counter}`;

    const sizingMode  = sizingSettings?.mode === "manual" ? "manual" : "auto";
    const usedLeverage = sizingMode === "manual" ? (sizingSettings.leverage || CONFIG.LEVERAGE) : CONFIG.LEVERAGE;
    const usedLots     = sizingMode === "manual" ? (sizingSettings.lots || riskLevels.deltaContracts) : riskLevels.deltaContracts;
    const usedBtcQty   = sizingMode === "manual" ? usedLots * 0.001 : riskLevels.btcQty;
    const usedNotional = sizingMode === "manual" ? usedBtcQty * currentPrice : riskLevels.notionalUSDT;
    const usedMargin   = usedNotional / usedLeverage;

    const trade = {
      id, type: "paper",
      signalId: signal.signalId,
      direction: signal.direction,
      strategy: signal.strategy,
      regime, confidence: signal.confidence,
      confidenceLabel: signal.confidenceLabel || null,
      entry: currentPrice,
      sl: riskLevels.sl, tp: riskLevels.tp, rr: riskLevels.rr,
      btcQty: usedBtcQty, notionalUSDT: usedNotional,
      deltaContracts: usedLots, marginUsed: usedMargin,
      leverage: usedLeverage, sizingMode, lots: usedLots,
      feeRate: CONFIG.TAKER_FEE,
      riskUSDT: riskLevels.riskUSDT,
      entryTime: Date.now(),
      status: "open",
      session, newsRisk: newsRisk?.score || 0,
      factors: signal.factors,
      smcBias: smcData?.bosChoch?.bias || "NEUTRAL",
      smcOpposed: signal.smcOpposed || false,
      mfe: 0, mae: 0,
      reached1R: false, reached2R: false, reached3R: false, reached5R: false,
      maxRR: 0,
      healthHistory: [],
      pnl: null,
      fundingRate: fundingRate || 0,
      health: null,
      netExpectancy: calcNetExpectancy(riskLevels.tpDist, riskLevels.slDist, usedBtcQty, currentPrice),
      duplicateSetup: signal.duplicateSetup || false,
      sessionPenaltyApplied: signal.sessionPenaltyApplied || false,
    };

    const logEntry = this.signalLog.find(s => s.signalId === signal.signalId);
    if (logEntry) { logEntry.tradedAs = id; logEntry.filteredBy = null; }
    this.positions.push(trade);
    this.trades.push(trade);
    return trade;
  }

  updateAll(currentPrice, candles, smcData, patienceMode = "PATIENT") {
    const candleHigh = candles.length > 0 ? candles[candles.length - 1].h : currentPrice;
    const candleLow  = candles.length > 0 ? candles[candles.length - 1].l : currentPrice;

    for (let i = 0; i < this.positions.length; i++) {
      const t = this.positions[i];
      if (t.status !== "open") continue;

      // MFE / MAE
      if (t.direction === "LONG") {
        t.mfe = Math.max(t.mfe || 0, candleHigh - t.entry);
        t.mae = Math.max(t.mae || 0, t.entry - candleLow);
      } else {
        t.mfe = Math.max(t.mfe || 0, t.entry - candleLow);
        t.mae = Math.max(t.mae || 0, candleHigh - t.entry);
      }

      // R-multiples
      const slDist = Math.abs(t.entry - t.sl);
      if (slDist > 0) {
        const mfeR = t.mfe / slDist;
        if (mfeR >= 1) t.reached1R = true;
        if (mfeR >= 2) t.reached2R = true;
        if (mfeR >= 3) t.reached3R = true;
        if (mfeR >= 5) t.reached5R = true;
        t.maxRR = Math.max(t.maxRR || 0, mfeR);
      }

      // SL/TP — check wicks
      let slHit = false, tpHit = false, exitPrice = currentPrice, exitReason = "";
      if (t.direction === "LONG") {
        if (candleLow  <= t.sl) { slHit = true; exitPrice = t.sl;  exitReason = "STOP_LOSS"; }
        if (candleHigh >= t.tp) { tpHit = true; exitPrice = t.tp;  exitReason = "TAKE_PROFIT"; }
        if (slHit && tpHit)     { tpHit = false; exitPrice = t.sl; exitReason = "STOP_LOSS"; }
      } else {
        if (candleHigh >= t.sl) { slHit = true; exitPrice = t.sl;  exitReason = "STOP_LOSS"; }
        if (candleLow  <= t.tp) { tpHit = true; exitPrice = t.tp;  exitReason = "TAKE_PROFIT"; }
        if (slHit && tpHit)     { tpHit = false; exitPrice = t.sl; exitReason = "STOP_LOSS"; }
      }

      if (slHit || tpHit) {
        this._closeTrade(t, exitPrice, exitReason, candles);
        this.positions.splice(i, 1);
        i--;
        continue;
      }

      // Health engine
      const health = calcTradeHealth(t, currentPrice, candles, smcData, patienceMode);
      t.health = health;
      if (health.action === "CLOSE") {
        this._closeTrade(t, currentPrice, `HEALTH_EXIT: ${health.reason}`, candles);
        this.positions.splice(i, 1);
        i--;
      }
    }
  }

  _closeTrade(t, exitPrice, exitReason, candles) {
    t.status    = "closed";
    t.exit      = exitPrice;
    t.exitTime  = Date.now();
    t.exitReason = exitReason;
    const holdHours = (t.exitTime - t.entryTime) / 3600000;
    t.pnl = calcFuturesPnL({
      direction:   t.direction,
      entry:       t.entry,
      exit:        exitPrice,
      btcQty:      t.btcQty,
      leverage:    t.leverage,
      fundingRate: t.fundingRate,
      holdHours,
      feeRate:     t.feeRate,
    });
  }

  // Restore state from Supabase data on startup
  loadFromDB(trades) {
    if (!trades || !trades.length) return;
    this.trades = trades;
    this.positions = trades.filter(t => t.status === "open");
    this.seenSignalIds = new Set(trades.map(t => t.signalId).filter(Boolean));
    this.counter = trades.length;
  }
}
