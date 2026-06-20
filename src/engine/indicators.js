// Alpha Bot Backend — Indicators Engine
// Pure functions. No browser APIs. Extracted verbatim from App.jsx v34.EL.
// DO NOT modify — these must stay in sync with the frontend.

import { CONFIG } from "./config.js";

export function calcEMA(data, period) {
  if (!data || data.length === 0) return [];
  const k = 2 / (period + 1);
  let ema = data[0];
  const result = [ema];
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

export function calcATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

export function calcRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function calcMACD(closes) {
  if (!closes || closes.length < 35) return null;
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signal = calcEMA(macdLine.slice(26), 9);
  const last = signal.length - 1;
  return {
    macd: macdLine[macdLine.length - 1],
    signal: signal[last],
    hist: macdLine[macdLine.length - 1] - signal[last],
  };
}

export function calcBollingerBands(closes, period = 20, stdMult = 2) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mean + stdMult * std, mid: mean, lower: mean - stdMult * std, std, width: (std * 2) / mean };
}

export function calcADX(candles, period = 14) {
  if (!candles || candles.length < period * 2) return null;
  const slice = candles.slice(-(period * 2));
  const pDM = [], nDM = [], tr = [];
  for (let i = 1; i < slice.length; i++) {
    const c = slice[i], p = slice[i - 1];
    const upMove = c.h - p.h, downMove = p.l - c.l;
    pDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    nDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  const smooth = (arr, p) => {
    let s = arr.slice(0, p).reduce((a, b) => a + b, 0);
    const res = [s];
    for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; res.push(s); }
    return res;
  };
  const sTR = smooth(tr, period), sPDM = smooth(pDM, period), sNDM = smooth(nDM, period);
  const pDI = sPDM.map((v, i) => (v / sTR[i]) * 100);
  const nDI = sNDM.map((v, i) => (v / sTR[i]) * 100);
  const dx = pDI.map((v, i) => Math.abs(v - nDI[i]) / (v + nDI[i]) * 100);
  const adx = dx.slice(-period).reduce((a, b) => a + b, 0) / period;
  return { adx, pdi: pDI[pDI.length - 1], ndi: nDI[nDI.length - 1] };
}

export function calcVolumeProfile(candles, lookback = 20) {
  if (!candles || candles.length < lookback) return { avgVol: 0, lastVol: 0, ratio: 0 };
  const slice = candles.slice(-lookback);
  const avgVol = slice.reduce((s, c) => s + c.v, 0) / slice.length;
  const lastVol = candles[candles.length - 1]?.v || 0;
  return { avgVol, lastVol, ratio: avgVol > 0 ? lastVol / avgVol : 0 };
}

// ── SMC Functions ─────────────────────────────────────────

export function detectSwingPoints(candles, lookback = 5) {
  const highs = [], lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const slice = candles.slice(i - lookback, i + lookback + 1);
    const isSwingHigh = candles[i].h === Math.max(...slice.map(c => c.h));
    const isSwingLow  = candles[i].l === Math.min(...slice.map(c => c.l));
    if (isSwingHigh) highs.push({ idx: i, price: candles[i].h, t: candles[i].t });
    if (isSwingLow)  lows.push({ idx: i, price: candles[i].l, t: candles[i].t });
  }
  return { highs: highs.slice(-5), lows: lows.slice(-5) };
}

export function detectOrderBlocks(candles, swings) {
  const obs = [];
  for (let i = 2; i < candles.length - 3; i++) {
    const c = candles[i];
    if (c.c < c.o) {
      const nextThree = candles.slice(i + 1, i + 4);
      const strongUp = nextThree.every(nc => nc.c > nc.o) && nextThree[nextThree.length - 1].c > c.h;
      if (strongUp) obs.push({ type: "bullish", high: c.h, low: c.l, idx: i, t: c.t });
    }
    if (c.c > c.o) {
      const nextThree = candles.slice(i + 1, i + 4);
      const strongDown = nextThree.every(nc => nc.c < nc.o) && nextThree[nextThree.length - 1].c < c.l;
      if (strongDown) obs.push({ type: "bearish", high: c.h, low: c.l, idx: i, t: c.t });
    }
  }
  return obs.slice(-6);
}

export function detectFairValueGaps(candles) {
  const fvgs = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1], curr = candles[i], next = candles[i + 1];
    if (next.l > prev.h) fvgs.push({ type: "bullish", high: next.l, low: prev.h, idx: i, t: curr.t });
    if (next.h < prev.l) fvgs.push({ type: "bearish", high: prev.l, low: next.h, idx: i, t: curr.t });
  }
  return fvgs.slice(-6);
}

export function detectBOS_CHoCH(candles, swings) {
  if (!swings || swings.highs.length < 2 || swings.lows.length < 2) return null;
  const lastHigh = swings.highs[swings.highs.length - 1];
  const prevHigh = swings.highs[swings.highs.length - 2];
  const lastLow  = swings.lows[swings.lows.length - 1];
  const prevLow  = swings.lows[swings.lows.length - 2];
  const last = candles[candles.length - 1];
  let bos = null, choch = null, bias = "NEUTRAL";
  if (last.c > lastHigh.price) { bos = "BULLISH"; bias = "BULLISH"; }
  else if (last.c < lastLow.price) { bos = "BEARISH"; bias = "BEARISH"; }
  if (lastHigh.price < prevHigh.price && lastLow.price < prevLow.price && last.c > lastHigh.price) choch = "BULLISH";
  else if (lastHigh.price > prevHigh.price && lastLow.price > prevLow.price && last.c < lastLow.price) choch = "BEARISH";
  return { bos, choch, bias };
}

export function detectLiquiditySweep(candles, swings) {
  if (!swings || candles.length < 2) return null;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  if (!last || !prev || !swings.highs.length || !swings.lows.length) return null;
  const recentHigh = swings.highs[swings.highs.length - 1];
  const recentLow  = swings.lows[swings.lows.length - 1];
  if (last.h > recentHigh.price && last.c < recentHigh.price) return { type: "BEAR_SWEEP", level: recentHigh.price };
  if (last.l < recentLow.price  && last.c > recentLow.price)  return { type: "BULL_SWEEP", level: recentLow.price };
  return null;
}

export function calcPremiumDiscount(candles, swings) {
  if (!swings || !swings.highs.length || !swings.lows.length) return "NEUTRAL";
  const rangeHigh = Math.max(...swings.highs.map(h => h.price));
  const rangeLow  = Math.min(...swings.lows.map(l => l.price));
  const mid = (rangeHigh + rangeLow) / 2;
  const price = candles[candles.length - 1]?.c || 0;
  if (price > mid * 1.002) return "PREMIUM";
  if (price < mid * 0.998) return "DISCOUNT";
  return "NEUTRAL";
}

export function detectRegime(candles) {
  if (!candles || candles.length < 60) return { regime: "UNCERTAIN", reason: "Insufficient data" };
  const closes = candles.map(c => c.c);
  const atr = calcATR(candles);
  const adx = calcADX(candles);
  const bb  = calcBollingerBands(closes);
  const vol = calcVolumeProfile(candles);
  const ema21 = calcEMA(closes, 21);
  if (!atr || !adx || !bb) return { regime: "UNCERTAIN", reason: "Indicator data missing" };
  const lastClose = closes[closes.length - 1];
  const normalizedATR = atr / lastClose;
  const isHighVol  = normalizedATR > 0.008;
  const isTrending = adx.adx > 25;
  const isRanging  = adx.adx < 20 && bb.width < 0.015;
  const isBreakout = vol.ratio > 2.0 && bb.width > 0.02;
  const emaSlope   = (ema21[ema21.length - 1] - ema21[ema21.length - 5]) / ema21[ema21.length - 5];
  const swings  = detectSwingPoints(candles);
  const sweep   = detectLiquiditySweep(candles, swings);
  const bosChoch = detectBOS_CHoCH(candles, swings);
  if (isHighVol && normalizedATR > 0.012) return { regime: "HIGH_VOLATILITY", reason: `ATR ${(normalizedATR * 100).toFixed(2)}% — extreme volatility`, adx, bb, atr };
  if (sweep && bosChoch?.choch) return { regime: "REVERSAL", reason: "Liquidity sweep + CHoCH", adx, bb, atr, sweep, bosChoch };
  if (isBreakout) return { regime: "BREAKOUT", reason: `Volume ${vol.ratio.toFixed(1)}x + BB expansion`, adx, bb, atr, vol };
  if (isTrending) {
    const dir = emaSlope > 0 ? "UPTREND" : "DOWNTREND";
    return { regime: "TRENDING", direction: dir, reason: `ADX ${adx.adx.toFixed(1)} — ${dir}`, adx, bb, atr };
  }
  if (isRanging) return { regime: "RANGING", reason: `ADX ${adx.adx.toFixed(1)}, BB width ${(bb.width * 100).toFixed(2)}%`, adx, bb, atr };
  return { regime: "UNCERTAIN", reason: `ADX ${adx.adx.toFixed(1)} borderline`, adx, bb, atr };
}
