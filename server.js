const express = require("express");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;
const URL = "https://www.babypips.com/tools/risk-on-risk-off-meter";

let lastGoodData = {
  ok: true,
  value: 50,
  regime: "Neutral",
  updatedAt: new Date().toISOString(),
  cached: true
};

app.get("/", (req, res) => {
  res.send("Babypips RORO API laeuft. Nutze /roro");
});

async function getRiskData() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
  });

  await page.setExtraHTTPHeaders({
    "accept-language": "en-US,en;q=0.9"
  });

  try {
    await page.goto(URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(8000);

    const body = await page.locator("body").innerText();

    console.log("BODY START:");
    console.log(body.slice(0, 3000));
    console.log("BODY ENDE");

    if (body.includes("Sorry, you have been blocked") || body.includes("unable to access babypips.com")) {
      throw new Error("Von Babypips/Cloudflare geblockt");
    }

    const regimeMatches = body.match(/Risk-On|Risk-Off|Neutral/g) || [];
    const numberMatches = body.match(/\b\d{1,3}\b/g) || [];

    if (regimeMatches.length === 0 || numberMatches.length === 0) {
      throw new Error("Score nicht gefunden");
    }

    const regime = regimeMatches[regimeMatches.length - 1];
    const value = parseInt(numberMatches[numberMatches.length - 1], 10);

    if (isNaN(value) || value < 0 || value > 100) {
      throw new Error("Ungueltiger Score gefunden");
    }

    const freshData = {
      ok: true,
      value,
      regime,
      updatedAt: new Date().toISOString(),
      cached: false
    };

    lastGoodData = freshData;
    return freshData;
  } finally {
    await browser.close();
  }
}

app.get("/roro", async (req, res) => {
  try {
    const data = await getRiskData();
    res.json(data);
  } catch (err) {
    console.error("RORO Fehler:", err);
    res.json({
      ...lastGoodData,
      warning: String(err),
      fallback: true
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server laeuft auf Port ${PORT}`);
});