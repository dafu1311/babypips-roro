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

// -------------------- FOREX FACTORY NEWS --------------------
function minutesUntil(timeStr) {
  if (!timeStr || timeStr === "All Day" || timeStr === "Tentative") return null;

  const now = new Date();
  const today = new Date();

  const m = timeStr.match(/(\d{1,2}):(\d{2})(am|pm)/i);
  if (!m) return null;

  let hours = parseInt(m[1], 10);
  const mins = parseInt(m[2], 10);
  const ampm = m[3].toLowerCase();

  if (ampm === "pm" && hours !== 12) hours += 12;
  if (ampm === "am" && hours === 12) hours = 0;

  today.setHours(hours, mins, 0, 0);

  const diffMs = today.getTime() - now.getTime();
  return Math.round(diffMs / 60000);
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

    // Akzeptiere evtl. Cookie/Dialoge nicht aktiv; wir lesen einfach Tabelle
    const rows = await page.locator("tr.calendar__row, tr.calendar_row").evaluateAll((trs) => {
      return trs.map((tr) => {
        const txt = (sel) => {
          const el = tr.querySelector(sel);
          return el ? el.textContent.trim() : "";
        };

        const impactEl =
          tr.querySelector(".calendar__impact span[title]") ||
          tr.querySelector(".impact span[title]") ||
          tr.querySelector(".calendar__impact");

        const impactTitle = impactEl
          ? (impactEl.getAttribute("title") || impactEl.textContent || "").trim()
          : "";

        return {
          time: txt(".calendar__time, .time"),
          currency: txt(".calendar__currency, .currency"),
          event: txt(".calendar__event-title, .event, .calendar__event"),
          actual: txt(".calendar__actual, .actual"),
          forecast: txt(".calendar__forecast, .forecast"),
          previous: txt(".calendar__previous, .previous"),
          impact: impactTitle
        };
      });
    });

    const usdHigh = rows.filter((r) => {
      const currencyOk = r.currency === "USD";
      const impactText = (r.impact || "").toLowerCase();
      const redOk =
        impactText.includes("high") ||
        impactText.includes("red") ||
        impactText.includes("high impact");
      return currencyOk && redOk && r.event;
    });

    if (!usdHigh.length) {
      return {
        ok: true,
        found: false,
        message: "Keine USD Red Folder News gefunden"
      };
    }

    const enriched = usdHigh.map((r) => ({
      ...r,
      minutesLeft: minutesUntil(r.time)
    }));

    // Bevorzuge das nächste kommende Event, sonst das erste
    enriched.sort((a, b) => {
      const av = a.minutesLeft === null ? 999999 : Math.abs(a.minutesLeft);
      const bv = b.minutesLeft === null ? 999999 : Math.abs(b.minutesLeft);
      return av - bv;
    });

    const news = enriched[0];

    return {
      ok: true,
      found: true,
      currency: news.currency,
      impact: "HIGH",
      time: news.time || "-",
      event: news.event || "-",
      actual: news.actual || "-",
      forecast: news.forecast || "-",
      previous: news.previous || "-",
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