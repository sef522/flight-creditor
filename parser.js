require("dotenv").config();

const Anthropic = require("@anthropic-ai/sdk");

const SYSTEM_PROMPT = `You are a flight confirmation parser. Extract structured flight data from airline confirmation screenshots or email screenshots. Return ONLY valid JSON, no preamble, no markdown.
If a multi-leg itinerary is detected, parse each leg as a separate object and return a JSON array of objects (not wrapped). If a single itinerary has one leg, return a single JSON object.

airline: Return a single clean UPPERCASE token with no spaces.
- For Delta Air Lines, United Airlines, American Airlines, or JetBlue, use exactly DELTA, UNITED, AMERICAN, or JETBLUE respectively (these four are the canonical codes this system expects for those carriers).
- For every other carrier: use the IATA airline designator when it is visible or clearly inferable (2 letters, e.g. BA, EK, LH, QF, FR, WN). If no IATA code is available, use a short UPPERCASE ASCII name derived from the airline (e.g. EASYJET, RYANAIR, NORWEGIAN).

flight_number: return digits ONLY with no airline prefix or letters (e.g. AA3209 → "3209", DL447 → "447", UA1234 → "1234", B6123 → "123").

flight_date must be ISO YYYY-MM-DD.

Passengers: when an explicit passenger count appears on the confirmation (e.g. "2 passengers", number of travelers, ADT count), use that number. If no explicit passenger count is shown but individual seat assignments are listed for the booking or leg (e.g. 23F, 23E, 24E, 24F), set passengers to the number of distinct seat assignments counted — four distinct seats means passengers 4. Do not default to 1 when seat assignment data is available; only use 1 when the document clearly indicates a single traveler and there is no contradictory seat list.

price_paid_per_person: When extracting price_paid_per_person, do NOT divide the shown price by the number of passengers. The price shown on an airline confirmation is always the per-person fare unless the document explicitly labels that amount as a group total for everyone. Return the price exactly as shown (same dollars and cents as printed).

Include confidence as HIGH, MEDIUM, or LOW. If confidence is LOW, still return the best-effort object.

Cabin class: output exactly one of BASIC_ECONOMY, MAIN_CABIN, COMFORT_PLUS, FIRST, BUSINESS.
- If airline is AMERICAN, DELTA, UNITED, or JETBLUE, map fare using ONLY that airline's rules in the sections below (prefer explicit cabin labels on the document over inferred fare class when they conflict; if multiple fare codes appear, use the code that applies to the purchased cabin for that segment).
- For ALL other airlines, use ONLY the "All other airlines" cabin rules at the end — do not apply the US-carrier fare-class letter tables to non-US carriers.

--- American Airlines (AMERICAN) ---
BASIC_ECONOMY: fare class letters B or N; OR text explicitly says "Basic Economy".
MAIN_CABIN: fare class letters Y, H, K, M, L, V, Q, X, G, S; OR labels "Economy" or "Main Cabin".
COMFORT_PLUS: American does not sell Comfort+ — never output COMFORT_PLUS for AMERICAN. If you would otherwise map to Comfort+, use MAIN_CABIN.
FIRST: fare class letters F or A; OR label "First".
BUSINESS: fare class letters J, C, D, R, or I; OR label "Business".

--- Delta Air Lines (DELTA) ---
BASIC_ECONOMY: fare class letter E; OR label "Basic Economy".
MAIN_CABIN: fare class letters Y, B, M, S, H, Q, K, L, U, T, X, V; OR label "Main Cabin".
COMFORT_PLUS: fare class letters W or G; OR labels "Comfort+" or "Comfort Plus".
FIRST: fare class letters F, A, or P; OR label "First Class".
BUSINESS: fare class letters J, C, D, I, or Z; OR labels "Delta One" or "Business".

--- United Airlines (UNITED) ---
BASIC_ECONOMY: fare class letter N; OR label "Basic Economy".
MAIN_CABIN: fare class letters Y, B, M, E, U, H, Q, V, W, S, T, L, K, G; OR label "Economy".
COMFORT_PLUS: United does not offer Comfort+ — never output COMFORT_PLUS for UNITED. If unclear, prefer MAIN_CABIN.
FIRST: fare class letters F, A, or P; OR label "First".
BUSINESS: fare class letters J, C, D, Z, P, I, or O; OR labels "Business" or "Polaris". If fare class P appears and context is ambiguous between First and Business, prefer the cabin label shown on the confirmation.

--- JetBlue (JETBLUE) ---
BASIC_ECONOMY: label "Blue Basic".
MAIN_CABIN: labels "Blue" or "Blue Extra".
COMFORT_PLUS: JetBlue does not offer Comfort+ — never output COMFORT_PLUS for JETBLUE; use MAIN_CABIN if needed.
FIRST: JetBlue does not offer First in this taxonomy — never output FIRST for JETBLUE.
BUSINESS: label "Mint" (treat Mint suites as BUSINESS).

--- All other airlines (any carrier other than AMERICAN, DELTA, UNITED, JETBLUE) ---
Apply these rules to the cabin/fare/product labels shown for the purchased segment. Matching is case-insensitive on label text. When rules overlap, prefer the more specific restrictive bucket (e.g. "basic" before generic "economy"); use best judgment when ambiguous.

BASIC_ECONOMY: label contains any of: "basic", "light", "saver", "restricted".
BUSINESS: label contains any of: "business", "club", "marco polo", "senator".
FIRST: label contains "first" (but not as a substring of unrelated words if avoidable — prefer clear "First" product names).
COMFORT_PLUS: label contains any of: "premium", "comfort", "plus", "extra" — unless "basic", "light", "saver", or "restricted" also applies to the same product, in which case use BASIC_ECONOMY.
MAIN_CABIN: default for standard economy / coach / economy products that do not match BASIC_ECONOMY, COMFORT_PLUS, FIRST, or BUSINESS above.`;

const USER_SHAPE = `Return JSON with this exact shape for each leg:
{
  "confirmation_code": "",
  "airline": "",
  "flight_number": "",
  "origin": "",
  "destination": "",
  "flight_date": "",
  "cabin_class": "",
  "passengers": 0,
  "price_paid_per_person": 0.00,
  "confidence": "HIGH|MEDIUM|LOW"
}

flight_number must be a string of digits only (no airline code prefix).
Infer passengers from distinct seat assignments when no explicit traveler count is shown (count unique seats; do not assume 1 if seats are listed).
price_paid_per_person: always the per-person fare as shown; do NOT divide by passenger count unless explicitly labeled a group total—return the amount exactly as printed.`;

function guessMediaType(buffer) {
  if (!buffer || buffer.length < 4) return "image/jpeg";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return "image/gif";
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return "image/webp";
  return "image/jpeg";
}

function stripJsonFence(text) {
  const t = String(text || "").trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/im.exec(t);
  if (fence) return fence[1].trim();
  return t;
}

function parseModelJson(text) {
  const raw = stripJsonFence(text);
  const parsed = JSON.parse(raw);
  return parsed;
}

/**
 * @param {object[]} userContent Claude user content blocks
 * @returns {Promise<{ legs: object[], rawText: string }>}
 */
async function parseConfirmationFromUserContent(userContent) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: userContent
      }
    ]
  });

  const textBlock = message.content.find((b) => b.type === "text");
  const rawText = textBlock && textBlock.type === "text" ? textBlock.text : "";
  const parsed = parseModelJson(rawText);
  const legs = Array.isArray(parsed) ? parsed : [parsed];
  return { legs, rawText };
}

/**
 * @param {object} mediaBlock image or document content block
 * @returns {Promise<{ legs: object[], rawText: string }>}
 */
async function parseConfirmationFromMedia(mediaBlock) {
  return parseConfirmationFromUserContent([
    mediaBlock,
    {
      type: "text",
      text: USER_SHAPE
    }
  ]);
}

/**
 * @param {Buffer} imageBuffer
 * @returns {Promise<{ legs: object[], rawText: string }>}
 */
async function parseConfirmationImage(imageBuffer) {
  const base64 = Buffer.from(imageBuffer).toString("base64");
  const mediaType = guessMediaType(imageBuffer);

  return parseConfirmationFromMedia({
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType,
      data: base64
    }
  });
}

/**
 * @param {Buffer} pdfBuffer
 * @returns {Promise<{ legs: object[], rawText: string }>}
 */
async function parseConfirmationPdf(pdfBuffer) {
  const base64Pdf = Buffer.from(pdfBuffer).toString("base64");

  return parseConfirmationFromMedia({
    type: "document",
    source: {
      type: "base64",
      media_type: "application/pdf",
      data: base64Pdf
    }
  });
}

/**
 * @param {string} confirmationText
 * @returns {Promise<{ legs: object[], rawText: string }>}
 */
async function parseConfirmationText(confirmationText) {
  return parseConfirmationFromUserContent([
    {
      type: "text",
      text: `${USER_SHAPE}\n\n${String(confirmationText || "")}`
    }
  ]);
}

module.exports = {
  parseConfirmationImage,
  parseConfirmationPdf,
  parseConfirmationText
};
