function roundCents(n) {
  return Math.round(Number(n) * 100) / 100;
}

function splitEvenCents(total, count) {
  const cents = Math.round(Number(total) * 100);
  const base = Math.floor(cents / count);
  const remainder = cents - base * count;
  return Array.from({ length: count }, (_, i) => (base + (i < remainder ? 1 : 0)) / 100);
}

function airport(code) {
  return String(code || "").trim().toUpperCase();
}

function confirmation(code) {
  return String(code || "").trim().toUpperCase();
}

/**
 * Round trip: exactly two legs, same confirmation, reciprocal airports
 * (A→B and B→A). Two-leg connections (A→B, B→C) are not round trips.
 */
function isRoundTripItinerary(legs) {
  if (!Array.isArray(legs) || legs.length !== 2) return false;
  const [a, b] = legs;
  if (confirmation(a.confirmation_code) !== confirmation(b.confirmation_code)) return false;
  if (!airport(a.origin) || !airport(a.destination) || !airport(b.origin) || !airport(b.destination)) {
    return false;
  }
  return airport(a.origin) === airport(b.destination) && airport(a.destination) === airport(b.origin);
}

function normalizeFarePresentation(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "combined_total" || v === "itemized_per_leg") return v;
  return null;
}

function perLegLog(assignmentLeg) {
  const leg = assignmentLeg.leg;
  return {
    confirmation: confirmation(leg.confirmation_code),
    flight_number: String(leg.flight_number || "").trim(),
    route: `${airport(leg.origin)}→${airport(leg.destination)}`,
    flight_date: leg.flight_date,
    extracted_price: roundCents(leg.price_paid_per_person),
    fare_presentation: assignmentLeg.farePresentationLog,
    extracted_fare_presentation: normalizeFarePresentation(leg.fare_presentation),
    baseline: assignmentLeg.baseline
  };
}

function roundTripAssigned(list, baselines, total, splitMethod, farePresentationLog) {
  return {
    isRoundTrip: true,
    splitMethod,
    legsDetected: 2,
    totalFareExtracted: total,
    farePresentationFallback: farePresentationLog === "fallback_heuristic",
    assigned: list.map((leg, i) => ({
      leg,
      baseline: baselines[i],
      is_round_trip: true,
      total_fare_paid: total,
      farePresentationLog
    }))
  };
}

/**
 * Branch on trip type and return per-leg baselines to store.
 * One-way (single leg): keep the extracted fare as the baseline.
 * Round trip: use fare_presentation from extraction; fall back to p0 !== p1 if it is missing.
 */
function assignFareBaselines(legs) {
  const list = Array.isArray(legs) ? legs : [];

  if (list.length === 1) {
    const total = roundCents(list[0].price_paid_per_person);
    const assigned = [
      {
        leg: list[0],
        baseline: total,
        is_round_trip: false,
        total_fare_paid: total
      }
    ];
    return {
      isRoundTrip: false,
      splitMethod: "one-way",
      legsDetected: 1,
      totalFareExtracted: total,
      assigned
    };
  }

  if (isRoundTripItinerary(list)) {
    const p0 = roundCents(list[0].price_paid_per_person);
    const p1 = roundCents(list[1].price_paid_per_person);
    const pres0 = normalizeFarePresentation(list[0].fare_presentation);
    const pres1 = normalizeFarePresentation(list[1].fare_presentation);

    if (pres0 === "itemized_per_leg" || pres1 === "itemized_per_leg") {
      const total = roundCents(p0 + p1);
      return roundTripAssigned(list, [p0, p1], total, "per-leg-extracted", "itemized_per_leg");
    }

    if (pres0 === "combined_total" && pres1 === "combined_total") {
      const total = p0;
      return roundTripAssigned(
        list,
        splitEvenCents(total, 2),
        total,
        "even-split-combined-total",
        "combined_total"
      );
    }

    console.warn("intake fare: fare_presentation missing or invalid; using p0 !== p1 fallback heuristic", {
      confirmation: confirmation(list[0].confirmation_code),
      fare_presentation: [list[0].fare_presentation ?? null, list[1].fare_presentation ?? null],
      p0,
      p1
    });
    const distinctPerLegFares = p0 !== p1;
    if (distinctPerLegFares) {
      const total = roundCents(p0 + p1);
      return roundTripAssigned(list, [p0, p1], total, "per-leg-extracted", "fallback_heuristic");
    }
    const total = p0;
    return roundTripAssigned(
      list,
      splitEvenCents(total, 2),
      total,
      "even-split-combined-total",
      "fallback_heuristic"
    );
  }

  if (list.length === 2) {
    const sameConf =
      confirmation(list[0].confirmation_code) === confirmation(list[1].confirmation_code);
    if (sameConf) {
      console.log("intake fare: two legs share a confirmation but are not a reciprocal round trip; not splitting", {
        confirmation: confirmation(list[0].confirmation_code),
        routes: list.map((l) => `${airport(l.origin)}→${airport(l.destination)}`)
      });
    }
  }

  const assigned = list.map((leg) => {
    const fare = roundCents(leg.price_paid_per_person);
    return {
      leg,
      baseline: fare,
      is_round_trip: false,
      total_fare_paid: fare
    };
  });
  const totalFareExtracted = roundCents(
    assigned.reduce((sum, item) => sum + Number(item.baseline), 0)
  );
  return {
    isRoundTrip: false,
    splitMethod: "non-round-trip-as-extracted",
    legsDetected: list.length,
    totalFareExtracted,
    assigned
  };
}

function logIntakeFareBaselines(result) {
  console.log("intake fare baselines", {
    legsDetected: result.legsDetected,
    totalFareExtracted: result.totalFareExtracted,
    isRoundTrip: result.isRoundTrip,
    splitMethod: result.splitMethod,
    farePresentationFallback: result.farePresentationFallback === true,
    perLegBaselines: result.assigned.map(perLegLog)
  });
}

module.exports = {
  assignFareBaselines,
  isRoundTripItinerary,
  logIntakeFareBaselines,
  roundCents,
  splitEvenCents
};
