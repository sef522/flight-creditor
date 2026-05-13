# flight-creditor

Autonomous agent that watches flight bookings for **same-cabin** price drops: you send **airline confirmation screenshots** over Telegram, it parses them with **Claude**, stores legs in **Supabase**, and each day runs **SerpApi Google Flights** quotes. When savings per ticket clear your threshold, it sends a **Telegram** alert with a link back to the airline’s booking site.

## Stack

| Piece | Role |
|-------|------|
| **Node.js 20+** | Runtime (e.g. Railway). |
| **Telegram** (`node-telegram-bot-api`) | Photo intake, commands, alerts. |
| **Anthropic** (`@anthropic-ai/sdk`) | Vision: `claude-sonnet-4-20250514` parses confirmations to structured JSON. |
| **Supabase** (`@supabase/supabase-js`) | Postgres: `watched_flights`, `price_checks`. Service role only on the server. |
| **`ws`** | Passed as Supabase **Realtime** `transport` so the client does not assume a global `WebSocket` (fixes Node 20 / Railway). |
| **SerpApi** (`serpapi`) | `google_flights` engine for public fare lookups (no browser scraping). |
| **`node-cron`** | Daily monitor at **9:00 AM `America/New_York`**. |
| **`dotenv`** | Env loaded at process start and in modules that need secrets. |
| **Railway** | `railway.toml` — `node index.js`. |

## Repository layout

| Path | Purpose |
|------|---------|
| `index.js` | Loads env, registers `unhandledRejection` / `uncaughtException` / Telegram `polling_error`, starts bot + cron. |
| `bot.js` | Telegram handlers: photos, `/list`, `/stop`, `/price`, `/updateprice`. |
| `parser.js` | Claude vision → legs JSON (airline/cabin normalization, digit-only flight numbers, passenger/seat and fare rules in the system prompt). |
| `monitor.js` | Daily job: active future flights → airline `getFare` → `price_checks` rows → threshold alerts + deep links. |
| `supabase.js` | Single `createClient` (with `ws` transport) + all DB helpers used by bot and monitor. |
| `scrapers/serpapi.js` | SerpApi `searchFlights` + `findMatchingGoogleFlightFare` (shared by all airlines). |
| `scrapers/{american,delta,united,jetblue}.js` | Thin wrappers: same `getFare(origin, destination, flightDate, flightNumber, cabinClass)` → `{ pricePerPerson, cabinClass } \| null`. |
| `supabase/migrations/` | Schema for `watched_flights` and `price_checks`. |
| `.env.example` | Required env var names. |

## Database (Supabase)

Apply `supabase/migrations/20250512120000_initial_flight_creditor.sql`.

- **`watched_flights`** — One row per monitored leg: confirmation code, airline (`DELTA` \| `UNITED` \| `AMERICAN` \| `JETBLUE`), flight number (digits as stored), IATA origin/destination, date, cabin enum, passengers, `price_paid_per_person`, `active`, optional `added_by_telegram_user_id`.
- **`price_checks`** — Each poll: `flight_id`, `current_price_per_person`, `delta_per_person`, `total_savings`, `alert_sent`.

RLS is enabled on both tables with no policies for `anon` / `authenticated`; only the **service role** (this server) should talk to the API.

## Setup

1. **Clone and install**

   ```bash
   cd flight-creditor
   npm install
   ```

2. **Supabase** — Create a project, run the migration (SQL editor or CLI), copy **URL** + **service_role** key (server only).

3. **Telegram** — Bot token from [@BotFather](https://t.me/BotFather). Optional but recommended: set `TELEGRAM_CHAT_ID` to your numeric chat id (e.g. via `getUpdates`) so only that chat can use the bot and receives alerts.

4. **Anthropic** — API key from [console.anthropic.com](https://console.anthropic.com).

5. **SerpApi** — API key from [serpapi.com/manage-api-key](https://serpapi.com/manage-api-key) (Google Flights engine).

6. **Environment**

   ```bash
   cp .env.example .env
   # edit .env
   ```

7. **Run**

   ```bash
   npm start
   ```

## Environment variables

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | **Required.** BotFather token. |
| `TELEGRAM_CHAT_ID` | If set, **only this chat** can use commands and photo intake; **price-drop alerts** are sent here. Omit to allow any chat (not recommended in production). |
| `ANTHROPIC_API_KEY` | Claude vision for confirmation parsing. |
| `SERPAPI_API_KEY` | SerpApi Google Flights searches for `getFare`. |
| `SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (never ship to a browser). |
| `ALERT_THRESHOLD_PER_TICKET` | Minimum **per-person** savings (USD) toward an alert; total bar is `threshold × passengers` (default `25`). |

## Telegram usage

- **Photo** — Send a confirmation screenshot (largest Telegram photo is used). Parser returns one or more legs; each valid leg is inserted into `watched_flights`. Low-confidence parses get a warning and are not stored.
- **`/list`** — Lists all **active** watches from Supabase.
- **`/stop [confirmation_code]`** — Sets `active = false` for that confirmation (case-insensitive); may stop multiple legs sharing the code.
- **`/price [confirmation_code] [price_per_person]`** — If paid price is still unset (0 / null), sets `price_paid_per_person` for all active legs with that confirmation. If already non-zero, replies to use `/updateprice`.
- **`/updateprice [confirmation_code] [price_per_person]`** — Always updates paid price for matching active legs.

Commands support `/command@BotName` style suffixes where implemented.

## Daily monitor (`monitor.js`)

- Runs **once per day at 9:00 AM Eastern** (`America/New_York`).
- Loads active rows with `flight_date >= today` (Eastern calendar date).
- Calls the scraper for that row’s airline; on **`null`** (error or no quote), logs and **skips** (no `price_checks` insert).
- On a numeric quote: writes **`price_checks`**, computes `total_savings = (paid − current) × passengers`, and sends an alert if `total_savings >= ALERT_THRESHOLD_PER_TICKET × passengers` and `delta_per_person > 0`, **unless** a duplicate was already alerted for the same flight at the same current price (see `shouldSkipDuplicateAlert` in `supabase.js`).
- Alerts include a **deep link** to the airline’s booking/search flow (`bookingDeepLink` in `monitor.js`).

## Fare lookups (SerpApi)

- Shared logic in **`scrapers/serpapi.js`**: `searchFlights` merges defaults (`engine: google_flights`, `type: 2` one-way, `currency: USD`, `hl: en`, `adults: 1`) with per-call `departure_id`, `arrival_id`, `outbound_date`, `travel_class`.
- **`travel_class` mapping**: `BASIC_ECONOMY` & `MAIN_CABIN` → `1`; `COMFORT_PLUS` → `2`; `BUSINESS` → `3`; `FIRST` → `4`.
- Results **`best_flights`** then **`other_flights`** are scanned for an itinerary whose **any** leg’s `flight_number` matches the stored digits (e.g. `AA 3209` → `3209`).
- **`MAIN_CABIN` vs `BASIC_ECONOMY`** (when `travel_class` is economy): itineraries whose combined fare/extension text matches **`/basic/i`** are **skipped** for Main; Basic requires a basic-labeled fare for a match.
- Airline files only differ by logging prefix; all use the same Google Flights dataset (no per-airline SerpApi filter unless you add one later).

## Supabase client (Node 20 / Railway)

`supabase.js` configures:

```js
createClient(url, key, {
  realtime: { transport: require("ws") }
});
```

So Realtime does not rely on a browser global `WebSocket`.

## How to add a new airline

1. Extend DB + parser enums for the new carrier if needed.
2. Add `scrapers/<name>.js` exporting `getFare` (same signature and return shape as existing scrapers).
3. Wire `pickScraper` and `bookingDeepLink` in `monitor.js`.

## Operational notes

- **SerpApi usage and quotas** depend on your plan; empty or partial Google Flights results yield `null` fares.
- **Parser behavior** (cabin fare tables, digit-only flight numbers, passengers inferred from seat rows when count missing, `price_paid_per_person` as printed without dividing by pax) lives in **`parser.js`** system prompt — adjust there, not in the bot, for extraction rules.
- All Supabase access should go through **`supabase.js`** helpers.

## License

Private / personal use.
