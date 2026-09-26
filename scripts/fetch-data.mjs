// Fetches water levels and dam storage from ThaiWater (สสน.) and writes
// compact JSON files for the app. Runs in GitHub Actions every ~20 minutes,
// so browsers never call ThaiWater directly.
//
// Water-level trend: ThaiWater's per-station graph API would need one request
// per station, so instead each run appends the latest reading to a rolling
// 12-hour history (published as history.json and read back on the next run)
// and derives the change over the last ~6 hours from it.
//
// usage: PAGES_URL=https://.../antiflood node scripts/fetch-data.mjs [outDir=public/data]
import { mkdir, writeFile } from "node:fs/promises";

const BASE = process.env.THAIWATER_BASE || "https://api-v3.thaiwater.net/api/v1/thaiwater30";
const PREV = process.env.PAGES_URL ? process.env.PAGES_URL.replace(/\/$/, "") + "/data" : null;
const outDir = process.argv[2] || "public/data";

const HISTORY_HOURS = 12;
const TREND_HOURS = 6;
const TREND_MIN_HOURS = 2; // need at least this much history to call a trend

const num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};
const th = (o) => (o && (o.th || o.en)) || "";
const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
// ThaiWater timestamps are Bangkok local time without an offset.
const toMs = (s) => {
  if (!s) return null;
  const ms = Date.parse(String(s).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? "" : "+07:00"));
  return Number.isFinite(ms) ? ms : null;
};

async function getJson(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i >= tries) throw new Error(`${url}: ${err.message}`);
      console.warn(`attempt ${i} for ${url} failed: ${err.message}; retrying`);
      await new Promise((r) => setTimeout(r, 5000 * i));
    }
  }
}

// Previously published file, or null (first deploy, or site unreachable).
async function getPrev(name) {
  if (!PREV) return null;
  try {
    return await getJson(`${PREV}/${name}`, 1);
  } catch (err) {
    console.warn(`no previous ${name}: ${err.message}`);
    return null;
  }
}

async function write(name, data) {
  await writeFile(`${outDir}/${name}`, JSON.stringify(data));
}

// ---------- water level ----------
async function waterLevels(prevHistory) {
  const raw = await getJson(`${BASE}/public/waterlevel_load`);
  const rows = raw?.waterlevel_data?.data;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("unexpected waterlevel_load response: waterlevel_data.data missing or empty");
  }

  const now = Date.now();
  const cutoff = now - HISTORY_HOURS * 36e5;
  const history = {}; // station id -> [[ms, wl], ...] oldest first
  const stations = [];

  for (const r of rows) {
    const s = r.station || {};
    const lat = num(s.tele_station_lat);
    const lng = num(s.tele_station_long);
    if (lat == null || lng == null) continue;
    const id = String(s.id ?? r.id);
    const wl = round(num(r.waterlevel_msl));
    const t = r.waterlevel_datetime || null;
    const tMs = toMs(t);

    let h = (prevHistory?.[id] || []).filter(([ms]) => ms >= cutoff);
    if (wl != null && tMs != null && tMs >= cutoff && !h.some(([ms]) => ms === tMs)) h.push([tMs, wl]);
    h.sort((a, b) => a[0] - b[0]);
    if (h.length) history[id] = h;

    // Change versus the oldest reading within the trend window.
    let tr = null, trh = null;
    if (wl != null && tMs != null) {
      const base = h.find(([ms]) => ms >= tMs - TREND_HOURS * 36e5);
      if (base && tMs - base[0] >= TREND_MIN_HOURS * 36e5) {
        tr = Math.round((wl - base[1]) * 100); // cm
        trh = Math.round((tMs - base[0]) / 36e5);
      }
    }

    stations.push({
      id,
      name: th(s.tele_station_name),
      prov: th(r.geocode?.province_name),
      amp: th(r.geocode?.amphoe_name),
      lat: round(lat, 5),
      lng: round(lng, 5),
      wl, // ระดับน้ำ (ม.รทก.)
      bank: round(num(s.min_bank)), // ระดับตลิ่ง (ม.รทก.)
      pct: round(num(r.storage_percent), 1), // % ความจุลำน้ำ
      tr, // เปลี่ยนแปลง (ซม.) ในช่วง trh ชั่วโมง
      trh,
      t,
    });
  }
  return { stations, history };
}

// ---------- dams ----------
async function dams() {
  const raw = await getJson(`${BASE}/analyst/dam`);
  const d = raw?.data || {};
  const groups = [
    ["large", d.dam_daily],
    ["medium", d.dam_medium],
  ];
  const out = [];
  for (const [size, rows] of groups) {
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      const dm = r.dam || {};
      const lat = num(dm.dam_lat);
      const lng = num(dm.dam_long);
      if (lat == null || lng == null) continue;
      out.push({
        id: dm.id,
        size,
        name: th(dm.dam_name),
        prov: th(r.geocode?.province_name),
        lat: round(lat, 5),
        lng: round(lng, 5),
        pct: round(num(r.dam_storage_percent), 1), // % ความจุ
        storage: round(num(r.dam_storage)), // ล้าน ลบ.ม.
        inflow: round(num(r.dam_inflow)), // ล้าน ลบ.ม./วัน
        released: round(num(r.dam_released)), // ล้าน ลบ.ม./วัน
        t: r.dam_date || null,
      });
    }
  }
  if (!out.length) throw new Error("unexpected dam response: no dams with coordinates");
  return out;
}

// ---------- main ----------
await mkdir(outDir, { recursive: true });
const updated = new Date().toISOString();
let failed = 0;
let haveWater = false;

const prevHistory = await getPrev("history.json");
try {
  const { stations, history } = await waterLevels(prevHistory);
  await write("waterlevel.json", { updated, source: "ThaiWater (สสน.)", stations });
  await write("history.json", history);
  haveWater = true;
  console.log(`wrote ${stations.length} stations (${stations.filter((s) => s.tr != null).length} with trend)`);
} catch (err) {
  failed++;
  console.error(`::warning::water levels: ${err.message}`);
  // Keep serving the last good data; the app shows its age.
  const prev = await getPrev("waterlevel.json");
  if (prev) { await write("waterlevel.json", prev); haveWater = true; }
  if (prevHistory) await write("history.json", prevHistory);
}

try {
  const list = await dams();
  await write("dams.json", { updated, source: "ThaiWater (สสน.)", dams: list });
  console.log(`wrote ${list.length} dams`);
} catch (err) {
  failed++;
  console.error(`::warning::dams: ${err.message}`);
  const prev = await getPrev("dams.json");
  if (prev) await write("dams.json", prev);
}

// Fail the deploy only when there is no water-level data at all to serve.
if (!haveWater) process.exit(1);
