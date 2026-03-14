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

function getISOWeekString(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function normalize(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function isTimeString(s) {
  return /\d{1,2}:\d{2}(am|pm)/i.test(String(s || "").trim());
}

function isValueCell(s) {
  const v = normalize(s).toLowerCase();
  if (!v) return false;
  if (v === "-") return true;
  return /^[\d.,%mkbtkmbt+-]+$/.test(v);
}

function isImpactCell(s) {
  const v = normalize(s).toLowerCase();
  return v === "high" || v === "medium" || v === "med" || v === "low";
}

function cleanEventName(s) {
  return normalize(s)
    .replace(/\s+m\/m$/i, " m/m")
    .replace(/\s+y\/y$/i, " y/y")
    .replace(/\s+q\/q$/i, " q/q");
}

function looksLikeHighImpact(html, cells) {
  const text = ` ${cells.join(" ").toLowerCase()} `;
  const h = String(html || "").toLowerCase();

  return (
    h.includes("high impact") ||
    h.includes("impact-high") ||
    text.includes(" high ")
  );
}

function getTodayTokens() {
  const now = getNowNY();

  const weekday = now.toLocaleDateString("en-US", { weekday: "short", timeZone: "America/New_York" });
  const month = now.toLocaleDateString("en-US", { month: "short", timeZone: "America/New_York" });
  const day = now.getDate();

  return [
    `${weekday} ${month} ${day}`,
    `${month} ${day}`,
    `${weekday}, ${month} ${day}`
  ];
}

// -------------------- ROOT --------------------
app.get("/", (req, res) => {
  res.send("Babypips API läuft. Nutze /roro oder /usd-news");
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

// -------------------- NEWS PARSER --------------------
function parseNewsRow(cells, currentDate) {
  const clean = cells.map(normalize).filter(Boolean);
  if (!clean.length) return null;

  const currencyIdx = clean.findIndex(c => c === "USD");
  if (currencyIdx === -1) return null;

  const time = clean.find(isTimeString) || "-";

  let impact = "-";
  for (const c of clean) {
    if (isImpactCell(c)) {
      impact = c.toUpperCase();
      break;
    }
  }

  let event = "-";
  for (let i = currencyIdx + 1; i < clean.length; i++) {
    const c = clean[i];
    const lc = c.toLowerCase();

    if (c === "USD") continue;
    if (isTimeString(c)) continue;
    if (isImpactCell(c)) continue;
    if (isValueCell(c)) continue;
    if (lc.includes("view details")) continue;

    event = cleanEventName(c);
    break;
  }

  if (event === "-") return null;

  const eventIdx = clean.findIndex(c => cleanEventName(c) === event);
  const valueCells = [];

  if (eventIdx !== -1) {
    for (let i = eventIdx + 1; i < clean.length; i++) {
      const c = clean[i];
      const lc = c.toLowerCase();

      if (lc.includes("view details")) continue;
      if (isValueCell(c)) valueCells.push(c);
    }
  }

  const actual = valueCells[0] || "-";
  const forecast = valueCells[1] || "-";
  const previous = valueCells[2] || "-";

  return {
    currency: "USD",
    impact,
    date: currentDate || "-",
    time,
    event,
    actual,
    forecast,
    previous
  };
}

async function getUsdNewsToday() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();

  try {
    const now = getNowNY();
    const todayTokens = getTodayTokens();
    const calendarUrl = `https://www.babypips.com/economic-calendar?week=${getISOWeekString(now)}`;

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
    let currentDate = "";

    for (const row of rows) {
      const cells = row.cells.map(normalize).filter(Boolean);
      if (!cells.length) continue;

      const first = cells[0] || "";

      if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/i.test(first)) {
        currentDate = first;
      }

      const isToday =
        todayTokens.some(t => currentDate.includes(t)) ||
        todayTokens.some(t => cells.some(c => c.includes(t)));

      if (!isToday) continue;

      if (!cells.includes("USD")) continue;
      if (!looksLikeHighImpact(row.html, cells)) continue;

      const parsed = parseNewsRow(cells, currentDate);
      if (!parsed) continue;

      events.push(parsed);
    }

    const deduped = [];
    const seen = new Set();

    for (const e of events) {
      const key = `${e.date}|${e.time}|${e.event}|${e.actual}|${e.forecast}|${e.previous}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(e);
      }
    }

    if (!deduped.length) {
      return {
        ok: true,
        found: false,
        message: "Keine USD Red Folder News für heute gefunden",
        events: [],
        updatedAt: new Date().toISOString()
      };
    }

    return {
      ok: true,
      found: true,
      count: deduped.length,
      events: deduped,
      updatedAt: new Date().toISOString()
    };
  } finally {
    await browser.close();
  }
}

app.get("/usd-news", async (req, res) => {
  try {
    const data = await getUsdNewsToday();
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