// Opens the live site on emulated phones and reports whether data, markers and
// map tiles load. Run by .github/workflows/smoke-test.yml.
import { createHash } from "node:crypto";
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
  const hashes = new Set(); // identical bytes on every tile = a placeholder, not a map
  page.on("response", async (r) => {
    const u = new URL(r.url());
    if (/cartocdn|openstreetmap|arcgisonline/.test(u.hostname) && !u.hostname.startsWith("nominatim")) {
      const k = `${u.hostname.split(".").slice(-2).join(".")} ${r.status()}`;
      tiles[k] = (tiles[k] || 0) + 1;
      try { hashes.add(createHash("sha1").update(await r.body()).digest("hex")); } catch { /* aborted */ }
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
  console.log("tile responses:", JSON.stringify(tiles), "distinct tile images:", hashes.size);
  await page.click("[data-toggle=sat]");
  await page.waitForTimeout(4000);
  console.log("satellite tiles loaded:", await page.locator(".leaflet-tile-loaded").count(), JSON.stringify(tiles), "distinct:", hashes.size);
  await browser.close();
}
