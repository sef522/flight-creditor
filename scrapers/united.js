require("dotenv").config();

const { searchFlights, findMatchingGoogleFlightFare, travelClassForCabin } = require("./serpapi");

/**
 * @returns {Promise<{ pricePerPerson: number, cabinClass: string } | null>}
 */
async function getFare(origin, destination, flightDate, flightNumber, cabinClass) {
  try {
    const data = await searchFlights({
      departure_id: String(origin || "").trim().toUpperCase(),
      arrival_id: String(destination || "").trim().toUpperCase(),
      outbound_date: flightDate,
      travel_class: travelClassForCabin(cabinClass)
    });
    const out = findMatchingGoogleFlightFare(data, flightNumber, cabinClass);
    console.log("united getFare", {
      origin,
      destination,
      flightDate,
      flightNumber,
      cabinClass,
      pricePerPerson: out?.pricePerPerson ?? null
    });
    return out;
  } catch (e) {
    console.error("united getFare error:", e?.message || e);
    return null;
  }
}

module.exports = { getFare };
