(() => {
  "use strict";
  const CFG = window.APP_CONFIG || {};
  const DATA_URL = "data/waterlevel.json";
  const DAMS_URL = "data/dams.json";
  const NEAR_KM = 20; // stations within this radius drive the summary alert
  const DAM_KM = 150; // dams shown in the near-me view
  const RISE_CM = 10; // change over the trend window that counts as rising/falling

  // Same bands as ThaiWater's "% ความจุลำน้ำ" legend.
  const STATUS = [
    { cls: "s5", label: "ล้นตลิ่ง", min: 100 },
    { cls: "s4", label: "น้ำมาก", min: 70 },
    { cls: "s3", label: "ปกติ", min: 30 },
    { cls: "s2", label: "น้ำน้อย", min: 10 },
    { cls: "s1", label: "น้ำน้อยวิกฤต", min: -Infinity },
  ];
  const NO_DATA = { cls: "s0", label: "ไม่มีข้อมูล", rank: 0 };
  // ThaiWater's reservoir legend (% of storage capacity).
  const DAM_STATUS = [
    { cls: "s5", label: "เกินความจุ", min: 100 },
    { cls: "s4", label: "น้ำมาก", min: 80 },
    { cls: "s3", label: "ปกติ", min: 30 },
    { cls: "s2", label: "น้ำน้อย", min: -Infinity },
  ];
  STATUS.forEach((s, i) => (s.rank = STATUS.length - i));

  const ADVICE = {
    s5: "มีสถานีที่น้ำล้นตลิ่งใกล้คุณ เตรียมอพยพ ตัดไฟ ยกของขึ้นที่สูง และติดตามประกาศจากอำเภอ/ปภ. 1784",
    s4: "ระดับน้ำสูงใกล้ตลิ่ง เฝ้าระวัง ยกของขึ้นที่สูง ชาร์จมือถือ เตรียมถุงยังชีพ",
    s3: "ระดับน้ำใกล้คุณยังปกติ ติดตามข้อมูลต่อเนื่อง โดยเฉพาะช่วงฝนตกหนัก",
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  let stations = [];
  let dams = [];
  let wx = {}; // data/weather.json: radar frames, cloud image, storms
  let myPos = null; // {lat, lng}
  let map, markerLayer, meMarker;

  function statusOf(st) {
    if (st.pct == null) return NO_DATA;
    return STATUS.find((s) => st.pct >= s.min);
  }

  function damStatusOf(d) {
    return d.pct == null ? NO_DATA : DAM_STATUS.find((s) => d.pct >= s.min);
  }

  const isRising = (s) => s.tr != null && s.tr >= RISE_CM;

  function trendHtml(s) {
    if (s.tr == null) return "";
    const span = `ใน ${s.trh} ชม.`;
    if (s.tr >= RISE_CM) return `<span class="trend up">▲ ขึ้น ${s.tr} ซม. ${span}</span>`;
    if (s.tr <= -RISE_CM) return `<span class="trend down">▼ ลง ${-s.tr} ซม. ${span}</span>`;
    return `<span class="trend flat">≈ ทรงตัว</span>`;
  }

  function km(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  // ThaiWater timestamps are Bangkok local time without an offset.
  function parseTime(v) {
    if (!v) return null;
    const str = String(v).replace(" ", "T");
    const d = new Date(/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/.test(str) ? str + "+07:00" : str);
    return isNaN(d) ? null : d;
  }

  function fmtTime(v) {
    const d = parseTime(v);
    if (!d) return v || "-";
    return d.toLocaleString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  function ageHours(v) {
    const d = parseTime(v);
    return d ? (Date.now() - d) / 36e5 : Infinity;
  }

  // ---------- data ----------
  async function load() {
    const wxReq = fetch("data/weather.json", { cache: "no-cache" })
      .then((res) => (res.ok ? res.json() : {}))
      .catch(() => ({}));
    const damsReq = fetch(DAMS_URL, { cache: "no-cache" })
      .then((res) => (res.ok ? res.json() : null))
      .catch((err) => { console.warn("dams", err); return null; });
    try {
      const res = await fetch(DATA_URL, { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      stations = data.stations || [];
      const age = ageHours(data.updated);
      $("updated").textContent =
        `ข้อมูล ${data.source || ""} อัปเดต ${fmtTime(data.updated)} · ${stations.length.toLocaleString()} สถานี` +
        (age > 3 ? " ⚠️ ข้อมูลอาจไม่เป็นปัจจุบัน" : "");
    } catch (err) {
      $("updated").textContent = "โหลดข้อมูลไม่สำเร็จ ตรวจสอบอินเทอร์เน็ต แล้วลองใหม่";
      console.error(err);
    }
    dams = (await damsReq)?.dams || [];
    wx = await wxReq;
    fillProvinces();
    drawMarkers();
    const savedProv = store.get("prov");
    if (savedProv) { $("province").value = savedProv; }
    render();
  }

  function fillProvinces() {
    const provs = [...new Set(stations.map((s) => s.prov).filter(Boolean))].sort((a, b) => a.localeCompare(b, "th"));
    const sel = $("province");
    sel.length = 1;
    for (const p of provs) sel.add(new Option(p, p));
  }

  // ---------- near-me list ----------
  function render() {
    const prov = $("province").value;
    let rows;
    if (prov) {
      // Province view: every station in the province, most critical first.
      rows = stations.filter((s) => s.prov === prov)
        .map((s) => (myPos ? { ...s, dist: km(myPos, s) } : s))
        .sort((a, b) => statusOf(b).rank - statusOf(a).rank || isRising(b) - isRising(a) || (b.pct ?? -1) - (a.pct ?? -1));
    } else if (myPos) {
      rows = stations.map((s) => ({ ...s, dist: km(myPos, s) }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, CFG.nearestCount || 15);
    } else {
      rows = [];
    }

    renderSummary(rows, prov);

    $("list").innerHTML = rows.map((s) => {
      const st = statusOf(s);
      const stale = ageHours(s.t) > 24;
      const pct = s.pct == null ? "" : `${s.pct.toFixed(0)}% ของตลิ่ง`;
      const diff = s.wl != null && s.bank != null ? (s.bank - s.wl) : null;
      const diffTxt = diff == null ? "" : diff >= 0 ? `ต่ำกว่าตลิ่ง ${diff.toFixed(2)} ม.` : `<b>สูงกว่าตลิ่ง ${(-diff).toFixed(2)} ม.</b>`;
      return `<li class="${st.cls}">
        <div class="row"><span class="name">${esc(s.name)}</span><span class="badge ${st.cls}">${st.label}</span></div>
        <div class="small muted">${esc(s.amp ? "อ." + s.amp + " " : "")}จ.${esc(s.prov)}${s.dist != null ? ` · ห่าง ${s.dist.toFixed(1)} กม.` : ""}</div>
        <div class="small">${pct}${pct && diffTxt ? " · " : ""}${diffTxt}</div>
        ${s.tr != null ? `<div class="small">${trendHtml(s)}</div>` : ""}
        <div class="bar" style="color:var(--${st.cls})"><i style="width:${Math.min(100, Math.max(0, s.pct ?? 0))}%"></i></div>
        <div class="small muted">วัดเมื่อ ${fmtTime(s.t)}${stale ? " ⚠️ ข้อมูลเก่า" : ""}
          · <a href="#" data-goto="${s.lat},${s.lng}">ดูบนแผนที่</a></div>
      </li>`;
    }).join("");

    renderDams(prov);
    renderProvHotlines(prov);
    renderRain(rows, prov);
  }

  function renderDams(prov) {
    let rows = [];
    if (prov) {
      rows = dams.filter((d) => d.prov === prov)
        .map((d) => (myPos ? { ...d, dist: km(myPos, d) } : d))
        .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
    } else if (myPos) {
      rows = dams.map((d) => ({ ...d, dist: km(myPos, d) }))
        .filter((d) => d.dist <= DAM_KM)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 5);
    }
    if (!rows.length) { $("dams").innerHTML = ""; return; }
    const items = rows.map((d) => {
      const st = damStatusOf(d);
      const flow = [
        d.inflow != null ? `น้ำไหลเข้า ${d.inflow}` : "",
        d.released != null ? `ระบายออก ${d.released}` : "",
      ].filter(Boolean).join(" · ");
      return `<li class="${st.cls}">
        <div class="row"><span class="name">🏞️ ${esc(d.name)}</span><span class="badge ${st.cls}">${st.label}</span></div>
        <div class="small muted">${d.size === "large" ? "เขื่อนขนาดใหญ่" : "อ่างขนาดกลาง"} · จ.${esc(d.prov)}${d.dist != null ? ` · ห่าง ${d.dist.toFixed(0)} กม.` : ""}</div>
        <div class="small">${d.pct != null ? `${d.pct.toFixed(0)}% ของความจุ` : "ไม่มีข้อมูล"}${d.storage != null ? ` (${d.storage} ล้าน ลบ.ม.)` : ""}</div>
        ${flow ? `<div class="small">${flow} <span class="muted">ล้าน ลบ.ม./วัน</span></div>` : ""}
        <div class="bar" style="color:var(--${st.cls})"><i style="width:${Math.min(100, Math.max(0, d.pct ?? 0))}%"></i></div>
        <div class="small muted">ข้อมูลวันที่ ${esc(d.t || "-")} · <a href="#" data-goto="${d.lat},${d.lng}">ดูบนแผนที่</a></div>
      </li>`;
    }).join("");
    $("dams").innerHTML = `<h2 class="section">เขื่อน / อ่างเก็บน้ำ${prov ? ` ใน จ.${esc(prov)}` : ` ในรัศมี ${DAM_KM} กม.`}</h2>
      <p class="small muted">ถ้าเขื่อนน้ำมากและเพิ่มการระบาย พื้นที่ท้ายเขื่อนอาจมีน้ำเพิ่มขึ้นภายในไม่กี่ชั่วโมง</p>
      <ul class="list">${items}</ul>`;
  }

  function renderSummary(rows, prov) {
    const el = $("summary");
    if (!myPos && !prov) {
      el.innerHTML = `<div class="card small">กด <b>“ใช้ตำแหน่งของฉัน”</b> เพื่อดูสถานีวัดระดับน้ำที่ใกล้ที่สุด หรือเลือกจังหวัด</div>`;
      return;
    }
    if (!rows.length) { el.innerHTML = `<div class="card small">ไม่พบสถานีวัดระดับน้ำ</div>`; return; }
    const nearMode = !prov;
    const pool = nearMode ? rows.filter((s) => s.dist <= NEAR_KM) : rows;
    if (!pool.length) {
      el.innerHTML = `<div class="card small">ไม่มีสถานีวัดในรัศมี ${NEAR_KM} กม. สถานีที่ใกล้ที่สุดแสดงด้านล่าง</div>`;
      return;
    }
    const worst = pool.reduce((w, s) => (statusOf(s).rank > statusOf(w).rank ? s : w), pool[0]);
    const st = statusOf(worst);
    const n5 = pool.filter((s) => statusOf(s).cls === "s5").length;
    const n4 = pool.filter((s) => statusOf(s).cls === "s4").length;
    const where = nearMode ? `ในรัศมี ${NEAR_KM} กม.` : `ใน จ.${esc(prov)}`;
    if (st === NO_DATA) {
      el.innerHTML = `<div class="alert s0">ยังไม่มีข้อมูลระดับน้ำจากสถานี ${where}<p>ติดตามประกาศจากอำเภอ/ปภ. 1784</p></div>`;
      return;
    }
    const counts = n5 || n4 ? `ล้นตลิ่ง ${n5} · น้ำมาก ${n4} สถานี ${where}` : `สถานีทั้งหมด ${where} ไม่พบระดับน้ำสูง`;
    const rising = pool.filter(isRising);
    let risingTxt = "";
    if (rising.length) {
      const top = rising.reduce((m, s) => (s.tr > m.tr ? s : m), rising[0]);
      risingTxt = `<p>▲ น้ำกำลังขึ้น ${rising.length} สถานี (เร็วสุด +${top.tr} ซม. ใน ${top.trh} ชม. ที่ ${esc(top.name)}) เตรียมพร้อมไว้ก่อน</p>`;
    }
    // A high station that is still rising deserves the stronger warning colour.
    const cls = st.cls === "s4" && rising.some((s) => statusOf(s).rank >= 4) ? "s5" : st.cls;
    el.innerHTML = `<div class="alert ${cls}">${counts}${risingTxt}<p>${ADVICE[st.cls] || "ติดตามข้อมูลต่อเนื่อง"}</p></div>`;
  }

  function renderProvHotlines(prov) {
    const list = (CFG.provinceHotlines || {})[prov];
    $("prov-hotlines").innerHTML = list && list.length
      ? `<div class="card"><h2>📞 ติดต่อใน จ.${esc(prov)}</h2><div class="hotlines">${hotlineHtml(list)}</div></div>`
      : "";
  }

  function hotlineHtml(list) {
    return list.map((h) => `<a href="tel:${esc(h.tel)}"><b>${esc(h.tel)}</b><span class="small">${esc(h.name)}</span></a>`).join("");
  }

  // ---------- location ----------
  function locate() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("อุปกรณ์นี้ไม่รองรับ GPS"));
      navigator.geolocation.getCurrentPosition(
        (p) => { myPos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }; resolve(myPos); },
        (e) => reject(new Error(e.code === 1 ? "ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง กรุณาเปิดสิทธิ์ตำแหน่งในการตั้งค่า" : "หาตำแหน่งไม่สำเร็จ ลองใหม่อีกครั้ง")),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
      );
    });
  }

  $("btn-locate").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = "กำลังหาตำแหน่ง…";
    try {
      await locate();
      $("province").value = "";
      store.set("prov", "");
      render();
      updateSos();
      if (map) showMe();
    } catch (err) { alert(err.message); }
    btn.disabled = false; btn.textContent = "📍 ใช้ตำแหน่งของฉัน";
  });

  $("province").addEventListener("change", (e) => {
    store.set("prov", e.target.value);
    render();
  });

  $("tab-near").addEventListener("click", (e) => {
    const a = e.target.closest("[data-goto]");
    if (!a) return;
    e.preventDefault();
    const [lat, lng] = a.dataset.goto.split(",").map(Number);
    showTab("map");
    map.setView([lat, lng], 13);
  });

  // ---------- map ----------
  let mapFilter = "all";
  let showDams = false;
  let satellite = false;
  let baseLayer = null;
  const LABEL_ZOOM = 9; // % labels only once zoomed in; dots below that
  let labelled = null;

  function initMap() {
    if (map || !window.L) return;
    map = L.map("map", { preferCanvas: true }).setView([13.5, 100.8], 6);
    setBase();
    markerLayer = L.layerGroup().addTo(map);
    map.on("zoomend", () => { if ((map.getZoom() >= LABEL_ZOOM) !== labelled) drawMarkers(); });
    map.on("moveend", () => {
      if (mapMode !== "radar" || myPos) return;
      clearTimeout(fcTimer);
      fcTimer = setTimeout(mapForecast, 800);
    });
    drawMarkers();
    if (myPos) showMe();
  }

  const cssColor = (cls) => getComputedStyle(document.documentElement).getPropertyValue("--" + cls).trim() || "#9aa3af";
  const gmapsLink = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

  function stationPopup(s) {
    const st = statusOf(s);
    const diff = s.wl != null && s.bank != null ? s.bank - s.wl : null;
    return `<div class="pop"><b>${esc(s.name)}</b><br><span class="muted">อ.${esc(s.amp)} จ.${esc(s.prov)}</span>` +
      `<div class="pop-status ${st.cls}">${st.label}${s.pct != null ? ` · ${s.pct.toFixed(0)}% ของตลิ่ง` : ""}</div>` +
      (diff != null ? (diff >= 0 ? `ต่ำกว่าตลิ่ง ${diff.toFixed(2)} ม.<br>` : `<b>สูงกว่าตลิ่ง ${(-diff).toFixed(2)} ม.</b><br>`) : "") +
      (s.tr != null ? `${trendHtml(s)}<br>` : "") +
      `<span class="muted">วัดเมื่อ ${fmtTime(s.t)}</span><br>` +
      `<a href="${gmapsLink(s.lat, s.lng)}" target="_blank" rel="noopener">เปิดใน Google Maps</a></div>`;
  }

  // Called when the map opens, when data finishes loading and when a filter
  // changes, so the map is never left empty or stale.
  function drawMarkers() {
    if (!map) return;
    markerLayer.clearLayers();
    labelled = map.getZoom() >= LABEL_ZOOM;
    let shown = stations;
    if (mapFilter === "high") shown = stations.filter((s) => statusOf(s).rank >= 4);
    if (mapFilter === "rising") shown = stations.filter(isRising);

    // Draw calmer stations first so critical ones sit on top.
    [...shown].sort((a, b) => statusOf(a).rank - statusOf(b).rank).forEach((s) => {
      const st = statusOf(s);
      const critical = st.rank >= 4 || isRising(s);
      if (critical && labelled) {
        // Labelled pin: severity colour, % of bank and a rising arrow.
        const label = `${s.pct != null ? s.pct.toFixed(0) + "%" : "?"}${isRising(s) ? " ▲" : ""}`;
        L.marker([s.lat, s.lng], {
          icon: L.divIcon({ className: "wl-pin", html: `<span class="${st.cls}">${label}</span>`, iconSize: null }),
          zIndexOffset: st.rank * 100,
        }).bindPopup(stationPopup(s)).addTo(markerLayer);
      } else {
        L.circleMarker([s.lat, s.lng], {
          radius: critical ? 8 : 5, weight: critical ? 2 : 1, color: "#fff", fillColor: cssColor(st.cls), fillOpacity: 0.95,
        }).bindPopup(stationPopup(s)).addTo(markerLayer);
      }
    });

    if (showDams) {
      dams.filter((d) => d.pct != null).forEach((d) => {
        const st = damStatusOf(d);
        L.marker([d.lat, d.lng], {
          icon: L.divIcon({ className: "dam-icon", html: `<i style="background:${cssColor(st.cls)}"></i>`, iconSize: [16, 16] }),
        }).bindPopup(
          `<div class="pop"><b>🏞️ ${esc(d.name)}</b><br><span class="muted">จ.${esc(d.prov)}</span>` +
          `<div class="pop-status ${st.cls}">${st.label}${d.pct != null ? ` · ${d.pct.toFixed(0)}% ของความจุ` : ""}</div>` +
          (d.released != null ? `ระบายออก ${d.released} ล้าน ลบ.ม./วัน<br>` : "") +
          `<span class="muted">ข้อมูลวันที่ ${esc(d.t || "-")}</span></div>`
        ).addTo(markerLayer);
      });
    }

    const n5 = stations.filter((s) => statusOf(s).cls === "s5").length;
    const n4 = stations.filter((s) => statusOf(s).cls === "s4").length;
    const nUp = stations.filter(isRising).length;
    $("map-counts").innerHTML =
      `<b class="c5">ล้นตลิ่ง ${n5}</b> · <b class="c4">น้ำมาก ${n4}</b>` + (nUp ? ` · <b class="c5">▲ ขึ้น ${nUp}</b>` : "") +
      ` <span class="muted">จาก ${stations.length} สถานี</span>`;
  }

  document.querySelectorAll(".chips [data-filter]").forEach((b) => b.addEventListener("click", () => {
    mapFilter = b.dataset.filter;
    document.querySelectorAll(".chips [data-filter]").forEach((x) => x.classList.toggle("active", x === b));
    drawMarkers();
  }));
  document.querySelector(".chips [data-toggle=dams]").addEventListener("click", (e) => {
    showDams = !showDams;
    e.currentTarget.classList.toggle("active", showDams);
    drawMarkers();
  });
  document.querySelector(".chips [data-toggle=sat]").addEventListener("click", (e) => {
    satellite = !satellite;
    e.currentTarget.classList.toggle("active", satellite);
    setBase();
  });
  $("map-locate").addEventListener("click", async () => {
    try { await locate(); render(); showMe(); } catch (err) { alert(err.message); }
  });

  // Street basemaps, tried in order: if one fails before any tile loads, the
  // next one takes over. (CARTO was dropped: it now serves "API KEY REQUIRED"
  // placeholder images with HTTP 200, which no error handler can catch.)
  const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  const STREET = [
    ["https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: OSM_ATTR }],
    ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Tiles &copy; Esri" }],
  ];
  const SATELLITE = [
    ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics" }],
  ];

  function setBase() {
    if (baseLayer) map.removeLayer(baseLayer);
    $("map-notice").hidden = true;
    addBaseLayer(map, satellite ? SATELLITE : STREET, (layer) => { baseLayer = layer; }, () => {
      $("map-notice").hidden = false;
      $("map-notice").textContent = "โหลดภาพแผนที่พื้นหลังไม่ได้ (สัญญาณอ่อน?) จุดสถานียังแสดงตามปกติ";
    });
  }

  function addBaseLayer(m, list = STREET, onLayer, onAllFailed, i = 0) {
    if (i >= list.length) { if (onAllFailed) onAllFailed(); return; }
    const [url, opts] = list[i];
    const layer = L.tileLayer(url, { ...opts, attribution: opts.attribution + " · ข้อมูลน้ำ ThaiWater" }).addTo(m);
    if (onLayer) onLayer(layer);
    let loaded = false, errors = 0, done = false;
    layer.on("tileload", () => { loaded = true; });
    layer.on("tileerror", () => {
      if (loaded || done || ++errors < 3) return;
      done = true;
      m.removeLayer(layer);
      addBaseLayer(m, list, onLayer, onAllFailed, i + 1);
    });
  }

  function showMe() {
    if (!myPos || !map) return;
    if (meMarker) meMarker.remove();
    meMarker = L.circleMarker([myPos.lat, myPos.lng], { radius: 9, weight: 3, color: "#fff", fillColor: "#1a73e8", fillOpacity: 1 })
      .addTo(map).bindPopup("ตำแหน่งของคุณ");
    map.setView([myPos.lat, myPos.lng], 12);
  }

  // ---------- rain forecast ----------
  // Open-Meteo model forecast for a point: 15-minute steps for the next 2 h and
  // hourly for 24 h. RainViewer no longer publishes radar nowcasts, so the
  // "will it rain" answer comes from the model; the radar loop shows where the
  // rain has been moving over the past 2 hours.
  const forecastCache = new Map();

  async function rainForecast(lat, lng) {
    const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
    const hit = forecastCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60e3) return hit.data;
    const url = "https://api.open-meteo.com/v1/forecast?timezone=Asia%2FBangkok" +
      `&latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}` +
      "&minutely_15=precipitation&forecast_minutely_15=8" +
      "&hourly=precipitation,precipitation_probability&forecast_hours=24";
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    const data = {
      m15: j.minutely_15?.precipitation || [],
      hours: (j.hourly?.time || []).map((t, i) => ({
        t, mm: j.hourly.precipitation?.[i] ?? 0, prob: j.hourly.precipitation_probability?.[i] ?? null,
      })),
    };
    forecastCache.set(key, { at: Date.now(), data });
    return data;
  }

  // Thai Meteorological Department bands for 24-hour rainfall.
  function rain24Label(mm) {
    if (mm > 90) return ["ฝนหนักมาก", "s5"];
    if (mm > 35) return ["ฝนหนัก", "s5"];
    if (mm > 10) return ["ฝนปานกลาง", "s4"];
    if (mm >= 0.1) return ["ฝนเล็กน้อย", "s3"];
    return ["ไม่มีฝน", "s3"];
  }

  function rainVerdict(f) {
    const WET = 0.1;
    const now = f.m15[0] ?? 0;
    const first = f.m15.findIndex((x) => x >= WET);
    const h3 = f.hours.slice(0, 3);
    const mm3 = h3.reduce((a, h) => a + h.mm, 0);
    const prob6 = Math.max(0, ...f.hours.slice(0, 6).map((h) => h.prob ?? 0));
    if (now >= WET) {
      const dryAt = f.hours.findIndex((h, i) => i > 0 && h.mm < WET);
      return ["🌧️ ฝนกำลังตกอยู่" + (dryAt > 0 ? ` คาดว่าตกต่ออีกราว ${dryAt} ชม.` : " และคาดว่าตกต่อเนื่อง"), "wet"];
    }
    if (first > 0) return [`🌧️ ฝนน่าจะเริ่มตกในอีกราว ${first * 15} นาที`, "wet"];
    if (mm3 >= 0.5 || prob6 >= 60) return [`🌦️ อาจมีฝนใน 3–6 ชม. ข้างหน้า (โอกาส ${prob6}%)`, "maybe"];
    return [`🌤️ ไม่น่ามีฝนใน 3 ชม. ข้างหน้า${prob6 ? ` (โอกาสฝน 6 ชม. ${prob6}%)` : ""}`, "dry"];
  }

  function rainHtml(f, where, nearHigh) {
    const [verdict, cls] = rainVerdict(f);
    const mm24 = f.hours.reduce((a, h) => a + h.mm, 0);
    const [label24, cls24] = rain24Label(mm24);
    const max = Math.max(1, ...f.hours.map((h) => h.mm));
    const bars = f.hours.map((h, i) =>
      `<i title="${h.t.slice(11, 16)} น. ${h.mm} มม." style="height:${Math.max(2, (h.mm / max) * 100)}%"${h.mm >= 0.1 ? ' class="wet"' : ""}></i>` +
      (i % 6 === 0 ? `<b style="left:${(i / f.hours.length) * 100}%">${h.t.slice(11, 13)}น.</b>` : "")).join("");
    const warn = nearHigh && mm24 > 35
      ? `<p class="rain-warn">⚠️ คาดว่าฝนหนักซ้ำในพื้นที่ที่น้ำสูงอยู่แล้ว ระดับน้ำอาจเพิ่มขึ้นอีก เตรียมพร้อมอพยพ</p>` : "";
    return `<div class="rain-now ${cls}">${verdict}</div>` +
      `<div class="small">24 ชม. ข้างหน้า${where}: <b class="c${cls24.slice(1)}">${label24}</b> รวม ~${mm24.toFixed(1)} มม.</div>` +
      `<div class="rain-bars" aria-hidden="true">${bars}</div>${warn}` +
      `<div class="small muted">พยากรณ์จากแบบจำลอง Open-Meteo อาจคลาดเคลื่อน ใช้ประกอบประกาศกรมอุตุนิยมวิทยา</div>`;
  }

  // Near-me tab: forecast at the user's position, or the province's centre.
  async function renderRain(rows, prov) {
    const el = $("rain");
    let pt = myPos;
    if (!pt && prov && rows.length) {
      pt = { lat: rows.reduce((a, s) => a + s.lat, 0) / rows.length, lng: rows.reduce((a, s) => a + s.lng, 0) / rows.length };
    }
    if (!pt) { el.innerHTML = ""; return; }
    const nearHigh = rows.some((s) => statusOf(s).rank >= 4 && (s.dist == null || s.dist <= NEAR_KM));
    el.innerHTML = `<div class="card"><h2>🌧️ ฝนจะตกอีกไหม</h2><div class="small muted">กำลังโหลดพยากรณ์…</div></div>`;
    try {
      const f = await rainForecast(pt.lat, pt.lng);
      el.innerHTML = `<div class="card"><h2>🌧️ ฝนจะตกอีกไหม</h2>${rainHtml(f, myPos ? " ตรงตำแหน่งคุณ" : ` (จ.${esc(prov)})`, nearHigh)}` +
        `<p class="small"><a href="#" data-mode-go="radar">ดูเรดาร์ฝนบนแผนที่ →</a></p></div>`;
    } catch {
      el.innerHTML = `<div class="card small muted">โหลดพยากรณ์ฝนไม่ได้ (ไม่มีสัญญาณ?)</div>`;
    }
  }

  // ---------- weather map modes ----------
  let mapMode = "water";
  let wxLayers = [];     // radar frame layers, oldest first
  let cloudLayer = null;
  let stormLayer = null;
  let frameIdx = 0, playTimer = null, fcTimer = null;

  const fmtUnix = (t) => new Date(t * 1000).toLocaleTimeString("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" });

  function clearWx() {
    clearInterval(playTimer); playTimer = null;
    wxLayers.forEach((l) => map.removeLayer(l)); wxLayers = [];
    if (cloudLayer) { map.removeLayer(cloudLayer); cloudLayer = null; }
    if (stormLayer) { map.removeLayer(stormLayer); stormLayer = null; }
  }

  function showFrame(i) {
    frameIdx = i;
    wxLayers.forEach((l, j) => l.setOpacity(j === i ? 0.75 : 0));
    const f = wx.radar.frames[i];
    const latest = i === wx.radar.frames.length - 1;
    $("wx-time").innerHTML = `<span>🌧️ เรดาร์ฝน เวลา <b>${fmtUnix(f.t)} น.</b>${latest ? " (ล่าสุด)" : ""}</span>` +
      `<span class="muted">ฟ้าอ่อน = ฝนเบา → เหลือง/แดง = ฝนหนัก</span>`;
    $("wx-slider").value = i;
  }

  function play(on) {
    clearInterval(playTimer); playTimer = null;
    $("wx-play").textContent = on ? "⏸" : "▶️";
    if (on) playTimer = setInterval(() => {
      // Hold on the latest frame a little longer before looping.
      const n = wx.radar.frames.length;
      showFrame(frameIdx >= n - 1 ? 0 : frameIdx + 1);
    }, 700);
  }

  function drawStorms() {
    if (!wx.storms?.length) return;
    stormLayer = L.layerGroup(wx.storms.map((st) => L.marker([st.lat, st.lng], {
      icon: L.divIcon({ className: "storm-icon", html: `<span class="${esc(st.alert || "")}">🌀 ${esc(st.name)}</span>`, iconSize: null }),
      zIndexOffset: 2000,
    }).bindPopup(`<div class="pop"><b>🌀 ${esc(st.name)}</b><br>ระดับเตือน GDACS: ${esc(st.alert || "-")}<br>` +
      `<span class="muted">ข้อมูลถึง ${esc(st.to || "-")}</span>` +
      (st.url ? `<br><a href="${esc(st.url)}" target="_blank" rel="noopener">รายละเอียด</a>` : "") + `</div>`))).addTo(map);
  }

  function setMapMode(mode) {
    initMap();
    mapMode = mode;
    document.querySelectorAll(".modes .mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    clearWx();
    const panel = $("wx-panel");
    panel.hidden = mode === "water";
    $("wx-player").hidden = true;
    $("wx-forecast").innerHTML = "";

    if (mode === "radar") {
      if (!wx.radar?.frames?.length) {
        $("wx-time").textContent = "ยังไม่มีข้อมูลเรดาร์ฝน ลองใหม่ภายหลัง";
      } else {
        wxLayers = wx.radar.frames.map((f) => L.tileLayer(`${wx.radar.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, {
          opacity: 0, maxNativeZoom: 7, maxZoom: 19, zIndex: 300, attribution: 'เรดาร์ฝน &copy; <a href="https://www.rainviewer.com/">RainViewer</a>',
        }).addTo(map));
        $("wx-slider").max = wx.radar.frames.length - 1;
        $("wx-player").hidden = false;
        showFrame(wx.radar.frames.length - 1);
        play(true);
        if (map.getZoom() > 8) map.setZoom(8); // radar detail stops at zoom 7
      }
      drawStorms();
      mapForecast();
    } else if (mode === "clouds") {
      if (wx.clouds) {
        cloudLayer = L.tileLayer(wx.clouds.url, {
          opacity: 0.7, maxNativeZoom: wx.clouds.maxZoom, maxZoom: 19, zIndex: 300,
          attribution: 'ภาพดาวเทียม Himawari &copy; NASA GIBS',
        }).addTo(map);
        const t = new Date(wx.clouds.time);
        $("wx-time").innerHTML = `<span>☁️ ภาพดาวเทียมอินฟราเรด เวลา <b>${isNaN(t) ? esc(wx.clouds.time) : t.toLocaleString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " น."}</b></span>` +
          `<span class="muted">สีขาวสว่าง = เมฆหนา ยอดสูง (กลุ่มพายุฝนฟ้าคะนอง)</span>`;
        if (map.getZoom() > 7) map.setZoom(6);
      } else {
        $("wx-time").textContent = "ยังไม่มีภาพดาวเทียม ลองใหม่ภายหลัง";
      }
      drawStorms();
      $("wx-forecast").innerHTML = wx.storms && !wx.storms.length
        ? "ไม่มีพายุหมุนเขตร้อนใกล้ประเทศไทยในขณะนี้ (GDACS)"
        : wx.storms?.length ? `🌀 มีพายุ ${wx.storms.length} ลูกใกล้ภูมิภาค แตะที่ป้ายเพื่อดูรายละเอียด` : "";
    }
  }

  // Forecast for the user's position, or the map centre while panning.
  async function mapForecast() {
    if (mapMode !== "radar") return;
    const c = myPos || map.getCenter();
    const el = $("wx-forecast");
    try {
      const f = await rainForecast(c.lat, c.lng);
      if (mapMode !== "radar") return;
      const [verdict] = rainVerdict(f);
      const mm24 = f.hours.reduce((a, h) => a + h.mm, 0);
      el.innerHTML = `<b>${myPos ? "ตรงตำแหน่งคุณ" : "กลางแผนที่"}:</b> ${verdict} · 24 ชม. ~${mm24.toFixed(1)} มม. (${rain24Label(mm24)[0]})`;
    } catch { el.textContent = "โหลดพยากรณ์ฝนไม่ได้"; }
  }

  document.querySelectorAll(".modes .mode").forEach((b) => b.addEventListener("click", () => setMapMode(b.dataset.mode)));
  $("wx-play").addEventListener("click", () => play(!playTimer));
  $("wx-slider").addEventListener("input", (e) => { play(false); showFrame(Number(e.target.value)); });
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-mode-go]");
    if (!a) return;
    e.preventDefault();
    showTab("map");
    setMapMode(a.dataset.modeGo);
    if (myPos) map.setView([myPos.lat, myPos.lng], 8);
  });

  // ---------- tabs ----------
  function showTab(name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    if (name === "map") { initMap(); setTimeout(() => map && map.invalidateSize(), 50); }
    if (name === "sos") { initSosMap(); setTimeout(() => sosMap && sosMap.invalidateSize(), 50); updateSos(); }
    window.scrollTo(0, 0);
  }
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

  // ---------- SOS ----------
  // The request location is separate from myPos: people often report for a
  // relative elsewhere, or correct a drifting GPS fix by moving the pin.
  const SOS_FIELDS = ["sos-name", "sos-phone", "sos-people", "sos-vuln", "sos-need", "sos-note"];
  const QUEUE_KEY = "sos-queue";
  let sosPos = null; // {lat, lng, acc?, src: "gps" | "pin"}
  let sosAddr = "";
  let sosMap, sosMarker, geoTimer;
  let sosForm = null; // {action, entries} from data/sosform.json

  const v = (id) => $(id).value.trim();
  const urgency = () => document.querySelector("input[name=sos-urg]:checked")?.value || "";
  const sosLink = () => (sosPos ? `https://maps.google.com/?q=${sosPos.lat.toFixed(6)},${sosPos.lng.toFixed(6)}` : "");

  function initSosMap() {
    if (sosMap || !window.L) return;
    const start = sosPos || myPos;
    sosMap = L.map("sos-map").setView(start ? [start.lat, start.lng] : [13.5, 100.8], start ? 16 : 5);
    addBaseLayer(sosMap);
    sosMap.on("click", (e) => setSosPos({ lat: e.latlng.lat, lng: e.latlng.lng, src: "pin" }));
    if (sosPos) placeSosMarker();
    else if (myPos) setSosPos({ ...myPos, src: "gps" });
  }

  function placeSosMarker() {
    if (!sosMap || !sosPos) return;
    if (!sosMarker) {
      sosMarker = L.marker([sosPos.lat, sosPos.lng], { draggable: true, autoPan: true }).addTo(sosMap);
      sosMarker.on("dragend", () => {
        const ll = sosMarker.getLatLng();
        setSosPos({ lat: ll.lat, lng: ll.lng, src: "pin" }, false);
      });
    } else {
      sosMarker.setLatLng([sosPos.lat, sosPos.lng]);
    }
  }

  function setSosPos(pos, pan = true) {
    sosPos = pos;
    sosAddr = "";
    placeSosMarker();
    if (pan && sosMap) sosMap.setView([pos.lat, pos.lng], Math.max(sosMap.getZoom(), 16));
    updateSos();
    // Rough street address, to read out on the phone and for rescuers. Best
    // effort: the coordinates are what matter.
    clearTimeout(geoTimer);
    geoTimer = setTimeout(async () => {
      try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&accept-language=th&lat=${pos.lat}&lon=${pos.lng}`;
        const res = await fetch(url);
        if (!res.ok || sosPos !== pos) return;
        sosAddr = (await res.json()).display_name || "";
        updateSos();
      } catch { /* offline: coordinates only */ }
    }, 800);
  }

  function sosText() {
    const lines = ["🆘 ขอความช่วยเหลือ น้ำท่วม"];
    if (urgency()) lines.push(urgency());
    if (sosPos) lines.push(`📍 ตำแหน่ง: ${sosLink()}`);
    if (sosAddr) lines.push(`🏠 ที่อยู่โดยประมาณ: ${sosAddr}`);
    if (v("sos-name") || v("sos-phone")) lines.push(`📞 ติดต่อ: ${[v("sos-name"), v("sos-phone")].filter(Boolean).join(" ")}`);
    if (v("sos-people")) lines.push(`👥 จำนวนคน: ${v("sos-people")}`);
    if (v("sos-vuln")) lines.push(`♿ กลุ่มเปราะบาง: ${v("sos-vuln")}`);
    if (v("sos-need")) lines.push(`📦 ต้องการ: ${v("sos-need")}`);
    if (v("sos-note")) lines.push(`📝 ${v("sos-note")}`);
    lines.push(`🕒 ${new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}`);
    return lines.join("\n");
  }

  function updateSos() {
    $("sos-loc").innerHTML = sosPos
      ? `<b>📍 ${sosPos.lat.toFixed(5)}, ${sosPos.lng.toFixed(5)}</b>` +
        (sosPos.src === "gps" && sosPos.acc ? ` <span class="muted">(GPS ±${Math.round(sosPos.acc)} ม.)</span>` : sosPos.src === "pin" ? ` <span class="muted">(ปักหมุดเอง)</span>` : "") +
        (sosAddr ? `<br>${esc(sosAddr)}` : "") +
        `<br><a href="${sosLink()}" target="_blank" rel="noopener">ตรวจดูใน Google Maps</a>`
      : "ยังไม่ได้ระบุตำแหน่ง";
    $("sos-loc").classList.toggle("ok", !!sosPos);
    const text = sosText();
    $("sos-preview").textContent = text;
    $("sos-line").href = "https://line.me/R/share?text=" + encodeURIComponent(text);
    const sep = /iPhone|iPad|iPod/.test(navigator.userAgent) ? "&" : "?";
    $("sos-sms").href = `sms:${sep}body=` + encodeURIComponent(text);
    SOS_FIELDS.forEach((id) => store.set(id, $(id).value));
  }

  SOS_FIELDS.forEach((id) => {
    const saved = store.get(id);
    if (saved) $(id).value = saved;
    $(id).addEventListener("input", updateSos);
  });
  document.querySelectorAll("input[name=sos-urg]").forEach((r) => r.addEventListener("change", updateSos));

  $("sos-getloc").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = "กำลังหาตำแหน่ง…";
    try {
      const p = await locate();
      render();
      initSosMap();
      setSosPos({ ...p, src: "gps" });
    } catch (err) { alert(err.message); }
    btn.disabled = false; btn.textContent = "📍 ใช้ตำแหน่ง GPS ของฉัน";
  });

  // --- sending to the help-request form, with an offline queue ---
  const loadQueue = () => { try { return JSON.parse(store.get(QUEUE_KEY) || "[]"); } catch { return []; } };
  const saveQueue = (q) => store.set(QUEUE_KEY, JSON.stringify(q));

  function showStatus(html, cls) {
    const el = $("sos-status");
    el.hidden = false;
    el.className = "status " + cls;
    el.innerHTML = html;
  }

  // One flush at a time: the "online" event and a button press can overlap, and
  // two concurrent flushes would post the same queued request twice.
  let flushing = null;
  function flushQueue() {
    if (!flushing) flushing = doFlush().finally(() => { flushing = null; });
    return flushing;
  }

  async function doFlush() {
    if (!sosForm) return;
    const queue = loadQueue();
    if (!queue.length) return;
    const left = [];
    for (const item of queue) {
      try {
        // Google Forms does not send CORS headers, so the response is opaque;
        // a network error is the only failure we can see.
        await fetch(sosForm.action, { method: "POST", mode: "no-cors", body: new URLSearchParams(item.body) });
        showStatus(`✅ <b>ส่งคำขอแล้ว</b> รหัสอ้างอิง <b>${esc(item.ref)}</b> (${esc(item.time)})<br>` +
          `ทีมช่วยเหลือจะติดต่อกลับทางเบอร์ที่ให้ไว้ ถ้าอันตรายถึงชีวิตให้โทร 1669 / 1784 ด้วย`, "ok");
      } catch {
        left.push(item);
      }
    }
    saveQueue(left);
    if (left.length) {
      showStatus(`⏳ ยังส่งไม่ได้ (ไม่มีสัญญาณ) แอปจะส่งให้อัตโนมัติเมื่อกลับมาออนไลน์ ` +
        `อย่าปิดหน้านี้ หรือส่งทาง SMS ด้านล่างแทน`, "wait");
    }
  }

  $("sos-submit").addEventListener("click", async () => {
    if (!sosForm) {
      showStatus("ยังไม่ได้เชื่อมต่อศูนย์รับเรื่องในพื้นที่ กรุณาโทร 1784 หรือส่งผ่าน LINE / SMS ด้านล่าง", "wait");
      return;
    }
    if (!sosPos) {
      showStatus("กรุณาระบุตำแหน่งก่อน (กดปุ่ม GPS หรือแตะบนแผนที่)", "err");
      $("sos-getloc").scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (!v("sos-phone")) {
      showStatus("กรุณาใส่เบอร์โทรติดต่อกลับ เพื่อให้ทีมช่วยเหลือโทรหาได้", "err");
      $("sos-phone").focus();
      return;
    }
    const ref = Math.random().toString(36).slice(2, 6).toUpperCase();
    const time = new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });
    const e = sosForm.entries;
    const body = {};
    const put = (key, val) => { if (e[key] && val) body[e[key]] = val; };
    put("urgency", urgency() || "ไม่ระบุ");
    put("name", v("sos-name"));
    put("phone", v("sos-phone"));
    put("people", [v("sos-people") && `${v("sos-people")} คน`, v("sos-vuln")].filter(Boolean).join(" · "));
    put("details", [v("sos-need") && `ต้องการ: ${v("sos-need")}`, v("sos-note")].filter(Boolean).join(" · "));
    put("location", `${sosLink()} (${sosPos.lat.toFixed(6)}, ${sosPos.lng.toFixed(6)}` +
      `${sosPos.src === "gps" && sosPos.acc ? `, GPS ±${Math.round(sosPos.acc)} ม.` : sosPos.src === "pin" ? ", ปักหมุดเอง" : ""})`);
    put("address", `${sosAddr || "-"} [รหัส ${ref}]`);
    // Any field the form lacks still reaches rescuers via the location answer.
    if (!e.address) body[e.location] += ` [รหัส ${ref}]`;

    const btn = $("sos-submit");
    btn.disabled = true;
    setTimeout(() => { btn.disabled = false; }, 30000); // avoid accidental double sends
    saveQueue([...loadQueue(), { ref, time, body }]);
    showStatus("กำลังส่ง…", "wait");
    await flushQueue();
  });
  window.addEventListener("online", flushQueue);

  $("sos-share").addEventListener("click", async () => {
    const text = sosText();
    if (navigator.share) {
      try { await navigator.share({ text }); return; } catch (err) { if (err.name === "AbortError") return; }
    }
    window.open("https://line.me/R/share?text=" + encodeURIComponent(text), "_blank");
  });

  $("sos-copy").addEventListener("click", async () => {
    const text = sosText();
    try { await navigator.clipboard.writeText(text); alert("คัดลอกแล้ว วางในแชทกลุ่มหรือโพสต์ได้เลย"); }
    catch { prompt("คัดลอกข้อความนี้", text); }
  });

  async function loadSosForm() {
    try {
      const res = await fetch("data/sosform.json", { cache: "no-cache" });
      if (res.ok) sosForm = await res.json();
    } catch { /* not configured or offline */ }
    if (!sosForm) {
      $("sos-submit").textContent = "ยังไม่ได้เชื่อมต่อศูนย์รับเรื่อง (ใช้ LINE / SMS ด้านล่าง)";
      $("sos-submit").classList.remove("danger");
    }
    if (loadQueue().length) flushQueue();
  }

  // ---------- static content ----------
  $("hotlines").innerHTML = hotlineHtml(CFG.hotlines || []);
  $("links").innerHTML = (CFG.links || []).map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name)}</a></li>`).join("");

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW", e));
  }

  load();
  loadSosForm();
  updateSos();
})();
