// ============================================================
// Alpha Bot Backend Worker — v34.EL
// 24/7 cloud bot: market data + analysis + paper trading
// Runs on Railway / Render / VPS. PAPER MODE ONLY.
// ============================================================
import "dotenv/config";
import http from "http";

import { CONFIG } from "./engine/config.js";
import { MarketDataEngine } from "./engine/market.js";
import { PaperTradeEngine } from "./engine/paper.js";
import {
  detectSwingPoints, detectOrderBlocks, detectFairValueGaps,
  detectBOS_CHoCH, detectLiquiditySweep, calcPremiumDiscount,
  detectRegime, calcATR,
} from "./engine/indicators.js";
import {
  generateSignal, calcRiskLevels, calcNetExpectancy,
  detectSession, checkNewsRisk, checkDailyLimits,
  calcSessionPerformance, checkDuplicateSetup,
  checkStrategyPerformanceBlock, checkSessionAutoBlock,
  checkTrendLossCooldown, checkTrendCooldown, checkStrictTrendEntry,
} from "./engine/signal.js";
import {
  supabase, USER_ID, envStatus,
  getBotStatus, upsertBotStatus,
  getPendingCommands, ackCommand,
  getSettings, upsertSetting,
  getAllTrades, getOpenTrades, upsertTrade, upsertTrades,
  upsertSignals, insertLog, upsertMarketSnapshot,
  subscribeToCommands,
} from "./db.js";

// ── State ──────────────────────────────────────────────────
const marketEngine = new MarketDataEngine();
const paperEngine  = new PaperTradeEngine();

let botStatus   = "STOPPED";   // RUNNING | PAUSED | STOPPED
let patienceMode = "PATIENT";
let strategyToggles = { TREND: false, RANGE: true, BREAKOUT: true, REVERSAL: true };
let sizingSettings  = { mode: "auto" };
let lastAnalysisTime = null;
let lastCandleTime   = null;
let startupComplete  = false;
let errorStatus      = null;

const COMMAND_POLL_MS   = parseInt(process.env.COMMAND_POLL_MS   || "2000");
const ANALYSIS_INTERVAL = parseInt(process.env.ANALYSIS_INTERVAL_MS || "60000");

// ── Startup ────────────────────────────────────────────────
async function startup() {
  console.log("[Worker] Alpha Bot Backend starting...");

  // 1. Load settings from DB
  try {
    const settings = await getSettings();
    if (settings.patienceMode)     patienceMode     = settings.patienceMode;
    if (settings.strategyToggles)  strategyToggles  = settings.strategyToggles;
    if (settings.sizingMode)       sizingSettings   = { mode: settings.sizingMode, leverage: settings.manualLeverage, lots: settings.manualLots };
    console.log("[Worker] Settings loaded from DB");
  } catch (e) {
    console.warn("[Worker] Could not load settings:", e.message);
  }

  // 2. Load existing trades from DB
  try {
    const trades = await getAllTrades(500);
    if (trades.length) {
      paperEngine.loadFromDB(trades);
      console.log(`[Worker] Loaded ${trades.length} trades from DB (${paperEngine.positions.length} open)`);
    }
  } catch (e) {
    console.warn("[Worker] Could not load trades:", e.message);
  }

  // 3. Load stored bot status
  try {
    const stored = await getBotStatus();
    if (stored?.status) {
      botStatus = stored.status;
      console.log(`[Worker] Restored bot status: ${botStatus}`);
    }
  } catch (e) {
    console.warn("[Worker] Could not load bot status:", e.message);
  }

  // 4. Fetch initial market data
  try {
    await marketEngine.fetchAllIntervals();
    await Promise.all([
      marketEngine.fetchOrderBook(),
      marketEngine.fetchFundingRate(),
      marketEngine.fetchOpenInterest(),
      marketEngine.fetchNews(),
    ]);
    console.log("[Worker] Initial market data loaded");
  } catch (e) {
    console.warn("[Worker] Initial market data failed:", e.message);
  }

  startupComplete = true;
  await upsertBotStatus({
    status: botStatus,
    serverOnline: true,
    lastAnalysisTime: null,
    lastCandleTime: null,
    errorStatus: null,
    version: CONFIG.VERSION,
  });
  await insertLog("INFO", "Backend worker started", { version: CONFIG.VERSION });

  // 5. Subscribe to real-time commands
  subscribeToCommands(handleCommand);

  // 6. Start main loops
  startWebSocket();
  startCommandPoll();
  startMarketRefreshLoop();
  startHeartbeatLoop();
}

// ── WebSocket candle loop ──────────────────────────────────
function startWebSocket() {
  marketEngine.connectWebSocket(async (candle) => {
    lastCandleTime = Date.now();
    const candles = marketEngine.getCandles("1m");

    if (candle.c && candles.length > 0 && botStatus === "RUNNING") {
      // Track position closes BEFORE updateAll
      const openIdsBefore = new Set(paperEngine.positions.map(p => p.id));

      const smcData = buildSMCData(candles);
      paperEngine.updateAll(candle.c, candles, smcData, patienceMode);

      // Detect newly closed trades and sync them
      const openIdsAfter = new Set(paperEngine.positions.map(p => p.id));
      const newlyClosedIds = [...openIdsBefore].filter(id => !openIdsAfter.has(id));
      if (newlyClosedIds.length > 0) {
        const closedTrades = paperEngine.trades.filter(t => newlyClosedIds.includes(t.id));
        for (const t of closedTrades) {
          await upsertTrade(t);
          console.log(`[Worker] Trade closed: ${t.id} @ ${t.exit} reason=${t.exitReason} PnL=${t.pnl?.netPnL?.toFixed(2)}`);
          await insertLog("TRADE", `Trade closed: ${t.direction} ${t.strategy}`, {
            id: t.id, entry: t.entry, exit: t.exit, pnl: t.pnl?.netPnL, reason: t.exitReason,
          });
        }
        await upsertBotStatus({ lastCandleTime, errorStatus: null });
      }
    }

    // Run analysis on every closed candle
    if (candle.closed && candles.length >= 60 && botStatus === "RUNNING") {
      await runAnalysis(candles);
    }
  });
}

// ── SMC Data Builder ───────────────────────────────────────
function buildSMCData(candles) {
  const swings         = detectSwingPoints(candles);
  const bosChoch       = detectBOS_CHoCH(candles, swings);
  const orderBlocks    = detectOrderBlocks(candles, swings);
  const fvgs           = detectFairValueGaps(candles);
  const sweep          = detectLiquiditySweep(candles, swings);
  const premiumDiscount = calcPremiumDiscount(candles, swings);
  return { swings, bosChoch, orderBlocks, fvgs, sweep, premiumDiscount, _orderBook: marketEngine.orderBook };
}

// ── Analysis Loop ──────────────────────────────────────────
async function runAnalysis(candles) {
  if (!candles || candles.length < 60) return;
  try {
    const smcData    = buildSMCData(candles);
    const regimeData = detectRegime(candles);
    const newsRisk   = checkNewsRisk(marketEngine.news || []);
    const closedTrades = paperEngine.trades.filter(t => t.status === "closed");
    const sessionPerf  = calcSessionPerformance(closedTrades);
    const currentSess  = detectSession();

    const dl = checkDailyLimits(paperEngine.trades, CONFIG.ACCOUNT_BALANCE);

    const extraCtx = {
      signalLog: paperEngine.signalLog,
      closedTrades,
      sessionPerf,
      currentSession: currentSess,
    };

    // Generate signal
    let sig;
    if (newsRisk.blocked) {
      const lastCandle = candles[candles.length - 1];
      sig = { action: "WAIT", reason: newsRisk.reason, confidence: 0, regime: regimeData.regime, signalId: `${CONFIG.SYMBOL}_${lastCandle?.t || 0}_BLOCKED_NEWS`, candleOpenTime: lastCandle?.t || 0 };
      paperEngine.logSignal(sig, "NEWS");
    } else if (dl.blocked) {
      const lastCandle = candles[candles.length - 1];
      sig = generateSignal(candles, regimeData, smcData, marketEngine.orderBook, marketEngine.fundingRate, marketEngine.openInterest, extraCtx);
      paperEngine.logSignal(sig, "DAILY_LIMIT");
      sig = { action: "WAIT", reason: dl.reason, confidence: 0, regime: regimeData.regime, signalId: `${CONFIG.SYMBOL}_${lastCandle?.t || 0}_BLOCKED_DAILY`, candleOpenTime: lastCandle?.t || 0 };
    } else {
      sig = generateSignal(candles, regimeData, smcData, marketEngine.orderBook, marketEngine.fundingRate, marketEngine.openInterest, extraCtx);
      const filterReason = sig.smcOpposed ? "SMC_OPPOSITION" : sig.action === "WATCH" ? "WATCH_BAND" : null;
      paperEngine.logSignal(sig, filterReason);
    }

    lastAnalysisTime = Date.now();

    // Try to enter a paper trade if signal is TRADE
    if (sig.action === "TRADE" || sig.action === "WATCH") {
      const atr = calcATR(candles);
      const ep  = candles[candles.length - 1].c;
      const rl  = calcRiskLevels(sig.direction, ep, atr, CONFIG.ACCOUNT_BALANCE);

      if (sig.action === "TRADE" && rl && !paperEngine.hasPosition(sig.signalId)) {
        const strategy = sig.strategy;
        let blockReason = null;

        // Gate 1 — Strategy toggle check (mirrors App.jsx STRATEGY_DISABLED)
        if (strategyToggles && strategyToggles[strategy] === false) {
          blockReason = "STRATEGY_DISABLED";
          paperEngine.updateSignalLog(sig.signalId, { filteredBy: "STRATEGY_DISABLED", tradedAs: "BLOCKED" });
          console.log(`[Worker] Signal BLOCKED: strategy ${strategy} disabled`);
        }

        // Gate 2 — Session auto-block (v34.EL: 10+ trades, WR < 30%)
        // Mirrors App.jsx checkSessionAutoBlock gate
        if (!blockReason && currentSess) {
          const sessBlock = checkSessionAutoBlock(currentSess, closedTrades);
          if (sessBlock.blocked) {
            blockReason = "SESSION_POOR_PERFORMANCE";
            paperEngine.updateSignalLog(sig.signalId, { filteredBy: "SESSION_POOR_PERFORMANCE", tradedAs: "BLOCKED", blockedDetails: sessBlock.reason });
            console.log(`[Worker] Signal BLOCKED: ${sessBlock.reason}`);
          }
        }

        // Gate 3 — Strategy poor performance auto-block (v34.EL: 20+ trades, WR < 30%)
        // Mirrors App.jsx checkStrategyPerformanceBlock gate
        if (!blockReason && strategy) {
          const stratBlock = checkStrategyPerformanceBlock(strategy, closedTrades);
          if (stratBlock.blocked) {
            blockReason = "STRATEGY_POOR_PERFORMANCE";
            paperEngine.updateSignalLog(sig.signalId, { filteredBy: "STRATEGY_POOR_PERFORMANCE", tradedAs: "BLOCKED", blockedDetails: stratBlock.reason });
            console.log(`[Worker] Signal BLOCKED: ${stratBlock.reason}`);
          }
        }

        // Gate 4 — TREND overtrading cooldown + TREND loss cooldown + strict entry
        // Mirrors App.jsx TREND_COOLDOWN → TREND_LOSS_COOLDOWN → STRICT_TREND_ENTRY_FAIL sequence
        if (!blockReason && strategy === "TREND") {
          const openPositions = paperEngine.positions.filter(t => t.status === "open");
          const closedCandles = candles.filter(c => c.closed);

          const cooldown = checkTrendCooldown(openPositions, closedTrades, sig.direction, closedCandles);
          if (cooldown.blocked) {
            blockReason = "TREND_COOLDOWN";
            paperEngine.updateSignalLog(sig.signalId, { filteredBy: "TREND_COOLDOWN", tradedAs: "BLOCKED", blockedDetails: cooldown.reason });
            console.log(`[Worker] Signal BLOCKED: ${cooldown.reason}`);
          }

          if (!blockReason) {
            const lossCooldown = checkTrendLossCooldown(closedTrades, sig.direction, closedCandles);
            if (lossCooldown.blocked) {
              blockReason = "TREND_LOSS_COOLDOWN";
              paperEngine.updateSignalLog(sig.signalId, { filteredBy: "TREND_LOSS_COOLDOWN", tradedAs: "BLOCKED", blockedDetails: lossCooldown.reason });
              console.log(`[Worker] Signal BLOCKED: ${lossCooldown.reason}`);
            }
          }

          if (!blockReason) {
            const strictCheck = checkStrictTrendEntry(candles, smcData, sig);
            if (!strictCheck.pass) {
              blockReason = "STRICT_TREND_ENTRY_FAIL";
              paperEngine.updateSignalLog(sig.signalId, { filteredBy: "STRICT_TREND_ENTRY_FAIL", tradedAs: "BLOCKED", blockedDetails: strictCheck.reason });
              console.log(`[Worker] Signal BLOCKED: ${strictCheck.reason}`);
            }
          }
        }

        if (!blockReason) {
          // Gate 5 — Fee gate (reward must be ≥ 3× fee)
          const usedBtcQty = sizingSettings?.mode === "manual" ? (sizingSettings.lots || 100) * 0.001 : rl.btcQty;
          const totalFee = ep * usedBtcQty * CONFIG.TAKER_FEE * 2;
          const expectedReward = rl.tpDist * usedBtcQty;
          if (expectedReward < totalFee * 3) {
            paperEngine.updateSignalLog(sig.signalId, { filteredBy: "FEE_GATE_HARD_BLOCK", tradedAs: "BLOCKED" });
            console.log(`[Worker] Signal FEE_GATE_HARD_BLOCK: reward ${expectedReward.toFixed(4)} < 3× fee ${(totalFee * 3).toFixed(4)}`);
          } else {
            // Gate 6 — Net expectancy check
            const netExp = calcNetExpectancy(rl.tpDist, rl.slDist, usedBtcQty, ep);
            if (netExp && netExp.expectedNetReward <= 0) {
              paperEngine.updateSignalLog(sig.signalId, { filteredBy: "NEGATIVE_NET_EXPECTANCY", tradedAs: "BLOCKED" });
              console.log("[Worker] Signal NEGATIVE_NET_EXPECTANCY blocked");
            } else if (netExp && netExp.netRR < CONFIG.MIN_NET_RR) {
              paperEngine.updateSignalLog(sig.signalId, { filteredBy: "LOW_NET_RR", tradedAs: "BLOCKED" });
              console.log(`[Worker] Signal LOW_NET_RR blocked: netRR=${netExp.netRR.toFixed(2)}`);
            } else {
              // All gates passed — open paper trade
              const pt = paperEngine.enter(
                sig, rl, ep, regimeData.regime, smcData,
                newsRisk, currentSess, marketEngine.fundingRate, sizingSettings
              );
              if (pt) {
                await upsertTrade(pt);
                console.log(`[Worker] 🟢 Trade OPENED: ${pt.direction} ${pt.strategy} @ ${ep} conf=${sig.confidence?.toFixed(0)}`);
                await insertLog("TRADE", `Trade opened: ${pt.direction} ${pt.strategy}`, {
                  id: pt.id, entry: ep, sl: pt.sl, tp: pt.tp, confidence: sig.confidence, regime: regimeData.regime,
                });
              }
            }
          }
        }
      }
    }

    // Sync signal log and status
    await upsertSignals(paperEngine.signalLog.slice(-50));
    await upsertBotStatus({
      status: botStatus,
      lastAnalysisTime,
      lastCandleTime,
      errorStatus: null,
      currentSignal: {
        action: sig.action,
        direction: sig.direction || null,
        strategy: sig.strategy || null,
        confidence: sig.confidence || 0,
        regime: regimeData.regime,
      },
      currentRegime: regimeData.regime,
      openPositions: paperEngine.positions.length,
      serverOnline: true,
    });

    // Snapshot market data for dashboard
    await upsertMarketSnapshot({
      symbol: CONFIG.SYMBOL,
      price: candles[candles.length - 1].c,
      regime: regimeData.regime,
      session: detectSession(),
      fundingRate: marketEngine.fundingRate,
      openInterest: marketEngine.openInterest,
      wsStatus: marketEngine.wsStatus,
      timestamp: Date.now(),
    });

  } catch (e) {
    errorStatus = e.message;
    console.error("[Worker] runAnalysis error:", e.message);
    await upsertBotStatus({ errorStatus: e.message, serverOnline: true });
    await insertLog("ERROR", `runAnalysis failed: ${e.message}`);
  }
}

// ── Command Handler ────────────────────────────────────────
async function handleCommand(cmd) {
  const { id, command, payload } = cmd;
  console.log(`[Worker] Command received: ${command}`, payload || "");

  switch (command) {
    case "START":
      if (botStatus !== "RUNNING") {
        botStatus = "RUNNING";
        await upsertBotStatus({ status: "RUNNING", errorStatus: null });
        await insertLog("INFO", "Bot started by remote command");
        console.log("[Worker] Bot STARTED");
      }
      break;

    case "STOP":
      botStatus = "STOPPED";
      await upsertBotStatus({ status: "STOPPED" });
      await insertLog("INFO", "Bot stopped by remote command");
      console.log("[Worker] Bot STOPPED");
      break;

    case "PAUSE":
      botStatus = "PAUSED";
      await upsertBotStatus({ status: "PAUSED" });
      await insertLog("INFO", "Bot paused by remote command");
      console.log("[Worker] Bot PAUSED");
      break;

    case "RESUME":
      botStatus = "RUNNING";
      await upsertBotStatus({ status: "RUNNING" });
      await insertLog("INFO", "Bot resumed by remote command");
      console.log("[Worker] Bot RESUMED");
      break;

    case "UPDATE_SETTINGS":
      if (payload?.patienceMode)    patienceMode    = payload.patienceMode;
      if (payload?.strategyToggles) strategyToggles = payload.strategyToggles;
      if (payload?.sizingMode) {
        sizingSettings = { mode: payload.sizingMode, leverage: payload.manualLeverage, lots: payload.manualLots };
      }
      await insertLog("INFO", "Settings updated by remote command", payload);
      console.log("[Worker] Settings updated:", payload);
      break;

    default:
      console.warn("[Worker] Unknown command:", command);
  }

  if (id) await ackCommand(id);
}

// ── Poll for commands (fallback if realtime misses) ────────
function startCommandPoll() {
  setInterval(async () => {
    try {
      const cmds = await getPendingCommands();
      for (const cmd of cmds) {
        await handleCommand(cmd);
      }
    } catch (e) {
      console.warn("[Worker] Command poll error:", e.message);
    }
  }, COMMAND_POLL_MS);
}

// ── Market data refresh loop (order book, funding, news) ───
function startMarketRefreshLoop() {
  setInterval(async () => {
    try {
      await Promise.all([
        marketEngine.fetchOrderBook(),
        marketEngine.fetchFundingRate(),
        marketEngine.fetchOpenInterest(),
      ]);
    } catch {}
  }, 30_000);

  setInterval(async () => {
    try { await marketEngine.fetchNews(); } catch {}
  }, 300_000); // news every 5 minutes
}

// ── Heartbeat — updates serverOnline every 30s ─────────────
function startHeartbeatLoop() {
  setInterval(async () => {
    try {
      await upsertBotStatus({
        status: botStatus,
        serverOnline: true,
        lastAnalysisTime,
        lastCandleTime,
        openPositions: paperEngine.positions.length,
        errorStatus,
      });
    } catch {}
  }, 30_000);
}

// ── Health check HTTP server (Railway/Render require port) ─
const PORT = process.env.PORT || 3001;
http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      botStatus,
      version: CONFIG.VERSION,
      startupComplete,
      openPositions: paperEngine.positions.length,
      lastAnalysisTime,
      lastCandleTime,
      wsStatus: marketEngine.wsStatus,
      errorStatus,
      envCheck: envStatus,
      timestamp: new Date().toISOString(),
    }));
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
}).listen(PORT, () => {
  console.log(`[Worker] Health check server on :${PORT}`);
  startup().catch(e => {
    console.error("[Worker] Startup failed:", e);
    process.exit(1);
  });
});

// ── Graceful shutdown ──────────────────────────────────────
async function shutdown() {
  console.log("[Worker] Shutting down...");
  marketEngine.disconnect();
  await upsertBotStatus({ serverOnline: false, status: botStatus });
  await insertLog("INFO", "Backend worker shut down");
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT",  shutdown);
