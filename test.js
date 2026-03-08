const { chromium } = require("playwright");

(async () => {

  const browser = await chromium.launch({ headless: true });

  const page = await browser.newPage();

  await page.goto("https://www.babypips.com/tools/risk-on-risk-off-meter");

  await page.waitForTimeout(8000);

  const body = await page.locator("body").innerText();

  // Zahl vor Risk-Off / Risk-On finden
  const match = body.match(/\b(\d{1,3})\s+(Risk-Off|Risk-On|Neutral)/);

  if(match){

    const value = parseInt(match[1]);
    const regime = match[2];

    console.log("Score:", value);
    console.log("Regime:", regime);

  } else {

    console.log("Score nicht gefunden");

  }

  await browser.close();

})();