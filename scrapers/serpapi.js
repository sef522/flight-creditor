require("dotenv").config();

const { getJson } = require("serpapi");

/**
 * @param {Record<string, unknown>} overrides SerpApi `google_flights` parameters merged onto defaults.
 * @returns {Promise<Record<string, unknown>>}
 */
async function searchFlights(overrides) {
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error("SERPAPI_API_KEY is not set");
  }
  const params = {
    engine: "google_flights",
    api_key: String(apiKey).trim(),
    type: "2",
    currency: "USD",
    hl: "en",
    adults: 1,
    ...overrides
  };
  if (params.travel_class != null && typeof params.travel_class === "string") {
    params.travel_class = Number(params.travel_class);
  }
  const json = await getJson(params);
  if (json && json.error) {
    throw new Error(typeof json.error === "string" ? json.error : JSON.stringify(json.error));
  }
  return json;
}

function travelClassForCabin(cabinClass) {
  switch (cabinClass) {
    case "BASIC_ECONOMY":
    case "MAIN_CABIN":
      return 1;
    case "COMFORT_PLUS":
      return 2;
    case "BUSINESS":
      return 3;
    case "FIRST":
      return 4;
    default:
      return 1;
  }
}

function normalizeFlightDigits(flightNumber) {
  const m = String(flightNumber || "").match(/(\d{1,4})$/);
  const raw = m ? m[1] : String(flightNumber || "").replace(/\D/g, "");
  const trimmed = String(raw).replace(/^0+/, "");
  return trimmed || raw;
}

function legFlightDigits(apiFlightNumber) {
  const m = String(apiFlightNumber || "").match(/(\d{1,4})\s*$/);
  const raw = m ? m[1] : "";
  const trimmed = String(raw).replace(/^0+/, "");
  return trimmed || raw;
}

function itineraryHasFlightNumber(itinerary, targetDigits) {
  const t = String(targetDigits || "").replace(/^0+/, "") || String(targetDigits);
  const legs = Array.isArray(itinerary?.flights) ? itinerary.flights : [];
  for (const leg of legs) {
    if (legFlightDigits(leg.flight_number) === t) return true;
  }
  return false;
}

function itineraryFareLabelText(itinerary) {
  const parts = [];
  if (Array.isArray(itinerary?.extensions)) {
    parts.push(...itinerary.extensions.map(String));
  }
  if (itinerary?.type) parts.push(String(itinerary.type));
  for (const leg of itinerary?.flights || []) {
    if (Array.isArray(leg.extensions)) {
      parts.push(...leg.extensions.map(String));
    }
    if (leg.travel_class) parts.push(String(leg.travel_class));
  }
  return parts.join(" | ");
}

/**
 * @param {Record<string, unknown>} data Parsed SerpApi Google Flights JSON
 * @param {string} flightNumber Raw flight number from DB (digits or prefixed)
 * @param {string} cabinClass watched_flights.cabin_class
 * @returns {{ pricePerPerson: number, cabinClass: string } | null}
 */
function findMatchingGoogleFlightFare(data, flightNumber, cabinClass) {
  const digits = normalizeFlightDigits(flightNumber);
  if (!digits) return null;

  const best = Array.isArray(data?.best_flights) ? data.best_flights : [];
  const other = Array.isArray(data?.other_flights) ? data.other_flights : [];
  const combined = [...best, ...other];

  const matching = combined.filter((it) => itineraryHasFlightNumber(it, digits));
  if (!matching.length) return null;

  const labelHasBasic = (it) => /basic/i.test(itineraryFareLabelText(it));

  if (cabinClass === "MAIN_CABIN") {
    for (const it of matching) {
      if (labelHasBasic(it)) continue;
      const n = Number(it.price);
      if (Number.isFinite(n) && n > 0) {
        return { pricePerPerson: n, cabinClass };
      }
    }
    return null;
  }

  if (cabinClass === "BASIC_ECONOMY") {
    for (const it of matching) {
      if (!labelHasBasic(it)) continue;
      const n = Number(it.price);
      if (Number.isFinite(n) && n > 0) {
        return { pricePerPerson: n, cabinClass };
      }
    }
    return null;
  }

  const it0 = matching[0];
  const n0 = Number(it0?.price);
  if (!Number.isFinite(n0) || n0 <= 0) return null;
  return { pricePerPerson: n0, cabinClass };
}

module.exports = {
  searchFlights,
  findMatchingGoogleFlightFare,
  travelClassForCabin,
  normalizeFlightDigits
};
