require("dotenv").config();

process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});

const TelegramBot = require("node-telegram-bot-api");
const { startBot } = require("./bot");
const { startMonitorCron } = require("./monitor");

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
bot.on("polling_error", (err) => {
  console.error("Telegram polling_error:", err?.message || err);
});
startBot(bot);
startMonitorCron(bot);

console.log("flight-creditor: Telegram listener and daily monitor (9:00 AM America/New_York) are running.");
