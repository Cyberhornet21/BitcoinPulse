# ₿ Bitcoin Pulse

> A minimalist, viral single-page website that shows the **real-time heartbeat of the Bitcoin network** — no backend, no build step, no API keys.

![status: BITCOIN IS RESTLESS](https://img.shields.io/badge/status-BITCOIN%20IS%20RESTLESS-ff7a00?style=flat-square)

---

## What it does

- **Animated heart** beats at a rate driven by real Bitcoin data (58–118 BPM)
- **Status phrase** ("BITCOIN IS STEADY", "BITCOIN IS IN PANIC", …) changes based on network conditions
- **Live HUD footer**: `Fees: 18 sat/vB • Vol: 0.12% • F&G: 72`
- Remembers the last known values across page reloads via `localStorage`

---

## Setup — GitHub Pages

1. Push this repo to GitHub (any branch, e.g. `main`)
2. Go to **Settings → Pages**
3. Source: **Deploy from a branch** → `main` → `/ (root)`
4. Your site will be live at [[`https://vibecodingfelix.github.io/Bitcoin-Pulse/`](https://vibecodingfelix.github.io/Bitcoin-Pulse/)](https://cyberhornet21.github.io/BitcoinPulse/)

That's it. No npm, no build, no config.

---

## Data Sources

| Source | Endpoint | Poll rate |
|--------|----------|-----------|
| **Fees** (fastest sat/vB) | `https://mempool.space/api/v1/fees/recommended` | every 20 s |
| **Mempool pressure** (optional) | `https://mempool.space/api/mempool` | every 20 s |
| **Fear & Greed Index** | `https://api.alternative.me/fng/` | every 20 s |
| **BTC Price / Volatility** | Kraken WebSocket `wss://ws.kraken.com` | continuous |
| **Price fallback** | `https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT` | every 3 s (if WS fails) |

**Rate limits**: All APIs are public and generous. Polling at 20 s is well within limits.

---

## Status Logic

| Status | Condition |
|--------|-----------|
| **DORMANT** | Very low fees + vol |
| **STEADY** | Fees < 0.5, vol < 0.5, F&G near 50 |
| **RESTLESS** | Fees or vol in mid range (≥ 0.40) |
| **OVERHEATED** | High fees (≥ 0.70) + mid vol |
| **EUPHORIC** | High vol + high greed |
| **PANIC** | High vol + high fear |

Anti-flicker: statuses are held for at least 25 seconds, unless PANIC or EUPHORIC triggers.

---

## Troubleshooting

### CORS errors on `api.alternative.me`
Some networks or browser extensions block this endpoint. The app handles it gracefully — Fear & Greed shows `—` and the pulse is not affected (neutral F&G assumed).

### Kraken WebSocket not connecting
Firewalls or certain ISPs block WebSocket connections. The app automatically falls back to polling Binance's public market data API every 3 seconds for price updates (BTC/USDT, used only for volatility calculation).

### Data showing as dim / stale
Values older than 3 minutes are shown at low opacity. Refresh the page or check your internet connection.

### Running locally
Because of browser security, some APIs may block requests from `file://`. Use a simple server:
```bash
npx serve .
# or
python3 -m http.server 8080
```

---

## Inspiration

- [https://github.com/WebDevSimplified/css-heart-animation](https://github.com/WebDevSimplified/css-heart-animation) — clean CSS-only heart
- [https://github.com/nicholasgasior/heartbeat-animation](https://github.com/nicholasgasior/heartbeat-animation) — JS-driven heartbeat timing
- [https://github.com/tobiasahlin/SpinKit](https://github.com/tobiasahlin/SpinKit) — CSS animation principles (timing, easing)

---

## License

MIT — do whatever you want with it. ₿
