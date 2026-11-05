/* FollowUp Vaseo – administratie RF-naalden */
(() => {
  "use strict";

  const Core = window.FollowUpCore;
  const { STATUS, STAGES, ACT_TYPES, AGE_GROUPS, REGIONS } = Core;
  const LOST_REASONS = ["Prijs", "Concurrent", "Geen budget", "Te weinig volume", "Geen interesse arts", "Andere"];
  const PRODUCTS = ["Thyroid", "Fibroid"];
  // Gegevens per procedure, zonder patiëntnamen of -nummers en met leeftijdsklasse i.p.v. exacte leeftijd. Volume = L × B × H × 0,524 (ellipsoïde).
  const PROC_FIELDS = [
    { key: "side", label: "Locatie", product: "Thyroid", options: ["Rechts", "Links", "Isthmus"] },
    { key: "noduleType", label: "Type nodule", product: "Thyroid", options: ["Solide", "Overwegend solide", "Gemengd", "Overwegend cystisch", "Cystisch"] },
    { key: "tirads", label: "TI-RADS", product: "Thyroid", options: ["1", "2", "3", "4", "5"] },
    { key: "bethesda", label: "Bethesda", product: "Thyroid", options: ["I", "II", "III", "IV", "V", "VI"] },
    { key: "indication", label: "Indicatie", product: "Thyroid", options: ["Symptomatisch", "Cosmetisch", "Autonoom (hot)", "Recidief", "Andere"] },
    { key: "figo", label: "FIGO-type", product: "Fibroid", options: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "2-5"] },
    { key: "fibroidCount", label: "Aantal myomen", product: "Fibroid", type: "number" },
    { key: "approach", label: "Benadering", product: "Fibroid", options: ["Transvaginaal", "Transcervicaal", "Laparoscopisch", "Percutaan"] },
    { key: "symptoms", label: "Klachten", product: "Fibroid", options: ["Bloedingen", "Druk / pijn", "Fertiliteit", "Combinatie", "Andere"] },
    { key: "length", label: "Lengte (mm)", type: "number", step: "0.1" },
    { key: "width", label: "Breedte (mm)", type: "number", step: "0.1" },
    { key: "depth", label: "Diepte (mm)", type: "number", step: "0.1" },
    { key: "volume", label: "Volume (ml)", type: "number", step: "0.01" },
    { key: "needle", label: "Naald / elektrode", placeholder: "bv. 18G, 10 mm tip" },
    { key: "needlesUsed", label: "Naalden gebruikt", type: "number" },
    { key: "power", label: "Vermogen (W)", type: "number" },
    { key: "duration", label: "Ablatietijd (s)", type: "number" },
    { key: "energy", label: "Energie (kJ)", type: "number", step: "0.01" },
    { key: "anesthesia", label: "Verdoving", options: ["Lokaal", "Sedatie", "Algemeen"] },
    { key: "complication", label: "Complicaties", options: ["Geen", "Licht", "Ernstig"] },
    { key: "ageGroup", label: "Leeftijdsklasse", options: AGE_GROUPS },
    { key: "patientSex", label: "Geslacht", options: ["V", "M", "X"] },
    { key: "followupDate", label: "Follow-up datum", type: "date" },
    { key: "followupVolume", label: "Follow-up volume (ml)", type: "number", step: "0.01" },
  ];
  const ellipsoid = (d) => (d.length && d.width && d.depth ? +(d.length * d.width * d.depth * 0.524 / 1000).toFixed(2) : "");
  // Volumereductie (VRR) in %, de standaardmaat voor RF-ablatie.
  const vrr = (d) => { const r = Core.vrr(d); return r === null ? null : Math.round(r); };
  const AUS_BOUNDS = [[-44, 112], [-10, 154]];

  const state = {
    db: { version: 1, hospitals: [] },
    selectedId: null,
    filter: { status: "all", product: "all", due: "all", query: "" },
    placing: null, // {id} wanneer we op de kaart een locatie kiezen
    dragId: null,
  };
  const markers = new Map();
  const store = window.FollowUpStore;
  const $ = (sel, root = document) => root.querySelector(sel);
  const statsView = $("#statsView");
  const todayView = $("#todayView");

  // ---------- helpers ----------
  const { esc, uid, lastContact } = Core;
  const today = () => Core.localDate();
  const fmtDate = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString("nl-BE", { day: "2-digit", month: "short", year: "numeric" }) : "—";
  const daysAgo = (d) => Math.round((new Date(today()) - new Date(d)) / 86400000);
  const byId = (id) => state.db.hospitals.find((h) => h.id === id);
  const sel = () => byId(state.selectedId);

  function countType(h, type) {
    return h.activities.filter((a) => a.type === type).reduce((s, a) => s + (Number(a.qty) || 1), 0);
  }
  const isOverdue = (h) => Core.isOverdue(h, today());
  function relDays(d) {
    if (!d) return "";
    const n = daysAgo(d);
    if (n === 0) return "vandaag";
    if (n === 1) return "gisteren";
    if (n < 0) return `over ${-n} d`;
    return `${n} d geleden`;
  }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 2600);
  }

  // ---------- opslag ----------
  // Elke wijziging staat meteen op dit toestel (MINE_KEY) en gaat daarna naar de databank, één opslag tegelijk.
  // Lukt dat niet (offline, botsing), dan blijft ze bewaard en proberen we later opnieuw.
  // sync.base is de laatste versie uit de databank: daarmee voegen we wijzigingen van twee toestellen samen.
  const BASE_KEY = "followup-base";
  const MINE_KEY = "followup-mine";
  const EXPORT_KEY = "followup-last-export";
  const sync = { base: null, dirty: false, running: false, retry: null, localOk: true, banner: false, ready: false };
  const copy = (v) => JSON.parse(JSON.stringify(v));
  function readLocal(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }
  function writeLocal(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }
  function removeLocal(key) {
    try { localStorage.removeItem(key); } catch (e) { /* privévenster */ }
  }
  function readDoc(key) {
    const doc = readLocal(key);
    return doc && Array.isArray(doc.hospitals) ? doc : null;
  }
  function setBase(doc) {
    sync.base = doc;
    writeLocal(BASE_KEY, doc);
  }
  function setSaveState(text, error = false) {
    $("#saveState").textContent = text;
    $("#saveState").classList.toggle("error", error);
  }
  function syncBanner(msg, reload) {
    sync.banner = !!msg;
    showBanner(msg, reload);
  }

  let saveTimer = null;
  function scheduleSave() {
    sync.dirty = true;
    sync.localOk = writeLocal(MINE_KEY, state.db);
    setSaveState("Opslaan…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 400);
  }
  async function flush() {
    clearTimeout(saveTimer);
    clearTimeout(sync.retry);
    if (sync.running || !sync.dirty) return;
    sync.running = true;
    let conflicts = 0;
    try {
      while (sync.dirty) {
        sync.dirty = false;
        const snapshot = copy(state.db);
        try {
          await store.save(snapshot);
          setBase(snapshot);
        } catch (e) {
          sync.dirty = true;
          if (!(e instanceof store.ConflictError) || ++conflicts > 3) throw e;
          await pullRemote();
          toast("Samengevoegd met wijzigingen van een ander toestel");
        }
      }
      removeLocal(MINE_KEY);
      setSaveState("✓ Opgeslagen");
      if (sync.banner) syncBanner("");
    } catch (e) {
      saveFailed(e);
      sync.retry = setTimeout(flush, 30000);
    } finally {
      sync.running = false;
    }
  }
  function saveFailed(e) {
    const where = sync.localOk ? "Je wijzigingen staan veilig op dit toestel en worden vanzelf verstuurd." : "Je wijzigingen staan alleen in dit venster: laat het open.";
    if (navigator.onLine === false) {
      setSaveState(sync.localOk ? "Offline · bewaard op dit toestel" : "Offline", !sync.localOk);
      syncBanner(`Geen verbinding. ${where}`);
      return;
    }
    setSaveState("Niet opgeslagen!", true);
    const hint = store.mode === "local" ? "Draait server.py nog?" : "Ben je nog aangemeld?";
    syncBanner(`Opslaan mislukt. ${hint} ${where} (${e.message || "botsing"})`, true);
  }
  // Voegt de versie uit de databank samen met wat hier staat.
  function applyRemote(theirs) {
    Core.prepare(theirs);
    const merged = Core.merge(sync.base, state.db, theirs);
    Core.prepare(merged);
    const changed = !Core.same(merged, state.db);
    setBase(copy(theirs));
    state.db = merged;
    if (!Core.same(merged, theirs)) {
      sync.dirty = true;
      sync.localOk = writeLocal(MINE_KEY, state.db);
    }
    return changed;
  }
  async function pullRemote() {
    const { db, empty } = await store.load();
    // Een lege uitkomst terwijl er wel data was: nooit als "alles verwijderd" behandelen.
    if (empty && sync.base && sync.base.hospitals.length) throw new Error("De databank gaf geen gegevens terug");
    const changed = applyRemote(db);
    if (changed) refreshScreens();
    return changed;
  }
  // Bij terugkeren naar de app: nieuwste versie ophalen, zodat een open venster niet achterloopt.
  async function refresh() {
    if (!sync.ready || sync.running || document.hidden) return;
    sync.running = true;
    try {
      const wasDirty = sync.dirty;
      if (await pullRemote() && !wasDirty) toast("Bijgewerkt met wijzigingen van een ander toestel");
    } catch (e) {
      /* offline of niet bereikbaar: volgende keer opnieuw */
    } finally {
      sync.running = false;
    }
    if (sync.dirty) flush();
  }
  // Niet hertekenen terwijl iemand in de fiche aan het typen is; dat gebeurt zodra het veld verlaten wordt.
  function refreshScreens() {
    const a = document.activeElement;
    if ($("#fiche").contains(a) && a.matches("input, select, textarea")) {
      state.ficheStale = true;
      renderKpis();
      renderList();
      renderMarkers();
      renderToday();
      renderStats();
    } else renderAll();
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flush();
    else refresh();
  });
  window.addEventListener("pagehide", flush);
  window.addEventListener("online", () => { flush(); refresh(); });
  setInterval(refresh, 120000);
  window.addEventListener("beforeunload", (e) => {
    if (sync.dirty && !sync.localOk) e.preventDefault();
  });
  function showBanner(msg, reload = false) {
    const b = $("#banner");
    b.textContent = msg;
    if (reload) {
      const btn = document.createElement("button");
      btn.className = "btn small";
      btn.textContent = "Herlaad";
      btn.style.marginLeft = "10px";
      btn.onclick = () => location.reload();
      b.append(btn);
    }
    b.hidden = !msg;
  }

  // ---------- kaart ----------
  const map = L.map("map", { zoomControl: true }).fitBounds(AUS_BOUNDS);
  // Lichtgrijze kaart in de stijl van vaseomedical.com; de statusbolletjes zijn de enige kleur.
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  function pinIcon(h) {
    const cls = ["pin", esc(h.status), h.id === state.selectedId ? "selected" : "", h.id === state.dragId ? "dragging" : ""].join(" ");
    return L.divIcon({ className: "", html: `<div class="${cls}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
  }

  function renderMarkers() {
    markers.forEach((m) => m.remove());
    markers.clear();
    for (const h of visibleHospitals()) {
      if (h.lat == null || h.lng == null) continue;
      const m = L.marker([h.lat, h.lng], { icon: pinIcon(h), draggable: h.id === state.dragId, zIndexOffset: h.id === state.selectedId ? 1000 : 0 })
        .addTo(map)
        .bindTooltip(esc(h.name), { direction: "top", offset: [0, -10], className: "pin-label" })
        .on("click", () => select(h.id, false));
      m.on("dragend", () => {
        const p = m.getLatLng();
        const cur = byId(h.id);
        if (!cur) return;
        cur.lat = +p.lat.toFixed(5);
        cur.lng = +p.lng.toFixed(5);
        scheduleSave();
        toast("Locatie bijgewerkt");
      });
      markers.set(h.id, m);
    }
    $("#dragHint").hidden = !(state.dragId && !state.ficheOpen);
    renderMapFilter();
  }
  function filterLabels() {
    const f = state.filter;
    return [
      f.status !== "all" && STATUS[f.status],
      f.product !== "all" && f.product,
      f.due !== "all" && { overdue: "Actie te laat", noAction: "Geen volgende actie", stale: "Lang stil" }[f.due],
      f.query && `“${f.query}”`,
    ].filter(Boolean);
  }
  function renderMapFilter() {
    const labels = filterLabels();
    $("#mapFilter").hidden = !labels.length;
    $("#mapFilterText").textContent = `Filter: ${labels.join(" · ")}`;
  }
  function resetFilters() {
    Object.assign(state.filter, { status: "all", product: "all", due: "all", query: "" });
    $("#search").value = "";
    for (const [id, key] of [["#statusFilters", "status"], ["#productFilters", "product"], ["#dueFilters", "due"]]) {
      $(id).querySelectorAll(".chip").forEach((c) => {
        const on = c.dataset[key] === "all";
        c.classList.toggle("active", on);
        c.setAttribute("aria-pressed", String(on));
      });
    }
    renderList();
    renderMarkers();
  }

  function fitAll() {
    if (!map.getContainer().offsetWidth) { state.pendingFit = true; return; }
    const pts = visibleHospitals().filter((h) => h.lat != null).map((h) => [h.lat, h.lng]);
    if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 12 });
  }

  map.on("click", (e) => {
    if (!state.placing) return;
    const h = byId(state.placing.id);
    state.placing = null;
    $("#placeHint").hidden = true;
    map.getContainer().style.cursor = "";
    if (!h) return;
    h.lat = +e.latlng.lat.toFixed(5);
    h.lng = +e.latlng.lng.toFixed(5);
    state.ficheOpen = true;
    scheduleSave();
    renderAll();
    toast("Locatie ingesteld");
  });
  function startPlacing(id) {
    state.placing = { id };
    state.ficheOpen = false;
    setView("map");
    renderFiche();
    $("#placeHint").hidden = false;
    map.getContainer().style.cursor = "crosshair";
  }
  $("#cancelPlace").addEventListener("click", () => {
    state.placing = null;
    $("#placeHint").hidden = true;
    map.getContainer().style.cursor = "";
  });
  $("#dragDone").addEventListener("click", () => {
    const id = state.dragId;
    state.dragId = null;
    if (id) select(id, false);
  });
  $("#mapFilterReset").addEventListener("click", resetFilters);
  $("#fitBtn").addEventListener("click", fitAll);
  $("#ausBtn").addEventListener("click", () => map.fitBounds(AUS_BOUNDS));

  // ---------- filter + lijst ----------
  function matchesQuery(h, q) {
    if (!q) return true;
    const hay = [h.name, h.address, h.sector, h.notes, ...h.contacts.flatMap((c) => [c.name, c.role, c.address, c.email])]
      .join(" ").toLowerCase();
    return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  }
  function visibleHospitals() {
    const { status, product, due, query } = state.filter;
    const t = today();
    const dueTest = { all: () => true, overdue: isOverdue, noAction: Core.needsAction, stale: (h) => Core.isStale(h, t) }[due];
    return state.db.hospitals.filter((h) =>
      (status === "all" || h.status === status) &&
      (product === "all" || h.products.includes(product)) &&
      dueTest(h) &&
      matchesQuery(h, query));
  }

  function renderList() {
    const order = { green: 0, orange: 1, red: 2, grey: 3 };
    const q = state.filter.query.toLowerCase();
    const nameHit = (h) => (q && h.name.toLowerCase().includes(q) ? 0 : 1);
    const items = visibleHospitals().sort((a, b) =>
      nameHit(a) - nameHit(b) || order[a.status] - order[b.status] || a.name.localeCompare(b.name));
    const ul = $("#list");
    if (!items.length) {
      ul.innerHTML = `<li class="empty">Geen resultaten${filterLabels().length ? ` <button class="link" data-reset>Filters wissen</button>` : ""}</li>`;
      return;
    }
    ul.innerHTML = items.map((h) => {
      const lc = lastContact(h);
      const primary = h.contacts.find((c) => c.primary);
      const bits = [h.stage];
      if (lc) bits.push("laatst " + relDays(lc));
      const selected = h.id === state.selectedId;
      return `<li class="${selected ? "selected" : ""}"><button class="row" data-id="${esc(h.id)}" ${selected ? 'aria-current="true"' : ""}>
        <i class="dot ${esc(h.status)}" aria-hidden="true"></i>
        <span class="row-body">
          <span class="name">${esc(h.name)}<span class="sr-only"> · status: ${esc(STATUS[h.status])}</span>${isOverdue(h) ? '<span class="badge">actie te laat</span>' : ""}${h.lat == null ? '<span class="badge neutral">geen locatie</span>' : ""}</span>
          <span class="meta">${esc(bits.join(" · "))}</span>
          ${primary ? `<span class="meta">★ ${esc(primary.name)}</span>` : ""}
        </span>
      </button></li>`;
    }).join("");
  }
  $("#list").addEventListener("click", (e) => {
    if (e.target.closest("[data-reset]")) return resetFilters();
    const row = e.target.closest("[data-id]");
    if (row) select(row.dataset.id, true);
  });

  function bindChips(containerSel, key) {
    $(containerSel).addEventListener("click", (e) => {
      const b = e.target.closest(".chip");
      if (!b) return;
      $(containerSel).querySelectorAll(".chip").forEach((c) => {
        c.classList.toggle("active", c === b);
        c.setAttribute("aria-pressed", String(c === b));
      });
      state.filter[key] = b.dataset[key];
      renderList();
      renderMarkers();
    });
  }
  bindChips("#statusFilters", "status");
  bindChips("#productFilters", "product");
  bindChips("#dueFilters", "due");

  $("#search").addEventListener("input", (e) => {
    state.filter.query = e.target.value.trim();
    renderList();
    renderMarkers();
  });
  $("#search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = $("#list [data-id]");
      if (first) select(first.dataset.id, true);
    }
  });

  function renderKpis() {
    const hs = state.db.hospitals;
    const n = (s) => hs.filter((h) => h.status === s).length;
    const procs = hs.reduce((s, h) => s + countType(h, "Procedure"), 0);
    const demos = hs.reduce((s, h) => s + countType(h, "Demo"), 0);
    const late = hs.filter(isOverdue).length;
    $("#kpis").innerHTML = `
      <div class="kpi"><b><i class="dot green" aria-hidden="true"></i>${n("green")}</b><span>Verkopen</span></div>
      <div class="kpi"><b><i class="dot orange" aria-hidden="true"></i>${n("orange")}</b><span>In progress</span></div>
      <div class="kpi"><b><i class="dot red" aria-hidden="true"></i>${n("red")}</b><span>Geen contact</span></div>
      <div class="kpi"><b>${procs}</b><span>Procedures</span></div>
      <div class="kpi"><b>${demos}</b><span>Demo's</span></div>
      <div class="kpi"><b style="${late ? "color:var(--red)" : ""}">${late}</b><span>Acties te laat</span></div>`;
  }

  // ---------- selectie ----------
  function select(id, fly) {
    state.selectedId = id;
    state.ficheOpen = true;
    if (state.dragId && state.dragId !== id) state.dragId = null;
    const h = sel();
    renderAll();
    if (fly && h) focusOn(h);
  }
  // Een verborgen kaart (gsm, ander tabblad) heeft geen grootte; dan pas inzoomen zodra ze zichtbaar is.
  function focusOn(h) {
    if (h.lat == null) return;
    if (map.getContainer().offsetWidth) {
      map.invalidateSize();
      map.flyTo([h.lat, h.lng], Math.max(map.getZoom(), 13), { duration: 0.6 });
    } else {
      state.pendingFocus = [h.lat, h.lng];
    }
  }
  function closeFiche() {
    state.selectedId = null;
    state.ficheOpen = false;
    state.dragId = null;
    renderAll();
  }

  function procSummary(d) {
    if (!d) return "";
    const r = vrr(d);
    return [
      d.side, d.figo && `FIGO ${d.figo}`, d.noduleType, d.tirads && `TI-RADS ${d.tirads}`,
      d.length && d.width && d.depth ? `${d.length}×${d.width}×${d.depth} mm` : "",
      d.volume && `${d.volume} ml`, d.energy && `${d.energy} kJ`,
      d.complication && d.complication !== "Geen" ? `complicatie: ${d.complication}` : "",
      r !== null ? `VRR ${r}%` : "",
    ].filter(Boolean).join(" · ");
  }

  // ---------- fiche ----------
  function renderFiche() {
    const el = $("#fiche");
    const h = sel();
    el.hidden = !h || !state.ficheOpen;
    if (!h) { el.innerHTML = ""; return; }

    const lc = lastContact(h);
    const contacts = [...h.contacts].sort((a, b) => (b.primary - a.primary) || a.name.localeCompare(b.name));
    const acts = [...h.activities].sort((a, b) => b.date.localeCompare(a.date));
    const late = isOverdue(h);

    el.innerHTML = `
      <div class="fiche-head">
        <div class="row">
          <i class="dot ${esc(h.status)}" style="width:14px;height:14px" aria-hidden="true"></i>
          <input class="fiche-title" data-field="name" value="${esc(h.name)}" aria-label="Naam">
          <button class="icon-btn show-on-map" data-act="show-map" title="Toon op kaart" aria-label="Toon op kaart"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z"/><path d="M9 4v14M15 6v14"/></svg></button>
          <button class="icon-btn" data-act="close" title="Sluiten" aria-label="Sluiten">✕</button>
        </div>
        <div class="status-pick">
          ${["green", "orange", "red"].map((k) => `<button class="${k} ${h.status === k ? "active" : ""}" data-status="${k}" aria-pressed="${h.status === k}"><i class="dot ${k}" aria-hidden="true"></i>${STATUS[k]}</button>`).join("")}
        </div>
      </div>

      <div class="section">
        <div class="stats">
          <div class="stat"><b>${fmtDate(lc)}</b><span>Laatste contact ${lc ? "· " + relDays(lc) : ""}</span></div>
          <div class="stat"><b>${countType(h, "Procedure")}</b><span>Procedures</span></div>
          <div class="stat"><b>${countType(h, "Demo")}</b><span>Demo's</span></div>
          <div class="stat"><b>${countType(h, "Bestelling")}</b><span>Naalden besteld</span></div>
        </div>
      </div>

      <div class="section">
        <h3>Opvolging</h3>
        <div class="grid">
          <label class="field">Verkoopfase
            <select data-field="stage">${STAGES.map((s) => `<option ${s === h.stage ? "selected" : ""}>${s}</option>`).join("")}</select>
          </label>
          <label class="field">Volgende actie op
            <input type="date" data-field="nextActionDate" value="${esc(h.nextActionDate)}">
          </label>
          <label class="field full">Volgende actie ${late ? '<span class="badge">te laat</span>' : ""}
            <input data-field="nextAction" value="${esc(h.nextAction)}" placeholder="bv. demo inplannen met Dr …">
          </label>
          ${h.nextActionDate ? `<div class="full next-acts">
            <button class="btn small" data-act="next-done">✓ Klaar</button>
            <button class="btn small" data-act="next-snooze">+1 week</button>
            <button class="btn small" data-act="next-ics">In agenda</button>
          </div>` : ""}
          ${h.stage === "Niet geïnteresseerd" ? `<label class="field full">Reden
            <select data-field="lostReason"><option value="">—</option>${LOST_REASONS.map((r) => `<option ${r === h.lostReason ? "selected" : ""}>${r}</option>`).join("")}</select>
          </label>` : ""}
        </div>
      </div>

      <div class="section">
        <h3>Verwachte verkoop</h3>
        <div class="grid">
          <label class="field">Waarde (A$)
            <input type="number" min="0" step="100" data-field="dealValue" value="${esc(h.dealValue)}">
          </label>
          <label class="field">Winkans (%)
            <input type="number" min="0" max="100" data-field="winChance" value="${esc(h.winChance)}" placeholder="${Core.WIN_CHANCE[h.stage]}">
          </label>
          <label class="field full">Verwachte sluitdatum
            <input type="date" data-field="closeDate" value="${esc(h.closeDate)}">
          </label>
        </div>
      </div>

      <div class="section">
        <h3>Contactmomenten <button class="btn small primary" data-act="add-activity">+ Contactmoment</button></h3>
        ${acts.length ? `<ul class="timeline">${acts.map((a) => {
          const c = h.contacts.find((x) => x.id === a.contactId);
          const sub = [a.product, c && c.name, (a.type === "Procedure" || a.type === "Bestelling") && a.qty ? `aantal: ${a.qty}` : ""].filter(Boolean).join(" · ");
          const det = procSummary(a.details);
          return `<li>
            <div class="t-date">${fmtDate(a.date)}</div>
            <div class="t-body">
              <div class="t-type"><span class="type-pill"></span>${esc(a.type)}</div>
              ${sub ? `<div class="t-sub">${esc(sub)}</div>` : ""}
              ${det ? `<div class="t-sub">${esc(det)}</div>` : ""}
              ${a.note ? `<div class="t-note">${esc(a.note)}</div>` : ""}
            </div>
            <div><button class="icon-btn" data-act="edit-activity" data-id="${esc(a.id)}" title="Bewerk" aria-label="Bewerk contactmoment">✎</button></div>
          </li>`;
        }).join("")}</ul>` : `<p class="muted">Nog geen contactmomenten. Voeg prospectie, telefoon, demo, procedure… toe.</p>`}
      </div>

      <div class="section">
        <h3>Contactpersonen <button class="btn small" data-act="add-contact">+ Contact</button></h3>
        ${contacts.length ? contacts.map((c) => `
          <div class="contact ${c.primary ? "primary" : ""}">
            <div class="c-actions">
              <button class="icon-btn" data-act="primary" data-id="${esc(c.id)}" title="${c.primary ? "Hoofdcontact" : "Maak hoofdcontact"}" aria-label="${c.primary ? "Hoofdcontact" : "Maak hoofdcontact"}" aria-pressed="${c.primary}">${c.primary ? "★" : "☆"}</button>
              <button class="icon-btn" data-act="edit-contact" data-id="${esc(c.id)}" title="Bewerk" aria-label="Bewerk ${esc(c.name)}">✎</button>
            </div>
            <div class="c-name">${esc(c.name)}${c.primary ? '<span class="tag primary">HOOFDCONTACT</span>' : ""}${c.product ? `<span class="tag">${esc(c.product)}</span>` : ""}</div>
            ${c.role ? `<div class="c-role">${esc(c.role)}</div>` : ""}
            ${c.phone ? `<div class="c-line">☎ <a href="tel:${esc(c.phone.replace(/[^\d+]/g, ""))}">${esc(c.phone)}</a></div>` : ""}
            ${c.email ? `<div class="c-line">✉ <a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>` : ""}
            ${c.address ? `<div class="c-line muted">${esc(c.address)}</div>` : ""}
            ${c.notes ? `<div class="c-line muted">ⓘ ${esc(c.notes)}</div>` : ""}
          </div>`).join("") : `<p class="muted">Nog geen contactpersonen.</p>`}
      </div>

      <div class="section">
        <h3>Gegevens</h3>
        <div class="grid">
          <label class="field full">Publiek / privé
            <select data-field="sector">${["", "Public", "Private", "University"].map((k) => `<option value="${k}" ${k === h.sector ? "selected" : ""}>${k || "—"}</option>`).join("")}</select>
          </label>
          <div class="field full"><span style="font-size:11px;color:var(--muted)">Producten</span>
            <div class="toggles">${PRODUCTS.map((p) => `<label><input type="checkbox" data-product="${p}" ${h.products.includes(p) ? "checked" : ""}>${p}</label>`).join("")}</div>
          </div>
          <label class="field">Regio
            <select data-field="region"><option value="">—</option>${REGIONS.map((r) => `<option ${r === h.region ? "selected" : ""}>${r}</option>`).join("")}</select>
          </label>
          <label class="field">Verantwoordelijke
            <input data-field="owner" value="${esc(h.owner)}" placeholder="bv. Lander">
          </label>
          <label class="field full">Adres
            <input data-field="address" value="${esc(h.address)}">
          </label>
          <div class="field full">
            <span style="font-size:11px;color:var(--muted)">Locatie op kaart</span>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:3px">
              ${h.lat == null
                ? `<button class="btn small primary" data-act="place">Plaats op kaart</button>`
                : `<button class="btn small ${state.dragId === h.id ? "primary" : ""}" data-act="drag">${state.dragId === h.id ? "✓ Klaar met verslepen" : "Versleep marker"}</button>
                   <button class="btn small" data-act="place">Klik nieuwe locatie</button>`}
            </div>
          </div>
          <label class="field full">Notities
            <textarea data-field="notes" rows="4">${esc(h.notes)}</textarea>
          </label>
        </div>
      </div>

      <div class="fiche-foot">
        <button class="btn danger" data-act="delete">Verwijder</button>
        <button class="btn" data-act="close">Sluiten</button>
      </div>`;
    attachAddressSearch(el.querySelector('[data-field="address"]'), (r) => {
      const cur = byId(h.id);
      if (!cur) return;
      cur.address = r.address;
      cur.lat = r.lat;
      cur.lng = r.lng;
      if (r.region) cur.region = r.region;
      scheduleSave();
      renderAll();
      focusOn(cur);
      toast("Adres en locatie ingesteld");
    });
  }

  // Velden in de fiche: opslaan zonder volledige herteken (focus blijft).
  // Tekst wordt al bij elke toetsaanslag bewaard, zodat een gesloten app niets verliest.
  $("#fiche").addEventListener("input", (e) => {
    const h = sel();
    const t = e.target;
    if (!h || !t.dataset.field || !t.matches('input:not([type]), textarea')) return;
    h[t.dataset.field] = t.value;
    scheduleSave();
  });
  $("#fiche").addEventListener("change", (e) => {
    const h = sel();
    if (!h) return;
    const t = e.target;
    const field = t.dataset.field;
    if (field === "stage") {
      const before = h.status;
      Core.setStage(h, t.value, today());
      if (h.status !== before) toast(`Status → ${STATUS[h.status]}`);
    } else if (field) {
      h[field] = t.type === "number" ? (t.value === "" ? "" : Number(t.value)) : t.value;
      if (field === "name" && !t.value.trim()) { h.name = "Naamloos"; t.value = h.name; }
    } else if (t.dataset.product) {
      const p = t.dataset.product;
      h.products = t.checked ? [...new Set([...h.products, p])] : h.products.filter((x) => x !== p);
    } else return;
    scheduleSave();
    renderList();
    renderKpis();
    renderToday();
    if (["name", "nextActionDate", "stage"].includes(field)) { renderFiche(); renderMarkers(); }
  });
  $("#fiche").addEventListener("focusout", () => {
    setTimeout(() => {
      if (!state.ficheStale || $("#fiche").contains(document.activeElement)) return;
      state.ficheStale = false;
      renderFiche();
    }, 0);
  });

  $("#fiche").addEventListener("click", (e) => {
    const h = sel();
    if (!h) return;
    const sb = e.target.closest("[data-status]");
    if (sb) { setStatus(h, sb.dataset.status); return; }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const id = b.dataset.id;
    switch (b.dataset.act) {
      case "close": return closeFiche();
      case "show-map":
        state.ficheOpen = false;
        setView("map");
        renderAll();
        if (h.lat != null) state.pendingFocus = [h.lat, h.lng];
        else toast("Dit ziekenhuis heeft nog geen locatie");
        return;
      case "add-contact": return contactDialog(h, null);
      case "edit-contact": return contactDialog(h, h.contacts.find((c) => c.id === id));
      case "primary": {
        const c = h.contacts.find((x) => x.id === id);
        const was = c.primary;
        h.contacts.forEach((x) => (x.primary = false));
        c.primary = !was;
        scheduleSave();
        return renderAll();
      }
      case "add-activity": return activityDialog(h, null);
      case "edit-activity": return activityDialog(h, h.activities.find((a) => a.id === id));
      case "place": return startPlacing(h.id);
      case "drag":
        state.dragId = state.dragId === h.id ? null : h.id;
        // Op gsm bedekt de fiche de kaart: eerst opzij en een Klaar-knop tonen.
        if (state.dragId && innerWidth <= 760) {
          state.ficheOpen = false;
          state.pendingFocus = [h.lat, h.lng];
          setView("map");
        } else if (state.dragId) toast("Sleep de marker naar de juiste plek");
        return renderAll();
      case "next-done": return nextDone(h);
      case "next-snooze": return nextSnooze(h);
      case "next-ics": return downloadIcs(h);
      case "delete":
        if (confirm(`"${h.name}" en alle contacten/contactmomenten definitief verwijderen?`)) {
          state.db.hospitals = state.db.hospitals.filter((x) => x.id !== h.id);
          scheduleSave();
          closeFiche();
        }
        return;
    }
  });

  // De statusknoppen zijn een snelkoppeling naar de fase: de fase blijft de enige bron.
  function setStatus(h, status) {
    if (h.status === status) return;
    Core.setStage(h, { green: "Klant", orange: "Eerste contact", red: "Prospect" }[status], today());
    scheduleSave();
    renderAll();
  }
  function nextDone(h) {
    h.nextAction = "";
    h.nextActionDate = "";
    scheduleSave();
    renderAll();
    toast("Actie afgerond. Plan gerust de volgende.");
  }
  function nextSnooze(h) {
    h.nextActionDate = Core.addDays(today() > h.nextActionDate ? today() : h.nextActionDate, 7);
    scheduleSave();
    renderAll();
    toast(`Verplaatst naar ${fmtDate(h.nextActionDate)}`);
  }
  function downloadIcs(h) {
    const day = (d) => d.replace(/-/g, "");
    const text = (s) => String(s).replace(/([\\;,])/g, "\\$1").replace(/\r?\n/g, "\\n");
    download(`actie-${day(h.nextActionDate)}.ics`, [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Vaseo Medical//FollowUp//NL", "BEGIN:VEVENT",
      `UID:${h.id}-${day(h.nextActionDate)}@followup`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]|\.\d+/g, "")}`,
      `DTSTART;VALUE=DATE:${day(h.nextActionDate)}`,
      `DTEND;VALUE=DATE:${day(Core.addDays(h.nextActionDate, 1))}`,
      `SUMMARY:${text(`${h.name}: ${h.nextAction || "Opvolgen"}`)}`,
      "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n"), "text/calendar");
  }

  // ---------- vandaag ----------
  function renderToday() {
    if (todayView.hidden) return;
    const t = today();
    const g = Core.dueGroups(state.db.hospitals, t);
    const main = (h, title, sub) => `<button class="today-main" data-open="${esc(h.id)}">
        <i class="dot ${esc(h.status)}" aria-hidden="true"></i>
        <span class="row-body"><span class="name">${esc(title)}<span class="sr-only"> · status: ${esc(STATUS[h.status])}</span></span><span class="meta">${esc(sub)}</span></span>
      </button>`;
    const acts = (h, withNext) => `<span class="today-acts">
        <button class="btn small primary" data-log="${esc(h.id)}">Log</button>
        ${withNext ? `<button class="btn small" data-snooze="${esc(h.id)}">+1 week</button><button class="btn small" data-done="${esc(h.id)}" aria-label="Actie afgerond">✓</button>` : ""}
      </span>`;
    const sub = (h) => [h.nextAction || "Geen omschrijving", fmtDate(h.nextActionDate)].join(" · ");
    const group = (title, items) => (items.length ? `<section class="today-group"><h3>${esc(title)} <span class="count">${items.length}</span></h3><ul>${items.join("")}</ul></section>` : "");
    const rows = (list, fn, withNext) => list.map((h) => `<li>${main(h, h.name, fn(h))}${acts(h, withNext)}</li>`);
    const silent = (h) => {
      const lc = lastContact(h);
      return [h.stage, lc ? `laatst ${relDays(lc)}` : "nog geen contact geregistreerd"].join(" · ");
    };
    const groups = [
      group("Te laat", rows(g.overdue, sub, true)),
      group("Vandaag", rows(g.today, sub, true)),
      group("Follow-ups procedures", g.followups.map(({ hospital: h, activity: a }) =>
        `<li>${main(h, h.name, `Follow-up ${fmtDate(a.details.followupDate)} · procedure van ${fmtDate(a.date)}`)}<span class="today-acts"><button class="btn small" data-edit-act="${esc(h.id)}|${esc(a.id)}">Resultaat invullen</button></span></li>`)),
      group("Deze week", rows(g.week, sub, true)),
      group("Geen volgende actie", rows(g.noAction, silent, false)),
      group(`Lang stil (meer dan ${Core.STALE_DAYS} dagen)`, rows(g.stale, silent, false)),
    ].join("");
    const lastExport = readLocal(EXPORT_KEY);
    const age = lastExport ? Core.daysBetween(lastExport, t) : null;
    const reminder = state.db.hospitals.length && (age === null || age > 7)
      ? `<p class="today-note">${age === null ? "Je hebt op dit toestel nog geen eigen back-up gedownload." : `Je laatste eigen back-up is ${age} dagen oud.`} <button class="link" data-export>Download nu</button></p>`
      : "";
    const prospects = g.uncontacted
      ? `<p class="today-note">${g.uncontacted} ${g.uncontacted === 1 ? "ziekenhuis is" : "ziekenhuizen zijn"} nog niet gecontacteerd. <button class="link" data-prospects>Bekijk de lijst</button></p>`
      : "";
    todayView.innerHTML = `
      <div class="s-head"><h2>Vandaag</h2><span class="muted">${esc(fmtDate(t))}</span></div>
      ${groups || `<p class="today-empty">Niets dringends. Alles is opgevolgd.</p>`}
      ${prospects}${reminder}`;
  }
  todayView.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const d = b.dataset;
    if (d.open) return select(d.open, false);
    if (d.log) return activityDialog(byId(d.log), null);
    if (d.snooze) return nextSnooze(byId(d.snooze));
    if (d.done) return nextDone(byId(d.done));
    if (d.editAct) {
      const [hid, aid] = d.editAct.split("|");
      const h = byId(hid);
      const a = h && h.activities.find((x) => x.id === aid);
      if (a) activityDialog(h, a);
      return;
    }
    if ("export" in d) return exportJson();
    if ("prospects" in d) {
      resetFilters();
      $('#statusFilters [data-status="red"]').click();
      setView(innerWidth > 760 ? "map" : "list");
    }
  });

  // Snel loggen vanuit de tabbalk: eerst het ziekenhuis kiezen.
  function logPicker() {
    const recent = [...state.db.hospitals].sort((a, b) => lastContact(b).localeCompare(lastContact(a)) || a.name.localeCompare(b.name));
    openDialog(`
      <h2>Contact loggen</h2>
      <label class="field full">Ziekenhuis<input id="pickSearch" type="search" placeholder="Typ om te zoeken…" autocomplete="off"></label>
      <ul class="pick-list" id="pickList"></ul>
      <div class="actions">
        <button class="btn" value="cancel" formnovalidate>Annuleer</button>
        <button type="button" class="btn" id="pickNew">+ Nieuw ziekenhuis</button>
      </div>`, () => {});
    const list = $("#pickList");
    const paint = () => {
      const q = $("#pickSearch").value.trim();
      const nameHit = (h) => (h.name.toLowerCase().includes(q.toLowerCase()) ? 0 : 1);
      const items = recent.filter((h) => matchesQuery(h, q)).sort((x, y) => nameHit(x) - nameHit(y));
      list.innerHTML = items.map((h) => `<li><button type="button" data-pick="${esc(h.id)}"><i class="dot ${esc(h.status)}" aria-hidden="true"></i>${esc(h.name)}</button></li>`).join("") || `<li class="muted">Geen ziekenhuis gevonden</li>`;
    };
    paint();
    $("#pickSearch").addEventListener("input", paint);
    $("#pickSearch").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const first = $("[data-pick]", list);
      if (first) first.click();
    });
    list.addEventListener("click", (e) => {
      const b = e.target.closest("[data-pick]");
      if (b) activityDialog(byId(b.dataset.pick), null);
    });
    $("#pickNew").addEventListener("click", () => $("#addHospitalBtn").click());
  }

  // ---------- adres zoeken (Photon / OpenStreetMap, geen API-sleutel nodig) ----------
  // Toont suggesties onder het invoerveld; onPick krijgt { address, lat, lng }.
  const NUMBER_FIRST = ["AU", "NZ", "US", "CA", "GB", "IE"];
  const AU_BBOX = [112, -44, 154, -10]; // west, zuid, oost, noord
  const AU_STATES = { "Queensland": "QLD", "New South Wales": "NSW", "Victoria": "VIC", "Tasmania": "TAS", "South Australia": "SA", "Western Australia": "WA", "Northern Territory": "NT", "Australian Capital Territory": "ACT" };
  function addressLabel(p) {
    const nr = [p.housenumber, p.street];
    const street = (NUMBER_FIRST.includes(p.countrycode) ? nr : nr.reverse()).filter(Boolean).join(" ");
    const pc = [p.postcode, p.city || p.district || p.county];
    const place = (NUMBER_FIRST.includes(p.countrycode) ? pc.reverse() : pc).filter(Boolean).join(" ");
    return [...new Set([p.name, street, place, p.state].filter(Boolean))].join(", ");
  }
  function attachAddressSearch(input, onPick) {
    const list = document.createElement("ul");
    list.className = "addr-list";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Adressuggesties");
    list.hidden = true;
    input.after(list);
    let results = [], active = -1, timer = null, seq = 0, failed = false;

    const close = () => { list.hidden = true; active = -1; };
    const paint = () => {
      list.innerHTML = results.length
        ? results.map((r, i) => `<li data-i="${i}" role="option" aria-selected="${i === active}" class="${i === active ? "active" : ""}">${esc(r.address)}</li>`).join("")
        : `<li class="addr-empty">${failed ? "Adres zoeken lukt nu niet. Probeer zo opnieuw" : "Geen resultaten"} — je kan de locatie ook manueel op de kaart aanduiden.</li>`;
      // Vast gepositioneerd zodat de lijst niet afgesneden wordt door een scrollend dialoogvenster of fiche.
      const r = input.getBoundingClientRect();
      const below = innerHeight - r.bottom - 12;
      list.style.left = r.left + "px";
      list.style.width = r.width + "px";
      list.style.maxHeight = Math.min(260, Math.max(below, r.top - 12)) + "px";
      if (below >= 160 || below >= r.top) { list.style.top = r.bottom + 4 + "px"; list.style.bottom = ""; }
      else { list.style.bottom = innerHeight - r.top + 4 + "px"; list.style.top = ""; }
      list.hidden = false;
    };
    const pick = (i) => {
      const r = results[i];
      if (!r) return;
      input.value = r.address;
      close();
      onPick(r);
    };
    async function search(q) {
      const my = ++seq;
      try {
        // Enkel Australië; voorrang aan wat de kaart toont, anders rond Brisbane.
        // Niets gevonden in Australië? Dan pas wereldwijd zoeken.
        const c = map.getCenter();
        const inAU = c.lng >= AU_BBOX[0] && c.lat >= AU_BBOX[1] && c.lng <= AU_BBOX[2] && c.lat <= AU_BBOX[3];
        const [lat, lon] = inAU ? [c.lat.toFixed(3), c.lng.toFixed(3)] : [-27.47, 153.03];
        const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lat=${lat}&lon=${lon}`;
        let json = await (await fetch(`${url}&bbox=${AU_BBOX.join(",")}`)).json();
        if (my !== seq) return;
        if (!json.features.length) json = await (await fetch(url)).json();
        if (my !== seq) return;
        const seen = new Set();
        results = json.features.map((f) => ({
          address: addressLabel(f.properties),
          lat: +f.geometry.coordinates[1].toFixed(5),
          lng: +f.geometry.coordinates[0].toFixed(5),
          region: AU_STATES[f.properties.state] || "",
        })).filter((r) => !seen.has(r.address) && seen.add(r.address));
        active = -1;
        failed = false;
        if (document.activeElement === input) paint();
      } catch (e) {
        if (my !== seq) return;
        results = [];
        failed = true;
        if (document.activeElement === input) paint();
      }
    }

    input.setAttribute("autocomplete", "off");
    input.placeholder = "Typ adres of naam ziekenhuis…";
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 3) { seq++; return close(); }
      timer = setTimeout(() => search(q), 300);
    });
    input.addEventListener("keydown", (e) => {
      if (list.hidden || !results.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        active = (active + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
        paint();
      } else if (e.key === "Enter") {
        e.preventDefault();
        pick(active < 0 ? 0 : active);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    });
    input.addEventListener("blur", () => setTimeout(close, 150));
    // Bij scrollen van de omliggende container klopt de positie niet meer.
    document.addEventListener("scroll", (e) => { if (!list.hidden && !list.contains(e.target)) close(); }, true);
    // mousedown i.p.v. click: anders verliest het veld eerst de focus en sluit de lijst.
    list.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const li = e.target.closest("li[data-i]");
      if (li) pick(+li.dataset.i);
    });
  }

  // ---------- dialogen ----------
  function openDialog(html, onSubmit) {
    const dlg = $("#dialog");
    const form = $("#dialogForm");
    form.innerHTML = html;
    form.onclick = form.oninput = form.onchange = null;
    if (!dlg.open) dlg.showModal();
    const first = form.querySelector("input, select, textarea");
    if (first) first.focus();
    form.onsubmit = (e) => {
      const submitter = e.submitter;
      if (!submitter || submitter.value === "cancel") return;
      if (submitter.value === "delete") { onSubmit(null, "delete"); return; }
      if (!form.reportValidity()) { e.preventDefault(); return; }
      onSubmit(Object.fromEntries(new FormData(form)), "ok");
    };
    return form;
  }

  // Enter in een veld betekent altijd "opslaan", nooit de eerste knop (Annuleer of Verwijder).
  $("#dialogForm").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.defaultPrevented || !e.target.matches("input")) return;
    e.preventDefault();
    const primary = $("#dialogForm .btn.primary");
    if (primary) $("#dialogForm").requestSubmit(primary);
  });

  function contactDialog(h, c) {
    const v = c || { name: "", role: "", phone: "", email: "", address: "", product: "", notes: "", primary: false };
    openDialog(`
      <h2>${c ? "Contactpersoon bewerken" : "Nieuwe contactpersoon"}</h2>
      <div class="grid">
        <label class="field full">Naam<input name="name" required value="${esc(v.name)}"></label>
        <label class="field full">Functie<input name="role" value="${esc(v.role)}" placeholder="bv. Endocrine Surgeon"></label>
        <label class="field">Telefoon<input name="phone" value="${esc(v.phone)}"></label>
        <label class="field">E-mail<input name="email" type="email" value="${esc(v.email)}"></label>
        <label class="field full">Adres / praktijk<input name="address" value="${esc(v.address)}"></label>
        <label class="field">Product
          <select name="product">${["", ...PRODUCTS, "Beide"].map((p) => `<option value="${p}" ${p === v.product ? "selected" : ""}>${p || "—"}</option>`).join("")}</select>
        </label>
        <label class="field" style="flex-direction:row;align-items:center;gap:6px;margin-top:16px"><input type="checkbox" name="primary" ${v.primary ? "checked" : ""} style="width:auto">Hoofdcontact</label>
        <label class="field full">Notities<textarea name="notes" rows="3">${esc(v.notes)}</textarea></label>
      </div>
      <div class="actions">
        ${c ? '<button class="btn danger" value="delete" formnovalidate style="margin-right:auto">Verwijder</button>' : ""}
        <button class="btn" value="cancel" formnovalidate>Annuleer</button>
        <button class="btn primary" value="ok">Opslaan</button>
      </div>`, (data, action) => {
      // Het document kan ondertussen samengevoegd zijn: altijd de actuele versie opzoeken.
      const cur = byId(h.id);
      if (!cur) return toast("Dit ziekenhuis bestaat niet meer");
      if (action === "delete") {
        if (!confirm(`${c.name} verwijderen?`)) return;
        cur.contacts = cur.contacts.filter((x) => x.id !== c.id);
        cur.activities.forEach((x) => { if (x.contactId === c.id) x.contactId = ""; });
      } else {
        const existing = c && cur.contacts.find((x) => x.id === c.id);
        const rec = existing || { id: uid() };
        Object.assign(rec, {
          name: data.name.trim(), role: data.role.trim(), phone: data.phone.trim(), email: data.email.trim(),
          address: data.address.trim(), product: data.product, notes: data.notes.trim(), primary: !!data.primary,
        });
        if (rec.primary) cur.contacts.forEach((x) => { if (x !== rec) x.primary = false; });
        if (!existing) cur.contacts.push(rec);
        if (rec.product && rec.product !== "Beide" && !cur.products.includes(rec.product)) cur.products.push(rec.product);
      }
      scheduleSave();
      renderAll();
    });
  }

  function activityDialog(h, a) {
    const v = a || { date: today(), type: "Bezoek", product: h.products.length === 1 ? h.products[0] : "", contactId: (h.contacts.find((c) => c.primary) || {}).id || "", qty: "", note: "" };
    const form = openDialog(`
      <h2>${a ? "Contactmoment bewerken" : "Nieuw contactmoment"} · ${esc(h.name)}</h2>
      <div class="grid">
        <label class="field">Datum<input type="date" name="date" required value="${esc(v.date)}"></label>
        <fieldset class="full type-pick"><legend>Type</legend>
          ${ACT_TYPES.map((t) => `<label><input type="radio" name="type" value="${t}" ${t === v.type ? "checked" : ""}><span>${t}</span></label>`).join("")}
        </fieldset>
        <label class="field">Product
          <select name="product">${["", ...PRODUCTS].map((p) => `<option value="${p}" ${p === v.product ? "selected" : ""}>${p || "—"}</option>`).join("")}</select>
        </label>
        <label class="field">Contactpersoon
          <select name="contactId"><option value="">—</option>${h.contacts.map((c) => `<option value="${esc(c.id)}" ${c.id === v.contactId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
        </label>
        <label class="field full" id="qtyField">Aantal <span id="qtyLabel"></span><input type="number" min="1" name="qty" value="${esc(v.qty)}" placeholder="1"></label>
        <div class="full proc" id="procFields">
          <div class="proc-title">Procedure-gegevens <span class="muted">(optioneel)</span></div>
          <p class="muted proc-warn">Geen patiëntnamen, -nummers of andere herkenbare details, ook niet in de notitie.</p>
          <div class="grid">${PROC_FIELDS.map((f) => {
            const val = (v.details || {})[f.key] ?? "";
            const input = f.options
              ? `<select name="d_${f.key}"><option value="">—</option>${f.options.map((o) => `<option ${o === String(val) ? "selected" : ""}>${o}</option>`).join("")}</select>`
              : `<input name="d_${f.key}" type="${f.type || "text"}" ${f.step ? `step="${f.step}"` : ""} min="0" value="${esc(val)}" placeholder="${esc(f.placeholder || "")}">`;
            return `<label class="field" data-for="${f.product || ""}">${f.label}${input}</label>`;
          }).join("")}</div>
          <p class="muted" id="vrrInfo"></p>
        </div>
        <label class="field full">Notitie<textarea name="note" rows="4" placeholder="Wat werd besproken, afspraken…">${esc(v.note)}</textarea></label>
        ${a ? "" : `<div class="full next-box">
          <div class="proc-title">Volgende actie</div>
          <div class="grid">
            <label class="field full">Wat<input name="nextAction" value="${esc(h.nextAction)}" placeholder="bv. offerte sturen"></label>
            <label class="field full">Wanneer<input type="date" name="nextActionDate" value="${esc(h.nextActionDate)}"></label>
          </div>
          <div class="next-acts">
            <button type="button" class="btn small" data-next="7">+1 week</button>
            <button type="button" class="btn small" data-next="14">+2 weken</button>
            <button type="button" class="btn small" data-next="30">+1 maand</button>
            <button type="button" class="btn small" data-next="0">Geen</button>
          </div>
        </div>`}
      </div>
      <div class="actions">
        ${a ? '<button class="btn danger" value="delete" formnovalidate style="margin-right:auto">Verwijder</button>' : ""}
        <button class="btn" value="cancel" formnovalidate>Annuleer</button>
        <button class="btn primary" value="ok">Opslaan</button>
      </div>`, (data, action) => {
      const cur = byId(h.id);
      if (!cur) return toast("Dit ziekenhuis bestaat niet meer");
      if (action === "delete") {
        if (!confirm("Dit contactmoment verwijderen?")) return;
        cur.activities = cur.activities.filter((x) => x.id !== a.id);
        if (cur.stage === "Klant" && !cur.activities.some((x) => x.type === "Bestelling")) toast("Geen bestellingen meer: kijk de verkoopfase na");
      } else {
        const existing = a && cur.activities.find((x) => x.id === a.id);
        const typeChanged = existing && existing.type !== data.type;
        const rec = existing || { id: uid(), createdBy: store.userEmail || "" };
        const hasQty = data.type === "Procedure" || data.type === "Bestelling";
        Object.assign(rec, { date: data.date, type: data.type, product: data.product, contactId: data.contactId, qty: hasQty ? Number(data.qty) || 1 : "", note: data.note.trim() });
        delete rec.details;
        if (data.type === "Procedure") {
          const d = {};
          for (const f of PROC_FIELDS) {
            if (f.product && f.product !== data.product) continue;
            const raw = (data["d_" + f.key] || "").trim();
            if (raw !== "") d[f.key] = f.type === "number" ? Number(raw) : raw;
          }
          if (!d.volume && ellipsoid(d)) d.volume = ellipsoid(d);
          if (Object.keys(d).length) rec.details = d;
        }
        if (!existing) cur.activities.push(rec);
        if (!existing || typeChanged) applyActivity(cur, rec);
        if (!a) {
          cur.nextAction = data.nextAction.trim();
          cur.nextActionDate = data.nextActionDate;
        }
      }
      scheduleSave();
      renderAll();
    });
    form.onclick = (e) => {
      const b = e.target.closest("[data-next]");
      if (!b) return;
      const days = Number(b.dataset.next);
      form.elements.nextActionDate.value = days ? Core.addDays(today(), days) : "";
      if (!days) form.elements.nextAction.value = "";
    };
    const sync = () => {
      const t = form.elements.type.value;
      const product = form.elements.product.value;
      const show = t === "Procedure" || t === "Bestelling";
      form.elements.product.required = t === "Procedure"; // zonder product telt een procedure niet mee in de doelen
      $("#qtyField", form).hidden = !show;
      $("#qtyLabel", form).textContent = t === "Procedure" ? "(procedures)" : "(naalden)";
      $("#procFields", form).hidden = t !== "Procedure";
      form.querySelectorAll("#procFields [data-for]").forEach((el) => {
        el.hidden = !!el.dataset.for && el.dataset.for !== product;
      });
      const num = (k) => Number(form.elements["d_" + k].value) || 0;
      const d = { length: num("length"), width: num("width"), depth: num("depth"), volume: num("volume"), followupVolume: num("followupVolume") };
      form.elements.d_volume.placeholder = ellipsoid(d) ? `${ellipsoid(d)} (berekend)` : "";
      if (!d.volume) d.volume = ellipsoid(d);
      const r = vrr(d);
      $("#vrrInfo", form).textContent = r === null ? "Volume wordt berekend uit L × B × D als je het leeg laat." : `Volumereductie (VRR): ${r}%`;
    };
    form.oninput = sync;
    form.onchange = sync;
    sync();
    if (!a) form.elements.note.focus(); // de datum klopt meestal al; op gsm opent die focus anders de datumkiezer
  }

  function applyActivity(h, act) {
    const next = Core.stageAfterActivity(h.stage, act.type);
    if (next === h.stage) return;
    Core.setStage(h, next, act.date || today());
    toast(`Fase → ${next}`);
  }

  // ---------- nieuw ziekenhuis ----------
  $("#addHospitalBtn").addEventListener("click", () => {
    openDialog(`
      <h2>Nieuw ziekenhuis</h2>
      <div class="grid">
        <label class="field full">Naam<input name="name" required></label>
        <label class="field full">Publiek / privé<select name="sector"><option value="">—</option><option>Public</option><option>Private</option><option>University</option></select></label>
        <label class="field full">Adres<input name="address"></label>
        <input type="hidden" name="lat"><input type="hidden" name="lng"><input type="hidden" name="region">
      </div>
      <p class="muted" id="addrHint">Kies een suggestie om de locatie automatisch in te stellen. Anders klik je na het opslaan op de kaart.</p>
      <div class="actions">
        <button class="btn" value="cancel" formnovalidate>Annuleer</button>
        <button class="btn primary" value="ok">Aanmaken</button>
      </div>`, (data) => {
      const hasLoc = data.lat !== "" && data.lng !== "";
      const h = Core.normalize({
        id: uid(), name: data.name.trim(), sector: data.sector, address: data.address.trim(), region: data.region,
        lat: hasLoc ? +data.lat : null, lng: hasLoc ? +data.lng : null, stage: "Prospect", createdAt: today(),
        stageHistory: [{ stage: "Prospect", date: today() }],
      });
      state.db.hospitals.push(h);
      scheduleSave();
      if (hasLoc) {
        select(h.id, true);
        toast("Ziekenhuis aangemaakt op de kaart");
      } else {
        select(h.id, false);
        startPlacing(h.id);
      }
    });
    const form = $("#dialogForm");
    const addr = form.querySelector('[name="address"]');
    attachAddressSearch(addr, (r) => {
      form.lat.value = r.lat;
      form.lng.value = r.lng;
      form.region.value = r.region;
      $("#addrHint").textContent = "✓ Locatie gevonden — wordt automatisch op de kaart gezet.";
    });
    // Adres na het kiezen nog aangepast? Dan geldt de gekozen locatie niet meer.
    addr.addEventListener("input", () => {
      if (!form.lat.value) return;
      form.lat.value = form.lng.value = "";
      $("#addrHint").textContent = "Kies een suggestie om de locatie automatisch in te stellen. Anders klik je na het opslaan op de kaart.";
    });
  });

  // ---------- export / import ----------
  function download(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  // Puntkomma + decimale komma, zoals Excel met Belgische instellingen verwacht.
  const csvCell = (v) => (typeof v === "number" ? String(v).replace(".", ",") : `"${String(v ?? "").replace(/"/g, '""')}"`);
  const csv = (rows) => "﻿" + rows.map((r) => r.map(csvCell).join(";")).join("\r\n");

  function exportJson() {
    download(`followup-vaseo-backup-${today()}.json`, JSON.stringify(state.db, null, 2), "application/json");
    writeLocal(EXPORT_KEY, today());
    renderToday();
  }
  $("#exportBtn").addEventListener("click", () => {
    openDialog(`
      <h2>Exporteren</h2>
      <p class="muted">CSV-bestanden openen rechtstreeks in Excel. De JSON-back-up kan je later terug importeren.</p>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn" value="hospitals">Overzicht ziekenhuizen (CSV)</button>
        <button class="btn" value="contacts">Contactpersonen (CSV)</button>
        <button class="btn" value="activities">Contactmomenten (CSV)</button>
        <button class="btn" value="procedures">Procedures met nodule-gegevens (CSV)</button>
        <button class="btn" value="json">Volledige back-up (JSON)</button>
      </div>
      <div class="actions"><button class="btn" value="cancel">Sluiten</button></div>`, () => {});
    $("#dialogForm").onsubmit = (e) => {
      const kind = e.submitter && e.submitter.value;
      const hs = state.db.hospitals;
      const d = today();
      if (kind === "hospitals") {
        download(`ziekenhuizen-${d}.csv`, csv([
          ["Naam", "Sector", "Regio", "Verantwoordelijke", "Status", "Fase", "Waarde (A$)", "Winkans (%)", "Sluitdatum", "Reden afgehaakt", "Producten", "Laatste contact", "Procedures", "Demo's", "Naalden besteld", "Volgende actie", "Actie op", "Hoofdcontact", "Adres", "Notities"],
          ...hs.map((h) => [h.name, h.sector, h.region, h.owner, STATUS[h.status], h.stage, h.dealValue, Core.winChance(h), h.closeDate, h.lostReason, h.products.join(", "), lastContact(h), countType(h, "Procedure"), countType(h, "Demo"), countType(h, "Bestelling"), h.nextAction, h.nextActionDate, (h.contacts.find((c) => c.primary) || {}).name, h.address, h.notes]),
        ]), "text/csv");
      } else if (kind === "contacts") {
        download(`contactpersonen-${d}.csv`, csv([
          ["Ziekenhuis", "Naam", "Functie", "Telefoon", "E-mail", "Adres", "Product", "Hoofdcontact", "Notities"],
          ...hs.flatMap((h) => h.contacts.map((c) => [h.name, c.name, c.role, c.phone, c.email, c.address, c.product, c.primary ? "ja" : "", c.notes])),
        ]), "text/csv");
      } else if (kind === "activities") {
        download(`contactmomenten-${d}.csv`, csv([
          ["Datum", "Ziekenhuis", "Type", "Product", "Contactpersoon", "Aantal", "Notitie", "Ingevoerd door"],
          ...hs.flatMap((h) => h.activities.map((a) => [a.date, h.name, a.type, a.product, (h.contacts.find((c) => c.id === a.contactId) || {}).name, a.qty, a.note, a.createdBy]))
            .sort((a, b) => b[0].localeCompare(a[0])),
        ]), "text/csv");
      } else if (kind === "procedures") {
        download(`procedures-${d}.csv`, csv([
          ["Datum", "Ziekenhuis", "Product", "Arts", "Aantal", ...PROC_FIELDS.map((f) => f.label), "VRR (%)", "Notitie"],
          ...hs.flatMap((h) => h.activities.filter((a) => a.type === "Procedure").map((a) => {
            const det = a.details || {};
            const r = vrr(det);
            return [a.date, h.name, a.product, (h.contacts.find((c) => c.id === a.contactId) || {}).name, a.qty,
              ...PROC_FIELDS.map((f) => det[f.key] ?? ""), r ?? "", a.note];
          })).sort((a, b) => b[0].localeCompare(a[0])),
        ]), "text/csv");
      } else if (kind === "json") {
        exportJson();
      }
    };
  });

  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const problems = Core.checkImport(data);
      if (problems.length) throw new Error(problems.slice(0, 5).join(" "));
      if (!confirm(`${data.hospitals.length} ziekenhuizen importeren? Dit vervangt alle huidige data.`)) return;
      Core.prepare(data);
      // Eerst tonen, pas daarna opslaan: een bestand dat niet werkt, raakt de databank niet.
      const previous = state.db;
      state.db = data;
      state.selectedId = null;
      try {
        renderAll();
      } catch (err) {
        state.db = previous;
        renderAll();
        throw err;
      }
      scheduleSave();
      fitAll();
      toast("Back-up geïmporteerd");
    } catch (err) {
      alert("Importeren mislukt: " + err.message);
    }
  });

  // Terugzetten vanuit de automatische back-ups in de databank.
  $("#backupsBtn").addEventListener("click", async () => {
    let list;
    try {
      list = await store.backups();
    } catch (e) {
      return toast(`Back-ups ophalen lukt niet: ${e.message}`);
    }
    openDialog(`
      <h2>Back-ups</h2>
      <p class="muted">Kies een versie om terug te zetten. De huidige stand gaat daarbij niet verloren: die blijft als back-up bewaard.</p>
      ${list.length ? `<div class="backup-list">${list.map((b) => `<button type="button" class="btn" data-backup="${esc(b.key)}">${esc(b.label)}</button>`).join("")}</div>` : `<p class="muted">Nog geen back-ups gevonden.</p>`}
      <div class="actions"><button class="btn" value="cancel">Sluiten</button></div>`, () => {});
    $("#dialogForm").onclick = async (e) => {
      const b = e.target.closest("[data-backup]");
      if (!b) return;
      try {
        const doc = await store.backup(b.dataset.backup);
        const problems = Core.checkImport(doc);
        if (problems.length) throw new Error(problems[0]);
        if (!confirm(`Terugzetten naar ${b.textContent}? Deze versie bevat ${doc.hospitals.length} ziekenhuizen.`)) return;
        Core.prepare(doc);
        $("#dialog").close();
        state.db = doc;
        state.selectedId = null;
        scheduleSave();
        renderAll();
        fitAll();
        toast("Back-up teruggezet");
      } catch (err) {
        toast(`Terugzetten mislukt: ${err.message}`);
      }
    };
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#dialog").open) {
      if (state.placing) $("#cancelPlace").click();
      else if (!menuList.hidden) toggleMenu(false);
      else if (state.selectedId) closeFiche();
    }
    if (e.key === "/" && document.activeElement === document.body) { e.preventDefault(); $("#search").focus(); }
  });

  // ---------- start ----------
  function renderStats() {
    if (!statsView.hidden) window.FollowUpStats.render(state.db, statsView, scheduleSave);
  }
  function renderAll() {
    state.ficheStale = false;
    renderStats();
    renderToday();
    renderKpis();
    renderList();
    renderMarkers();
    renderFiche();
    setTimeout(() => map.invalidateSize(), 0);
  }

  async function init() {
    const mine = readDoc(MINE_KEY);
    const cached = readDoc(BASE_KEY);
    try {
      await store.ready();
      const { db, empty } = await store.load();
      if (empty && (mine || cached)) throw new Error("De databank gaf geen gegevens terug.");
      if (empty) {
        Core.prepare(db);
        state.db = db;
        sync.base = copy(db);
        offerSeed();
      } else {
        // Niet-verstuurde wijzigingen van een vorige keer samenvoegen met de nieuwste versie.
        state.db = mine || copy(db);
        Core.prepare(state.db);
        sync.base = mine ? cached : null;
        applyRemote(db);
      }
      setSaveState("✓ Opgeslagen");
    } catch (e) {
      if (mine || cached) {
        // Geen verbinding: verder werken met wat op dit toestel staat.
        state.db = mine || cached;
        Core.prepare(state.db);
        sync.base = cached;
        sync.dirty = !!mine;
        setSaveState("Offline · bewaard op dit toestel");
        syncBanner("Geen verbinding met de databank. Je ziet de laatst bewaarde gegevens; wijzigingen worden later verstuurd.");
        sync.retry = setTimeout(flush, 30000);
      } else {
        showBanner(e.message);
      }
    }
    if (store.mode === "supabase") $("#logoutBtn").hidden = false;
    sync.ready = true;
    renderAll();
    map.invalidateSize();
    fitAll();
    if (sync.dirty) flush();
  }

  // Lege online databank: startlijst (uit de Excel) laden of een back-up importeren.
  function offerSeed() {
    const b = $("#banner");
    b.textContent = "De online databank is nog leeg. ";
    const btn = document.createElement("button");
    btn.className = "btn small primary";
    btn.textContent = "Laad startlijst uit Excel";
    btn.onclick = async () => {
      try {
        const res = await fetch("../data/seed.json", { cache: "no-store" });
        if (!res.ok) throw new Error(res.status);
        const doc = await res.json();
        Core.prepare(doc);
        state.db = doc;
        showBanner("");
        scheduleSave();
        renderAll();
        fitAll();
        toast(`${state.db.hospitals.length} ziekenhuizen geladen`);
      } catch (e) {
        alert("Startlijst niet gevonden. Gebruik Importeer met een JSON-back-up.");
      }
    };
    b.append(btn, " of gebruik Importeer met een JSON-back-up.");
    b.hidden = false;
  }

  $("#logoutBtn").addEventListener("click", () => {
    if (sync.dirty && !confirm("Er zijn nog niet-verstuurde wijzigingen. Toch afmelden? Ze gaan dan verloren.")) return;
    // Geen klantgegevens achterlaten op dit toestel.
    [BASE_KEY, MINE_KEY, EXPORT_KEY].forEach(removeLocal);
    store.signOut();
  });

  // ---------- schermen: lijst / kaart / statistieken ----------
  // Op desktop staan lijst en kaart naast elkaar; op gsm kies je via de tabbalk.
  function setView(view) {
    document.body.dataset.view = view;
    statsView.hidden = view !== "stats";
    todayView.hidden = view !== "today";
    document.querySelectorAll("button[data-view]").forEach((b) => {
      const on = b.dataset.view === view;
      b.classList.toggle("active", on);
      if (on) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    renderToday();
    if (view === "stats") window.FollowUpStats.render(state.db, statsView, scheduleSave);
    else window.FollowUpStats.hideTip();
    if (view === "map") setTimeout(() => {
      map.invalidateSize();
      if (state.pendingFocus) {
        map.setView(state.pendingFocus, Math.max(map.getZoom(), 13), { animate: false });
        state.pendingFocus = null;
        state.pendingFit = false;
      } else if (state.pendingFit) {
        state.pendingFit = false;
        fitAll();
      }
    }, 0);
  }
  $("#viewNav").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (b) setView(b.dataset.view);
  });
  document.querySelector(".tabbar").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.action === "log") return logPicker();
    state.ficheOpen = false;
    renderFiche();
    setView(b.dataset.view);
  });
  $("#logBtn").addEventListener("click", logPicker);
  setView("today");

  // ---------- menu (⋯) ----------
  const menuList = $("#menuList");
  function toggleMenu(open) {
    menuList.hidden = !open;
    $("#menuBtn").setAttribute("aria-expanded", String(open));
  }
  $("#menuBtn").addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(menuList.hidden); });
  menuList.addEventListener("click", () => toggleMenu(false));
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu")) toggleMenu(false); });
  init();

  // Zorgt dat de app ook zonder bereik opent.
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
