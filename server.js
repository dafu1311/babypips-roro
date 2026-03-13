const express = require("express");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

const RORO_URL = "https://www.babypips.com/tools/risk-on-risk-off-meter";
const FF_URL = "https://www.forexfactory.com/calendar";

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

// -------------------- FOREXFACTORY USD RED NEWS --------------------
// "Rote" USD-Events über Namensmuster
function isHighImpactUsdEvent(eventName) {
  const e = eventName.toLowerCase();

  const highImpactKeywords = [
    "core pce",
    "pce price",
    "core cpi",
    "cpi ",
    "cpi y/y",
    "cpi m/m",
    "ppi ",
    "non-farm",
    "nfp",
    "unemployment rate",
    "fomc",
    "fed",
    "interest rate",
    "powell",
    "gdp",
    "retail sales",
    "jolts",
    "ism",
    "durable goods",
    "personal income",
    "personal spending",
    "employment change",
    "consumer sentiment"
  ];

  return highImpactKeywords.some(k => e.includes(k));
}

function parseMinutesLeft(timeStr) {
  if (!timeStr || timeStr === "All Day" || timeStr === "Tentative") return null;

  const m = timeStr.match(/(\d{1,2}):(\d{2})(am|pm)/i);
  if (!m) return null;

  let hours = parseInt(m[1], 10);
  const mins = parseInt(m[2], 10);
  const ampm = m[3].toLowerCase();

  if (ampm === "pm" && hours !== 12) hours += 12;
  if (ampm === "am" && hours === 12) hours = 0;

  const now = new Date();
  const eventDate = new Date();
  eventDate.setHours(hours, mins, 0, 0);

  return Math.round((eventDate.getTime() - now.getTime()) / 60000);
}

async function getUsdRedNews() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();

  try {
    await page.goto(FF_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(6000);

    const text = await page.locator("body").innerText();
    const lines = text
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean);

    const events = [];
    let currentTime = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Zeit merken, z.B. 1:30pm oder 3:00pm
      if (/^\d{1,2}:\d{2}(am|pm)$/i.test(line)) {
        currentTime = line;
        continue;
      }

      // Suche USD-Blöcke
      if (line === "USD") {
        const eventName = lines[i + 1] || "";
        const valuesLine = lines[i + 2] || "";

        // Werte zerlegen (Actual Forecast Previous)
        const values = valuesLine.split(/\s+/).filter(Boolean);

        let actual = "-";
        let forecast = "-";
        let previous = "-";

        if (values.length >= 1) actual = values[0];
        if (values.length >= 2) forecast = values[1];
        if (values.length >= 3) previous = values[2];

        if (eventName && isHighImpactUsdEvent(eventName)) {
          events.push({
            currency: "USD",
            time: currentTime || "-",
            event: eventName,
            actual,
            forecast,
            previous,
            minutesLeft: parseMinutesLeft(currentTime)
          });
        }
      }
    }

    if (!events.length) {
      return {
        ok: true,
        found: false,
        message: "Keine USD Red Folder News gefunden"
      };
    }

    // nächstes relevantes Event zuerst
    events.sort((a, b) => {
      const av = a.minutesLeft === null ? 999999 : Math.abs(a.minutesLeft);
      const bv = b.minutesLeft === null ? 999999 : Math.abs(b.minutesLeft);
      return av - bv;
    });

    const news = events[0];

    return {
      ok: true,
      found: true,
      currency: news.currency,
      impact: "HIGH",
      time: news.time,
      event: news.event,
      actual: news.actual,
      forecast: news.forecast,
      previous: news.previous,
      minutesLeft: news.minutesLeft,
      updatedAt: new Date().toISOString()
    };
  } finally {
    await browser.close();
  }
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