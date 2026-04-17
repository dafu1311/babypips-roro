const express = require("express");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;
const URL = "https://www.babypips.com/tools/risk-on-risk-off-meter";

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

app.listen(PORT, () => {
  console.log(`Server laeuft auf Port ${PORT}`);
});