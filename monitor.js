require("dotenv").config();

const cron = require("node-cron");
const {
  getActiveWatchedFlightsForMonitoring,
  insertPriceCheck,
  shouldSkipDuplicateAlert
} = require("./supabase");
const { getFare } = require("./scrapers/generic");

const AIRLINE_DISPLAY = {
  DELTA: "DL",
  UNITED: "UA",
  AMERICAN: "AA",
  JETBLUE: "B6"
};

const CABIN_DISPLAY = {
  BASIC_ECONOMY: "Basic Economy",
  MAIN_CABIN: "Main Cabin",
  COMFORT_PLUS: "Comfort+",
  FIRST: "First",
  BUSINESS: "Business"
};

function formatShortDate(isoYmd) {
  try {
    const [y, m, d] = String(isoYmd).split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
      dt
    );
  } catch {
    return isoYmd;
  }
}

function alertThresholdPerTicket() {
  const raw = process.env.ALERT_THRESHOLD_PER_TICKET;
  const n = raw == null || raw === "" ? 25 : Number(raw);
  return Number.isFinite(n) ? n : 25;
}

function googleFlightsDeepLink(origin, destination, flightDate) {
  const o = String(origin || "").trim().toUpperCase();
  const d = String(destination || "").trim().toUpperCase();
  const fd = String(flightDate || "").trim();
  const q = `One way from ${o} to ${d} on ${fd}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

function bookingDeepLink(airline, origin, destination, flightDate) {
  const o = encodeURIComponent(origin);
  const d = encodeURIComponent(destination);
  const fd = encodeURIComponent(flightDate);
  switch (airline) {
    case "DELTA":
      return `https://www.delta.com/flight-search/book-a-flight?tripType=ONE_WAY&originCity=${o}&destinationCity=${d}&departureDate=${fd}&passengers=1`;
    case "UNITED":
      return `https://www.united.com/en/us/fsr/choose-flights?f=${o}&t=${d}&d=${fd}&tt=1&px=1&taxng=1&newHP=True&st=bestmatches`;
    case "AMERICAN":
      return `https://www.aa.com/booking/find-flights?from=${o}&to=${d}&date=${fd}&pax=1&adults=1&type=OneWay&tripType=oneway`;
    case "JETBLUE":
      return `https://www.jetblue.com/booking/flights?from=${o}&to=${d}&depart=${fd}&isOneWay=true&ADT=1`;
    default:
      return googleFlightsDeepLink(origin, destination, flightDate);
  }
}

function formatMoneyForStatus(n) {
  if (!Number.isFinite(n)) return "—";
  const rounded = Math.round(n * 100) / 100;
  return rounded % 1 === 0 ? `$${rounded.toFixed(0)}` : `$${rounded.toFixed(2)}`;
}

/**
 * @param {Array<{ flight: Record<string, unknown>, quote: { pricePerPerson: number } | null }>} pollSnapshot
 */
function buildWeeklyStatusMessage(pollSnapshot) {
  const dateLine = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York"
  }).format(new Date());

  const lines = [
    "📊 Weekly Status — flight-creditor",
    `🗓 Sunday check-in · ${dateLine}`,
    "",
    `Flights monitored: ${pollSnapshot.length}`
  ];

  for (const { flight, quote } of pollSnapshot) {
    const iata = AIRLINE_DISPLAY[flight.airline] || flight.airline;
    const when = formatShortDate(flight.flight_date);
    lines.push(
      `✈️ ${iata} ${flight.flight_number} · ${flight.origin}→${flight.destination} · ${when}`
    );
    if (!quote || quote.pricePerPerson == null) {
      lines.push("   No quote available today");
      continue;
    }
    const paid = Number(flight.price_paid_per_person);
    const current = Number(quote.pricePerPerson);
    const paidStr = formatMoneyForStatus(paid);
    const currentStr = formatMoneyForStatus(current);
    const dropped = Number.isFinite(paid) && Number.isFinite(current) && current < paid;
    lines.push(`   Paid: ${paidStr} · Current: ${currentStr} · ${dropped ? "Drop" : "No drop"}`);
  }

  lines.push("", "Next check: tomorrow 9:00 AM ET");
  return lines.join("\n");
}

function buildAlertText(flight, quote, deltaPerPerson, totalSavings) {
  const iata = AIRLINE_DISPLAY[flight.airline] || flight.airline;
  const cabin = CABIN_DISPLAY[flight.cabin_class] || flight.cabin_class;
  const when = formatShortDate(flight.flight_date);
  const paid = Number(flight.price_paid_per_person).toFixed(0);
  const now = Number(quote.pricePerPerson).toFixed(0);
  const dpp = Number(deltaPerPerson).toFixed(0);
  const total = Number(totalSavings).toFixed(0);
  const link = bookingDeepLink(flight.airline, flight.origin, flight.destination, flight.flight_date);
  return (
    `✈️ Price Drop Alert\n` +
    `${iata} ${flight.flight_number} · ${flight.origin} → ${flight.destination} · ${when}\n` +
    `Cabin: ${cabin}\n` +
    `Paid: $${paid}/person · Now: $${now}/person\n` +
    `Savings: $${dpp}/person · $${total} total (${flight.passengers} passengers)\n` +
    `Confirmation: ${flight.confirmation_code}\n\n` +
    `Rebook here: ${link}`
  );
}

async function runDailyChecks(bot) {
  const threshold = alertThresholdPerTicket();
  const flights = await getActiveWatchedFlightsForMonitoring();
  console.log(`Monitor: evaluating ${flights.length} active flight(s).`);

  /** @type {Array<{ flight: (typeof flights)[number], quote: { pricePerPerson: number } | null }>} */
  const pollSnapshot = [];

  for (const flight of flights) {
    let quote = null;
    try {
      quote = await getFare(
        flight.origin,
        flight.destination,
        flight.flight_date,
        flight.flight_number,
        flight.cabin_class
      );

      if (!quote || quote.pricePerPerson == null) {
        console.log("Monitor: no quote", {
          id: flight.id,
          airline: flight.airline,
          flight: flight.flight_number,
          route: `${flight.origin}-${flight.destination}`,
          date: flight.flight_date
        });
        pollSnapshot.push({ flight, quote: null });
        continue;
      }

      const paid = Number(flight.price_paid_per_person);
      const current = Number(quote.pricePerPerson);
      const deltaPerPerson = paid - current;
      const totalSavings = deltaPerPerson * Number(flight.passengers);

      const meetsThreshold = totalSavings >= threshold * Number(flight.passengers);
      let alertSent = false;

      if (meetsThreshold && deltaPerPerson > 0) {
        const skipDup = await shouldSkipDuplicateAlert(flight.id, current);
        if (skipDup) {
          console.log("Monitor: duplicate alert skipped (same price as last alerted)", {
            flight_id: flight.id,
            current
          });
        } else if (process.env.TELEGRAM_CHAT_ID) {
          const text = buildAlertText(flight, quote, deltaPerPerson, totalSavings);
          await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, text);
          alertSent = true;
        } else {
          console.warn("Monitor: alert would fire but TELEGRAM_CHAT_ID is missing");
        }
      }

      await insertPriceCheck({
        flight_id: flight.id,
        current_price_per_person: current,
        delta_per_person: deltaPerPerson,
        total_savings: totalSavings,
        alert_sent: alertSent
      });

      if (alertSent) {
        console.log("Monitor: alert sent", { flight_id: flight.id, totalSavings, current });
      }

      pollSnapshot.push({ flight, quote });
    } catch (e) {
      console.error("Monitor: row error", flight?.id, e);
      pollSnapshot.push({ flight, quote: quote && quote.pricePerPerson != null ? quote : null });
    }
  }

  if (new Date().getDay() === 0 && process.env.TELEGRAM_CHAT_ID) {
    try {
      const text = buildWeeklyStatusMessage(pollSnapshot);
      await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, text);
      console.log("Monitor: weekly status message sent (Sunday).");
    } catch (e) {
      console.error("Monitor: weekly status send failed:", e);
    }
  }
}

/**
 * @param {import('node-telegram-bot-api')} bot
 */
function startMonitorCron(bot) {
  cron.schedule(
    "0 9 * * *",
    () => {
      runDailyChecks(bot).catch((e) => console.error("Monitor cron run failed:", e));
    },
    { timezone: "America/New_York" }
  );
  console.log("Monitor: cron scheduled daily 9:00 AM America/New_York");
}

module.exports = { startMonitorCron, runDailyChecks };
