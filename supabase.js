require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.warn("Supabase: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.");
}

const supabase = createClient(url || "", key || "");

function todayIsoDateInEastern() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = fmt.formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  if (!y || !m || !d) return new Date().toISOString().slice(0, 10);
  return `${y}-${m}-${d}`;
}

async function insertWatchedFlight(row) {
  const { data, error } = await supabase.from("watched_flights").insert(row).select("id").maybeSingle();
  if (error) throw error;
  return data;
}

async function listActiveWatchedFlights() {
  const { data, error } = await supabase
    .from("watched_flights")
    .select("*")
    .eq("active", true)
    .order("flight_date", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function deactivateWatchedFlightByConfirmation(confirmationCode) {
  const code = String(confirmationCode || "").trim();
  if (!code) return { count: 0 };
  const { data, error } = await supabase
    .from("watched_flights")
    .update({ active: false })
    .ilike("confirmation_code", code)
    .eq("active", true)
    .select("id");
  if (error) throw error;
  return { count: Array.isArray(data) ? data.length : 0 };
}

async function getActiveWatchedFlightsForMonitoring() {
  const today = todayIsoDateInEastern();
  const { data, error } = await supabase
    .from("watched_flights")
    .select("*")
    .eq("active", true)
    .gte("flight_date", today);
  if (error) throw error;
  return data || [];
}

async function getLastPriceCheck(flightId) {
  const { data, error } = await supabase
    .from("price_checks")
    .select("*")
    .eq("flight_id", flightId)
    .order("checked_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return Array.isArray(data) && data[0] ? data[0] : null;
}

/**
 * True if we already sent an alert for this flight at this current price (avoids duplicate spam).
 * Uses the most recent price_checks row for the flight per spec.
 */
async function shouldSkipDuplicateAlert(flightId, newCurrentPricePerPerson) {
  const last = await getLastPriceCheck(flightId);
  if (!last || !last.alert_sent) return false;
  const lastPrice = Number(last.current_price_per_person);
  const nextPrice = Number(newCurrentPricePerPerson);
  if (Number.isNaN(lastPrice) || Number.isNaN(nextPrice)) return false;
  return Math.round(lastPrice * 100) === Math.round(nextPrice * 100);
}

async function insertPriceCheck(row) {
  const { data, error } = await supabase.from("price_checks").insert(row).select("id").maybeSingle();
  if (error) throw error;
  return data;
}

module.exports = {
  supabase,
  insertWatchedFlight,
  listActiveWatchedFlights,
  deactivateWatchedFlightByConfirmation,
  getActiveWatchedFlightsForMonitoring,
  getLastPriceCheck,
  shouldSkipDuplicateAlert,
  insertPriceCheck,
  todayIsoDateInEastern
};
