# Alpha Bot — Deployment Guide
## 24/7 Cloud Bot: Supabase + Railway + Vercel

---

## ARCHITECTURE

```
Mobile / Laptop
     │
     │  (reads bot_status, market_snapshots, trades, signal_log)
     │  (writes bot_commands, settings)
     ▼
 Supabase ◄──────────────────────────────► Railway/Render Backend
 (Database +                               (Node.js worker — runs 24/7)
  Realtime)                                - fetches market data
                                           - runs analysis loop
                                           - opens/closes paper trades
                                           - writes all results to Supabase
```

The **backend worker** is the only thing that touches market data and trading logic.
The **frontend** is a pure dashboard — reads from Supabase, writes commands.

---

## STEP 1 — SUPABASE

### 1a. Create project
1. Go to https://supabase.com → New Project
2. Choose a region close to you (lower latency)
3. Note your project URL and API keys

### 1b. Run SQL
1. Supabase Dashboard → SQL Editor → New query
2. Paste contents of `supabase_setup_v2.sql`
3. Click Run
4. You should see: `Alpha Bot v2 schema setup complete ✓`

### 1c. Enable Realtime
1. Supabase Dashboard → Database → Replication
2. Enable realtime for these tables:
   - bot_status
   - bot_commands
   - engine_logs
   - market_snapshots
   - signal_log
   - trades
   - settings
   - notes

### 1d. Get your credentials
From Supabase Dashboard → Project Settings → API:
- **Project URL**: `https://xxxxxxxxxxxx.supabase.co`
- **anon/public key**: for the frontend (.env.local)
- **service_role key**: for the backend (.env) — NEVER expose this in frontend

From Supabase Dashboard → Authentication → Users:
- Create your account (sign up via the app)
- Copy your user UUID — this is your `BOT_USER_ID`

---

## STEP 2 — BACKEND (Railway)

### 2a. Deploy to Railway
```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# From the alpha-bot-backend/ folder:
cd alpha-bot-backend
railway init          # Create new project
railway up            # Deploy
```

Or via Railway Dashboard:
1. https://railway.app → New Project → Deploy from GitHub
2. Connect your repo
3. Set root directory to `alpha-bot-backend/`

### 2b. Set environment variables
In Railway Dashboard → Your Service → Variables:

```
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
BOT_USER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
PORT=3001
```

**IMPORTANT**: Use the `service_role` key (not anon key) for the backend.
The service key bypasses Row Level Security — required for the worker.

### 2c. Verify deployment
Railway provides a public URL like `https://alpha-bot-backend-xxxx.railway.app`

Check: `https://alpha-bot-backend-xxxx.railway.app/health`

Expected response:
```json
{
  "status": "ok",
  "botStatus": "STOPPED",
  "version": "34.EL",
  "startupComplete": true,
  "wsStatus": "CONNECTED"
}
```

### Alternative: Render
1. https://render.com → New Web Service
2. Connect repo, root dir = `alpha-bot-backend/`
3. Build command: `npm install`
4. Start command: `npm start`
5. Add same environment variables

---

## STEP 3 — FRONTEND (Vercel)

### 3a. Set environment variables
Create `alpha-bot-frontend/.env.local`:
```
VITE_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```
Note: Frontend uses **anon key** (not service key).

### 3b. Deploy to Vercel
```bash
npm install -g vercel

cd alpha-bot-frontend   # the folder with App.jsx + vite.config.js
npm install
vercel                  # follow prompts
```

Or via Vercel Dashboard:
1. https://vercel.com → New Project → Import from GitHub
2. Framework: Vite
3. Add environment variables (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)
4. Deploy

### 3c. Install as PWA on mobile
1. Open `https://your-app.vercel.app` on Android Chrome
2. Tap 3-dot menu → "Add to Home Screen"
3. On iPhone: tap Share → "Add to Home Screen"

---

## STEP 4 — FIRST RUN

1. Open the app on your phone or laptop
2. Log in with your email
3. Go to **Diagnostics** tab → Cloud Bot Status panel
4. Tap **▶ START**
5. The command is written to Supabase → backend picks it up within 2 seconds
6. Bot status changes to **RUNNING** on all devices simultaneously

---

## CONTROLLING THE BOT

From **any device on any network**:

| Action | Where |
|--------|-------|
| Start / Stop / Pause | Dashboard quick buttons or Diagnostics tab |
| Change leverage / lots | Settings tab → Apply Settings |
| Change patience mode | Settings tab |
| Toggle strategies | Settings tab |
| View trades | Trades tab |
| View signals | Signal tab |
| View engine logs | Diagnostics tab → Engine Logs |

All commands go through Supabase → backend reads within 2 seconds.

---

## WHAT RUNS 24/7 (backend)

- Binance WebSocket for live BTC price
- Every closed 1-minute candle triggers full analysis
- SMC detection (BOS, CHoCH, FVG, Order Blocks, Sweeps)
- Regime detection (TRENDING / RANGING / BREAKOUT / REVERSAL)
- Signal generation (TREND / RANGE / BREAKOUT / REVERSAL strategies)
- Paper trade entry (confidence ≥85, fee gate, net expectancy check)
- Paper trade exit (SL/TP on wicks, health engine, patience modes)
- All results written to Supabase in real time
- Heartbeat every 30s updates bot_status

## WHAT THE FRONTEND DOES

- Reads bot_status, trades, signals, market_snapshots from Supabase
- Writes bot_commands when you tap Start/Stop/Pause
- Writes settings when you change anything
- Displays everything in real time via Supabase Realtime

---

## ENVIRONMENT VARIABLES SUMMARY

### Backend (Railway/Render) — .env
```
SUPABASE_URL=         # Your Supabase project URL
SUPABASE_SERVICE_KEY= # service_role key (full access)
BOT_USER_ID=          # Your auth.users UUID
PORT=3001             # Set automatically by Railway/Render
```

### Frontend (Vercel) — .env.local
```
VITE_SUPABASE_URL=      # Same Supabase project URL
VITE_SUPABASE_ANON_KEY= # anon/public key (limited RLS access)
```

---

## COSTS (all free tiers)

| Service | Free tier |
|---------|-----------|
| Supabase | 500MB DB, 50K MAU, 2GB bandwidth |
| Railway | $5/month hobby (or free trial) |
| Render | 750 hours/month free (sleeps after 15min idle) |
| Vercel | Unlimited for personal projects |

**Render note**: Free tier sleeps after 15 minutes of inactivity.
The `/health` endpoint ping keeps it awake. Or use Railway ($5/month) for true 24/7.

---

## MONITORING

- Railway/Render dashboard shows server logs
- Supabase → Table Editor → engine_logs shows all bot activity
- Frontend Diagnostics tab shows last 100 log entries in real time
- `/health` endpoint gives current bot state at any time
