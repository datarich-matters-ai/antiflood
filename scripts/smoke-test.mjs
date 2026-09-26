// Opens the live site on emulated phones and reports whether data, markers and
// map tiles load. Run by .github/workflows/smoke-test.yml.
import { chromium, webkit, devices } from "playwright";

const url = process.env.SITE_URL || "https://datarich-matters-ai.github.io/antiflood/";
const targets = [
  ["iPhone Safari", webkit, devices["iPhone 13"]],
  ["Android Chrome", chromium, devices["Pixel 7"]],
];

for (const [label, engine, device] of targets) {
  console.log(`===== ${label}`);
  const browser = await engine.launch();
  const ctx = await browser.newContext({ ...device, locale: "th-TH" });
  const page = await ctx.newPage();
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
  page.on("console", (m) => m.type() === "error" && console.log("console error:", m.text()));

  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(3000);
  console.log("header:", await page.textContent("#updated"));
  await page.click("[data-tab=map]");
  await page.waitForTimeout(6000);
  console.log("map box:", JSON.stringify(await page.locator("#map").boundingBox()));
  console.log("dam markers:", await page.locator(".dam-icon").count());
  console.log("tile images loaded:", await page.locator(".leaflet-tile-loaded").count());
  console.log("tile responses:", JSON.stringify(tiles));
  await browser.close();
}
