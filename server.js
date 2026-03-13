const express = require("express");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

const RORO_URL =
  "https://www.babypips.com/tools/risk-on-risk-off-meter";

const CALENDAR_URL =
  "https://www.babypips.com/economic-calendar";

// -------------------- ROOT --------------------

app.get("/", (req, res) => {
  res.send("API läuft. Nutze /roro oder /usd-news");
});

// -------------------- RISK DATA --------------------

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

    const match = body.match(
      /\b(\d{1,3})\s+(Risk-Off|Risk-On|Neutral)/
    );

    if (!match) {
      throw new Error("RORO Score nicht gefunden");
    }

    return {
      ok: true,
      value: parseInt(match[1]),
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

// -------------------- USD RED NEWS --------------------

function parseMinutesLeft(timeStr) {
  const m = timeStr.match(/(\d{1,2}):(\d{2})(am|pm)/i);

  if (!m) return null;

  let hours = parseInt(m[1]);
  const minutes = parseInt(m[2]);
  const ampm = m[3].toLowerCase();

  if (ampm === "pm" && hours !== 12) hours += 12;
  if (ampm === "am" && hours === 12) hours = 0;

  const now = new Date();

  const event = new Date();
  event.setHours(hours, minutes, 0, 0);

  return Math.round((event - now) / 60000);
}

async function getUsdNews() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();

  try {
    await page.goto(CALENDAR_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(6000);

    const rows = await page.evaluate(() => {
      const data = [];

      document.querySelectorAll("tr").forEach((row) => {
        const currency = row.innerText.includes("USD");

        if (!currency) return;

        const impact =
          row.innerHTML.includes("High Impact") ||
          row.innerHTML.includes("high");

        if (!impact) return;

        const cols = row.innerText.split("\n").map(x => x.trim());

        data.push(cols);
      });

      return data;
    });

    if (!rows.length) {
      return {
        ok: true,
        found: false
      };
    }

    const event = rows[0];

    const time = event[0] || "-";
    const name = event[2] || "-";
    const actual = event[3] || "-";
    const forecast = event[4] || "-";
    const previous = event[5] || "-";

    return {
      ok: true,
      found: true,
      currency: "USD",
      impact: "HIGH",
      time,
      event: name,
      actual,
      forecast,
      previous,
      minutesLeft: parseMinutesLeft(time),
      updatedAt: new Date().toISOString()
    };
  } finally {
    await browser.close();
  }
}

app.get("/usd-news", async (req, res) => {
  try {
    const data = await getUsdNews();
    res.json(data);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: String(err)
    });
  }
});

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});