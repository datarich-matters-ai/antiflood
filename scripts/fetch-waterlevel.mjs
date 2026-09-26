// Fetches the latest water levels from ThaiWater (สสน.) and writes a compact
// JSON file for the app. Runs in GitHub Actions every 20 minutes, so the
// browser never has to call ThaiWater directly (no CORS / rate-limit issues).
//
// usage: node scripts/fetch-waterlevel.mjs [out=public/data/waterlevel.json]
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const SRC = process.env.THAIWATER_URL
  || "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load";
const out = process.argv[2] || "public/data/waterlevel.json";

const num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};
const th = (o) => (o && (o.th || o.en)) || "";
const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

async function fetchWithRetry(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i >= tries) throw err;
      console.warn(`attempt ${i} failed: ${err.message}; retrying`);
      await new Promise((r) => setTimeout(r, 5000 * i));
    }
  }
}

const raw = await fetchWithRetry(SRC);
const rows = raw?.waterlevel_data?.data;
if (!Array.isArray(rows) || rows.length === 0) {
  throw new Error("unexpected ThaiWater response: waterlevel_data.data missing or empty");
}

const stations = [];
for (const r of rows) {
  const s = r.station || {};
  const lat = num(s.tele_station_lat);
  const lng = num(s.tele_station_long);
  if (lat == null || lng == null) continue;
  stations.push({
    id: r.id ?? s.id,
    name: th(s.tele_station_name),
    prov: th(r.geocode?.province_name),
    amp: th(r.geocode?.amphoe_name),
    basin: th(r.basin?.basin_name),
    agency: r.agency?.agency_shortname?.th || r.agency?.agency_shortname?.en || "",
    lat: round(lat, 5),
    lng: round(lng, 5),
    wl: round(num(r.waterlevel_msl)), // ระดับน้ำ (ม.รทก.)
    bank: round(num(s.min_bank)), // ระดับตลิ่ง (ม.รทก.)
    pct: round(num(r.storage_percent), 1), // % ความจุลำน้ำ
    t: r.waterlevel_datetime || null,
  });
}

await mkdir(dirname(out), { recursive: true });
await writeFile(
  out,
  JSON.stringify({ updated: new Date().toISOString(), source: "ThaiWater (สสน.)", stations })
);
console.log(`wrote ${stations.length} stations to ${out}`);
