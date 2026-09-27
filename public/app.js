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
  let gauges = []; // data/rain.json: rain stations
  let roads = [];  // road flood reports (Longdo live / cache, plus BMA sensors and Traffy when reachable)
  const roadSrc = {}; // source -> {ok, n, at}
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
    const rainReq = fetch("data/rain.json", { cache: "no-cache" })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
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
    gauges = (await rainReq)?.gauges || [];
    fetch("data/roads.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null).then(loadRoads);
    fillProvinces();
    drawMarkers();
    if (/^#r=/.test(location.hash)) showTab("route");
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
  let showRoads = true;
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

    if (showRoads) roads.filter((r) => roadStatus(r).level > 0).forEach((r) => roadMarker(r).addTo(markerLayer));

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
      ` <span class="muted">จาก ${stations.length} สถานี</span>` +
      (roads.length ? ` · <b>🚗 ถนนท่วม ${roads.filter((r) => roadStatus(r).level > 0).length}</b>` : "");
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
  document.querySelector(".chips [data-toggle=roads]").addEventListener("click", (e) => {
    showRoads = !showRoads;
    e.currentTarget.classList.toggle("active", showRoads);
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

  // ---------- road flood reports ----------
  // Longdo Traffic's public feed (iTIC, JS100, the public) is the main source
  // and allows browser access. The BMA road sensors and Traffy Fondue only
  // answer Thai networks, so the phone tries them directly and they simply
  // stay out when unreachable. Depth and passability are read from each
  // report's own text or sensor reading; nothing is made up.
  const LONGDO_TYPES = new Set(["6", "19", "18", "5"]);
  const FLOOD_TXT = /น้ำท่วม|ท่วมขัง|น้ำขัง|flood/i;

  async function getJsonTimeout(url, ms = 12000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctl.signal, cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally { clearTimeout(t); }
  }

  function fromLongdo(list) {
    const since = Date.now() - 12 * 36e5;
    return list.filter((e) => {
      const txt = `${e.title || ""} ${e.description || ""}`;
      if (!LONGDO_TYPES.has(String(e.type)) && e.icon !== "flood") return false;
      if ((String(e.type) === "18" || String(e.type) === "5") && !/น้ำ|ท่วม|flood/i.test(txt)) return false;
      const st = parseTime(e.start);
      return !st || st.getTime() >= since;
    }).map((e) => ({
      id: `ld${e.eid}`, src: "longdo", type: e.icon || String(e.type), title: e.title || "",
      desc: (e.description || "").replace(/\s+/g, " ").trim(), lat: Number(e.latitude), lng: Number(e.longitude),
      start: e.start, by: e.contributor || "", img: Array.isArray(e.images) ? e.images.slice(0, 3) : [],
    })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
  }

  async function loadBma() {
    const base = "https://floodbangkok.bangkok.go.th/bkk/dds/services/api/floods/v1/items/";
    const [prof, notif] = await Promise.all([
      getJsonTimeout(base + "sensor_profile?limit=-1&fields=id,code,name,road,district,lat,long"),
      getJsonTimeout(base + "flood_notification?limit=600&sort=-date_created&fields=sensor_profile,value,date_created&filter[date_created][_gte]=" + encodeURIComponent("$NOW(-3 hours)")),
    ]);
    const latest = new Map();
    for (const n of notif.data || []) if (!latest.has(n.sensor_profile)) latest.set(n.sensor_profile, n);
    const out = [];
    for (const p of prof.data || []) {
      const n = latest.get(p.id);
      const cm = n ? Number(n.value) : NaN;
      if (!Number.isFinite(cm) || cm < 5) continue; // below 5 cm = normal
      out.push({
        id: `bma${p.id}`, src: "bma", type: "sensor", title: `เซ็นเซอร์ กทม. ${p.name || p.code || ""}`.trim(),
        desc: [p.road && `ถ.${p.road}`, p.district && `เขต${p.district}`].filter(Boolean).join(" "),
        lat: Number(p.lat), lng: Number(p.long), start: n.date_created, depth: cm, amp: p.district || "", prov: "กรุงเทพมหานคร", img: [],
      });
    }
    return out.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
  }

  async function loadTraffy() {
    const j = await getJsonTimeout("https://publicapi.traffy.in.th/share/teamchadchart/search?limit=500", 15000);
    const rows = Array.isArray(j) ? j : j.results || j.data || [];
    const since = Date.now() - 12 * 36e5;
    return rows.filter((r) => {
      const txt = `${[].concat(r.problem_type_abdul || r.type || []).join(" ")} ${r.description || ""}`;
      const t = parseTime(r.timestamp);
      return FLOOD_TXT.test(txt) && !/ประปา|ท่อแตก|น้ำไม่ไหล/.test(txt) && (!t || t.getTime() >= since) && !/เสร็จสิ้น|finish/i.test(r.state || "");
    }).map((r) => ({
      id: `tf${r.ticket_id}`, src: "traffy", type: "report", title: "รายงานจากประชาชน (Traffy Fondue)",
      desc: `${r.description || ""} ${r.address ? `· ${r.address}` : ""}`.trim(),
      lat: Number(r.coords?.[1]), lng: Number(r.coords?.[0]), start: r.timestamp, img: [r.photo_url || r.photo].filter(Boolean),
    })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
  }

  async function loadRoads(cached) {
    let longdo = [];
    try { longdo = fromLongdo(await getJsonTimeout("https://event.longdo.com/feed/json")); roadSrc.longdo = { ok: true, live: true }; }
    catch { longdo = cached?.reports || []; roadSrc.longdo = { ok: !!longdo.length, live: false, at: cached?.updated }; }
    roads = longdo;
    roadsChanged();
    // Thai-network-only sources, merged in when they answer.
    // BMA road sensors would slot in here too, but their API sends no CORS
    // headers, so browsers block every site but the BMA's own (loadBma is kept
    // for when that changes).
    for (const [key, fn] of [["traffy", loadTraffy]]) {
      fn().then((list) => { roadSrc[key] = { ok: true, n: list.length }; roads = roads.filter((r) => r.src !== key).concat(list); roadsChanged(); })
        .catch(() => { roadSrc[key] = { ok: false }; roadsChanged(); });
    }
  }

  // Depth (cm) and passability from the report itself.
  const BODY_CM = [[/ข้อเท้า/, 15], [/ครึ่งล้อ/, 25], [/หน้าแข้ง/, 30], [/เข่า/, 50], [/ต้นขา/, 70], [/เอว/, 90], [/หน้าอก|ระดับอก/, 120]];
  function roadStatus(r) {
    const t = `${r.title} ${r.desc}`;
    let depth = r.depth ?? null, approx = false;
    if (depth == null) {
      const m = t.match(/(\d{1,3})\s*(?:ซม|เซน|cm)/i);
      if (m) depth = Number(m[1]);
      else { const b = BODY_CM.find(([re]) => re.test(t)); if (b) { depth = b[1]; approx = true; } }
    }
    let level, label;
    if (/น้ำลด(ลง)?แล้ว|ระบาย(เสร็จ|ได้)แล้ว|แห้งแล้ว|สัญจรได้(ตาม)?ปกติ/.test(t)) [level, label] = [0, "น้ำลดแล้ว"];
    else if (/รถเล็ก\S{0,6}(ไม่(ควร|แนะนำ|สามารถ)|ผ่านไม่ได้|หลีกเลี่ยง|งด)|เฉพาะรถ(ใหญ่|สูง)|รถ(กระบะ|สูง)\S{0,10}(ลุย|ผ่าน)(ได้|ไหว)/.test(t)) [level, label] = [2, "รถเล็กไม่ควรผ่าน"];
    else if (r.type === "roadclosed" || /ผ่านไม่ได้|ไม่สามารถ(สัญจร|ผ่าน)|ปิด(การจราจร|ถนน|เส้นทาง)|งดใช้เส้นทาง/.test(t)) [level, label] = [3, "ผ่านไม่ได้"];
    else if (/ผ่านได้|สัญจรได้|ขับ(ขี่)?(ช้า|ด้วยความระมัดระวัง)|ใช้ความระมัดระวัง/.test(t)) [level, label] = [1, "ผ่านได้ ขับช้า"];
    else if (depth != null) [level, label] = depth >= 50 ? [3, "ผ่านไม่ได้"] : depth >= 25 ? [2, "รถเล็กไม่ควรผ่าน"] : [1, depth >= 10 ? "ผ่านได้ ขับช้า" : "น้ำขังเล็กน้อย"];
    else [level, label] = [1, "น้ำท่วมขัง (ไม่ระบุความลึก)"];
    const cls = ["s3", "s2", "s4", "s5"][level];
    return { level, label, cls, depth, approx };
  }

  // Which amphoe/district a report belongs to: from its own text first, else
  // the nearest rain gauge's amphoe (marked approximate).
  function roadPlace(r) {
    if (r._place) return r._place;
    const t = r.desc || "";
    let amp = r.amp || (t.match(/อ(?:ำเภอ|\.)\s*([^\s,()]+)/) || [])[1] || "";
    let prov = r.prov || (t.match(/จ(?:ังหวัด|\.)\s*([^\s,()]+)/) || [])[1] || "";
    const tam = (t.match(/(?:ต(?:ำบล|\.)|แขวง)\s*([^\s,()]+)/) || [])[1] || "";
    const khet = (t.match(/เขต\s*([^\s,()]+)/) || [])[1];
    if (!amp && khet) { amp = khet; prov = prov || "กรุงเทพมหานคร"; }
    if (/กทม|กรุงเทพ/.test(t) && !prov) prov = "กรุงเทพมหานคร";
    let approx = false;
    if (!amp || !prov) {
      let best = null, bd = 15;
      for (const g of gauges) { const d = km(r, g); if (d < bd) { bd = d; best = g; } }
      if (best) { amp = amp || best.amp; prov = prov || best.prov; approx = true; }
    }
    prov = prov.replace(/^จ\./, "");
    r._place = { amp: amp || "ไม่ระบุ", prov: prov || "ไม่ระบุจังหวัด", tam, approx };
    return r._place;
  }

  const SRC_LABEL = { longdo: "Longdo Traffic", bma: "เซ็นเซอร์ กทม.", traffy: "Traffy Fondue" };

  function roadCard(r, withDist) {
    const st = roadStatus(r);
    const pl = roadPlace(r);
    const credit = (r.desc.match(/Cr\.?\s*([^\s]+)/i) || [])[1];
    return `<li class="${st.cls} road">
      <div class="row"><span class="name">${esc(r.title)}</span><span class="badge ${st.cls}">${st.label}</span></div>
      ${st.depth != null ? `<div class="small"><b>ระดับน้ำ ${st.approx ? "~" : ""}${Math.round(st.depth)} ซม.</b>${st.approx ? " (ประเมินจากคำบรรยาย)" : ""}</div>` : ""}
      <div class="small">${esc(r.desc.replace(/Cr\.?\s*\S+/i, "").trim())}</div>
      ${r.img?.length ? `<div class="photos">${r.img.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" loading="lazy" alt="รูปจากผู้รายงาน"></a>`).join("")}</div>` : ""}
      <div class="small muted">${pl.tam ? `ต./แขวง${esc(pl.tam)} ` : ""}อ./เขต${esc(pl.amp)} จ.${esc(pl.prov)}${pl.approx ? " (โดยประมาณ)" : ""}
        ${withDist && r.dist != null ? ` · ห่าง ${r.dist.toFixed(1)} กม.` : ""} · ${fmtTime(r.start)} · ${SRC_LABEL[r.src] || r.src}${credit ? ` (Cr. ${esc(credit)})` : ""}
        · <a href="${trafficLink(r.lat, r.lng, 16)}" target="_blank" rel="noopener">🚦 จราจรตรงนี้</a></div>
    </li>`;
  }

  function sourceStatus() {
    const s = [];
    s.push(roadSrc.longdo ? (roadSrc.longdo.live ? "Longdo สด ✓" : roadSrc.longdo.ok ? `Longdo (สำรอง ${fmtTime(roadSrc.longdo.at)})` : "Longdo ✗") : "Longdo …");
    if (roadSrc.bma) s.push(roadSrc.bma.ok ? `เซ็นเซอร์ กทม. ✓ (${roadSrc.bma.n})` : "เซ็นเซอร์ กทม. ✗");
    s.push(roadSrc.traffy ? (roadSrc.traffy.ok ? `Traffy ✓ (${roadSrc.traffy.n})` : "Traffy ✗ (ระบบไม่ตอบสนอง)") : "Traffy กำลังโหลด…");
    return s.join(" · ");
  }

  // ---------- district (amphoe) overview ----------
  function renderDistricts() {
    const el = $("districts");
    if (!el) return;
    const byProv = new Map();
    for (const r of roads) {
      const st = roadStatus(r);
      if (st.level === 0) continue;
      const { prov, amp } = roadPlace(r);
      if (!byProv.has(prov)) byProv.set(prov, new Map());
      const m = byProv.get(prov);
      if (!m.has(amp)) m.set(amp, []);
      m.get(amp).push(r);
    }
    const provs = [...byProv.entries()].map(([p, m]) => [p, [...m.values()].reduce((a, l) => a + l.length, 0)]).sort((a, b) => b[1] - a[1]);
    const sel = store.get("dist-prov");
    const cur = provs.some(([p]) => p === sel) ? sel : provs[0]?.[0];
    el.innerHTML = `<div class="card">
      <h2>📋 น้ำท่วมถนนรายอำเภอ ตอนนี้</h2>
      <p class="small muted">${roads.length ? `${roads.length} รายงานใน 12 ชม. ล่าสุด · ` : ""}${sourceStatus()}</p>
      ${provs.length ? `<select id="dist-prov" aria-label="เลือกจังหวัด">${provs.map(([p, n]) => `<option value="${esc(p)}"${p === cur ? " selected" : ""}>${esc(p)} (${n})</option>`).join("")}</select>
      <table class="dist"><thead><tr><th>อำเภอ/เขต</th><th title="ผ่านไม่ได้">⛔</th><th title="รถเล็กไม่ควรผ่าน">🚙</th><th title="ผ่านได้/ขับช้า">⚠️</th><th>ลึกสุด</th></tr></thead><tbody>
      ${[...(byProv.get(cur) || new Map()).entries()].map(([amp, list]) => {
        const sts = list.map(roadStatus);
        const c = (lv) => sts.filter((x) => x.level === lv).length;
        const deep = Math.max(-1, ...sts.map((x) => x.depth ?? -1));
        return [amp, list, c(3), c(2), c(1), deep];
      }).sort((a, b) => b[2] - a[2] || b[3] - a[3] || b[1].length - a[1].length).map(([amp, list, n3, n2, n1, deep]) =>
        `<tr data-amp="${esc(amp)}"><td><a href="#">${esc(amp)}</a></td><td class="${n3 ? "c5" : ""}">${n3 || "-"}</td><td class="${n2 ? "c4" : ""}">${n2 || "-"}</td><td>${n1 || "-"}</td><td>${deep >= 0 ? Math.round(deep) + " ซม." : "-"}</td></tr>
         <tr class="dist-detail" hidden><td colspan="5"><ul class="list">${list.sort((a, b) => roadStatus(b).level - roadStatus(a).level).map((r) => roadCard(r, false)).join("")}</ul>
           <button class="btn wide" data-area="${list[0].lat},${list[0].lng},${esc(amp)}">🗺️ ดูพื้นที่นี้บนแผนที่ + ความเสี่ยง</button></td></tr>`).join("")}
      </tbody></table>` : `<p class="small">ยังไม่มีรายงานน้ำท่วมถนนใน 12 ชม. ล่าสุด</p>`}
    </div>`;
    $("dist-prov")?.addEventListener("change", (e) => { store.set("dist-prov", e.target.value); renderDistricts(); });
    el.querySelectorAll("tr[data-amp] a").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      const tr = a.closest("tr").nextElementSibling;
      tr.hidden = !tr.hidden;
    }));
    el.querySelectorAll("[data-area]").forEach((b) => b.addEventListener("click", () => {
      const [lat, lng, ...name] = b.dataset.area.split(",");
      openArea({ lat: +lat, lng: +lng, km: 5, name: name.join(",") });
      $("route-area").scrollIntoView({ behavior: "smooth" });
    }));
  }

  let roadsTimer = null;
  function roadsChanged() {
    // Several sources land at different times; redraw once they settle.
    clearTimeout(roadsTimer);
    roadsTimer = setTimeout(() => {
      renderDistricts();
      if (routeArea) openArea(routeArea, true);
      if (map) drawMarkers();
    }, 200);
  }

  // ---------- route: flood risk around a place ----------
  // Everything shown here comes from live data (ThaiWater stations, rain
  // gauges, Open-Meteo forecast). The risk score is a transparent sum of those
  // inputs, listed under it; it estimates risk, it does not confirm flooding.
  const ROUTE_KEY = "route-area";
  let routeMap = null, routeLayer = null, routeArea = null;

  const trafficLink = (lat, lng, z = 15) => `https://www.google.com/maps/@${lat},${lng},${z}z/data=!5m1!1e1`;

  function riskScore(area, near) {
    const parts = [];
    const sts = near.roads.map(roadStatus);
    const n3 = sts.filter((x) => x.level === 3).length, n2 = sts.filter((x) => x.level === 2).length, n1 = sts.filter((x) => x.level === 1).length;
    const roadPts = Math.min(40, n3 * 20 + n2 * 12 + n1 * 5);
    parts.push([roadPts, near.roads.length ? `รายงานน้ำท่วมถนนในพื้นที่: ผ่านไม่ได้ ${n3} · รถเล็กไม่ควรผ่าน ${n2} · ขับช้า/ขัง ${n1}` : "ไม่มีรายงานน้ำท่วมถนนในพื้นที่ (12 ชม.)"]);
    const maxR24 = Math.max(0, ...near.gauges.map((g) => g.r24 ?? 0));
    const maxR1 = Math.max(0, ...near.gauges.map((g) => g.r1 ?? 0));
    const rainPts = Math.min(35, (maxR24 / 90) * 35);
    parts.push([rainPts, `ฝนสะสม 24 ชม. สูงสุดในพื้นที่ ${maxR24.toFixed(1)} มม.${maxR1 ? ` (ชั่วโมงล่าสุด ${maxR1.toFixed(1)} มม.)` : ""}`]);
    const mm6 = area.fc ? area.fc.hours.slice(0, 6).reduce((a, h) => a + h.mm, 0) : null;
    const fcPts = mm6 == null ? 0 : Math.min(25, (mm6 / 35) * 25);
    parts.push([fcPts, mm6 == null ? "พยากรณ์ฝน 6 ชม.: โหลดไม่ได้" : `พยากรณ์ฝน 6 ชม. ข้างหน้า ${mm6.toFixed(1)} มม.`]);
    const worst = near.stations.reduce((w, s) => (!w || statusOf(s).rank > statusOf(w).rank ? s : w), null);
    let wlPts = 0, wlTxt = "ไม่มีสถานีวัดระดับน้ำในรัศมี 10 กม.";
    if (worst) {
      const r = statusOf(worst).rank; // s5 = 5, s4 = 4 ...
      wlPts = r >= 5 ? 30 : r === 4 ? 18 : r === 3 ? 5 : 0;
      const up = near.stations.filter(isRising).length;
      if (up) wlPts = Math.min(40, wlPts + 10);
      wlTxt = `แม่น้ำ/คลองใกล้เคียง: ${statusOf(worst).label} ที่ ${esc(worst.name)}${up ? ` · น้ำกำลังขึ้น ${up} สถานี` : ""}`;
    }
    parts.push([wlPts, wlTxt]);
    const score = Math.min(100, Math.round(parts.reduce((a, [p]) => a + p, 0)));
    const level = score >= 70 ? ["สูงมาก", "s5"] : score >= 45 ? ["สูง", "s4"] : score >= 20 ? ["ปานกลาง", "s2"] : ["ต่ำ", "s3"];
    return { score, level, parts };
  }

  async function openArea(area, quiet = false) {
    routeArea = area;
    store.set(ROUTE_KEY, JSON.stringify(area));
    history.replaceState(null, "", `#r=${area.lat.toFixed(5)},${area.lng.toFixed(5)},${area.km},${encodeURIComponent(area.name)}`);
    $("route-results").innerHTML = "";
    const el = $("route-area");
    if (!quiet) el.innerHTML = `<div class="card small muted">กำลังรวบรวมข้อมูลพื้นที่ ${esc(area.name)}…</div>`;

    const near = {
      gauges: gauges.map((g) => ({ ...g, dist: km(area, g) })).filter((g) => g.dist <= area.km + 5)
        .sort((a, b) => (b.r1 ?? -1) - (a.r1 ?? -1) || b.r24 - a.r24),
      roads: roads.map((r) => Object.assign(r, { dist: km(area, r) })).filter((r) => r.dist <= area.km)
        .sort((a, b) => roadStatus(b).level - roadStatus(a).level || a.dist - b.dist),
      stations: stations.map((s) => ({ ...s, dist: km(area, s) })).filter((s) => s.dist <= 10)
        .sort((a, b) => statusOf(b).rank - statusOf(a).rank || a.dist - b.dist),
    };
    if (!area.fc) { try { area.fc = await rainForecast(area.lat, area.lng); } catch { area.fc = null; } }
    if (routeArea !== area) return;
    const risk = riskScore(area, near);
    const heavy = near.gauges.filter((g) => (g.r1 ?? 0) >= 10 || g.r24 >= 35);

    el.innerHTML = `
      <div class="card">
        <div class="row"><h2>📍 ${esc(area.name)}</h2><span class="muted small">รัศมี ${area.km} กม.</span></div>
        <div class="risk ${risk.level[1]}"><b>${risk.score}</b><span>คะแนนโอกาสน้ำท่วม<br><b>${risk.level[0]}</b></span></div>
        <ul class="small risk-parts">${risk.parts.map(([p, t]) => `<li><b>+${Math.round(p)}</b> ${t}</li>`).join("")}</ul>
        <p class="small muted">คะแนนรวมจากข้อมูลจริงข้างต้น (รายงานน้ำท่วมถนน ฝนจริง ฝนพยากรณ์ ระดับน้ำ) สูงสุด 100</p>
        ${area.fc ? `<div class="rain-now ${rainVerdict(area.fc)[1]}">${rainVerdict(area.fc)[0]}</div>` : ""}
        <div class="btn-row two">
          <a class="btn primary" href="${trafficLink(area.lat, area.lng, area.km > 4 ? 13 : 14)}" target="_blank" rel="noopener">🚦 ดูจราจร Google Maps</a>
          <button class="btn" id="route-share">🔗 แชร์ลิงก์พื้นที่นี้</button>
        </div>
      </div>
      <div id="route-map"></div>
      <div class="card">
        <h2>🚗 ถนนน้ำท่วมตอนนี้ (${near.roads.length})</h2>
        <p class="small muted">${sourceStatus()}</p>
        <ul class="list">${near.roads.slice(0, 30).map((r) => roadCard(r, true)).join("") || `<li class="s3 small">ไม่มีรายงานน้ำท่วมถนนในรัศมี ${area.km} กม. ใน 12 ชม. ล่าสุด</li>`}</ul>
      </div>
      <div class="card">
        <h2>🌧️ ฝนตกหนักตรงไหน</h2>
        ${heavy.length ? "" : `<p class="small">ไม่มีสถานีวัดฝนในพื้นที่ที่ฝนหนัก (≥10 มม./ชม. หรือ ≥35 มม./24 ชม.)</p>`}
        <ul class="list">${(heavy.length ? heavy : near.gauges.slice(0, 5)).slice(0, 10).map((g) => `
          <li class="${(g.r1 ?? 0) >= 10 || g.r24 >= 35 ? "s5" : g.r24 >= 10 ? "s4" : "s3"}">
            <div class="row"><span class="name">${esc(g.name)}</span><span class="small">${g.dist.toFixed(1)} กม.</span></div>
            <div class="small">${g.r1 != null ? `ชั่วโมงล่าสุด <b>${g.r1} มม.</b> · ` : ""}24 ชม. <b>${g.r24} มม.</b> (${rain24Label(g.r24)[0]})</div>
            <div class="small muted">ต.${esc(g.tam)} อ.${esc(g.amp)} จ.${esc(g.prov)} · ${fmtTime(g.t)} ·
              <a href="${trafficLink(g.lat, g.lng)}" target="_blank" rel="noopener">🚦 จราจรตรงนี้</a></div>
          </li>`).join("") || `<li class="s0 small">ไม่มีสถานีวัดฝนในรัศมี ${area.km + 5} กม.</li>`}</ul>
      </div>
      <div class="card">
        <h2>💧 แม่น้ำ/คลองใกล้เคียง (10 กม.)</h2>
        <ul class="list">${near.stations.slice(0, 8).map((s) => `
          <li class="${statusOf(s).cls}">
            <div class="row"><span class="name">${esc(s.name)}</span><span class="badge ${statusOf(s).cls}">${statusOf(s).label}</span></div>
            <div class="small">${s.pct != null ? `${s.pct.toFixed(0)}% ของตลิ่ง · ` : ""}${s.dist.toFixed(1)} กม. ${trendHtml(s)}</div>
            <div class="small muted">${fmtTime(s.t)} · <a href="${trafficLink(s.lat, s.lng)}" target="_blank" rel="noopener">🚦 จราจรตรงนี้</a></div>
          </li>`).join("") || `<li class="s0 small">ไม่มีสถานีวัดระดับน้ำในรัศมี 10 กม.</li>`}</ul>
      </div>
      <div class="card small">
        <b>เช็กเพิ่มเติม:</b> ทางหลวง <a href="tel:1586">1586</a> · ทางหลวงชนบท <a href="tel:1146">1146</a> ·
        <a href="https://share.traffy.in.th/teamchadchart" target="_blank" rel="noopener">Traffy Fondue</a> ·
        <a href="${trafficLink(area.lat, area.lng, 14)}" target="_blank" rel="noopener">Google Maps จราจร</a>
      </div>`;

    $("route-share").addEventListener("click", async () => {
      const url = location.href;
      const text = `เช็กความเสี่ยงน้ำท่วม ${area.name}`;
      if (navigator.share) { try { await navigator.share({ title: text, url }); return; } catch (e) { if (e.name === "AbortError") return; } }
      try { await navigator.clipboard.writeText(url); alert("คัดลอกลิงก์แล้ว เปิดลิงก์นี้จะเห็นพื้นที่นี้ทันที"); } catch { prompt("คัดลอกลิงก์นี้", url); }
    });
    drawRouteMap(area, near);
  }

  function roadMarker(r) {
    const st = roadStatus(r);
    const icon = ["✅", "⚠️", "🚙", "⛔"][st.level];
    return L.marker([r.lat, r.lng], {
      icon: L.divIcon({ className: "road-pin", html: `<span class="${st.cls}">${icon}${st.depth != null ? ` ${Math.round(st.depth)}` : ""}</span>`, iconSize: null }),
      zIndexOffset: 1000 + st.level * 100,
    }).bindPopup(`<ul class="list pop-list">${roadCard(r, false)}</ul>`, { maxWidth: 300 });
  }

  function drawRouteMap(area, near) {
    if (!window.L) return;
    if (routeMap) { routeMap.remove(); routeMap = null; }
    // Fit the view before adding layers: a circle has no bounds until the map has one.
    routeMap = L.map("route-map", { preferCanvas: true })
      .fitBounds(L.latLng(area.lat, area.lng).toBounds(area.km * 2000), { padding: [10, 10] });
    addBaseLayer(routeMap);
    routeLayer = L.layerGroup().addTo(routeMap);
    L.circle([area.lat, area.lng], { radius: area.km * 1000, color: "#0b5cab", weight: 2, fillOpacity: 0.05 }).addTo(routeLayer);
    near.gauges.forEach((g) => {
      const heavy = (g.r1 ?? 0) >= 10 || g.r24 >= 35;
      L.marker([g.lat, g.lng], {
        icon: L.divIcon({ className: "rain-pin", html: `<span class="${heavy ? "heavy" : g.r24 >= 10 ? "mid" : ""}">🌧 ${g.r1 != null ? g.r1 : g.r24}</span>`, iconSize: null }),
      }).bindPopup(`<div class="pop"><b>🌧️ ${esc(g.name)}</b><br>${g.r1 != null ? `ชั่วโมงล่าสุด ${g.r1} มม.<br>` : ""}24 ชม. ${g.r24} มม.<br>` +
        `<a href="${trafficLink(g.lat, g.lng)}" target="_blank" rel="noopener">🚦 จราจรตรงนี้</a></div>`).addTo(routeLayer);
    });
    near.stations.forEach((s) => {
      L.circleMarker([s.lat, s.lng], { radius: 8, weight: 2, color: "#fff", fillColor: cssColor(statusOf(s).cls), fillOpacity: 0.95 })
        .bindPopup(stationPopup(s)).addTo(routeLayer);
    });
    near.roads.forEach((r) => roadMarker(r).addTo(routeLayer));
  }

  async function searchPlace(q) {
    const list = $("route-results");
    list.innerHTML = `<li class="muted small">กำลังค้นหา…</li>`;
    try {
      const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=th&accept-language=th&limit=6&q=" + encodeURIComponent(q);
      const res = await fetch(url);
      const found = res.ok ? await res.json() : [];
      if (!found.length) { list.innerHTML = `<li class="muted small">ไม่พบ "${esc(q)}" ลองพิมพ์ชื่อเขต อำเภอ หรือถนนอีกแบบ</li>`; return; }
      list.innerHTML = found.map((f, i) => `<li><button data-i="${i}">${esc(f.display_name)}</button></li>`).join("");
      list.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
        const f = found[Number(b.dataset.i)];
        const [s0, n0, w0, e0] = (f.boundingbox || []).map(Number);
        // Size the circle to the place: a district gets its extent, a road or point 3 km.
        let radius = 3;
        if (f.category !== "highway" && [s0, n0, w0, e0].every(Number.isFinite)) {
          radius = Math.round(Math.min(10, Math.max(2, km({ lat: s0, lng: w0 }, { lat: n0, lng: e0 }) / 2)));
        }
        openArea({ lat: Number(f.lat), lng: Number(f.lon), km: radius, name: q.trim() || f.display_name.split(",")[0] });
      }));
    } catch {
      list.innerHTML = `<li class="muted small">ค้นหาไม่ได้ (ไม่มีสัญญาณ?)</li>`;
    }
  }

  $("route-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("route-q").value.trim();
    if (q) searchPlace(q);
  });
  $("route-near").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = "กำลังหาตำแหน่ง…";
    try { const p = await locate(); render(); openArea({ lat: p.lat, lng: p.lng, km: 3, name: "รอบตัวฉัน" }); }
    catch (err) { alert(err.message); }
    btn.disabled = false; btn.textContent = "📍 ใกล้ฉัน (รัศมี 3 กม.)";
  });

  // Shared links (#r=lat,lng,km,name) open straight into that area; otherwise
  // the last area this person looked at is remembered.
  function initialArea() {
    const m = location.hash.match(/^#r=(-?[\d.]+),(-?[\d.]+),(\d+),(.*)$/);
    if (m) return { area: { lat: +m[1], lng: +m[2], km: +m[3], name: decodeURIComponent(m[4]) || "พื้นที่ที่แชร์" }, shared: true };
    try { const a = JSON.parse(store.get(ROUTE_KEY) || "null"); if (a) return { area: a, shared: false }; } catch { /* ignore */ }
    return null;
  }

  // ---------- tabs ----------
  function showTab(name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    if (name === "map") { initMap(); setTimeout(() => map && map.invalidateSize(), 50); }
    if (name === "route") {
      if (!routeArea) { const init = initialArea(); if (init) openArea(init.area); }
      else if (routeMap) setTimeout(() => routeMap.invalidateSize(), 50);
    }
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
