require("dotenv").config();

const Anthropic = require("@anthropic-ai/sdk");

const SYSTEM_PROMPT =
  "You are a flight confirmation parser. Extract structured flight data from airline confirmation screenshots or email screenshots. Return ONLY valid JSON, no preamble, no markdown. " +
  "If a multi-leg itinerary is detected, parse each leg as a separate object and return a JSON array of objects (not wrapped). " +
  "If a single itinerary has one leg, return a single JSON object. " +
  "Normalize airline to one of: DELTA, UNITED, AMERICAN, JETBLUE. " +
  "Normalize cabin_class to one of: BASIC_ECONOMY, MAIN_CABIN, COMFORT_PLUS, FIRST, BUSINESS. " +
  "flight_date must be ISO YYYY-MM-DD. " +
  "Include confidence as HIGH, MEDIUM, or LOW. If confidence is LOW, still return the best-effort object.";

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
}`;

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
 * @param {Buffer} imageBuffer
 * @returns {Promise<{ legs: object[], rawText: string }>}
 */
async function parseConfirmationImage(imageBuffer) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const client = new Anthropic({ apiKey });
  const base64 = Buffer.from(imageBuffer).toString("base64");
  const mediaType = guessMediaType(imageBuffer);

  const message = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: base64
            }
          },
          {
            type: "text",
            text: USER_SHAPE
          }
        ]
      }
    ]
  });

  const textBlock = message.content.find((b) => b.type === "text");
  const rawText = textBlock && textBlock.type === "text" ? textBlock.text : "";
  const parsed = parseModelJson(rawText);
  const legs = Array.isArray(parsed) ? parsed : [parsed];
  return { legs, rawText };
}

module.exports = {
  parseConfirmationImage
};
