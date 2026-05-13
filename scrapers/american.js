require("dotenv").config();

const { chromium } = require("playwright");

const TIMEOUT_MS = 30000;

function flightDigits(flightNumber) {
  const m = String(flightNumber || "").match(/(\d{1,4})$/);
  return m ? m[1] : String(flightNumber || "").replace(/\D/g, "");
}

function rowMatchesCabin(text, cabinClass) {
  const t = String(text || "");
  switch (cabinClass) {
    case "BASIC_ECONOMY":
      return /basic\s+economy|main\s+cabin\s+choice/i.test(t);
    case "MAIN_CABIN":
      if (/basic\s+economy/i.test(t)) return false;
      return /main\s+cabin|main\s+select|economy/i.test(t);
    case "COMFORT_PLUS":
      return /premium\s+economy|main\s+cabin\s+extra|comfort/i.test(t);
    case "FIRST":
      return /\bfirst\b/i.test(t);
    case "BUSINESS":
      return /\bbusiness\b/i.test(t);
    default:
      return true;
  }
}

function minFareFromText(text) {
  const matches = [...String(text).matchAll(/\$\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.\d{2})?/g)];
  const nums = matches
    .map((m) => Number(m[1].replace(/,/g, "")))
    .filter((n) => Number.isFinite(n) && n >= 10 && n < 100000);
  if (!nums.length) return null;
  return Math.min(...nums);
}

/**
 * @returns {Promise<{ pricePerPerson: number, cabinClass: string } | null>}
 */
async function getFare(origin, destination, flightDate, flightNumber, cabinClass) {
  const digits = flightDigits(flightNumber);
  const url = `https://www.aa.com/booking/find-flights?from=${encodeURIComponent(
    origin
  )}&to=${encodeURIComponent(destination)}&date=${encodeURIComponent(
    flightDate
  )}&pax=1&adults=1&type=OneWay&tripType=oneway`;

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    });
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));

    const price = await page.evaluate(
      ({ digits, cabinClass }) => {
        function rowMatchesCabin(text, cc) {
          const t = String(text || "");
          switch (cc) {
            case "BASIC_ECONOMY":
              return /basic\s+economy|main\s+cabin\s+choice/i.test(t);
            case "MAIN_CABIN":
              if (/basic\s+economy/i.test(t)) return false;
              return /main\s+cabin|main\s+select|economy/i.test(t);
            case "COMFORT_PLUS":
              return /premium\s+economy|main\s+cabin\s+extra|comfort/i.test(t);
            case "FIRST":
              return /\bfirst\b/i.test(t);
            case "BUSINESS":
              return /\bbusiness\b/i.test(t);
            default:
              return true;
          }
        }
        const candidates = Array.from(
          document.querySelectorAll("tr, [role='row'], li, article, section, div, span")
        );
        let best = null;
        for (const el of candidates) {
          const t = el.innerText || "";
          if (!t.includes(digits)) continue;
          if (!rowMatchesCabin(t, cabinClass)) continue;
          const matches = [...t.matchAll(/\$\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.\d{2})?/g)];
          const nums = matches
            .map((m) => Number(m[1].replace(/,/g, "")))
            .filter((n) => Number.isFinite(n) && n >= 10 && n < 100000);
          if (!nums.length) continue;
          const localMin = Math.min(...nums);
          if (best == null || localMin < best) best = localMin;
        }
        return best;
      },
      { digits, cabinClass }
    );

    const fallback =
      price ??
      (await (async () => {
        const body = await page.evaluate(() => document.body?.innerText || "");
        if (!body.includes(digits)) return null;
        if (!rowMatchesCabin(body, cabinClass)) return null;
        return minFareFromText(body);
      })());

    console.log("american getFare", {
      origin,
      destination,
      flightDate,
      flightNumber,
      cabinClass,
      pricePerPerson: fallback
    });

    if (fallback == null) return null;
    return { pricePerPerson: Number(fallback), cabinClass };
  } catch (e) {
    console.error("american getFare error:", e?.message || e);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { getFare };
