// Fetches water levels and dam storage from ThaiWater (สสน.) and writes
// compact JSON files for the app. Runs in GitHub Actions every ~5 minutes,
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

// ---------- rain gauges ----------
// Rainfall stations nationwide (ThaiWater rain_24h): accumulated rain in the
// last 24 h and, where the station reports it, the last hour.
async function rainGauges() {
  const raw = await getJson(`${BASE}/public/rain_24h`);
  const rows = Array.isArray(raw?.data) ? raw.data : [];
  const out = [];
  for (const r of rows) {
    const s = r.station || {};
    const lat = num(s.tele_station_lat);
    const lng = num(s.tele_station_long);
    const r24 = num(r.rain_24h);
    if (lat == null || lng == null || r24 == null) continue;
    out.push({
      name: th(s.tele_station_name),
      prov: th(r.geocode?.province_name),
      amp: th(r.geocode?.amphoe_name),
      tam: th(r.geocode?.tumbon_name),
      lat: round(lat, 5),
      lng: round(lng, 5),
      r24: round(r24, 1),
      r1: round(num(r.rain_1h), 1),
      t: r.rainfall_datetime || null,
    });
  }
  if (!out.length) throw new Error("unexpected rain_24h response: no stations");
  return out;
}

// ---------- weather overlays ----------
// Rain radar frames (RainViewer), the latest Himawari infrared cloud image
// (NASA GIBS) and tropical cyclones near Thailand (GDACS). Each part is
// optional: a failure leaves that layer out rather than failing the file.
const IR_LAYER = "Himawari_AHI_Band13_Clean_Infrared";
const TC_BOX = { w: 80, e: 130, s: -5, n: 35 }; // SE Asia, Bay of Bengal, S China Sea

async function weather() {
  const out = {};

  try {
    const rv = await getJson("https://api.rainviewer.com/public/weather-maps.json", 2);
    const frames = (rv?.radar?.past || []).map((f) => ({ t: f.time, path: f.path }));
    if (rv?.host && frames.length) out.radar = { host: rv.host, frames };
  } catch (err) { console.warn(`radar: ${err.message}`); }

  try {
    const res = await fetch("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&REQUEST=GetCapabilities",
      { signal: AbortSignal.timeout(60000) });
    const caps = await res.text();
    const at = caps.indexOf(`<ows:Identifier>${IR_LAYER}</ows:Identifier>`);
    if (at < 0) throw new Error(`${IR_LAYER} not in GIBS capabilities`);
    const block = caps.slice(caps.lastIndexOf("<Layer>", at), caps.indexOf("</Layer>", at));
    const time = block.match(/<Default>([^<]+)<\/Default>/)?.[1];
    const tms = block.match(/<TileMatrixSet>([^<]+)<\/TileMatrixSet>/)?.[1];
    const level = Number(tms?.match(/Level(\d+)/)?.[1]);
    if (!time || !tms) throw new Error("no default time / tile matrix set");
    out.clouds = {
      url: `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${IR_LAYER}/default/${time}/${tms}/{z}/{y}/{x}.png`,
      time,
      maxZoom: Number.isFinite(level) ? level : 6,
    };
  } catch (err) { console.warn(`clouds: ${err.message}`); }

  try {
    const tc = await getJson("https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC", 2);
    const recent = Date.now() - 3 * 864e5;
    out.storms = (tc?.features || [])
      .filter((f) => {
        const [lng, lat] = f.geometry?.coordinates || [];
        const p = f.properties || {};
        return lng >= TC_BOX.w && lng <= TC_BOX.e && lat >= TC_BOX.s && lat <= TC_BOX.n &&
          Date.parse(p.todate) >= recent;
      })
      .map((f) => ({
        name: f.properties.eventname || f.properties.name,
        lat: f.geometry.coordinates[1],
        lng: f.geometry.coordinates[0],
        alert: f.properties.alertlevel, // Green / Orange / Red
        to: f.properties.todate,
        url: f.properties.url?.report || "",
      }));
  } catch (err) { console.warn(`storms: ${err.message}`); }

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

try {
  const gauges = await rainGauges();
  await write("rain.json", { updated, source: "ThaiWater (สสน.)", gauges });
  console.log(`wrote ${gauges.length} rain gauges (${gauges.filter((g) => g.r1 != null).length} with 1 h rain)`);
} catch (err) {
  console.error(`::warning::rain: ${err.message}`);
  const prev = await getPrev("rain.json");
  if (prev) await write("rain.json", prev);
}

try {
  const w = await weather();
  await write("weather.json", { updated, ...w });
  console.log(`weather: radar ${w.radar?.frames.length ?? 0} frames, clouds ${w.clouds?.time ?? "none"}, storms ${w.storms?.length ?? "n/a"}`);
} catch (err) {
  console.error(`::warning::weather: ${err.message}`);
}

// Fail the deploy only when there is no water-level data at all to serve.
if (!haveWater) process.exit(1);
