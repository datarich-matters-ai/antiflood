// Reads the Google Form named by `sosFormUrl` in public/config.js and writes
// public/data/sosform.json: the form's submit URL and which "entry.N" id holds
// each field. The app posts help requests straight to that form; responses land
// in the form's Google Sheet, which only the people it is shared with can see.
//
// Questions are matched by keywords in their titles (see FIELDS), so the form
// owner can word them freely and reorder them.
//
// usage: PAGES_URL=https://.../antiflood node scripts/sos-form.mjs [outDir=public/data]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import vm from "node:vm";

const outDir = process.argv[2] || "public/data";
const PREV = process.env.PAGES_URL ? process.env.PAGES_URL.replace(/\/$/, "") + "/data/sosform.json" : null;

const FIELDS = {
  urgency: /เร่งด่วน|สถานการณ์/,
  name: /ชื่อ/,
  phone: /เบอร์|โทร/,
  people: /จำนวน|คน|เปราะบาง/,
  details: /ต้องการ|รายละเอียด/,
  location: /ตำแหน่ง|พิกัด|แผนที่/,
  address: /ที่อยู่/,
};

const sandbox = { window: {} };
vm.runInNewContext(await readFile("public/config.js", "utf8"), sandbox);
const formUrl = process.env.SOS_FORM_URL || sandbox.window.APP_CONFIG?.sosFormUrl;

await mkdir(outDir, { recursive: true });

async function keepPrevious(reason) {
  console.error(`::warning::SOS form: ${reason}`);
  if (!PREV) return;
  try {
    const res = await fetch(PREV);
    if (res.ok) {
      await writeFile(`${outDir}/sosform.json`, await res.text());
      console.log("kept previously published sosform.json");
    }
  } catch { /* nothing to keep */ }
}

if (!formUrl) {
  console.log("sosFormUrl not set in config.js; help requests can only be shared via LINE/SMS");
} else {
  try {
    const res = await fetch(formUrl.replace(/\/(viewform|formResponse).*$/, "/viewform"), { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const m = html.match(/FB_PUBLIC_LOAD_DATA_\s*=\s*(\[.*?\]);\s*<\/script>/s);
    if (!m) throw new Error("form data not found; is the form published and not restricted to one organisation?");
    const items = JSON.parse(m[1])?.[1]?.[1] || [];
    const questions = items
      .filter((it) => Array.isArray(it?.[4]?.[0]))
      .map((it) => ({ title: String(it[1] || ""), entry: `entry.${it[4][0][0]}` }));

    const entries = {};
    const used = new Set();
    for (const [key, re] of Object.entries(FIELDS)) {
      const q = questions.find((q) => !used.has(q.entry) && re.test(q.title));
      if (q) { entries[key] = q.entry; used.add(q.entry); }
    }
    if (!entries.location) throw new Error("no question whose title mentions ตำแหน่ง/พิกัด/แผนที่");

    const action = res.url.replace(/\/viewform.*$/, "/formResponse");
    await writeFile(`${outDir}/sosform.json`, JSON.stringify({ action, entries }));
    console.log(`SOS form ok: ${Object.keys(entries).join(", ")}`);
    const unmatched = questions.filter((q) => !used.has(q.entry)).map((q) => q.title);
    if (unmatched.length) console.log(`questions not filled by the app: ${unmatched.join(" | ")}`);
  } catch (err) {
    await keepPrevious(err.message);
  }
}
