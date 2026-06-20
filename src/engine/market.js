// Alpha Bot Backend — Market Data Engine (Node.js)
// Uses ws for WebSocket (no browser), node-fetch for REST.
// Mirrors MarketDataEngine from App.jsx v34.EL.

import WebSocket from "ws";
import fetch from "node-fetch";
import { CONFIG } from "./config.js";

export class MarketDataEngine {
  constructor() {
    this.candles      = {};
    this.orderBook    = { bids: [], asks: [] };
    this.fundingRate  = null;
    this.openInterest = null;
    this.ws           = null;
    this.news         = [];
    this.newsAvailable = false;
    this.wsStatus     = "DISCONNECTED";
    this.wsReconnectAttempts = 0;
    this.wsMaxReconnectAttempts = 30;
    this.wsReconnectTimer = null;
    this.onCandleCallback = null;
    this.errors       = {};
  }

  async fetchCandles(interval = "1m") {
    try {
      const res = await fetch(`${CONFIG.BINANCE_REST}/klines?symbol=${CONFIG.SYMBOL}&interval=${interval}&limit=${CONFIG.CANDLE_LIMIT}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      const parsed = raw.map(c => ({
        t: c[0], o: parseFloat(c[1]), h: parseFloat(c[2]),
        l: parseFloat(c[3]), c: parseFloat(c[4]), v: parseFloat(c[5]),
        closed: true,
      }));
      this.candles[interval] = parsed;
      delete this.errors[`candles_${interval}`];
    } catch (e) {
      this.errors[`candles_${interval}`] = e.message;
      console.warn(`[Market] fetchCandles ${interval} failed:`, e.message);
    }
  }

  async fetchAllIntervals() {
    await Promise.all(["1m", "5m", "15m", "1h", "4h"].map(i => this.fetchCandles(i)));
  }

  getCandles(interval = "1m") { return this.candles[interval] || []; }

  async fetchOrderBook() {
    try {
      const res = await fetch(`${CONFIG.BINANCE_REST}/depth?symbol=${CONFIG.SYMBOL}&limit=20`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.orderBook = {
        bids: data.bids.map(b => ({ price: parseFloat(b[0]), qty: parseFloat(b[1]) })),
        asks: data.asks.map(a => ({ price: parseFloat(a[0]), qty: parseFloat(a[1]) })),
      };
      delete this.errors.orderBook;
    } catch (e) {
      this.errors.orderBook = e.message;
    }
  }

  async fetchFundingRate() {
    try {
      const res = await fetch(`${CONFIG.BINANCE_FUTURES}/fundingRate?symbol=${CONFIG.SYMBOL}&limit=1`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.fundingRate = data[0] ? parseFloat(data[0].fundingRate) : null;
      delete this.errors.fundingRate;
    } catch (e) {
      this.errors.fundingRate = e.message;
      this.fundingRate = null;
    }
  }

  async fetchOpenInterest() {
    try {
      const res = await fetch(`${CONFIG.BINANCE_FUTURES}/openInterest?symbol=${CONFIG.SYMBOL}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.openInterest = data.openInterest ? parseFloat(data.openInterest) : null;
      delete this.errors.openInterest;
    } catch (e) {
      this.errors.openInterest = e.message;
    }
  }

  async fetchNews() {
    const sources = ["https://nfs.faireconomy.media/ff_calendar_thisweek.json"];
    for (const url of sources) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) { this.errors.news = "UNAVAILABLE"; this.newsAvailable = false; this.news = []; return; }
        const data = await res.json();
        this.news = (data || []).filter(e =>
          ["USD", ""].includes(e.country) &&
          ["high", "medium"].includes(e.impact?.toLowerCase())
        ).map(e => ({ title: e.title, date: e.date, impact: e.impact, country: e.country }));
        delete this.errors.news;
        this.newsAvailable = true;
        return;
      } catch {
        this.errors.news = "UNAVAILABLE";
        this.newsAvailable = false;
      }
    }
    this.news = [];
    this.newsAvailable = false;
  }

  connectWebSocket(onCandle) {
    this.onCandleCallback = onCandle;
    if (this.ws) { try { this.ws.terminate(); } catch {} this.ws = null; }
    this.wsStatus = "CONNECTING";
    const stream = `${CONFIG.SYMBOL.toLowerCase()}@kline_1m`;
    try {
      this.ws = new WebSocket(`${CONFIG.BINANCE_WS}/${stream}`);
    } catch (e) {
      this._scheduleWsReconnect(onCandle);
      return;
    }

    this.ws.on("open", () => {
      this.wsStatus = "CONNECTED";
      this.wsReconnectAttempts = 0;
      delete this.errors.ws;
      console.log("[Market] WebSocket connected");
    });

    this.ws.on("message", (msg) => {
      try {
        const d = JSON.parse(msg.toString());
        if (d.k) {
          const k = d.k;
          const candle = {
            t: k.t, o: parseFloat(k.o), h: parseFloat(k.h),
            l: parseFloat(k.l), c: parseFloat(k.c), v: parseFloat(k.v),
            closed: k.x,
          };
          if (!this.candles["1m"]) this.candles["1m"] = [];
          const arr = this.candles["1m"];
          if (arr.length > 0) {
            const last = arr[arr.length - 1];
            if (last.t === candle.t) {
              arr[arr.length - 1] = candle;
            } else if (candle.closed) {
              arr.push(candle);
              if (arr.length > CONFIG.CANDLE_LIMIT) arr.shift();
            }
          }
          if (onCandle) onCandle(candle);
        }
      } catch {}
    });

    this.ws.on("error", (e) => {
      this.wsStatus = "FAILED";
      this.errors.ws = e.message;
      console.warn("[Market] WebSocket error:", e.message);
    });

    this.ws.on("close", () => {
      if (this.wsStatus === "CONNECTED") this.wsStatus = "RECONNECTING";
      this._scheduleWsReconnect(onCandle);
    });
  }

  _scheduleWsReconnect(onCandle) {
    if (this.wsReconnectAttempts >= this.wsMaxReconnectAttempts) {
      this.wsStatus = "FAILED";
      this.errors.ws = `WebSocket failed after ${this.wsMaxReconnectAttempts} attempts`;
      return;
    }
    const delay = Math.min(30000, 1000 * Math.pow(2, this.wsReconnectAttempts));
    this.wsReconnectAttempts++;
    this.wsStatus = "RECONNECTING";
    if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
    this.wsReconnectTimer = setTimeout(() => this.connectWebSocket(onCandle), delay);
    console.log(`[Market] WS reconnect in ${delay}ms (attempt ${this.wsReconnectAttempts})`);
  }

  disconnect() {
    if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
    if (this.ws) { try { this.ws.terminate(); } catch {} }
    this.wsStatus = "DISCONNECTED";
  }
}
