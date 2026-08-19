require("dotenv").config();

const {
  insertWatchedFlight,
  listActiveWatchedFlights,
  deactivateWatchedFlightByConfirmation,
  getWatchedFlightByConfirmationCode,
  updatePricePaidPerPerson
} = require("./supabase");
const { parseConfirmationImage, parseConfirmationPdf, parseConfirmationText } = require("./parser");

const GENERIC_PARSE_REPLY =
  "⚠️ Couldn't parse that confirmation. Please try again, or send a screenshot, PDF, or the full email text.";

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

function isAllowedChat(msg) {
  const allow = process.env.TELEGRAM_CHAT_ID;
  if (!allow) return true;
  return String(msg.chat?.id) === String(allow).trim();
}

function commandRoot(text) {
  const parts = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  return parts[0].split("@")[0].toLowerCase();
}

function missingLegFields(leg) {
  const missing = [];
  if (!leg || !leg.confirmation_code) missing.push("confirmation code");
  if (!leg || !leg.airline) missing.push("airline");
  if (!leg || !leg.flight_number) missing.push("flight number");
  if (!leg || !leg.origin) missing.push("origin");
  if (!leg || !leg.destination) missing.push("destination");
  if (!leg || !leg.flight_date) missing.push("flight date");
  if (!leg || !leg.cabin_class) missing.push("cabin class");
  if (!leg || typeof leg.passengers !== "number" || leg.passengers <= 0) {
    missing.push("passenger count");
  }
  if (!leg || typeof leg.price_paid_per_person !== "number") {
    missing.push("price paid per person");
  }
  return missing;
}

function legFieldSnapshot(leg) {
  return {
    confirmation_code: leg?.confirmation_code ?? null,
    airline: leg?.airline ?? null,
    flight_number: leg?.flight_number ?? null,
    origin: leg?.origin ?? null,
    destination: leg?.destination ?? null,
    flight_date: leg?.flight_date ?? null,
    cabin_class: leg?.cabin_class ?? null,
    passengers: leg?.passengers ?? null,
    passengersType: typeof leg?.passengers,
    price_paid_per_person: leg?.price_paid_per_person ?? null,
    priceType: typeof leg?.price_paid_per_person,
    confidence: leg?.confidence ?? null
  };
}

function formatMissingFieldsReply(legs) {
  const lines = [];
  const list = Array.isArray(legs) ? legs : [];
  if (!list.length) {
    return "⚠️ Couldn't parse that confirmation. No flight details were found. Paste the full confirmation email, or send a screenshot or PDF.";
  }
  for (let i = 0; i < list.length; i++) {
    const missing = missingLegFields(list[i]);
    if (!missing.length) continue;
    const prefix = list.length > 1 ? `Leg ${i + 1}: ` : "";
    lines.push(`${prefix}${missing.join(", ")}`);
  }
  if (!lines.length) {
    return GENERIC_PARSE_REPLY;
  }
  return `⚠️ Couldn't parse that confirmation. Missing: ${lines.join("; ")}. Paste the full confirmation email, or send a screenshot or PDF.`;
}

function buildConfirmLine(leg) {
  const iata = AIRLINE_DISPLAY[leg.airline] || leg.airline;
  const cabin = CABIN_DISPLAY[leg.cabin_class] || leg.cabin_class;
  const when = formatShortDate(leg.flight_date);
  const paid = Number(leg.price_paid_per_person).toFixed(0);
  return `✅ Got it. Monitoring ${iata} ${leg.flight_number} ${leg.origin}→${leg.destination} on ${when} · ${cabin} · ${leg.passengers} passenger${
    leg.passengers === 1 ? "" : "s"
  } · $${paid}/person paid.`;
}

function parseCodePriceCommand(text, commandPrefix) {
  const t = String(text || "").trim();
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;
  const cmd = parts[0].split("@")[0].toLowerCase();
  if (cmd !== commandPrefix.toLowerCase()) return null;
  const code = parts[1];
  const priceStr = parts.slice(2).join(" ");
  const price = Number(priceStr);
  if (!code || !Number.isFinite(price) || price < 0) return null;
  return { code, price };
}

function isPriceUnset(row) {
  const p = row?.price_paid_per_person;
  if (p == null || p === "") return true;
  const n = Number(p);
  return !Number.isFinite(n) || n === 0;
}

function buildManualPriceSetLine(row, pricePerPerson) {
  const iata = AIRLINE_DISPLAY[row.airline] || row.airline;
  const when = formatShortDate(row.flight_date);
  const paid = Number(pricePerPerson).toFixed(2);
  return `✅ Price set. Monitoring ${iata}${row.flight_number} ${row.origin}→${row.destination} on ${when} · ${row.passengers} passengers · $${paid}/person.`;
}

/**
 * Shared ingest for photo, PDF, and text confirmation intake.
 * @param {import('node-telegram-bot-api')} bot
 * @param {import('node-telegram-bot-api').Message} msg
 * @param {object[]} legs
 */
async function ingestParsedLegs(bot, msg, legs) {
  const telegramUserId = msg.from?.id != null ? String(msg.from.id) : null;
  const inserted = [];
  const list = Array.isArray(legs) ? legs : [];
  console.log("ingestParsedLegs: validating extracted legs", {
    count: list.length,
    legs: list.map((leg, index) => ({
      index,
      missing: missingLegFields(leg),
      fields: legFieldSnapshot(leg)
    }))
  });

  for (let i = 0; i < list.length; i++) {
    const leg = list[i];
    const missing = missingLegFields(leg);
    if (missing.length) {
      console.warn("ingestParsedLegs: leg failed schema validation", {
        index: i,
        missing,
        fields: legFieldSnapshot(leg)
      });
      continue;
    }
    const conf = String(leg.confidence || "").toUpperCase();
    if (conf === "LOW") {
      console.warn("ingestParsedLegs: leg rejected for LOW confidence", {
        index: i,
        fields: legFieldSnapshot(leg)
      });
      await bot.sendMessage(
        msg.chat.id,
        "⚠️ Couldn't parse that confirmation with enough confidence. Please send a clearer screenshot, the full PDF, or the full email text."
      );
      return;
    }
    const row = {
      confirmation_code: String(leg.confirmation_code).trim(),
      airline: leg.airline,
      flight_number: String(leg.flight_number).trim(),
      origin: String(leg.origin).trim().toUpperCase(),
      destination: String(leg.destination).trim().toUpperCase(),
      flight_date: leg.flight_date,
      cabin_class: leg.cabin_class,
      passengers: leg.passengers,
      price_paid_per_person: leg.price_paid_per_person,
      active: true,
      added_by_telegram_user_id: telegramUserId
    };
    await insertWatchedFlight(row);
    inserted.push(leg);
  }

  if (!inserted.length) {
    console.warn("ingestParsedLegs: no valid legs to insert", {
      count: list.length,
      missingByLeg: list.map((leg, index) => ({
        index,
        missing: missingLegFields(leg),
        fields: legFieldSnapshot(leg)
      }))
    });
    await bot.sendMessage(msg.chat.id, formatMissingFieldsReply(list));
    return;
  }

  for (const leg of inserted) {
    await bot.sendMessage(msg.chat.id, buildConfirmLine(leg));
  }
}

/**
 * @param {import('node-telegram-bot-api')} bot
 */
function startBot(bot) {
  bot.on("polling_error", (err) => {
    const code = err?.code;
    const status = err?.response?.statusCode ?? err?.response?.status;
    if (code === "ETELEGRAM" && status === 409) {
      console.warn("Bot conflict: another instance is running. This instance will stop polling.");
      bot.stopPolling();
      return;
    }
    console.error("Telegram polling_error:", err?.message || err);
  });

  bot.on("message", async (msg) => {
    try {
      if (msg.document) {
        console.log("Telegram document update received", {
          chatId: msg.chat?.id,
          mimeType: msg.document.mime_type,
          fileName: msg.document.file_name,
          fileId: msg.document.file_id,
          fileSize: msg.document.file_size
        });
      }

      if (msg.text) {
        console.log("Telegram text update received", {
          chatId: msg.chat?.id,
          textLength: String(msg.text).length,
          startsWithSlash: String(msg.text).trim().startsWith("/")
        });
      }

      if (!isAllowedChat(msg)) return;

      const text = String(msg.text || "").trim();
      if (text.startsWith("/list")) {
        const rows = await listActiveWatchedFlights();
        if (!rows.length) {
          await bot.sendMessage(msg.chat.id, "No active watched flights.");
          return;
        }
        const lines = rows.map((r) => {
          const iata = AIRLINE_DISPLAY[r.airline] || r.airline;
          const cabin = CABIN_DISPLAY[r.cabin_class] || r.cabin_class;
          const when = formatShortDate(r.flight_date);
          const paid = Number(r.price_paid_per_person).toFixed(0);
          return `• ${iata} ${r.flight_number} ${r.origin}→${r.destination} · ${when} · ${cabin} · ${r.passengers} pax · $${paid}/person · conf ${r.confirmation_code}`;
        });
        await bot.sendMessage(msg.chat.id, `Active watches:\n${lines.join("\n")}`);
        return;
      }

      if (text.startsWith("/stop")) {
        const parts = text.split(/\s+/);
        const code = parts[1];
        if (!code) {
          await bot.sendMessage(msg.chat.id, "Usage: /stop [confirmation_code]");
          return;
        }
        const { count } = await deactivateWatchedFlightByConfirmation(code);
        if (count === 0) {
          await bot.sendMessage(msg.chat.id, `No active booking found with confirmation ${code}.`);
        } else {
          await bot.sendMessage(msg.chat.id, `Stopped monitoring ${count} active leg(s) for ${code}.`);
        }
        return;
      }

      if (commandRoot(text) === "/updateprice") {
        const parsed = parseCodePriceCommand(text, "/updateprice");
        if (!parsed) {
          await bot.sendMessage(msg.chat.id, "Usage: /updateprice [confirmation_code] [price_per_person]");
          return;
        }
        const { code, price } = parsed;
        const rows = await getWatchedFlightByConfirmationCode(code);
        if (!rows.length) {
          await bot.sendMessage(msg.chat.id, `⚠️ No flight found with confirmation code ${code}.`);
          return;
        }
        for (const row of rows) {
          await updatePricePaidPerPerson(row.id, price);
          await bot.sendMessage(msg.chat.id, buildManualPriceSetLine(row, price));
        }
        return;
      }

      if (commandRoot(text) === "/price") {
        const parsed = parseCodePriceCommand(text, "/price");
        if (!parsed) {
          await bot.sendMessage(msg.chat.id, "Usage: /price [confirmation_code] [price_per_person]");
          return;
        }
        const { code, price } = parsed;
        const rows = await getWatchedFlightByConfirmationCode(code);
        if (!rows.length) {
          await bot.sendMessage(msg.chat.id, `⚠️ No flight found with confirmation code ${code}.`);
          return;
        }
        const existingNonZero = rows.find((r) => !isPriceUnset(r));
        if (existingNonZero) {
          const existing = Number(existingNonZero.price_paid_per_person).toFixed(2);
          const confDisplay = existingNonZero.confirmation_code || code;
          await bot.sendMessage(
            msg.chat.id,
            `⚠️ Price already set to $${existing} for ${confDisplay}. Use /updateprice to change it.`
          );
          return;
        }
        for (const row of rows) {
          await updatePricePaidPerPerson(row.id, price);
          await bot.sendMessage(msg.chat.id, buildManualPriceSetLine(row, price));
        }
        return;
      }

      if (msg.document) {
        if (msg.document.mime_type !== "application/pdf") {
          await bot.sendMessage(
            msg.chat.id,
            "Only PDFs and screenshots are supported."
          );
          return;
        }

        console.log("Entering PDF document intake branch", {
          chatId: msg.chat?.id,
          fileName: msg.document.file_name,
          fileId: msg.document.file_id,
          fileSize: msg.document.file_size
        });

        const pdfFileId = msg.document.file_id;
        const pdfLink = await bot.getFileLink(pdfFileId);
        const pdfRes = await fetch(pdfLink);
        if (!pdfRes.ok) {
          throw new Error(`Telegram file download failed: ${pdfRes.status}`);
        }
        const pdfArrayBuf = await pdfRes.arrayBuffer();
        const pdfBuffer = Buffer.from(pdfArrayBuf);

        let pdfLegs;
        try {
          const parsed = await parseConfirmationPdf(pdfBuffer);
          pdfLegs = parsed.legs;
        } catch (e) {
          console.error("parseConfirmationPdf failed:", e);
          await bot.sendMessage(msg.chat.id, GENERIC_PARSE_REPLY);
          return;
        }

        await ingestParsedLegs(bot, msg, pdfLegs);
        return;
      }

      if (text && !text.startsWith("/")) {
        console.log("Entering text intake branch", {
          chatId: msg.chat?.id,
          textLength: text.length
        });

        let textLegs;
        try {
          const parsed = await parseConfirmationText(text);
          textLegs = parsed.legs;
        } catch (e) {
          console.error("parseConfirmationText failed:", e);
          await bot.sendMessage(msg.chat.id, GENERIC_PARSE_REPLY);
          return;
        }

        await ingestParsedLegs(bot, msg, textLegs);
        return;
      }

      if (!msg.photo || !msg.photo.length) {
        return;
      }

      const best = msg.photo[msg.photo.length - 1];
      const fileId = best.file_id;
      const link = await bot.getFileLink(fileId);
      const res = await fetch(link);
      if (!res.ok) {
        throw new Error(`Telegram file download failed: ${res.status}`);
      }
      const arrayBuf = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);

      let legs;
      try {
        const parsed = await parseConfirmationImage(buffer);
        legs = parsed.legs;
      } catch (e) {
        console.error("parseConfirmationImage failed:", e);
        await bot.sendMessage(msg.chat.id, GENERIC_PARSE_REPLY);
        return;
      }

      await ingestParsedLegs(bot, msg, legs);
    } catch (e) {
      console.error("bot message handler error:", e);
      try {
        await bot.sendMessage(msg.chat.id, "Something went wrong processing your message. Please try again.");
      } catch (sendErr) {
        console.error("bot error reply failed:", sendErr);
      }
    }
  });
}

module.exports = { startBot };
