const express = require("express");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

const RORO_URL = "https://www.babypips.com/tools/risk-on-risk-off-meter";
const FF_JSON_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

app.get("/", (req, res) => {
  res.send("API laeuft. Nutze /roro oder /usd-news");
});

// -------------------- RORO --------------------
async function getRiskData() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();

  try {
    await page.goto(RORO_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(8000);

    const body = await page.locator("body").innerText();
    const match = body.match(/\b(\d{1,3})\s+(Risk-Off|Risk-On|Neutral)/);

    if (!match) {
      throw new Error("RORO Score nicht gefunden");
    }

    return {
      ok: true,
      value: parseInt(match[1], 10),
      regime: match[2],
      updatedAt: new Date().toISOString()
    };
  } finally {
    await browser.close();
  }
}

app.get("/roro", async (req, res) => {
  try {
    const data = await getRiskData();
    res.json(data);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: String(err)
    });
  }
});

// -------------------- NEWS HELFER --------------------
function pick(obj, keys, fallback = "") {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== "") {
      return String(obj[k]).trim();
    }
  }
  return fallback;
}

function parseImpactValue(item) {
  const raw = pick(item, ["impact", "impactTitle", "impact_name", "impactLabel"], "").toLowerCase();

  if (raw.includes("high") || raw.includes("red")) return "HIGH";
  if (raw.includes("medium")) return "MEDIUM";
  if (raw.includes("low")) return "LOW";

  // Manche Feeds speichern Impact numerisch
  const numeric = Number(pick(item, ["impact_num", "impactNum", "impactValue"], ""));
  if (!Number.isNaN(numeric)) {
    if (numeric >= 3) return "HIGH";
    if (numeric === 2) return "MEDIUM";
    if (numeric === 1) return "LOW";
  }

  return "";
}

function parseMinutesLeft(item) {
  const dateStr = pick(item, ["date", "datetime", "timestamp", "dateUtc"], "");
  if (!dateStr) return null;

  const eventDate = new Date(dateStr);
  if (isNaN(eventDate.getTime())) return null;

  return Math.round((eventDate.getTime() - Date.now()) / 60000);
}

function formatEventTime(item) {
  const directTime = pick(item, ["time", "event_time"], "");
  if (directTime) return directTime;

  const dateStr = pick(item, ["date", "datetime", "timestamp", "dateUtc"], "");
  if (!dateStr) return "-";

  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "-";

  let hours = d.getHours();
  const mins = d.getMinutes().toString().padStart(2, "0");
  const suffix = hours >= 12 ? "pm" : "am";
  hours = hours % 12;
  if (hours === 0) hours = 12;

  return `${hours}:${mins}${suffix}`;
}

// -------------------- USD RED NEWS --------------------
async function getUsdRedNews() {
  const response = await fetch(FF_JSON_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });

  if (!response.ok) {
    throw new Error(`ForexFactory JSON Fehler: ${response.status}`);
  }

  const data = await response.json();

  if (!Array.isArray(data)) {
    throw new Error("ForexFactory JSON hat unerwartetes Format");
  }

  const events = data.map((item) => {
    const currency = pick(item, ["currency", "symbol", "ccy"], "");
    const event = pick(item, ["title", "event", "name"], "");
    const actual = pick(item, ["actual"], "-");
    const forecast = pick(item, ["forecast"], "-");
    const previous = pick(item, ["previous"], "-");
    const impact = parseImpactValue(item);
    const time = formatEventTime(item);
    const minutesLeft = parseMinutesLeft(item);

    return {
      currency,
      event,
      actual,
      forecast,
      previous,
      impact,
      time,
      minutesLeft
    };
  });

  const usdHigh = events.filter((e) => {
    return e.currency === "USD" && e.impact === "HIGH" && e.event;
  });

  if (!usdHigh.length) {
    return {
      ok: true,
      found: false,
      message: "Keine USD Red Folder News gefunden"
    };
  }

  // nächstes relevantes Event zuerst
  usdHigh.sort((a, b) => {
    const av = a.minutesLeft === null ? 999999 : Math.abs(a.minutesLeft);
    const bv = b.minutesLeft === null ? 999999 : Math.abs(b.minutesLeft);
    return av - bv;
  });

  const news = usdHigh[0];

  return {
    ok: true,
    found: true,
    currency: news.currency,
    impact: news.impact,
    time: news.time || "-",
    event: news.event || "-",
    actual: news.actual || "-",
    forecast: news.forecast || "-",
    previous: news.previous || "-",
    minutesLeft: news.minutesLeft,
    updatedAt: new Date().toISOString()
  };
}

app.get("/usd-news", async (req, res) => {
  try {
    const data = await getUsdRedNews();
    res.json(data);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: String(err)
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server laeuft auf Port ${PORT}`);
});
