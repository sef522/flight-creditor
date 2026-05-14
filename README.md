# ✈️ flight-creditor

A Telegram bot that monitors your flight bookings for price drops and alerts you when you can save money by canceling and rebooking.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-sef522-yellow?style=flat&logo=buy-me-a-coffee)](https://www.buymeacoffee.com/sef522)

## How it works

You DM the bot a photo of your airline confirmation. Claude reads the screenshot, saves the legs to a database, and once a day the bot checks current fares via SerpApi (Google Flights). If the math beats your savings bar, you get a Telegram ping with a link so you can compare and rebook on your own.

## Features

- Screenshot intake — no manual form-filling for confirmations
- Same-cabin fare checks against what you paid (Google Flights data for **any** airline)
- Daily run (9am Eastern) for active future flights
- `/list`, `/stop`, `/price`, `/updateprice` for managing watches
- Optional lock to a single Telegram chat (handy if the bot is “yours”)

## Requirements

- Node.js 20+
- Railway (or any Node host)
- Supabase (free tier works)
- Telegram bot (via [@BotFather](https://t.me/BotFather))
- SerpApi ([free tier — about 250 searches/month](https://serpapi.com/))
- Anthropic API key ([console](https://console.anthropic.com))

## Setup

1. **Clone and install**

   ```bash
   git clone https://github.com/sef522/flight-creditor.git
   cd flight-creditor
   npm install
   ```

2. **Supabase** — Create a project, open the SQL editor (or use the CLI), and run the SQL migrations **in order**: `supabase/migrations/20250512120000_initial_flight_creditor.sql`, then `supabase/migrations/20250514120000_remove_airline_constraint.sql`. Copy the project **URL** and **service_role** key (server-side only; never put that in a browser app).

3. **Telegram** — Talk to [@BotFather](https://t.me/BotFather), `/newbot`, and copy the bot token.

4. **SerpApi** — Sign up at [serpapi.com](https://serpapi.com), grab an API key from the dashboard.

5. **`.env`** — Copy the example file and fill it in:

   ```bash
   cp .env.example .env
   ```

   You’ll need Anthropic and SerpApi keys, Supabase URL + service role, and the Telegram token. Optionally set `TELEGRAM_CHAT_ID` so only your chat can drive the bot and receives alerts (get your numeric id from `getUpdates` after messaging the bot once).

6. **Deploy to Railway** — New project → deploy from this repo (or push after `railway link`). Add the same env vars in Railway’s dashboard. Start command is already `node index.js` in `railway.toml`. Redeploy when you change env or code.

Local smoke test: `npm start` with `.env` in place.

## Usage

**Add a flight** — Send the bot a clear photo of your confirmation (the largest image Telegram sends is used). If the parse looks good, legs get stored; shaky parses get a warning and nothing is saved until you try a clearer shot.

**Set what you paid** — After adding, run `/price ABC123 450` where `ABC123` is your confirmation code and `450` is **per person** in USD (whole dollars are fine). If a price is already set, use `/updateprice` instead.

**Other commands**

- `/list` — Active watches
- `/stop ABC123` — Stop monitoring that confirmation (all legs with that code)
- `/updateprice ABC123 450` — Change the stored per-person price anytime

## How alerts work

Default is **`ALERT_THRESHOLD_PER_TICKET=25`**: the public fare has to be at least **$25 less per person** than the price you saved (same math no matter how many passengers — it’s a per-ticket bar).

Nothing auto-cancels or auto-rebooks. You get a Telegram nudge, then you handle cancel / credit / rebook on the airline if it’s still worth it. Alerts include a **deep link**: Delta, United, American, and JetBlue get that airline’s own search URL; every other carrier gets a **Google Flights** search for the same route and date.

Set `TELEGRAM_CHAT_ID` or you won’t get pings — the bot only sends alerts to that chat.

## Environment variables

| Variable | What it’s for |
|----------|----------------|
| `TELEGRAM_BOT_TOKEN` | BotFather token (required) |
| `TELEGRAM_CHAT_ID` | If set, only this chat can use the bot; **alerts only send when this is set** |
| `ANTHROPIC_API_KEY` | Claude vision for reading confirmation screenshots |
| `SERPAPI_API_KEY` | Google Flights lookups via SerpApi |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (server only) |
| `ALERT_THRESHOLD_PER_TICKET` | Min per-person savings toward an alert, in USD (default `25`) |

## Airlines

Any airline works. The parser records an **IATA-style code** (e.g. `BA`, `LH`) or a short name when that’s clearer; Delta, United, American, and JetBlue are still normalized to `DELTA`, `UNITED`, `AMERICAN`, and `JETBLUE` so cabin rules and booking links stay accurate. Fare checks use **Google Flights via SerpApi** for every carrier — same engine as before, not a per-airline scraper.

## Contributing

PRs welcome. If this saved you money, [buy me a coffee](https://www.buymeacoffee.com/sef522) ☕

## License

MIT
