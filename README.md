# flight-creditor

Autonomous agent that ingests airline confirmation screenshots via Telegram, stores watched itineraries in Supabase, and runs a daily **SerpApi Google Flights** lookup for same-cabin public fares. When total savings meet your per-ticket threshold, it sends a Telegram alert with a deep link back to the airline booking flow.

## Stack

- Node.js 20+
- Supabase (Postgres) via service role on the server
- Telegram Bot API (`node-telegram-bot-api`)
- Anthropic Claude Sonnet 4 (`claude-sonnet-4-20250514`) for vision parsing
- **SerpApi** (`serpapi` npm package) — `google_flights` engine for fare quotes
- `node-cron` — daily run at **9:00 AM America/New_York**
- Railway (`railway.toml` runs `node index.js`)

## Setup

1. **Clone and install**

   ```bash
   cd flight-creditor
   npm install
   ```

2. **Supabase**

   - Create a project (or use an existing one).
   - Apply the SQL migration in `supabase/migrations/20250512120000_initial_flight_creditor.sql` (Supabase SQL editor, or `supabase db push` if you use the CLI).
   - Copy **Project URL** and **service_role** key for the server only (never expose service role in a browser app).

3. **Telegram**

   - Create a bot with [@BotFather](https://t.me/BotFather), copy the token.
   - Send a message to the bot, then resolve your numeric chat id (many guides use `https://api.telegram.org/bot<token>/getUpdates`). Set `TELEGRAM_CHAT_ID` to restrict intake/alerts to your chat (recommended).

4. **Anthropic**

   - Create an API key at [console.anthropic.com](https://console.anthropic.com).

5. **SerpApi**

   - Create an API key at [serpapi.com/manage-api-key](https://serpapi.com/manage-api-key). Fare lookups use the **Google Flights** engine.

6. **Environment**

   ```bash
   cp .env.example .env
   # fill in values
   ```

7. **Run locally**

   ```bash
   npm start
   ```

## Environment variables

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather. Required. |
| `TELEGRAM_CHAT_ID` | If set, photo intake and `/list` / `/stop` only apply to this chat id; price alerts are sent here. |
| `ANTHROPIC_API_KEY` | Claude API key for confirmation screenshot parsing. |
| `SERPAPI_API_KEY` | SerpApi key for Google Flights fare searches. |
| `SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (server-side only). |
| `ALERT_THRESHOLD_PER_TICKET` | Dollars saved **per person** before an alert fires; total bar is this times passenger count (default `25`). |

## Usage (Telegram)

- Send a **photo** of a confirmation (highest-resolution Telegram asset is downloaded). The bot parses legs with Claude, inserts rows into `watched_flights`, and replies with a short confirmation per leg.
- `/list` — active watches from Supabase.
- `/stop [confirmation_code]` — sets `active = false` for matching confirmation (case-insensitive).

## How to add a new airline scraper

1. Add the airline to the `watched_flights.airline` check constraint and parser normalization in `parser.js` / bot copy if you surface codes.
2. Create `scrapers/<airline>.js` exporting:

   ```js
   async function getFare(origin, destination, flightDate, flightNumber, cabinClass) {
     // return { pricePerPerson, cabinClass } or null
   }
   module.exports = { getFare };
   ```

3. At the top of the file, call `require("dotenv").config();` so env stays consistent with the rest of the app.
4. Use `searchFlights` / `findMatchingGoogleFlightFare` from `scrapers/serpapi.js` (same Google Flights data for all carriers; filter or extend as needed).
5. Wire the scraper in `monitor.js` (`pickScraper` switch) and add a `bookingDeepLink` case for alert links.
6. Swallow errors, return `null` on failure, and **log** the outcome for debugging.

## Notes

- Fare data comes from SerpApi’s Google Flights results (`best_flights` / `other_flights`). Results depend on Google’s coverage and your SerpApi plan.
- When a scraper returns `null`, the monitor **logs and skips** that cycle (no `price_checks` row, since there is no reliable current price).
- RLS is enabled on both tables with no policies for `anon` / `authenticated`; the service role bypasses RLS for this backend-only workload.

## License

Private / personal use.
