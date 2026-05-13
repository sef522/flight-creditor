require("dotenv").config();

const fs = require("fs").promises;
const { chromium } = require("playwright");

const TIMEOUT_MS = 30000;
const DEBUG_HTML = "/tmp/american-debug.html";
const DEBUG_TEXT = "/tmp/american-debug-text.txt";
const DEBUG_SCREENSHOT = "/tmp/american-debug.png";

function flightDigits(flightNumber) {
  const m = String(flightNumber || "").match(/(\d{1,4})$/);
  return m ? m[1] : String(flightNumber || "").replace(/\D/g, "");
}

function flightTextRegexSource(digits) {
  const d = String(digits || "").replace(/^0+/, "") || String(digits);
  return `(?:^|[^0-9])(?:AA\\s*)?0*${d}(?:[^0-9]|$)`;
}

async function writeDebugArtifacts(page, log) {
  try {
    const html = await page.content().catch(() => "");
    const text = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    await fs.writeFile(DEBUG_HTML, html, "utf8");
    await fs.writeFile(DEBUG_TEXT, text, "utf8");
    log.info(
      "american debug: wrote",
      DEBUG_HTML,
      `(${html.length} chars),`,
      DEBUG_TEXT,
      `(${text.length} chars)`
    );
    if (text.length <= 12000) {
      console.log("american debug page text:\n", text);
    } else {
      console.log("american debug page text (first 8000 chars):\n", text.slice(0, 8000));
    }
    await page.screenshot({ path: DEBUG_SCREENSHOT, fullPage: true }).catch((e) => {
      log.warn("american debug screenshot failed:", e?.message);
    });
    console.log("american debug: screenshot", DEBUG_SCREENSHOT);
  } catch (e) {
    console.error("american debug artifact write failed:", e?.message || e);
  }
}

async function acceptCookiesIfPresent(page) {
  const candidates = [
    "#onetrust-accept-btn-handler",
    'button:has-text("Accept All Cookies")',
    'button:has-text("Accept all")',
    'button:has-text("Accept")'
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
      await loc.click({ timeout: 3000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      return;
    }
  }
}

async function maybeClickSearch(page) {
  const search = page.getByRole("button", { name: /search flights|search/i }).first();
  if (await search.isVisible({ timeout: 4000 }).catch(() => false)) {
    await search.click({ timeout: 8000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function ensurePassengerCountOne(page) {
  const spin = page.getByRole("spinbutton", { name: /adults?/i }).first();
  if (await spin.isVisible({ timeout: 2500 }).catch(() => false)) {
    await spin.fill("1").catch(() => {});
    await spin.press("Tab").catch(() => {});
  }
}

async function isAccessDenied(page) {
  const t = await page.evaluate(() => document.body?.innerText?.slice(0, 800) || "").catch(() => "");
  return /access denied/i.test(t) && /errors\.edgesuite\.net/i.test(t);
}

async function waitForFlightInDom(page, digits, log) {
  const pattern = flightTextRegexSource(digits);
  try {
    await page.waitForFunction(
      (src) => {
        const body = document.body?.innerText || "";
        try {
          return new RegExp(src, "i").test(body);
        } catch {
          return false;
        }
      },
      pattern,
      { timeout: 25000 }
    );
  } catch (e) {
    log.warn("american: timeout waiting for flight digits in DOM:", e?.message || e);
  }
}

async function launchChromium() {
  const args = ["--disable-blink-features=AutomationControlled"];
  if (process.env.AMERICAN_USE_CHROME_CHANNEL === "1") {
    try {
      return await chromium.launch({ headless: true, channel: "chrome", args });
    } catch (e) {
      console.warn("american: Chrome channel launch failed, falling back to bundled Chromium:", e?.message || e);
    }
  }
  return chromium.launch({ headless: true, args });
}

/**
 * @returns {Promise<{ pricePerPerson: number, cabinClass: string } | null>}
 */
async function getFare(origin, destination, flightDate, flightNumber, cabinClass) {
  const digits = flightDigits(flightNumber);
  const log = {
    info: (...a) => console.log(...a),
    warn: (...a) => console.warn(...a)
  };

  const url =
    `https://www.aa.com/booking/find-flights?from=${encodeURIComponent(origin)}` +
    `&to=${encodeURIComponent(destination)}` +
    `&date=${encodeURIComponent(flightDate)}` +
    `&pax=1&adults=1&type=OneWay&tripType=oneway`;

  let browser;
  try {
    browser = await launchChromium();
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
      timezoneId: "America/New_York",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    await acceptCookiesIfPresent(page);
    await ensurePassengerCountOne(page);
    await maybeClickSearch(page);

    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});

    if (await isAccessDenied(page)) {
      log.warn("american: Akamai Access Denied — results will not load from this network/IP.");
      await writeDebugArtifacts(page, log);
      return null;
    }

    await waitForFlightInDom(page, digits, log);
    await new Promise((r) => setTimeout(r, 2000));

    await writeDebugArtifacts(page, log);

    const price = await page.evaluate(
      ({ d, cabin }) => {
        const dNorm = String(d || "").replace(/^0+/, "") || String(d);
        const flightRe = new RegExp(`(?:^|[^0-9])(?:AA\\s*)?0*${dNorm}(?:[^0-9]|$)`, "i");

        function cabinLabelRegex(cc) {
          switch (cc) {
            case "BASIC_ECONOMY":
              return /basic\s+economy/i;
            case "MAIN_CABIN":
              return /main\s+cabin|\bmain\b/i;
            case "COMFORT_PLUS":
              return /premium|extra|comfort/i;
            case "FIRST":
              return /\bfirst\b/i;
            case "BUSINESS":
              return /\bbusiness|flagship|polaris/i;
            default:
              return /./;
          }
        }

        function moneyNearLabel(block, labelRe) {
          const idx = block.search(labelRe);
          if (idx === -1) return null;
          const slice = block.slice(idx, Math.min(block.length, idx + 260));
          const m = slice.match(/\$\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.\d{2})?/);
          if (!m) return null;
          return Number(m[1].replace(/,/g, ""));
        }

        const labelRe = cabinLabelRegex(cabin);

        function scoreBlock(text) {
          if (!flightRe.test(text)) return 0;
          const len = text.length;
          if (len < 40 || len > 9000) return 0;
          return 9000 - len + (labelRe.test(text) ? 400 : 0);
        }

        let bestBlock = "";
        let bestScore = 0;
        const nodes = document.querySelectorAll("tr, li, article, section, div, button, span");
        for (const el of nodes) {
          const t = el.innerText || "";
          if (!t || t.length < 10) continue;
          const sc = scoreBlock(t);
          if (sc > bestScore) {
            bestScore = sc;
            bestBlock = t;
          }
        }

        if (!bestScore && flightRe.test(document.body?.innerText || "")) {
          bestBlock = document.body.innerText || "";
        }

        if (!bestBlock) return null;

        if (cabin === "MAIN_CABIN") {
          const m1 = moneyNearLabel(bestBlock, /Main\s+Cabin/i);
          if (m1 != null) return m1;
          const m2 = moneyNearLabel(bestBlock, /\bMain\b(?!\s+Extra)/i);
          if (m2 != null) return m2;
        }

        const fromLabel = moneyNearLabel(bestBlock, labelRe);
        if (fromLabel != null) return fromLabel;

        const fares = [...bestBlock.matchAll(/\$\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.\d{2})?/g)]
          .map((x) => Number(x[1].replace(/,/g, "")))
          .filter((n) => Number.isFinite(n) && n >= 25 && n < 100000);
        if (!fares.length) return null;

        if (cabin === "BASIC_ECONOMY") {
          const be = moneyNearLabel(bestBlock, /basic\s+economy/i);
          return be != null ? be : Math.min(...fares);
        }
        if (cabin === "MAIN_CABIN") {
          if (/basic\s+economy/i.test(bestBlock)) {
            const lo = Math.min(...fares);
            const rest = fares.filter((n) => n > lo);
            return rest.length ? Math.min(...rest) : lo;
          }
          return Math.min(...fares);
        }

        return Math.min(...fares);
      },
      { d: digits, cabin: cabinClass }
    );

    console.log("american getFare", {
      origin,
      destination,
      flightDate,
      flightNumber,
      cabinClass,
      pricePerPerson: price
    });

    if (price == null || !Number.isFinite(Number(price))) return null;
    return { pricePerPerson: Number(price), cabinClass };
  } catch (e) {
    console.error("american getFare error:", e?.message || e);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { getFare };
