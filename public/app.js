/* FollowUp Vaseo – administratie RF-naalden */
(() => {
  "use strict";

  const Core = window.FollowUpCore;
  const I18N = window.FollowUpI18n;
  const { t, tv } = I18N;
  const { STAGES, ACT_TYPES, AGE_GROUPS, REGIONS } = Core;
  const LOST_REASONS = ["Prijs", "Concurrent", "Geen budget", "Te weinig volume", "Geen interesse arts", "Andere"];
  // Wat in de databank staat (fase, type, keuzes bij een procedure) blijft Nederlands; tv() vertaalt het bij het tonen.
  const statusLabel = (k) => t("status." + k);
  const opt = (value, current, label = tv(value)) => `<option value="${esc(value)}" ${String(value) === String(current ?? "") ? "selected" : ""}>${esc(label)}</option>`;
  // Gegevens per procedure, zonder patiëntnamen of -nummers en met leeftijdsklasse i.p.v. exacte leeftijd. Volume = L × B × H × 0,524 (ellipsoïde).
  const PROC_FIELDS = [
    { key: "side", product: "Thyroid", options: ["Rechts", "Links", "Isthmus"] },
    { key: "noduleType", product: "Thyroid", options: ["Solide", "Overwegend solide", "Gemengd", "Overwegend cystisch", "Cystisch"] },
    { key: "tirads", product: "Thyroid", options: ["1", "2", "3", "4", "5"] },
    { key: "bethesda", product: "Thyroid", options: ["I", "II", "III", "IV", "V", "VI"] },
    { key: "indication", product: "Thyroid", options: ["Symptomatisch", "Cosmetisch", "Autonoom (hot)", "Recidief", "Andere"] },
    { key: "figo", product: "Fibroid", options: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "2-5"] },
    { key: "fibroidCount", product: "Fibroid", type: "number" },
    { key: "approach", product: "Fibroid", options: ["Transvaginaal", "Transcervicaal", "Laparoscopisch", "Percutaan"] },
    { key: "symptoms", product: "Fibroid", options: ["Bloedingen", "Druk / pijn", "Fertiliteit", "Combinatie", "Andere"] },
    { key: "length", type: "number", step: "0.1" },
    { key: "width", type: "number", step: "0.1" },
    { key: "depth", type: "number", step: "0.1" },
    { key: "volume", type: "number", step: "0.01" },
    { key: "needle" },
    { key: "needlesUsed", type: "number" },
    { key: "power", type: "number" },
    { key: "duration", type: "number" },
    { key: "energy", type: "number", step: "0.01" },
    { key: "anesthesia", options: ["Lokaal", "Sedatie", "Algemeen"] },
    { key: "complication", options: ["Geen", "Licht", "Ernstig"] },
    { key: "ageGroup", options: AGE_GROUPS },
    { key: "patientSex", options: ["V", "M", "X"] },
    { key: "followupDate", type: "date" },
    { key: "followupVolume", type: "number", step: "0.01" },
  ];
  const procLabel = (f) => t("proc." + f.key);
  const ellipsoid = (d) => (d.length && d.width && d.depth ? +(d.length * d.width * d.depth * 0.524 / 1000).toFixed(2) : "");
  // Volumereductie (VRR) in %, de standaardmaat voor RF-ablatie.
  const vrr = (d) => { const r = Core.vrr(d); return r === null ? null : Math.round(r); };
  const AUS_BOUNDS = [[-44, 112], [-10, 154]];

  const state = {
    db: { version: 1, hospitals: [] },
    selectedId: null,
    filter: { status: "all", product: "all", due: "all", query: "" },
    agenda: { tab: "planned", y: new Date().getFullYear(), m: new Date().getMonth(), day: "", owner: "" },
    log: { period: "quarter", type: "", product: "", author: "", query: "", limit: 50 },
    placing: null, // {id} wanneer we op de kaart een locatie kiezen
    dragId: null,
  };
  const markers = new Map();
  const store = window.FollowUpStore;
  const $ = (sel, root = document) => root.querySelector(sel);
  const statsView = $("#statsView");
  const todayView = $("#todayView");
  const agendaView = $("#agendaView");
  const usersView = $("#usersView");
  const can = store.can;
  // De lijst indicaties staat in het document en is uit te breiden (menu → Indicaties).
  const inds = () => Core.indications(state.db);

  // ---------- helpers ----------
  const { esc, uid, lastContact } = Core;
  const ymd = (y, m, d) => Core.localDate(new Date(y, m, d));
  const today = () => Core.localDate();
  const fmtDate = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString(I18N.locale, { day: "2-digit", month: "short", year: "numeric" }) : "—";
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
    if (n === 0) return t("rel.today");
    if (n === 1) return t("rel.yesterday");
    if (n < 0) return t("rel.in", { n: -n });
    return t("rel.ago", { n });
  }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 2600);
  }

  // ---------- rechten ----------
  // Welke knoppen verdwijnen, bepaalt styles.css aan de hand van dit attribuut (.w-only, .d-only, .i-only).
  function applyRights() {
    const flags = [];
    if (!can.write) flags.push("no-write");
    if (!can.remove) flags.push("no-delete");
    if (!can.importData) flags.push("no-import");
    document.body.dataset.rights = flags.join(" ");
    $("#usersBtn").hidden = !can.manageUsers;
  }
  // Knoppen weghalen kan met CSS, een invulveld op slot zetten niet.
  function lockFields(root) {
    if (can.write || !root) return;
    root.querySelectorAll("input, select, textarea").forEach((el) => {
      if (el.tagName === "SELECT" || el.type === "checkbox" || el.type === "radio") el.disabled = true;
      else el.readOnly = true;
    });
  }

  // ---------- wie heeft dit ingevoerd ----------
  // date is wanneer het contactmoment gebeurde, createdAt wanneer iemand het in de app zette.
  const people = new Map(); // id → naam, uit app_users
  async function loadPeople() {
    try {
      people.clear();
      for (const u of await store.users()) if (u.name && u.role !== "none") people.set(u.id, u.name);
    } catch (e) { /* lokaal of schema nog niet uitgevoerd: dan tonen we geen namen */ }
  }
  const myStamp = () => store.me().id || store.me().name || "";
  function stamp(rec, isNew) {
    if (isNew) { rec.createdBy = myStamp(); rec.createdAt = today(); }
    rec.updatedBy = myStamp();
    rec.updatedAt = today();
    return rec;
  }
  // Oudere contactmomenten hebben een e-mailadres als stempel; dat tonen we zoals het is.
  function personName(v) {
    if (!v) return "";
    if (v === store.me().id) return store.me().name;
    return people.get(v) || (/^[0-9a-f-]{36}$/.test(v) ? "" : v);
  }
  function stampLine(rec) {
    if (!rec) return "";
    const lines = [];
    if (rec.createdAt || rec.createdBy) {
      const by = personName(rec.createdBy);
      if (by || rec.createdAt) lines.push(by && rec.createdAt ? t("stamp.created", { name: by, date: fmtDate(rec.createdAt) })
        : by ? t("stamp.createdBy", { name: by }) : t("stamp.createdOn", { date: fmtDate(rec.createdAt) }));
    }
    if (rec.updatedAt && (rec.updatedAt !== rec.createdAt || rec.updatedBy !== rec.createdBy)) {
      const by = personName(rec.updatedBy);
      lines.push(by ? t("stamp.updated", { name: by, date: fmtDate(rec.updatedAt) }) : t("stamp.updatedOn", { date: fmtDate(rec.updatedAt) }));
    }
    return lines.length ? `<p class="muted stamp">${esc(lines.join(" · "))}</p>` : "";
  }
  // Namen om uit te kiezen bij "Verantwoordelijke" en in de filters: gebruikers plus wat al ingevuld staat.
  const ownerNames = () => [...new Set([...people.values(), ...state.db.hospitals.map((h) => h.owner.trim())].filter(Boolean))].sort((a, b) => a.localeCompare(b));

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
    if (!can.write) return; // alleen lezen: niets bewaren, de databank zou het ook weigeren
    sync.dirty = true;
    sync.localOk = writeLocal(MINE_KEY, state.db);
    setSaveState(t("save.saving"));
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
          toast(t("save.merged"));
        }
      }
      removeLocal(MINE_KEY);
      setSaveState(t("save.saved"));
      if (sync.banner) syncBanner("");
    } catch (e) {
      saveFailed(e);
      sync.retry = setTimeout(flush, 30000);
    } finally {
      sync.running = false;
    }
  }
  function saveFailed(e) {
    const where = t(sync.localOk ? "save.whereDevice" : "save.whereWindow");
    if (navigator.onLine === false) {
      setSaveState(t(sync.localOk ? "save.offlineKept" : "save.offline"), !sync.localOk);
      syncBanner(t("save.noConnection", { where }));
      return;
    }
    setSaveState(t("save.failed"), true);
    const hint = t(store.mode === "local" ? "save.hintLocal" : "save.hintOnline");
    syncBanner(t("save.failedBody", { hint, where, msg: e.message || t("save.conflict") }), true);
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
    if (empty && sync.base && sync.base.hospitals.length) throw new Error(t("store.empty"));
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
      if (await pullRemote() && !wasDirty) toast(t("save.updated"));
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
      renderAgenda();
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
      btn.textContent = t("btn.reload");
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
      const m = L.marker([h.lat, h.lng], { icon: pinIcon(h), draggable: h.id === state.dragId && can.write, zIndexOffset: h.id === state.selectedId ? 1000 : 0 })
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
        toast(t("map.locationUpdated"));
      });
      markers.set(h.id, m);
    }
    $("#dragHint").hidden = !(state.dragId && !state.ficheOpen);
    renderMapFilter();
  }
  function filterLabels() {
    const f = state.filter;
    return [
      f.status !== "all" && statusLabel(f.status),
      f.product !== "all" && f.product,
      f.due !== "all" && t("due." + f.due),
      f.query && `“${f.query}”`,
    ].filter(Boolean);
  }
  function renderMapFilter() {
    const labels = filterLabels();
    $("#mapFilter").hidden = !labels.length;
    $("#mapFilterText").textContent = t("map.filter", { list: labels.join(" · ") });
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
    toast(t("map.locationSet"));
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
      ul.innerHTML = `<li class="empty">${esc(t("list.empty"))}${filterLabels().length ? ` <button class="link" data-reset>${esc(t("list.clear"))}</button>` : ""}</li>`;
      return;
    }
    ul.innerHTML = items.map((h) => {
      const lc = lastContact(h);
      const primary = h.contacts.find((c) => c.primary);
      const bits = [tv(h.stage)];
      if (lc) bits.push(t("rel.last", { when: relDays(lc) }));
      const selected = h.id === state.selectedId;
      return `<li class="${selected ? "selected" : ""}"><button class="row" data-id="${esc(h.id)}" ${selected ? 'aria-current="true"' : ""}>
        <i class="dot ${esc(h.status)}" aria-hidden="true"></i>
        <span class="row-body">
          <span class="name">${esc(h.name)}<span class="sr-only"> · ${esc(t("sr.status", { status: statusLabel(h.status) }))}</span>${isOverdue(h) ? `<span class="badge">${esc(t("badge.overdue"))}</span>` : ""}${h.lat == null ? `<span class="badge neutral">${esc(t("badge.noLocation"))}</span>` : ""}</span>
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
  // De indicatieknoppen volgen de lijst in het document.
  function renderProductFilter() {
    const list = inds();
    if (state.filter.product !== "all" && !list.includes(state.filter.product)) state.filter.product = "all";
    const chip = (value, label) => `<button class="chip ${state.filter.product === value ? "active" : ""}" data-product="${esc(value)}" aria-pressed="${state.filter.product === value}">${esc(label)}</button>`;
    $("#productFilters").innerHTML = chip("all", t("filter.allIndications")) + list.map((p) => chip(p, p)).join("");
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
      <div class="kpi"><b><i class="dot green" aria-hidden="true"></i>${n("green")}</b><span>${esc(t("kpi.selling"))}</span></div>
      <div class="kpi"><b><i class="dot orange" aria-hidden="true"></i>${n("orange")}</b><span>${esc(t("kpi.progress"))}</span></div>
      <div class="kpi"><b><i class="dot red" aria-hidden="true"></i>${n("red")}</b><span>${esc(t("kpi.noContact"))}</span></div>
      <div class="kpi"><b>${procs}</b><span>${esc(t("kpi.procedures"))}</span></div>
      <div class="kpi"><b>${demos}</b><span>${esc(t("kpi.demos"))}</span></div>
      <div class="kpi"><b style="${late ? "color:var(--red)" : ""}">${late}</b><span>${esc(t("kpi.overdue"))}</span></div>`;
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
      tv(d.side), d.figo && `FIGO ${d.figo}`, tv(d.noduleType), d.tirads && `TI-RADS ${d.tirads}`,
      d.length && d.width && d.depth ? `${d.length}×${d.width}×${d.depth} mm` : "",
      d.volume && `${d.volume} ml`, d.energy && `${d.energy} kJ`,
      d.complication && d.complication !== "Geen" ? t("proc.complicationIs", { value: tv(d.complication) }) : "",
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
    const sectors = ["", "Public", "Private", "University"];

    el.innerHTML = `
      <div class="fiche-head">
        <div class="row">
          <i class="dot ${esc(h.status)}" style="width:14px;height:14px" aria-hidden="true"></i>
          <input class="fiche-title" data-field="name" value="${esc(h.name)}" aria-label="${esc(t("f.name"))}">
          <button class="icon-btn show-on-map" data-act="show-map" title="${esc(t("f.showOnMap"))}" aria-label="${esc(t("f.showOnMap"))}"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z"/><path d="M9 4v14M15 6v14"/></svg></button>
          <button class="icon-btn" data-act="close" title="${esc(t("btn.close"))}" aria-label="${esc(t("btn.close"))}">✕</button>
        </div>
        <div class="status-pick">
          ${["green", "orange", "red"].map((k) => `<button class="${k} ${h.status === k ? "active" : ""}" data-status="${k}" aria-pressed="${h.status === k}" ${can.write ? "" : "disabled"}><i class="dot ${k}" aria-hidden="true"></i>${esc(statusLabel(k))}</button>`).join("")}
        </div>
      </div>

      <div class="section">
        <div class="stats">
          <div class="stat"><b>${fmtDate(lc)}</b><span>${esc(t("f.lastContact"))} ${lc ? "· " + esc(relDays(lc)) : ""}</span></div>
          <div class="stat"><b>${countType(h, "Procedure")}</b><span>${esc(t("kpi.procedures"))}</span></div>
          <div class="stat"><b>${countType(h, "Demo")}</b><span>${esc(t("kpi.demos"))}</span></div>
          <div class="stat"><b>${countType(h, "Bestelling")}</b><span>${esc(t("f.needlesOrdered"))}</span></div>
        </div>
      </div>

      <div class="section">
        <h3>${esc(t("f.followup"))}</h3>
        <div class="grid">
          <label class="field">${esc(t("f.stage"))}
            <select data-field="stage">${STAGES.map((s) => opt(s, h.stage)).join("")}</select>
          </label>
          <label class="field">${esc(t("f.nextOn"))}
            <input type="date" data-field="nextActionDate" value="${esc(h.nextActionDate)}">
          </label>
          <label class="field full">${esc(t("f.next"))} ${late ? `<span class="badge">${esc(t("badge.late"))}</span>` : ""}
            <input data-field="nextAction" value="${esc(h.nextAction)}" placeholder="${esc(t("f.next.ph"))}">
          </label>
          ${h.nextActionDate ? `<div class="full next-acts w-only">
            <button class="btn small" data-act="next-done">✓ ${esc(t("btn.done"))}</button>
            <button class="btn small" data-act="next-snooze">${esc(t("btn.plusWeek"))}</button>
            <button class="btn small" data-act="next-ics">${esc(t("btn.toCalendar"))}</button>
          </div>` : ""}
          ${h.stage === "Niet geïnteresseerd" ? `<label class="field full">${esc(t("f.reason"))}
            <select data-field="lostReason"><option value="">—</option>${LOST_REASONS.map((r) => opt(r, h.lostReason)).join("")}</select>
          </label>` : ""}
        </div>
      </div>

      <div class="section">
        <h3>${esc(t("f.expected"))}</h3>
        <div class="grid">
          <label class="field">${esc(t("f.value"))}
            <input type="number" min="0" step="100" data-field="dealValue" value="${esc(h.dealValue)}">
          </label>
          <label class="field">${esc(t("f.winChance"))}
            <input type="number" min="0" max="100" data-field="winChance" value="${esc(h.winChance)}" placeholder="${Core.WIN_CHANCE[h.stage]}">
          </label>
          <label class="field full">${esc(t("f.closeDate"))}
            <input type="date" data-field="closeDate" value="${esc(h.closeDate)}">
          </label>
        </div>
      </div>

      <div class="section">
        <h3>${esc(t("f.activities"))} <button class="btn small primary w-only" data-act="add-activity">${esc(t("btn.addActivity"))}</button></h3>
        ${acts.length ? `<ul class="timeline">${acts.map((a) => {
          const c = h.contacts.find((x) => x.id === a.contactId);
          const sub = [a.product, c && c.name, (a.type === "Procedure" || a.type === "Bestelling") && a.qty ? t("a.qtyIs", { n: a.qty }) : "", personName(a.createdBy)].filter(Boolean).join(" · ");
          const det = procSummary(a.details);
          return `<li>
            <div class="t-date">${fmtDate(a.date)}</div>
            <div class="t-body">
              <div class="t-type"><span class="type-pill"></span>${esc(tv(a.type))}</div>
              ${sub ? `<div class="t-sub">${esc(sub)}</div>` : ""}
              ${det ? `<div class="t-sub">${esc(det)}</div>` : ""}
              ${a.note ? `<div class="t-note">${esc(a.note)}</div>` : ""}
            </div>
            <div><button class="icon-btn w-only" data-act="edit-activity" data-id="${esc(a.id)}" title="${esc(t("btn.edit"))}" aria-label="${esc(t("a.editAria"))}">✎</button></div>
          </li>`;
        }).join("")}</ul>` : `<p class="muted">${esc(t("f.noActivities"))}</p>`}
      </div>

      <div class="section">
        <h3>${esc(t("f.contacts"))} <button class="btn small w-only" data-act="add-contact">${esc(t("btn.addContact"))}</button></h3>
        ${contacts.length ? contacts.map((c) => `
          <div class="contact ${c.primary ? "primary" : ""}">
            <div class="c-actions w-only">
              <button class="icon-btn" data-act="primary" data-id="${esc(c.id)}" title="${esc(t(c.primary ? "c.primary" : "c.makePrimary"))}" aria-label="${esc(t(c.primary ? "c.primary" : "c.makePrimary"))}" aria-pressed="${c.primary}">${c.primary ? "★" : "☆"}</button>
              <button class="icon-btn" data-act="edit-contact" data-id="${esc(c.id)}" title="${esc(t("btn.edit"))}" aria-label="${esc(t("c.editAria", { name: c.name }))}">✎</button>
            </div>
            <div class="c-name">${esc(c.name)}${c.primary ? `<span class="tag primary">${esc(t("c.primary"))}</span>` : ""}${c.product ? `<span class="tag">${esc(c.product === "Beide" ? bothLabel() : c.product)}</span>` : ""}</div>
            ${c.role ? `<div class="c-role">${esc(c.role)}</div>` : ""}
            ${c.phone ? `<div class="c-line">☎ <a href="tel:${esc(c.phone.replace(/[^\d+]/g, ""))}">${esc(c.phone)}</a></div>` : ""}
            ${c.email ? `<div class="c-line">✉ <a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>` : ""}
            ${c.address ? `<div class="c-line muted">${esc(c.address)}</div>` : ""}
            ${c.notes ? `<div class="c-line muted">ⓘ ${esc(c.notes)}</div>` : ""}
          </div>`).join("") : `<p class="muted">${esc(t("f.noContacts"))}</p>`}
      </div>

      <div class="section">
        <h3>${esc(t("f.data"))}</h3>
        <div class="grid">
          <label class="field full">${esc(t("f.sector"))}
            <select data-field="sector">${sectors.map((k) => opt(k, h.sector, k || "—")).join("")}</select>
          </label>
          <div class="field full"><span style="font-size:11px;color:var(--muted)">${esc(t("f.indications"))}</span>
            <div class="toggles">${[...new Set([...inds(), ...h.products])].map((p) => `<label><input type="checkbox" data-product="${esc(p)}" ${h.products.includes(p) ? "checked" : ""}>${esc(p)}</label>`).join("")}</div>
          </div>
          <label class="field">${esc(t("f.region"))}
            <select data-field="region"><option value="">—</option>${REGIONS.map((r) => opt(r, h.region)).join("")}</select>
          </label>
          <label class="field">${esc(t("f.owner"))}
            <input data-field="owner" value="${esc(h.owner)}" list="ownerList" placeholder="${esc(t("f.owner.ph"))}">
            <datalist id="ownerList">${ownerNames().map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
          </label>
          <label class="field full">${esc(t("f.address"))}
            <input data-field="address" value="${esc(h.address)}">
          </label>
          <div class="field full w-only">
            <span style="font-size:11px;color:var(--muted)">${esc(t("f.location"))}</span>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:3px">
              ${h.lat == null
                ? `<button class="btn small primary" data-act="place">${esc(t("btn.place"))}</button>`
                : `<button class="btn small ${state.dragId === h.id ? "primary" : ""}" data-act="drag">${esc(t(state.dragId === h.id ? "btn.dragDone" : "btn.drag"))}</button>
                   <button class="btn small" data-act="place">${esc(t("btn.placeNew"))}</button>`}
            </div>
          </div>
          <label class="field full">${esc(t("f.notes"))}
            <textarea data-field="notes" rows="4">${esc(h.notes)}</textarea>
          </label>
        </div>
      </div>

      <div class="fiche-foot">
        <button class="btn danger d-only" data-act="delete">${esc(t("btn.delete"))}</button>
        <button class="btn" data-act="close">${esc(t("btn.close"))}</button>
      </div>`;
    lockFields(el);
    if (can.write) attachAddressSearch(el.querySelector('[data-field="address"]'), (r) => {
      const cur = byId(h.id);
      if (!cur) return;
      cur.address = r.address;
      cur.lat = r.lat;
      cur.lng = r.lng;
      if (r.region) cur.region = r.region;
      scheduleSave();
      renderAll();
      focusOn(cur);
      toast(t("map.addressSet"));
    });
  }
  // "Beide" bij een contactpersoon betekent: alle indicaties.
  const bothLabel = () => t(inds().length === 2 ? "c.both" : "c.allIndications");

  // Velden in de fiche: opslaan zonder volledige herteken (focus blijft).
  // Tekst wordt al bij elke toetsaanslag bewaard, zodat een gesloten app niets verliest.
  $("#fiche").addEventListener("input", (e) => {
    const h = sel();
    const el = e.target;
    if (!can.write || !h || !el.dataset.field || !el.matches('input:not([type]), textarea')) return;
    h[el.dataset.field] = el.value;
    scheduleSave();
  });
  $("#fiche").addEventListener("change", (e) => {
    const h = sel();
    if (!h || !can.write) return;
    const el = e.target;
    const field = el.dataset.field;
    if (field === "stage") {
      const before = h.status;
      Core.setStage(h, el.value, today());
      if (h.status !== before) toast(t("toast.status", { status: statusLabel(h.status) }));
    } else if (field) {
      h[field] = el.type === "number" ? (el.value === "" ? "" : Number(el.value)) : el.value;
      if (field === "name" && !el.value.trim()) { h.name = "Naamloos"; el.value = h.name; }
    } else if (el.dataset.product) {
      const p = el.dataset.product;
      h.products = el.checked ? [...new Set([...h.products, p])] : h.products.filter((x) => x !== p);
    } else return;
    scheduleSave();
    renderList();
    renderKpis();
    renderToday();
    renderAgenda();
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
    if (sb) { if (can.write) setStatus(h, sb.dataset.status); return; }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (!can.write && !["close", "show-map"].includes(b.dataset.act)) return;
    const id = b.dataset.id;
    switch (b.dataset.act) {
      case "close": return closeFiche();
      case "show-map":
        state.ficheOpen = false;
        setView("map");
        renderAll();
        if (h.lat != null) state.pendingFocus = [h.lat, h.lng];
        else toast(t("map.noLocation"));
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
        } else if (state.dragId) toast(t("map.dragHint"));
        return renderAll();
      case "next-done": return nextDone(h);
      case "next-snooze": return nextSnooze(h);
      case "next-ics": return downloadIcs(h);
      case "delete":
        if (can.remove && confirm(t("confirm.deleteHospital", { name: h.name }))) {
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
    toast(t("toast.actionDone"));
  }
  function nextSnooze(h) {
    h.nextActionDate = Core.addDays(today() > h.nextActionDate ? today() : h.nextActionDate, 7);
    scheduleSave();
    renderAll();
    toast(t("toast.moved", { date: fmtDate(h.nextActionDate) }));
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
      `SUMMARY:${text(`${h.name}: ${h.nextAction || t("ics.followUp")}`)}`,
      "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n"), "text/calendar");
  }

  // ---------- vandaag ----------
  function renderToday() {
    if (todayView.hidden) return;
    const td = today();
    const g = Core.dueGroups(state.db.hospitals, td);
    const main = (h, title, sub) => `<button class="today-main" data-open="${esc(h.id)}">
        <i class="dot ${esc(h.status)}" aria-hidden="true"></i>
        <span class="row-body"><span class="name">${esc(title)}<span class="sr-only"> · ${esc(t("sr.status", { status: statusLabel(h.status) }))}</span></span><span class="meta">${esc(sub)}</span></span>
      </button>`;
    const acts = (h, withNext) => `<span class="today-acts w-only">
        <button class="btn small primary" data-log="${esc(h.id)}">${esc(t("btn.log"))}</button>
        ${withNext ? `<button class="btn small" data-snooze="${esc(h.id)}">${esc(t("btn.plusWeek"))}</button><button class="btn small" data-done="${esc(h.id)}" aria-label="${esc(t("today.doneAria"))}">✓</button>` : ""}
      </span>`;
    const sub = (h) => [h.nextAction || t("today.noDescription"), fmtDate(h.nextActionDate)].join(" · ");
    const group = (title, items) => (items.length ? `<section class="today-group"><h3>${esc(title)} <span class="count">${items.length}</span></h3><ul>${items.join("")}</ul></section>` : "");
    const rows = (list, fn, withNext) => list.map((h) => `<li>${main(h, h.name, fn(h))}${acts(h, withNext)}</li>`);
    const silent = (h) => {
      const lc = lastContact(h);
      return [tv(h.stage), lc ? t("rel.last", { when: relDays(lc) }) : t("today.neverContacted")].join(" · ");
    };
    const groups = [
      group(t("today.overdue"), rows(g.overdue, sub, true)),
      group(t("today.today"), rows(g.today, sub, true)),
      group(t("today.followups"), g.followups.map(({ hospital: h, activity: a }) =>
        `<li>${main(h, h.name, t("today.followupLine", { date: fmtDate(a.details.followupDate), proc: fmtDate(a.date) }))}<span class="today-acts w-only"><button class="btn small" data-edit-act="${esc(h.id)}|${esc(a.id)}">${esc(t("btn.fillResult"))}</button></span></li>`)),
      group(t("today.week"), rows(g.week, sub, true)),
      group(t("due.noAction"), rows(g.noAction, silent, false)),
      group(t("today.stale", { n: Core.STALE_DAYS }), rows(g.stale, silent, false)),
    ].join("");
    const lastExport = readLocal(EXPORT_KEY);
    const age = lastExport ? Core.daysBetween(lastExport, td) : null;
    const reminder = state.db.hospitals.length && (age === null || age > 7)
      ? `<p class="today-note">${esc(age === null ? t("today.noBackup") : t("today.backupAge", { n: age }))} <button class="link" data-export>${esc(t("today.downloadNow"))}</button></p>`
      : "";
    const prospects = g.uncontacted
      ? `<p class="today-note">${esc(t(g.uncontacted === 1 ? "today.uncontactedOne" : "today.uncontacted", { n: g.uncontacted }))} <button class="link" data-prospects>${esc(t("today.showList"))}</button></p>`
      : "";
    todayView.innerHTML = `
      <div class="s-head"><h2>${esc(t("nav.today"))}</h2><span class="muted">${esc(fmtDate(td))}</span></div>
      ${groups || `<p class="today-empty">${esc(t("today.empty"))}</p>`}
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
    if (d.editAct) return editActivity(d.editAct);
    if ("export" in d) return exportJson();
    if ("prospects" in d) {
      resetFilters();
      $('#statusFilters [data-status="red"]').click();
      setView(innerWidth > 760 ? "map" : "list");
    }
  });
  function editActivity(ref) {
    const [hid, aid] = ref.split("|");
    const h = byId(hid);
    const a = h && h.activities.find((x) => x.id === aid);
    if (a) activityDialog(h, a);
  }

  // ---------- agenda ----------
  // Wat gepland staat over alle ziekenhuizen heen: de volgende actie van elk ziekenhuis en de
  // follow-ups van procedures. Een maandrooster om te zien waar het druk is, eronder de lijst.
  // Maand- en weekdagnamen komen van Intl, niet uit i18n.js.
  function plannedAll() {
    const who = state.agenda.owner;
    const out = [];
    for (const h of state.db.hospitals) {
      if (who && h.owner.trim() !== who) continue;
      if (h.nextActionDate) out.push({ h, date: h.nextActionDate, kind: "action" });
      for (const a of h.activities) {
        const d = a.type === "Procedure" && a.details;
        if (d && d.followupDate && !d.followupVolume) out.push({ h, a, date: d.followupDate, kind: "followup" });
      }
    }
    return out.sort((x, y) => x.date.localeCompare(y.date) || x.h.name.localeCompare(y.h.name));
  }
  const weekday = (date) => new Date(date + "T00:00:00").toLocaleDateString(I18N.locale, { weekday: "short", day: "numeric", month: "short" });
  function agendaRow({ h, a, date, kind }) {
    const text = kind === "action" ? (h.nextAction || t("today.noDescription")) : t("agenda.followupOf", { date: fmtDate(a.date) });
    const sub = [kind === "followup" ? t("agenda.followup") : "", text, h.owner].filter(Boolean).join(" · ");
    return `<li class="ag-row ${date < today() ? "late" : ""}">
      <div class="ag-date"><b>${esc(weekday(date))}</b><span>${esc(relDays(date))}</span></div>
      <button class="ag-body" data-open="${esc(h.id)}">
        <span class="ag-name"><i class="dot ${esc(h.status)}" aria-hidden="true"></i>${esc(h.name)}</span>
        <span class="ag-sub">${esc(sub)}</span>
      </button>
      <div class="ag-acts w-only">
        ${kind === "action"
          ? `<button class="btn small primary" data-log="${esc(h.id)}">${esc(t("btn.log"))}</button>
             <button class="btn small" data-snooze="${esc(h.id)}">${esc(t("btn.plusWeek"))}</button>
             <button class="btn small" data-done="${esc(h.id)}" aria-label="${esc(t("today.doneAria"))}">✓</button>`
          : `<button class="btn small" data-edit-act="${esc(h.id)}|${esc(a.id)}">${esc(t("btn.fillResult"))}</button>`}
      </div>
    </li>`;
  }
  const agendaTabs = () => `<div class="s-seg">${[["planned", "agenda.tabPlanned"], ["log", "agenda.tabLog"]].map(([k, key]) =>
    `<button data-ag-tab="${k}" aria-pressed="${state.agenda.tab === k}" class="${state.agenda.tab === k ? "active" : ""}">${esc(t(key))}</button>`).join("")}</div>`;

  function renderAgenda() {
    if (agendaView.hidden) return;
    if (state.agenda.tab === "log") return renderLog();
    const { y, m, day, owner } = state.agenda;
    const names = ownerNames();
    if (owner && !names.includes(owner)) state.agenda.owner = "";
    const items = plannedAll();
    const td = today();
    const month = `${y}-${String(m + 1).padStart(2, "0")}`;
    const overdue = items.filter((x) => x.date < td);
    const inMonth = items.filter((x) => x.date.startsWith(month));
    const byDay = new Map();
    for (const x of inMonth) byDay.set(x.date, [...(byDay.get(x.date) || []), x]);
    // 1 januari 2024 was een maandag; enkel om de weekdagnamen op te halen.
    const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(I18N.locale, { weekday: "short" }));
    const monthLabel = new Date(y, m, 1).toLocaleDateString(I18N.locale, { month: "long", year: "numeric" });
    const lead = (new Date(y, m, 1).getDay() + 6) % 7; // maandag vooraan
    const days = new Date(y, m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(`<span class="cal-day empty"></span>`);
    for (let d = 1; d <= days; d++) {
      const date = ymd(y, m, d);
      const list = byDay.get(date) || [];
      const dots = list.slice(0, 4).map((x) => `<i class="${x.kind}"></i>`).join("");
      const cls = ["cal-day", date === td ? "today" : "", date === day ? "sel" : "", list.length && date < td ? "late" : ""].filter(Boolean).join(" ");
      const label = list.length ? `${fmtDate(date)} · ${t("agenda.count", { n: list.length })}` : fmtDate(date);
      cells.push(`<button class="${cls}" data-day="${date}" aria-label="${esc(label)}" aria-pressed="${date === day}">
        <span class="cal-n">${d}</span>
        <span class="cal-dots">${dots}${list.length > 4 ? `<em>+${list.length - 4}</em>` : ""}</span>
      </button>`);
    }
    while (cells.length % 7) cells.push(`<span class="cal-day empty"></span>`); // laatste week aanvullen
    // Een voorbije maand tonen we volledig; "te laat" staat er dan niet nog eens boven.
    const past = month < td.slice(0, 7);
    const shown = day ? items.filter((x) => x.date === day) : past ? inMonth : inMonth.filter((x) => x.date >= td);
    agendaView.innerHTML = `
      <div class="s-head">
        <h2>${esc(t("nav.agenda"))}</h2>
        <div class="s-filters">
          <div class="ag-nav">
            <button class="btn small" data-ag="prev" aria-label="${esc(t("agenda.prevMonth"))}" title="${esc(t("agenda.prevMonth"))}">‹</button>
            <button class="btn small" data-ag="today">${esc(t("agenda.thisMonth"))}</button>
            <button class="btn small" data-ag="next" aria-label="${esc(t("agenda.nextMonth"))}" title="${esc(t("agenda.nextMonth"))}">›</button>
          </div>
          ${names.length ? `<label><select data-ag-owner aria-label="${esc(t("f.owner"))}"><option value="">${esc(t("agenda.everyone"))}</option>${names.map((n) => opt(n, state.agenda.owner, n)).join("")}</select></label>` : ""}
          ${agendaTabs()}
        </div>
      </div>
      <div class="cal">
        <div class="cal-month">${esc(monthLabel)}</div>
        <div class="cal-grid">
          ${weekdays.map((w) => `<span class="cal-wd">${esc(w)}</span>`).join("")}
          ${cells.join("")}
        </div>
        <div class="cal-key"><span><i class="action"></i>${esc(t("f.next"))}</span><span><i class="followup"></i>${esc(t("agenda.followup"))}</span></div>
      </div>
      ${items.length ? "" : `<p class="muted">${esc(t(state.agenda.owner ? "agenda.noneFor" : "agenda.none"))}</p>`}
      ${overdue.length && !day && !past ? `<div class="ag-block">
        <h3 class="ag-h">${esc(t("today.overdue"))} <span class="badge">${overdue.length}</span></h3>
        <ul class="ag-list">${overdue.map(agendaRow).join("")}</ul>
      </div>` : ""}
      ${items.length ? `<div class="ag-block">
        <h3 class="ag-h">${esc(day ? fmtDate(day) : monthLabel)}${day ? ` · <button class="link" data-ag="clear">${esc(t("agenda.wholeMonth"))}</button>` : ""}</h3>
        ${shown.length ? `<ul class="ag-list">${shown.map(agendaRow).join("")}</ul>`
          : `<p class="muted">${esc(t(day ? "agenda.dayEmpty" : past ? "agenda.monthNone" : "agenda.monthEmpty"))}</p>`}
      </div>` : ""}`;
  }

  // ---------- logboek ----------
  // De andere helft van de agenda: niet wat komt maar wat gebeurd is, over alle ziekenhuizen heen.
  const LOG_STEP = 50;
  const LOG_PERIODS = ["week", "month", "quarter", "year", "all"];
  function periodStart(period) {
    const d = new Date();
    const y = d.getFullYear(), m = d.getMonth();
    if (period === "week") return ymd(y, m, d.getDate() - ((d.getDay() + 6) % 7));
    if (period === "month") return ymd(y, m, 1);
    if (period === "quarter") return ymd(y, m - 3, d.getDate());
    if (period === "year") return ymd(y, 0, 1);
    return "";
  }
  // De week van een datum: de maandag als sleutel en het ISO-weeknummer (dat van de donderdag).
  function weekOf(date) {
    const d = new Date(date + "T00:00:00");
    const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
    const thu = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 3);
    const n = Math.floor(Math.round((thu - new Date(thu.getFullYear(), 0, 1)) / 86400000) / 7) + 1;
    const short = (x) => x.toLocaleDateString(I18N.locale, { day: "numeric", month: "short" });
    const year = thu.getFullYear() === new Date().getFullYear() ? "" : ` ${thu.getFullYear()}`;
    return { key: Core.localDate(mon), label: `${t("log.week", { n })} · ${short(mon)} – ${short(sun)}${year}` };
  }
  // Wie iets invoerde: de naam als we die kennen, anders wat er staat (oudere e-mailstempels).
  const authorOf = (a) => personName(a.createdBy);
  function logItems() {
    const L = state.log;
    const from = periodStart(L.period);
    const words = L.query.toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (const h of state.db.hospitals) {
      for (const a of h.activities) {
        if (from && a.date < from) continue;
        if (L.type && a.type !== L.type) continue;
        if (L.product && a.product !== L.product) continue;
        if (L.author && authorOf(a) !== L.author) continue;
        if (words.length) {
          const c = h.contacts.find((x) => x.id === a.contactId);
          const hay = [h.name, h.address, c && c.name, a.type, tv(a.type), a.product, a.note].join(" ").toLowerCase();
          if (!words.every((w) => hay.includes(w))) continue;
        }
        out.push({ h, a });
      }
    }
    return out.sort((x, y) => y.a.date.localeCompare(x.a.date) || x.h.name.localeCompare(y.h.name));
  }
  function logRow({ h, a }) {
    const c = h.contacts.find((x) => x.id === a.contactId);
    const sub = [tv(a.type), a.product, c && c.name, (a.type === "Procedure" || a.type === "Bestelling") && a.qty ? t("a.qtyIs", { n: a.qty }) : "", authorOf(a)].filter(Boolean).join(" · ");
    return `<li class="ag-row">
      <div class="ag-date"><b>${esc(weekday(a.date))}</b><span>${esc(relDays(a.date))}</span></div>
      <button class="ag-body" data-open="${esc(h.id)}">
        <span class="ag-name"><i class="dot ${esc(h.status)}" aria-hidden="true"></i>${esc(h.name)}</span>
        <span class="ag-sub">${esc(sub)}</span>
        ${a.note ? `<span class="ag-note">${esc(a.note)}</span>` : ""}
      </button>
      <div class="ag-acts w-only">
        <button class="icon-btn" data-edit-act="${esc(h.id)}|${esc(a.id)}" title="${esc(t("btn.edit"))}" aria-label="${esc(t("a.editAria"))}">✎</button>
      </div>
    </li>`;
  }
  // Alleen de lijst, niet de filters erboven: anders verliest het zoekveld zijn cursor bij elke letter.
  function renderLogBody() {
    const body = $("#logBody", agendaView);
    if (!body) return;
    const items = logItems();
    if (!items.length) { body.innerHTML = `<p class="muted">${esc(t("log.empty"))}</p>`; return; }
    const counts = {};
    for (const { a } of items) counts[a.type] = (counts[a.type] || 0) + 1;
    const perType = Object.entries(counts).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${n} ${tv(k).toLowerCase()}`).join(" · ");
    const visible = items.slice(0, state.log.limit);
    const weeks = [];
    for (const x of visible) {
      const w = weekOf(x.a.date);
      if (!weeks.length || weeks[weeks.length - 1].key !== w.key) weeks.push({ ...w, rows: [] });
      weeks[weeks.length - 1].rows.push(x);
    }
    body.innerHTML = `
      <p class="log-sum"><b>${esc(t(items.length === 1 ? "log.countOne" : "log.count", { n: items.length }))}</b>${perType ? ` — ${esc(perType)}` : ""}
        <button class="btn small" data-log-export>${esc(t("log.export"))}</button></p>
      ${weeks.map((w) => `<div class="ag-block">
        <h3 class="ag-h">${esc(w.label)}</h3>
        <ul class="ag-list">${w.rows.map(logRow).join("")}</ul>
      </div>`).join("")}
      ${items.length > visible.length ? `<p class="log-more"><span class="muted">${esc(t("log.shown", { n: visible.length, total: items.length }))}</span>
        <button class="btn small" data-log-more>${esc(t("log.more"))}</button></p>` : ""}`;
  }
  function renderLog() {
    const L = state.log;
    const authors = [...new Set(state.db.hospitals.flatMap((h) => h.activities.map(authorOf)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    if (L.author && !authors.includes(L.author)) L.author = "";
    if (L.product && !inds().includes(L.product)) L.product = "";
    const pick = (key, list, all, label = tv) => `<label><select data-log-pick="${key}" aria-label="${esc(all)}"><option value="">${esc(all)}</option>${list.map((k) => opt(k, L[key], label(k))).join("")}</select></label>`;
    agendaView.innerHTML = `
      <div class="s-head">
        <h2>${esc(t("nav.agenda"))}</h2>
        <div class="s-filters">${agendaTabs()}</div>
      </div>
      <div class="s-filters log-filters">
        <label><select data-log-pick="period" aria-label="${esc(t("log.period"))}">${LOG_PERIODS.map((p) => opt(p, L.period, t("log.period." + p))).join("")}</select></label>
        ${pick("type", ACT_TYPES, t("log.allTypes"))}
        ${pick("product", inds(), t("filter.allIndications"), (k) => k)}
        ${authors.length ? pick("author", authors, t("log.anyAuthor"), (k) => k) : ""}
        <input type="search" data-log-search value="${esc(L.query)}" placeholder="${esc(t("log.search"))}" aria-label="${esc(t("log.search"))}">
      </div>
      <div id="logBody"></div>`;
    renderLogBody();
  }

  agendaView.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const d = b.dataset;
    const A = state.agenda;
    if (d.agTab) { A.tab = d.agTab; return renderAgenda(); }
    if (d.day) { A.day = A.day === d.day ? "" : d.day; return renderAgenda(); }
    if (d.ag === "clear") { A.day = ""; return renderAgenda(); }
    if (d.ag === "today") { const n = new Date(); Object.assign(A, { y: n.getFullYear(), m: n.getMonth(), day: "" }); return renderAgenda(); }
    if (d.ag === "prev" || d.ag === "next") {
      const n = new Date(A.y, A.m + (d.ag === "next" ? 1 : -1), 1);
      Object.assign(A, { y: n.getFullYear(), m: n.getMonth(), day: "" });
      return renderAgenda();
    }
    if (d.open) return select(d.open, false);
    if (d.log) return activityDialog(byId(d.log), null);
    if (d.snooze) return nextSnooze(byId(d.snooze));
    if (d.done) return nextDone(byId(d.done));
    if (d.editAct) return editActivity(d.editAct);
    if ("logMore" in d) { state.log.limit += LOG_STEP; return renderLogBody(); }
    if ("logExport" in d) return download(`${t("file.log")}-${today()}.csv`, activitiesCsv(logItems()), "text/csv");
  });
  agendaView.addEventListener("change", (e) => {
    const el = e.target;
    if ("agOwner" in el.dataset) { state.agenda.owner = el.value; state.agenda.day = ""; return renderAgenda(); }
    if (el.dataset.logPick) { state.log[el.dataset.logPick] = el.value; state.log.limit = LOG_STEP; renderLogBody(); }
  });
  agendaView.addEventListener("input", (e) => {
    if (!("logSearch" in e.target.dataset)) return;
    state.log.query = e.target.value.trim();
    state.log.limit = LOG_STEP;
    renderLogBody();
  });

  // ---------- gebruikers (enkel beheerder) ----------
  // Nieuwe accounts maak je in het Supabase-dashboard: dat vraagt een sleutel die niet in een publieke app hoort.
  // Hier geef je ze een naam en een rol.
  let users = [];
  async function loadUsers() {
    const head = `<div class="s-head"><h2>${esc(t("users.title"))}</h2></div><p class="muted u-intro">${esc(t("users.intro"))}</p>`;
    usersView.innerHTML = `${head}<p class="muted">${esc(t("users.loading"))}</p>`;
    try {
      users = (await store.users()).map((u) => ({ id: u.id, name: u.name || "", role: store.ROLES.includes(u.role) ? u.role : "none" }));
    } catch (e) {
      usersView.innerHTML = `${head}<p class="login-error">${esc(t("users.failed", { msg: e.message }))}</p>`;
      return;
    }
    renderUsers();
  }
  function renderUsers() {
    const meId = store.me().id;
    const order = ["admin", "editor", "contributor", "viewer", "none"];
    usersView.innerHTML = `
      <div class="s-head"><h2>${esc(t("users.title"))}</h2></div>
      <p class="muted u-intro">${esc(t("users.intro"))}</p>
      ${users.length ? `<div class="u-list">${users.map((u) => `
        <div class="u-row">
          <div class="u-who">
            <input data-uid="${esc(u.id)}" data-ufield="name" value="${esc(u.name)}" placeholder="${esc(t("users.name"))}" aria-label="${esc(t("users.name"))}">
            ${u.id === meId ? `<small>${esc(t("users.you"))}</small>` : ""}
          </div>
          <div class="u-role">
            <select data-uid="${esc(u.id)}" data-ufield="role" aria-label="${esc(t("users.role"))}">${order.map((r) => opt(r, u.role, t("role." + r))).join("")}</select>
            <small>${esc(t("role." + u.role + ".hint"))}</small>
          </div>
        </div>`).join("")}</div>` : `<p class="muted">${esc(t("users.none"))}</p>`}`;
  }
  usersView.addEventListener("change", async (e) => {
    const el = e.target.closest("[data-uid]");
    const u = el && users.find((x) => x.id === el.dataset.uid);
    if (!u) return;
    const before = { ...u };
    if (el.dataset.ufield === "name") u.name = el.value.trim();
    else u.role = el.value;
    try {
      await store.saveUser(u);
      await loadPeople();
      renderUsers();
      toast(t(u.id === store.me().id && u.role !== before.role ? "users.reloadNeeded" : "users.saved"));
    } catch (err) {
      Object.assign(u, before);
      renderUsers();
      toast(t("users.failed", { msg: err.message }));
    }
  });

  // ---------- indicaties ----------
  // De lijst waarvoor de naalden verkocht worden. Toevoegen kan hier; een bestaande naam blijft staan,
  // want contactmomenten, doelen en prijzen verwijzen ernaar.
  function indicationsDialog() {
    openDialog(`
      <h2>${esc(t("ind.title"))}</h2>
      <p class="muted">${esc(t("ind.intro"))}</p>
      <div class="toggles ind-list">${inds().map((p) => `<span class="tag">${esc(p)}</span>`).join("")}</div>
      <label class="field full w-only" style="margin-top:14px">${esc(t("ind.new"))}<input name="name" required maxlength="40" placeholder="${esc(t("ind.new.ph"))}"></label>
      <div class="actions">
        <button class="btn" value="cancel" formnovalidate>${esc(t("btn.close"))}</button>
        <button class="btn primary w-only" value="ok">${esc(t("btn.add"))}</button>
      </div>`, (data) => {
      const name = (data.name || "").trim();
      if (!name || !can.write) return;
      if (inds().some((x) => x.toLowerCase() === name.toLowerCase())) return toast(t("ind.exists", { name }));
      state.db.indications = [...inds(), name];
      scheduleSave();
      renderProductFilter();
      renderAll();
      toast(t("ind.added", { name }));
    });
  }

  // Snel loggen vanuit de tabbalk: eerst het ziekenhuis kiezen.
  function logPicker() {
    if (!can.write) return toast(t("rights.readOnly"));
    const recent = [...state.db.hospitals].sort((a, b) => lastContact(b).localeCompare(lastContact(a)) || a.name.localeCompare(b.name));
    openDialog(`
      <h2>${esc(t("pick.title"))}</h2>
      <label class="field full">${esc(t("pick.hospital"))}<input id="pickSearch" type="search" placeholder="${esc(t("pick.ph"))}" autocomplete="off"></label>
      <ul class="pick-list" id="pickList"></ul>
      <div class="actions">
        <button class="btn" value="cancel" formnovalidate>${esc(t("btn.cancel"))}</button>
        <button type="button" class="btn" id="pickNew">${esc(t("pick.new"))}</button>
      </div>`, () => {});
    const list = $("#pickList");
    const paint = () => {
      const q = $("#pickSearch").value.trim();
      const nameHit = (h) => (h.name.toLowerCase().includes(q.toLowerCase()) ? 0 : 1);
      const items = recent.filter((h) => matchesQuery(h, q)).sort((x, y) => nameHit(x) - nameHit(y));
      list.innerHTML = items.map((h) => `<li><button type="button" data-pick="${esc(h.id)}"><i class="dot ${esc(h.status)}" aria-hidden="true"></i>${esc(h.name)}</button></li>`).join("") || `<li class="muted">${esc(t("pick.none"))}</li>`;
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
    list.setAttribute("aria-label", t("addr.aria"));
    list.hidden = true;
    input.after(list);
    let results = [], active = -1, timer = null, seq = 0, failed = false;

    const close = () => { list.hidden = true; active = -1; };
    const paint = () => {
      list.innerHTML = results.length
        ? results.map((r, i) => `<li data-i="${i}" role="option" aria-selected="${i === active}" class="${i === active ? "active" : ""}">${esc(r.address)}</li>`).join("")
        : `<li class="addr-empty">${esc(t(failed ? "addr.failed" : "addr.empty"))}</li>`;
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
    input.placeholder = t("addr.ph");
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
      <h2>${esc(t(c ? "c.editTitle" : "c.newTitle"))}</h2>
      <div class="grid">
        <label class="field full">${esc(t("c.name"))}<input name="name" required value="${esc(v.name)}"></label>
        <label class="field full">${esc(t("c.role"))}<input name="role" value="${esc(v.role)}" placeholder="${esc(t("c.role.ph"))}"></label>
        <label class="field">${esc(t("c.phone"))}<input name="phone" value="${esc(v.phone)}"></label>
        <label class="field">${esc(t("c.email"))}<input name="email" type="email" value="${esc(v.email)}"></label>
        <label class="field full">${esc(t("c.address"))}<input name="address" value="${esc(v.address)}"></label>
        <label class="field">${esc(t("f.indication"))}
          <select name="product">${opt("", v.product, "—")}${[...new Set([...inds(), ...(v.product && v.product !== "Beide" ? [v.product] : [])])].map((p) => opt(p, v.product, p)).join("")}${opt("Beide", v.product, bothLabel())}</select>
        </label>
        <label class="field" style="flex-direction:row;align-items:center;gap:6px;margin-top:16px"><input type="checkbox" name="primary" ${v.primary ? "checked" : ""} style="width:auto">${esc(t("c.primary"))}</label>
        <label class="field full">${esc(t("f.notes"))}<textarea name="notes" rows="3">${esc(v.notes)}</textarea></label>
      </div>
      ${stampLine(c)}
      <div class="actions">
        ${c ? `<button class="btn danger d-only" value="delete" formnovalidate style="margin-right:auto">${esc(t("btn.delete"))}</button>` : ""}
        <button class="btn" value="cancel" formnovalidate>${esc(t("btn.cancel"))}</button>
        <button class="btn primary" value="ok">${esc(t("btn.save"))}</button>
      </div>`, (data, action) => {
      // Het document kan ondertussen samengevoegd zijn: altijd de actuele versie opzoeken.
      const cur = byId(h.id);
      if (!cur) return toast(t("toast.hospitalGone"));
      if (action === "delete") {
        if (!can.remove || !confirm(t("confirm.deleteContact", { name: c.name }))) return;
        cur.contacts = cur.contacts.filter((x) => x.id !== c.id);
        cur.activities.forEach((x) => { if (x.contactId === c.id) x.contactId = ""; });
      } else {
        const existing = c && cur.contacts.find((x) => x.id === c.id);
        const rec = existing || { id: uid() };
        Object.assign(rec, {
          name: data.name.trim(), role: data.role.trim(), phone: data.phone.trim(), email: data.email.trim(),
          address: data.address.trim(), product: data.product, notes: data.notes.trim(), primary: !!data.primary,
        });
        stamp(rec, !existing);
        if (rec.primary) cur.contacts.forEach((x) => { if (x !== rec) x.primary = false; });
        if (!existing) cur.contacts.push(rec);
        if (rec.product && rec.product !== "Beide" && !cur.products.includes(rec.product)) cur.products.push(rec.product);
      }
      scheduleSave();
      renderAll();
    });
  }

  function activityDialog(h, a) {
    if (!h || !can.write) return;
    const v = a || { date: today(), type: "Bezoek", product: h.products.length === 1 ? h.products[0] : "", contactId: (h.contacts.find((c) => c.primary) || {}).id || "", qty: "", note: "" };
    const products = [...new Set([...inds(), ...(v.product ? [v.product] : [])])];
    const form = openDialog(`
      <h2>${esc(t(a ? "a.editTitle" : "a.newTitle"))} · ${esc(h.name)}</h2>
      <div class="grid">
        <label class="field">${esc(t("a.date"))}<input type="date" name="date" required value="${esc(v.date)}"></label>
        <fieldset class="full type-pick"><legend>${esc(t("a.type"))}</legend>
          ${ACT_TYPES.map((k) => `<label><input type="radio" name="type" value="${esc(k)}" ${k === v.type ? "checked" : ""}><span>${esc(tv(k))}</span></label>`).join("")}
        </fieldset>
        <label class="field">${esc(t("f.indication"))}
          <select name="product">${opt("", v.product, "—")}${products.map((p) => opt(p, v.product, p)).join("")}</select>
        </label>
        <label class="field">${esc(t("a.contact"))}
          <select name="contactId"><option value="">—</option>${h.contacts.map((c) => opt(c.id, v.contactId, c.name)).join("")}</select>
        </label>
        <label class="field full" id="qtyField">${esc(t("a.qty"))} <span id="qtyLabel"></span><input type="number" min="1" name="qty" value="${esc(v.qty)}" placeholder="1"></label>
        <div class="full proc" id="procFields">
          <div class="proc-title">${esc(t("proc.title"))} <span class="muted">${esc(t("proc.optional"))}</span></div>
          <p class="muted proc-warn">${esc(t("proc.warn"))}</p>
          <div class="grid">${PROC_FIELDS.map((f) => {
            const val = (v.details || {})[f.key] ?? "";
            const input = f.options
              ? `<select name="d_${f.key}"><option value="">—</option>${f.options.map((o) => opt(o, val)).join("")}</select>`
              : `<input name="d_${f.key}" type="${f.type || "text"}" ${f.step ? `step="${f.step}"` : ""} min="0" value="${esc(val)}" placeholder="${f.key === "needle" ? esc(t("proc.needle.ph")) : ""}">`;
            return `<label class="field" data-for="${f.product || ""}">${esc(procLabel(f))}${input}</label>`;
          }).join("")}</div>
          <p class="muted" id="vrrInfo"></p>
        </div>
        <label class="field full">${esc(t("a.note"))}<textarea name="note" rows="4" placeholder="${esc(t("a.note.ph"))}">${esc(v.note)}</textarea></label>
        ${a ? "" : `<div class="full next-box">
          <div class="proc-title">${esc(t("f.next"))}</div>
          <div class="grid">
            <label class="field full">${esc(t("a.nextWhat"))}<input name="nextAction" value="${esc(h.nextAction)}" placeholder="${esc(t("a.nextWhat.ph"))}"></label>
            <label class="field full">${esc(t("a.nextWhen"))}<input type="date" name="nextActionDate" value="${esc(h.nextActionDate)}"></label>
          </div>
          <div class="next-acts">
            <button type="button" class="btn small" data-next="7">${esc(t("btn.plusWeek"))}</button>
            <button type="button" class="btn small" data-next="14">${esc(t("btn.plus2Weeks"))}</button>
            <button type="button" class="btn small" data-next="30">${esc(t("btn.plusMonth"))}</button>
            <button type="button" class="btn small" data-next="0">${esc(t("btn.none"))}</button>
          </div>
        </div>`}
      </div>
      ${stampLine(a)}
      <div class="actions">
        ${a ? `<button class="btn danger d-only" value="delete" formnovalidate style="margin-right:auto">${esc(t("btn.delete"))}</button>` : ""}
        <button class="btn" value="cancel" formnovalidate>${esc(t("btn.cancel"))}</button>
        <button class="btn primary" value="ok">${esc(t("btn.save"))}</button>
      </div>`, (data, action) => {
      const cur = byId(h.id);
      if (!cur) return toast(t("toast.hospitalGone"));
      if (action === "delete") {
        if (!can.remove || !confirm(t("confirm.deleteActivity"))) return;
        cur.activities = cur.activities.filter((x) => x.id !== a.id);
        if (cur.stage === "Klant" && !cur.activities.some((x) => x.type === "Bestelling")) toast(t("toast.noOrdersLeft"));
      } else {
        const existing = a && cur.activities.find((x) => x.id === a.id);
        const typeChanged = existing && existing.type !== data.type;
        const rec = existing || { id: uid() };
        const hasQty = data.type === "Procedure" || data.type === "Bestelling";
        Object.assign(rec, { date: data.date, type: data.type, product: data.product, contactId: data.contactId, qty: hasQty ? Number(data.qty) || 1 : "", note: data.note.trim() });
        stamp(rec, !existing);
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
    const refresh = () => {
      const type = form.elements.type.value;
      const product = form.elements.product.value;
      const show = type === "Procedure" || type === "Bestelling";
      form.elements.product.required = type === "Procedure"; // zonder indicatie telt een procedure niet mee in de doelen
      $("#qtyField", form).hidden = !show;
      $("#qtyLabel", form).textContent = t(type === "Procedure" ? "a.qtyProcedures" : "a.qtyNeedles");
      $("#procFields", form).hidden = type !== "Procedure";
      form.querySelectorAll("#procFields [data-for]").forEach((el) => {
        el.hidden = !!el.dataset.for && el.dataset.for !== product;
      });
      const num = (k) => Number(form.elements["d_" + k].value) || 0;
      const d = { length: num("length"), width: num("width"), depth: num("depth"), volume: num("volume"), followupVolume: num("followupVolume") };
      form.elements.d_volume.placeholder = ellipsoid(d) ? t("proc.calculated", { v: ellipsoid(d) }) : "";
      if (!d.volume) d.volume = ellipsoid(d);
      const r = vrr(d);
      $("#vrrInfo", form).textContent = r === null ? t("proc.volumeHint") : t("proc.vrrIs", { n: r });
    };
    form.oninput = refresh;
    form.onchange = refresh;
    refresh();
    if (!a) form.elements.note.focus(); // de datum klopt meestal al; op gsm opent die focus anders de datumkiezer
  }

  function applyActivity(h, act) {
    const next = Core.stageAfterActivity(h.stage, act.type);
    if (next === h.stage) return;
    Core.setStage(h, next, act.date || today());
    toast(t("toast.stage", { stage: tv(next) }));
  }

  // ---------- nieuw ziekenhuis ----------
  $("#addHospitalBtn").addEventListener("click", () => {
    if (!can.write) return toast(t("rights.readOnly"));
    openDialog(`
      <h2>${esc(t("h.newTitle"))}</h2>
      <div class="grid">
        <label class="field full">${esc(t("c.name"))}<input name="name" required></label>
        <label class="field full">${esc(t("f.sector"))}<select name="sector"><option value="">—</option><option>Public</option><option>Private</option><option>University</option></select></label>
        <label class="field full">${esc(t("f.address"))}<input name="address"></label>
        <input type="hidden" name="lat"><input type="hidden" name="lng"><input type="hidden" name="region">
      </div>
      <p class="muted" id="addrHint">${esc(t("h.addrHint"))}</p>
      <div class="actions">
        <button class="btn" value="cancel" formnovalidate>${esc(t("btn.cancel"))}</button>
        <button class="btn primary" value="ok">${esc(t("btn.create"))}</button>
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
        toast(t("h.created"));
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
      $("#addrHint").textContent = t("h.addrFound");
    });
    // Adres na het kiezen nog aangepast? Dan geldt de gekozen locatie niet meer.
    addr.addEventListener("input", () => {
      if (!form.lat.value) return;
      form.lat.value = form.lng.value = "";
      $("#addrHint").textContent = t("h.addrHint");
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
  const cols = (keys) => keys.map((k) => t("col." + k));
  // Contactmomenten als CSV: dezelfde kolommen voor de export en voor het logboek.
  function activitiesCsv(items) {
    return csv([
      cols(["date", "hospital", "type", "indication", "contact", "qty", "note", "addedBy"]),
      ...items.map(({ h, a }) => [a.date, h.name, tv(a.type), a.product, (h.contacts.find((c) => c.id === a.contactId) || {}).name, a.qty, a.note, personName(a.createdBy)])
        .sort((x, y) => y[0].localeCompare(x[0])),
    ]);
  }

  function exportJson() {
    download(`followup-vaseo-backup-${today()}.json`, JSON.stringify(state.db, null, 2), "application/json");
    writeLocal(EXPORT_KEY, today());
    renderToday();
  }
  $("#exportBtn").addEventListener("click", () => {
    openDialog(`
      <h2>${esc(t("btn.export"))}</h2>
      <p class="muted">${esc(t("export.hint"))}</p>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn" value="hospitals">${esc(t("export.hospitals"))}</button>
        <button class="btn" value="contacts">${esc(t("export.contacts"))}</button>
        <button class="btn" value="activities">${esc(t("export.activities"))}</button>
        <button class="btn" value="procedures">${esc(t("export.procedures"))}</button>
        <button class="btn" value="json">${esc(t("export.json"))}</button>
      </div>
      <div class="actions"><button class="btn" value="cancel">${esc(t("btn.close"))}</button></div>`, () => {});
    $("#dialogForm").onsubmit = (e) => {
      const kind = e.submitter && e.submitter.value;
      const hs = state.db.hospitals;
      const d = today();
      if (kind === "hospitals") {
        download(`${t("file.hospitals")}-${d}.csv`, csv([
          cols(["name", "sector", "region", "owner", "status", "stage", "value", "winChance", "closeDate", "lostReason", "indications", "lastContact", "procedures", "demos", "needles", "nextAction", "nextActionDate", "primaryContact", "address", "notes"]),
          ...hs.map((h) => [h.name, h.sector, h.region, h.owner, statusLabel(h.status), tv(h.stage), h.dealValue, Core.winChance(h), h.closeDate, tv(h.lostReason), h.products.join(", "), lastContact(h), countType(h, "Procedure"), countType(h, "Demo"), countType(h, "Bestelling"), h.nextAction, h.nextActionDate, (h.contacts.find((c) => c.primary) || {}).name, h.address, h.notes]),
        ]), "text/csv");
      } else if (kind === "contacts") {
        download(`${t("file.contacts")}-${d}.csv`, csv([
          cols(["hospital", "name", "role", "phone", "email", "address", "indication", "primaryContact", "notes"]),
          ...hs.flatMap((h) => h.contacts.map((c) => [h.name, c.name, c.role, c.phone, c.email, c.address, c.product === "Beide" ? bothLabel() : c.product, c.primary ? t("yes") : "", c.notes])),
        ]), "text/csv");
      } else if (kind === "activities") {
        download(`${t("file.activities")}-${d}.csv`, activitiesCsv(hs.flatMap((h) => h.activities.map((a) => ({ h, a })))), "text/csv");
      } else if (kind === "procedures") {
        download(`${t("file.procedures")}-${d}.csv`, csv([
          [...cols(["date", "hospital", "indication", "physician", "qty"]), ...PROC_FIELDS.map(procLabel), t("col.vrr"), t("col.note")],
          ...hs.flatMap((h) => h.activities.filter((a) => a.type === "Procedure").map((a) => {
            const det = a.details || {};
            const r = vrr(det);
            return [a.date, h.name, a.product, (h.contacts.find((c) => c.id === a.contactId) || {}).name, a.qty,
              ...PROC_FIELDS.map((f) => (f.options ? tv(det[f.key] ?? "") : det[f.key] ?? "")), r ?? "", a.note];
          })).sort((a, b) => b[0].localeCompare(a[0])),
        ]), "text/csv");
      } else if (kind === "json") {
        exportJson();
      }
    };
  });

  $("#importBtn").addEventListener("click", () => { if (can.importData) $("#importFile").click(); });
  $("#importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || !can.importData) return;
    try {
      const data = JSON.parse(await file.text());
      const problems = Core.checkImport(data);
      if (problems.length) throw new Error(problems.slice(0, 5).join(" "));
      if (!confirm(t("import.confirm", { n: data.hospitals.length }))) return;
      Core.prepare(data);
      // Eerst tonen, pas daarna opslaan: een bestand dat niet werkt, raakt de databank niet.
      const previous = state.db;
      state.db = data;
      state.selectedId = null;
      try {
        renderProductFilter();
        renderAll();
      } catch (err) {
        state.db = previous;
        renderProductFilter();
        renderAll();
        throw err;
      }
      scheduleSave();
      fitAll();
      toast(t("import.done"));
    } catch (err) {
      alert(t("import.failed", { msg: err.message }));
    }
  });

  // Terugzetten vanuit de automatische back-ups in de databank.
  $("#backupsBtn").addEventListener("click", async () => {
    if (!can.importData) return;
    let list;
    try {
      list = await store.backups();
    } catch (e) {
      return toast(t("backups.loadFailed", { msg: e.message }));
    }
    openDialog(`
      <h2>${esc(t("backups.title"))}</h2>
      <p class="muted">${esc(t("backups.intro"))}</p>
      ${list.length ? `<div class="backup-list">${list.map((b) => `<button type="button" class="btn" data-backup="${esc(b.key)}">${esc(b.label)}</button>`).join("")}</div>` : `<p class="muted">${esc(t("backups.none"))}</p>`}
      <div class="actions"><button class="btn" value="cancel">${esc(t("btn.close"))}</button></div>`, () => {});
    $("#dialogForm").onclick = async (e) => {
      const b = e.target.closest("[data-backup]");
      if (!b) return;
      try {
        const doc = await store.backup(b.dataset.backup);
        const problems = Core.checkImport(doc);
        if (problems.length) throw new Error(problems[0]);
        if (!confirm(t("backups.confirm", { when: b.textContent, n: doc.hospitals.length }))) return;
        Core.prepare(doc);
        $("#dialog").close();
        state.db = doc;
        state.selectedId = null;
        scheduleSave();
        renderProductFilter();
        renderAll();
        fitAll();
        toast(t("backups.done"));
      } catch (err) {
        toast(t("backups.failed", { msg: err.message }));
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
    if (!statsView.hidden) window.FollowUpStats.render(state.db, statsView, scheduleSave, { readOnly: !can.write });
  }
  function renderAll() {
    state.ficheStale = false;
    renderStats();
    renderToday();
    renderAgenda();
    renderKpis();
    renderList();
    renderMarkers();
    renderFiche();
    setTimeout(() => map.invalidateSize(), 0);
  }

  async function init() {
    const mine = readDoc(MINE_KEY);
    const cached = readDoc(BASE_KEY);
    let blocked = false;
    try {
      await store.ready();
      applyRights();
      if (can.noAccess) {
        // Aangemeld, maar een beheerder moet dit account nog een rol geven.
        blocked = true;
        throw new Error(t("rights.noAccess", { email: store.me().email }));
      }
      loadPeople().then(() => { if (sync.ready) renderAll(); });
      const { db, empty } = await store.load();
      if (empty && (mine || cached)) throw new Error(t("store.empty"));
      if (empty) {
        Core.prepare(db);
        state.db = db;
        sync.base = copy(db);
        if (can.write) offerSeed();
      } else {
        // Niet-verstuurde wijzigingen van een vorige keer samenvoegen met de nieuwste versie.
        state.db = mine || copy(db);
        Core.prepare(state.db);
        sync.base = mine ? cached : null;
        applyRemote(db);
      }
      setSaveState(can.write ? t("save.saved") : t("rights.readOnlyShort"));
    } catch (e) {
      applyRights();
      if (!blocked && (mine || cached)) {
        // Geen verbinding: verder werken met wat op dit toestel staat.
        state.db = mine || cached;
        Core.prepare(state.db);
        sync.base = cached;
        sync.dirty = !!mine;
        setSaveState(t("save.offlineKept"));
        syncBanner(t("save.offlineBanner"));
        sync.retry = setTimeout(flush, 30000);
      } else {
        showBanner(e.message);
      }
    }
    if (store.mode === "supabase") $("#logoutBtn").hidden = false;
    sync.ready = !blocked;
    renderProductFilter();
    renderAll();
    map.invalidateSize();
    fitAll();
    if (sync.dirty) flush();
  }

  // Lege online databank: startlijst (uit de Excel) laden of een back-up importeren.
  function offerSeed() {
    const b = $("#banner");
    b.textContent = t("seed.empty") + " ";
    const btn = document.createElement("button");
    btn.className = "btn small primary";
    btn.textContent = t("seed.load");
    btn.onclick = async () => {
      try {
        const res = await fetch("../data/seed.json", { cache: "no-store" });
        if (!res.ok) throw new Error(res.status);
        const doc = await res.json();
        Core.prepare(doc);
        state.db = doc;
        showBanner("");
        scheduleSave();
        renderProductFilter();
        renderAll();
        fitAll();
        toast(t("seed.loaded", { n: state.db.hospitals.length }));
      } catch (e) {
        alert(t("seed.missing"));
      }
    };
    b.append(btn, " " + t("seed.or"));
    b.hidden = false;
  }

  $("#logoutBtn").addEventListener("click", () => {
    if (sync.dirty && !confirm(t("confirm.logoutDirty"))) return;
    // Geen klantgegevens achterlaten op dit toestel.
    [BASE_KEY, MINE_KEY, EXPORT_KEY].forEach(removeLocal);
    store.signOut();
  });

  // ---------- schermen: vandaag / lijst / kaart / agenda / statistieken / gebruikers ----------
  // Op desktop staan lijst en kaart naast elkaar; op gsm kies je via de tabbalk.
  function setView(view) {
    if (view === "users" && !can.manageUsers) view = "today";
    document.body.dataset.view = view;
    statsView.hidden = view !== "stats";
    todayView.hidden = view !== "today";
    agendaView.hidden = view !== "agenda";
    usersView.hidden = view !== "users";
    document.querySelectorAll("button[data-view]").forEach((b) => {
      const on = b.dataset.view === view;
      b.classList.toggle("active", on);
      if (on) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    renderToday();
    renderAgenda();
    if (view === "users") loadUsers();
    if (view === "stats") renderStats();
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
  $("#usersBtn").addEventListener("click", () => { state.ficheOpen = false; renderFiche(); setView("users"); });
  $("#indicationsBtn").addEventListener("click", indicationsDialog);

  // ---------- taal ----------
  // De knop toont de taal waar je naartoe schakelt. Wat in de databank staat verandert niet.
  function updateLangBtn() {
    const b = $("#langBtn");
    b.textContent = t("lang.switch");
    b.title = t("lang.title");
    b.setAttribute("aria-label", t("lang.title"));
  }
  $("#langBtn").addEventListener("click", () => I18N.setLang(I18N.other));
  I18N.onChange(() => {
    updateLangBtn();
    if ($("#dialog").open) $("#dialog").close();
    if (!sync.dirty && !sync.banner && $("#saveState").textContent) setSaveState(can.write ? t("save.saved") : t("rights.readOnlyShort"));
    renderProductFilter();
    renderAll();
    if (document.body.dataset.view === "users") renderUsers();
  });
  document.documentElement.lang = I18N.lang;
  I18N.applyStatic();
  updateLangBtn();
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
