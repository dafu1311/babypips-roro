const express = require("express");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

const RORO_URL = "https://www.babypips.com/tools/risk-on-risk-off-meter";

// -------------------- DATE HELPERS --------------------

function getNowNY() {
  const now = new Date();
  return new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function getISOWeekString(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function isWeekendNY() {
  const now = getNowNY();
  const d = now.getDay();
  return d === 0 || d === 6;
}

function normalize(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function looksLikeHighImpact(html, cells) {
  const text = cells.join(" ").toLowerCase();
  const h = html.toLowerCase();

  return (
    h.includes("high impact") ||
    h.includes("impact-high") ||
    text.includes("high")
  );
}

// -------------------- ROOT --------------------

app.get("/", (req, res) => {
  res.send("Babypips API läuft. Nutze /roro oder /usd-news");
});

// -------------------- RORO (DEIN FUNKTIONIERENDER CODE) --------------------

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
      throw new Error("Score nicht gefunden");
    }

    const value = parseInt(match[1], 10);
    const regime = match[2];

    return {
      ok: true,
      value,
      regime,
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

// -------------------- NEWS SCRAPER --------------------

async function getUsdNews(mode = "auto") {

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();

  try {

    const now = getNowNY();

    if (mode === "auto") {
      mode = isWeekendNY() ? "nextweek" : "today";
    }

    const targetDate = mode === "nextweek"
      ? addDays(now, 7)
      : now;

    const calendarUrl =
      `https://www.babypips.com/economic-calendar?week=${getISOWeekString(targetDate)}`;

    await page.goto(calendarUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(6000);

    const rows = await page.locator("tr").evaluateAll((trs) => {

      return trs.map(tr => ({
        html: tr.innerHTML,
        cells: Array.from(tr.querySelectorAll("td,th"))
          .map(c => (c.textContent || "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
      }));

    });

    const events = [];

    for (const row of rows) {

      const cells = row.cells;

      if (!cells.length) continue;

      const currencyIdx = cells.findIndex(c => c === "USD");
      if (currencyIdx === -1) continue;

      if (!looksLikeHighImpact(row.html, cells)) continue;

      const time = cells.find(c => /\d{1,2}:\d{2}(am|pm)/i.test(c)) || "-";

      let event = "-";

      for (let i = currencyIdx + 1; i < cells.length; i++) {

        const c = cells[i];

        const isValue =
          /^[\d.,%MKBTkmbt+-]+$/.test(c) ||
          c === "-" ||
          c.toLowerCase() === "high";

        if (!isValue) {
          event = c;
          break;
        }

      }

      const tail = cells.slice(-4);

      const actual = normalize(tail[0]);
      const forecast = normalize(tail[1]);
      const previous = normalize(tail[2]);

      events.push({
        currency: "USD",
        impact: "HIGH",
        time,
        event,
        actual,
        forecast,
        previous
      });

    }

    if (!events.length) {

      return {
        ok: true,
        found: false,
        mode,
        events: []
      };

    }

    return {
      ok: true,
      found: true,
      mode,
      count: events.length,
      events
    };

  } finally {

    await browser.close();

  }

}

app.get("/usd-news", async (req, res) => {

  try {

    const mode = req.query.mode || "auto";

    const data = await getUsdNews(mode);

    res.json(data);

  } catch (err) {

    res.status(500).json({
      ok: false,
      error: String(err)
    });

  }

});

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});