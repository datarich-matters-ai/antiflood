(() => {
  "use strict";
  const CFG = window.APP_CONFIG || {};
  const DATA_URL = "data/waterlevel.json";
  const NEAR_KM = 20; // stations within this radius drive the summary alert

  // Same bands as ThaiWater's "% ความจุลำน้ำ" legend.
  const STATUS = [
    { cls: "s5", label: "ล้นตลิ่ง", min: 100 },
    { cls: "s4", label: "น้ำมาก", min: 70 },
    { cls: "s3", label: "ปกติ", min: 30 },
    { cls: "s2", label: "น้ำน้อย", min: 10 },
    { cls: "s1", label: "น้ำน้อยวิกฤต", min: -Infinity },
  ];
  const NO_DATA = { cls: "s0", label: "ไม่มีข้อมูล", rank: 0 };
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
  let myPos = null; // {lat, lng}
  let map, markerLayer, meMarker;

  function statusOf(st) {
    if (st.pct == null) return NO_DATA;
    return STATUS.find((s) => st.pct >= s.min);
  }

  function km(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  function fmtTime(iso) {
    if (!iso) return "-";
    const d = new Date(iso.replace(" ", "T"));
    if (isNaN(d)) return iso;
    return d.toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  function ageHours(iso) {
    const d = new Date(String(iso || "").replace(" ", "T"));
    return isNaN(d) ? Infinity : (Date.now() - d) / 36e5;
  }

  // ---------- data ----------
  async function load() {
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
    fillProvinces();
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
        .sort((a, b) => statusOf(b).rank - statusOf(a).rank || (b.pct ?? -1) - (a.pct ?? -1));
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
        <div class="bar" style="color:var(--${st.cls})"><i style="width:${Math.min(100, Math.max(0, s.pct ?? 0))}%"></i></div>
        <div class="small muted">วัดเมื่อ ${fmtTime(s.t)}${stale ? " ⚠️ ข้อมูลเก่า" : ""}
          · <a href="#" data-goto="${s.lat},${s.lng}">ดูบนแผนที่</a></div>
      </li>`;
    }).join("");

    renderProvHotlines(prov);
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
    el.innerHTML = `<div class="alert ${st.cls}">${counts}<p>${ADVICE[st.cls] || "ติดตามข้อมูลต่อเนื่อง"}</p></div>`;
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

  $("list").addEventListener("click", (e) => {
    const a = e.target.closest("[data-goto]");
    if (!a) return;
    e.preventDefault();
    const [lat, lng] = a.dataset.goto.split(",").map(Number);
    showTab("map");
    map.setView([lat, lng], 13);
  });

  // ---------- map ----------
  function initMap() {
    if (map || !window.L) return;
    map = L.map("map", { preferCanvas: true }).setView([13.5, 100.8], 6);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18, attribution: "&copy; OpenStreetMap · ข้อมูลน้ำ ThaiWater",
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    const color = (cls) => getComputedStyle(document.documentElement).getPropertyValue("--" + cls).trim();
    // Draw calmer stations first so critical ones sit on top.
    [...stations].sort((a, b) => statusOf(a).rank - statusOf(b).rank).forEach((s) => {
      const st = statusOf(s);
      L.circleMarker([s.lat, s.lng], {
        radius: st.rank >= 4 ? 8 : 5, weight: 1, color: "#fff", fillColor: color(st.cls), fillOpacity: 0.9,
      }).bindPopup(
        `<b>${esc(s.name)}</b><br>อ.${esc(s.amp)} จ.${esc(s.prov)}<br>` +
        `<b>${st.label}</b>${s.pct != null ? ` (${s.pct.toFixed(0)}% ของตลิ่ง)` : ""}<br>` +
        `ระดับน้ำ ${s.wl ?? "-"} ม.รทก. · ตลิ่ง ${s.bank ?? "-"} ม.รทก.<br>` +
        `<span style="color:#666">วัดเมื่อ ${fmtTime(s.t)}</span>`
      ).addTo(markerLayer);
    });
    if (myPos) showMe();
  }

  function showMe() {
    if (!myPos) return;
    if (meMarker) meMarker.remove();
    meMarker = L.marker([myPos.lat, myPos.lng]).addTo(map).bindPopup("ตำแหน่งของคุณ");
    map.setView([myPos.lat, myPos.lng], 11);
  }

  // ---------- tabs ----------
  function showTab(name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    if (name === "map") { initMap(); setTimeout(() => map && map.invalidateSize(), 50); }
    if (name === "sos") updateSos();
    window.scrollTo(0, 0);
  }
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

  // ---------- SOS ----------
  const SOS_FIELDS = ["sos-people", "sos-vuln", "sos-need", "sos-phone", "sos-note"];

  function sosText() {
    const v = (id) => $(id).value.trim();
    const lines = ["🆘 ขอความช่วยเหลือ น้ำท่วม"];
    if (myPos) {
      lines.push(`📍 พิกัด: https://maps.google.com/?q=${myPos.lat.toFixed(6)},${myPos.lng.toFixed(6)}`);
    }
    if (v("sos-people")) lines.push(`👥 จำนวนคน: ${v("sos-people")}`);
    if (v("sos-vuln")) lines.push(`♿ กลุ่มเปราะบาง: ${v("sos-vuln")}`);
    if (v("sos-need")) lines.push(`📦 ต้องการ: ${v("sos-need")}`);
    if (v("sos-phone")) lines.push(`📞 ติดต่อ: ${v("sos-phone")}`);
    if (v("sos-note")) lines.push(`📝 ${v("sos-note")}`);
    lines.push(`🕒 ${new Date().toLocaleString("th-TH")}`);
    return lines.join("\n");
  }

  function updateSos() {
    $("sos-loc").textContent = myPos
      ? `📍 พิกัด ${myPos.lat.toFixed(5)}, ${myPos.lng.toFixed(5)}${myPos.acc ? ` (คลาดเคลื่อน ±${Math.round(myPos.acc)} ม.)` : ""}`
      : "ยังไม่ได้ระบุพิกัด (กดปุ่มด้านล่าง)";
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

  $("sos-getloc").addEventListener("click", async () => {
    $("sos-loc").textContent = "กำลังหาตำแหน่ง…";
    try { await locate(); render(); } catch (err) { alert(err.message); }
    updateSos();
  });

  $("sos-share").addEventListener("click", async () => {
    if (!myPos) {
      try { await locate(); render(); } catch { /* send without location rather than block */ }
      updateSos();
    }
    const text = sosText();
    if (navigator.share) {
      try { await navigator.share({ text }); return; } catch (e) { if (e.name === "AbortError") return; }
    }
    window.open("https://line.me/R/share?text=" + encodeURIComponent(text), "_blank");
  });

  $("sos-copy").addEventListener("click", async () => {
    const text = sosText();
    try { await navigator.clipboard.writeText(text); alert("คัดลอกแล้ว วางในแชทกลุ่มหรือโพสต์ได้เลย"); }
    catch { prompt("คัดลอกข้อความนี้", text); }
  });

  // ---------- static content ----------
  $("hotlines").innerHTML = hotlineHtml(CFG.hotlines || []);
  $("links").innerHTML = (CFG.links || []).map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name)}</a></li>`).join("");

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW", e));
  }

  load();
  updateSos();
})();
