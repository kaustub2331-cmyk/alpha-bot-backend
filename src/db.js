// Alpha Bot Backend — Supabase Database Layer

import { createClient } from "@supabase/supabase-js";

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, BOT_USER_ID } = process.env;

// ENV CHECK — logs presence only (never values) so a missing var on
// Railway/Render is visible immediately in deploy logs and via /health.
export const envStatus = {
  SUPABASE_URL: Boolean(SUPABASE_URL),
  SUPABASE_SERVICE_KEY: Boolean(SUPABASE_SERVICE_KEY),
  BOT_USER_ID: Boolean(BOT_USER_ID),
};
console.log("[DB] ENV CHECK:", envStatus);

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(
    "[DB] SUPABASE_URL and SUPABASE_SERVICE_KEY are required — " +
    "if these are set as Railway Shared Variables, make sure this service " +
    "has a Reference Variable for them (Service → Variables → Shared Variable), " +
    "or add them directly under this service's own Variables tab."
  );
  process.exit(1);
}
if (!BOT_USER_ID) {
  console.error("[DB] BOT_USER_ID is required — set to your Supabase auth user UUID");
  process.exit(1);
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

export const USER_ID = BOT_USER_ID;

// ── Bot Status ─────────────────────────────────────────────
// bot_status uses real typed columns (snake_case in Postgres),
// but the rest of the app works in camelCase. Map between the two
// here so callers never have to think about column naming.
const BOT_STATUS_FIELD_MAP = {
  status: "status",
  serverOnline: "server_online",
  lastAnalysisTime: "last_analysis_time",
  lastCandleTime: "last_candle_time",
  errorStatus: "error_status",
  currentSignal: "current_signal",
  currentRegime: "current_regime",
  openPositions: "open_positions",
  version: "version",
};
const BOT_STATUS_REVERSE_MAP = Object.fromEntries(
  Object.entries(BOT_STATUS_FIELD_MAP).map(([camel, snake]) => [snake, camel])
);

function toBotStatusRow(fields) {
  const row = {};
  for (const [key, value] of Object.entries(fields)) {
    row[BOT_STATUS_FIELD_MAP[key] || key] = value;
  }
  return row;
}

function fromBotStatusRow(row) {
  if (!row) return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[BOT_STATUS_REVERSE_MAP[key] || key] = value;
  }
  return out;
}

export async function getBotStatus() {
  const { data, error } = await supabase
    .from("bot_status")
    .select("*")
    .eq("user_id", USER_ID)
    .maybeSingle();
  if (error) console.warn("[DB] getBotStatus:", error.message);
  return fromBotStatusRow(data);
}

export async function upsertBotStatus(fields) {
  const row = toBotStatusRow({ user_id: USER_ID, updated_at: new Date().toISOString(), ...fields });
  const { error } = await supabase
    .from("bot_status")
    .upsert(row, { onConflict: "user_id" });
  if (error) console.warn("[DB] upsertBotStatus:", error.message);
}

// ── Bot Commands ───────────────────────────────────────────
export async function getPendingCommands() {
  const { data, error } = await supabase
    .from("bot_commands")
    .select("*")
    .eq("user_id", USER_ID)
    .eq("status", "PENDING")
    .order("created_at", { ascending: true });
  if (error) console.warn("[DB] getPendingCommands:", error.message);
  return data || [];
}

export async function ackCommand(id) {
  const { error } = await supabase
    .from("bot_commands")
    .update({ status: "DONE", acked_at: new Date().toISOString() })
    .eq("id", id);
  if (error) console.warn("[DB] ackCommand:", error.message);
}

// ── Settings ───────────────────────────────────────────────
export async function getSettings() {
  const { data, error } = await supabase
    .from("settings")
    .select("key, value")
    .eq("user_id", USER_ID);
  if (error) { console.warn("[DB] getSettings:", error.message); return {}; }
  return (data || []).reduce((acc, row) => {
    try { acc[row.key] = typeof row.value === "string" ? JSON.parse(row.value) : row.value; }
    catch { acc[row.key] = row.value; }
    return acc;
  }, {});
}

export async function upsertSetting(key, value) {
  const { error } = await supabase
    .from("settings")
    .upsert({ user_id: USER_ID, key, value: JSON.stringify(value), updated_at: new Date().toISOString() }, { onConflict: "user_id,key" });
  if (error) console.warn("[DB] upsertSetting:", error.message);
}

// ── Trades ─────────────────────────────────────────────────
export async function getOpenTrades() {
  const { data, error } = await supabase
    .from("trades")
    .select("trade_id, data")
    .eq("user_id", USER_ID)
    .filter("data->status", "eq", "open");
  if (error) { console.warn("[DB] getOpenTrades:", error.message); return []; }
  return (data || []).map(r => r.data).filter(Boolean);
}

export async function getAllTrades(limit = 500) {
  const { data, error } = await supabase
    .from("trades")
    .select("trade_id, data")
    .eq("user_id", USER_ID)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) { console.warn("[DB] getAllTrades:", error.message); return []; }
  return (data || []).map(r => r.data).filter(Boolean);
}

export async function upsertTrade(trade) {
  const { error } = await supabase
    .from("trades")
    .upsert({ user_id: USER_ID, trade_id: trade.id, data: trade, updated_at: new Date().toISOString() }, { onConflict: "trade_id" });
  if (error) console.warn("[DB] upsertTrade:", error.message);
}

export async function upsertTrades(trades) {
  if (!trades?.length) return;
  const rows = trades.map(t => ({
    user_id: USER_ID, trade_id: t.id, data: t, updated_at: new Date().toISOString(),
  }));
  const CHUNK = 50;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase
      .from("trades")
      .upsert(rows.slice(i, i + CHUNK), { onConflict: "trade_id" });
    if (error) console.warn("[DB] upsertTrades chunk:", error.message);
  }
}

// ── Signal Log ─────────────────────────────────────────────
export async function upsertSignals(signals) {
  if (!signals?.length) return;
  const rows = signals.slice(-200).map(s => ({
    user_id: USER_ID,
    signal_id: s.signalId,
    data: s,
    updated_at: new Date().toISOString(),
  }));
  const CHUNK = 50;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase
      .from("signal_log")
      .upsert(rows.slice(i, i + CHUNK), { onConflict: "signal_id" });
    if (error) console.warn("[DB] upsertSignals chunk:", error.message);
  }
}

// ── Engine Logs ────────────────────────────────────────────
export async function insertLog(level, message, data = null) {
  const { error } = await supabase
    .from("engine_logs")
    .insert({ user_id: USER_ID, level, message, data, created_at: new Date().toISOString() });
  if (error) console.warn("[DB] insertLog:", error.message);
}

// ── Market Snapshots ───────────────────────────────────────
export async function upsertMarketSnapshot(snapshot) {
  const { error } = await supabase
    .from("market_snapshots")
    .upsert({ user_id: USER_ID, symbol: snapshot.symbol || "BTCUSDT", data: snapshot, updated_at: new Date().toISOString() }, { onConflict: "user_id,symbol" });
  if (error) console.warn("[DB] upsertMarketSnapshot:", error.message);
}

// ── Subscribe to remote commands ───────────────────────────
export function subscribeToCommands(onCommand) {
  return supabase
    .channel(`bot_commands:${USER_ID}`)
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "bot_commands",
      filter: `user_id=eq.${USER_ID}`,
    }, payload => {
      if (payload.new?.status === "PENDING") onCommand(payload.new);
    })
    .subscribe();
}
