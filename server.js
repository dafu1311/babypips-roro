const express = require("express");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

const RORO_URL = "https://www.babypips.com/tools/risk-on-risk-off-meter";

// -------------------- HELPERS --------------------
function getISOWeekString(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function getNowInNewYork() {
  const now = new Date();
  return new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
}

function normalizeText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function compactEventName(name) {
  return normalizeText(name)
    .replace(/\s+m\/m$/i, " m/m")
    .replace(/\s+y\/y$/i, " y/y")
    .replace(/\s+q\/q$/i, " q/q");
}

function getTodayTokens() {
  const now = getNowInNewYork();

  const weekday = now.toLocaleDateString("en-US", { weekday: "short", timeZone: "America/New_York" });
  const month = now.toLocaleDateString("en-US", { month: "short", timeZone: "America/New_York" });
  const day = now.getDate();

  return [
    `${weekday} ${month} ${day}`,
    `${month} ${day}`,
    `${weekday}, ${month} ${day}`
  ];
}

function parseMinutesLeft(timeStr) {
  const m = String(timeStr).match(/(\d{1,2}):(\d{2})(am|pm)/i);
  if (!m) return null;

  let hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  const ampm = m[3].toLowerCase();

  if (ampm === "pm" && hours !== 12) hours += 12;
  if (ampm === "am" && hours === 12) hours = 0;

  const now = getNowInNewYork();
  const event = new Date(now);
  event.setHours(hours, minutes, 0, 0);

  return Math.round((event.getTime() - now.getTime()) / 60000);
}

function looksLikeHighImpact(rowHtml, cells) {
  const html = String(rowHtml || "").toLowerCase();
  const text = cells.join(" ").toLowerCase();

  return (
    html.includes("high impact") ||
    html.includes("impact-high") ||
    text.includes("high impact")
  );
}

const CALENDAR_URL = () => {
  const nyNow = getNowInNewYork();
  return `https://www.babypips.com/economic-calendar?week=${getISOWeekString(nyNow)}`;
};

// -------------------- ROOT --------------------
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

// -------------------- USD NEWS LIST --------------------
async function getUsdNewsList() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();

  try {
    await page.goto(CALENDAR_URL(), {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(7000);

    const rows = await page.locator("tr").evaluateAll((trs) => {
      return trs.map((tr) => ({
        html: tr.innerHTML,
        cells: Array.from(tr.querySelectorAll("td, th"))
          .map((cell) => (cell.textContent || "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
      }));
    });

    const todayTokens = getTodayTokens();
    let currentDate = "";
    const events = [];

    for (const row of rows) {
      const cells = row.cells.map((c) => c.trim()).filter(Boolean);
      if (!cells.length) continue;

      const first = cells[0] || "";

      if (
        todayTokens.some((t) => first.includes(t)) ||
        /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/.test(first)
      ) {
        currentDate = first;
      }

      const isToday =
        todayTokens.some((t) => currentDate.includes(t)) ||
        todayTokens.some((t) => cells.some((c) => c.includes(t)));

      if (!isToday) continue;

      const currencyIdx = cells.findIndex((c) => c === "USD");
      if (currencyIdx === -1) continue;

      if (!looksLikeHighImpact(row.html, cells)) continue;

      const time = cells.find((c) => /\d{1,2}:\d{2}(am|pm)/i.test(c)) || "-";

      let event = "-";
      let actual = "-";
      let forecast = "-";
      let previous = "-";

      for (let i = currencyIdx + 1; i < cells.length; i++) {
        const c = cells[i];
        if (!c) continue;

        const isNumberLike =
          /^[\d.,%MKBT+-]+$/.test(c) ||
          c === "-" ||
          c.toLowerCase() === "high";

        if (!isNumberLike && !/\d{1,2}:\d{2}(am|pm)/i.test(c) && c !== "USD") {
          event = c;
          break;
        }
      }

      const tail = cells.slice(-4);
      if (tail.length >= 3) {
        actual = tail[0] || "-";
        forecast = tail[1] || "-";
        previous = tail[2] || "-";
      }

      if (/view details/i.test(previous)) previous = "-";
      if (/view details/i.test(forecast)) forecast = "-";
      if (/view details/i.test(actual)) actual = "-";

      events.push({
        currency: "USD",
        impact: "HIGH",
        time,
        event: compactEventName(event),
        actual: normalizeText(actual),
        forecast: normalizeText(forecast),
        previous: normalizeText(previous),
        minutesLeft: parseMinutesLeft(time)
      });
    }

    const deduped = [];
    const seen = new Set();

    for (const e of events) {
      const key = `${e.time}|${e.event}|${e.actual}|${e.forecast}|${e.previous}`;
      if (!seen.has(key) && e.event !== "-") {
        seen.add(key);
        deduped.push(e);
      }
    }

    deduped.sort((a, b) => {
      const av = a.minutesLeft === null ? 999999 : a.minutesLeft;
      const bv = b.minutesLeft === null ? 999999 : b.minutesLeft;
      return av - bv;
    });

    if (!deduped.length) {
      return {
        ok: true,
        found: false,
        message: "Keine USD Red Folder News fuer heute gefunden",
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
    const data = await getUsdNewsList();
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