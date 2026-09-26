// Opens the live site in headless Chrome and reports whether data, markers and
// map tiles load. Run by .github/workflows/smoke-test.yml.
import { chromium } from "playwright-core";

const url = process.env.SITE_URL || "https://datarich-matters-ai.github.io/antiflood/";
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const tiles = {};
page.on("response", (r) => {
  const u = new URL(r.url());
  if (/cartocdn|openstreetmap|arcgisonline/.test(u.hostname)) {
    const k = `${u.hostname.split(".").slice(-2).join(".")} ${r.status()}`;
    tiles[k] = (tiles[k] || 0) + 1;
  }
});
page.on("requestfailed", (r) => console.log("request failed:", r.url(), r.failure()?.errorText));
page.on("pageerror", (e) => console.log("page error:", e.message));

await page.goto(url, { waitUntil: "networkidle" });
console.log("header:", await page.textContent("#updated"));
await page.click("[data-tab=map]");
await page.waitForTimeout(6000);
console.log("dam markers:", await page.locator(".dam-icon").count());
console.log("tile images loaded:", await page.locator(".leaflet-tile-loaded").count());
console.log("tile responses:", JSON.stringify(tiles));
console.log("attribution:", await page.textContent(".leaflet-control-attribution"));
await browser.close();
