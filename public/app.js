/* FollowUp Vaseo – administratie RF-naalden */
(() => {
  "use strict";

  const STATUS = {
    green: "Aan het verkopen",
    orange: "In progress / actie nodig",
    red: "Nog geen contact",
  };
  const STAGES = [
    "Prospect", "Eerste contact", "Meeting / bezoek", "Demo gepland", "Demo gedaan",
    "Proefperiode", "Klant", "On hold", "Niet geïnteresseerd",
  ];
  const ACT_TYPES = {
    "Prospectie": "#7b61ff",
    "Telefoon": "#0f5b8f",
    "E-mail": "#3a8dde",
    "Bezoek": "#16a3a3",
    "Demo": "#f29a1f",
    "Procedure": "#22a45d",
    "Bestelling": "#147a43",
    "Andere": "#8a94a3",
  };
  const PRODUCTS = ["Thyroid", "Fibroid"];
  const AUS_BOUNDS = [[-44, 112], [-10, 154]];

  const state = {
    db: { version: 1, hospitals: [] },
    selectedId: null,
    filter: { status: "all", product: "all", query: "" },
    placing: null, // {id} wanneer we op de kaart een locatie kiezen
    dragId: null,
  };
  const markers = new Map();
  const $ = (sel, root = document) => root.querySelector(sel);

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => Math.random().toString(16).slice(2, 12);
  const today = () => new Date().toISOString().slice(0, 10);
  const fmtDate = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString("nl-BE", { day: "2-digit", month: "short", year: "numeric" }) : "—";
  const daysAgo = (d) => Math.round((new Date(today()) - new Date(d)) / 86400000);
  const byId = (id) => state.db.hospitals.find((h) => h.id === id);
  const sel = () => byId(state.selectedId);

  function lastContact(h) {
    return h.activities.reduce((max, a) => (a.date > max ? a.date : max), "");
  }
  function countType(h, type) {
    return h.activities.filter((a) => a.type === type).reduce((s, a) => s + (Number(a.qty) || 1), 0);
  }
  function isOverdue(h) {
    return !!h.nextActionDate && h.nextActionDate < today();
  }
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
  let saveTimer = null;
  function scheduleSave() {
    $("#saveState").textContent = "Opslaan…";
    $("#saveState").classList.remove("error");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }
  async function save() {
    try {
      const res = await fetch("/api/data", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.db),
      });
      if (!res.ok) throw new Error((await res.json()).error || res.status);
      $("#saveState").textContent = "✓ Opgeslagen";
    } catch (e) {
      $("#saveState").textContent = "Niet opgeslagen!";
      $("#saveState").classList.add("error");
      showBanner("Opslaan mislukt. Draait server.py nog? Je wijzigingen staan alleen nog in dit venster. (" + e.message + ")");
    }
  }
  window.addEventListener("beforeunload", (e) => {
    if (saveTimer && $("#saveState").textContent !== "✓ Opgeslagen") { e.preventDefault(); }
  });
  function showBanner(msg) {
    const b = $("#banner");
    b.textContent = msg;
    b.hidden = !msg;
  }
  function normalize(h) {
    h.contacts ||= [];
    h.activities ||= [];
    h.products ||= [];
    h.status ||= "red";
    h.stage ||= "Prospect";
    return h;
  }

  // ---------- kaart ----------
  const map = L.map("map", { zoomControl: true }).fitBounds(AUS_BOUNDS);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  function pinIcon(h) {
    const cls = ["pin", h.status, h.id === state.selectedId ? "selected" : "", h.id === state.dragId ? "dragging" : ""].join(" ");
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
        h.lat = +p.lat.toFixed(5);
        h.lng = +p.lng.toFixed(5);
        scheduleSave();
        toast("Locatie bijgewerkt");
      });
      markers.set(h.id, m);
    }
  }

  function fitAll() {
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
    scheduleSave();
    renderAll();
    toast("Locatie ingesteld");
  });
  function startPlacing(id) {
    state.placing = { id };
    $("#placeHint").hidden = false;
    map.getContainer().style.cursor = "crosshair";
  }
  $("#cancelPlace").addEventListener("click", () => {
    state.placing = null;
    $("#placeHint").hidden = true;
    map.getContainer().style.cursor = "";
  });
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
    const { status, product, query } = state.filter;
    return state.db.hospitals.filter((h) =>
      (status === "all" || h.status === status) &&
      (product === "all" || (product === "overdue" ? isOverdue(h) : h.products.includes(product))) &&
      matchesQuery(h, query));
  }

  function renderList() {
    const order = { green: 0, orange: 1, red: 2 };
    const q = state.filter.query.toLowerCase();
    const nameHit = (h) => (q && h.name.toLowerCase().includes(q) ? 0 : 1);
    const items = visibleHospitals().sort((a, b) =>
      nameHit(a) - nameHit(b) || order[a.status] - order[b.status] || a.name.localeCompare(b.name));
    const ul = $("#list");
    if (!items.length) {
      ul.innerHTML = `<li class="empty">Geen resultaten</li>`;
      return;
    }
    ul.innerHTML = items.map((h) => {
      const lc = lastContact(h);
      const primary = h.contacts.find((c) => c.primary);
      const bits = [h.stage];
      if (lc) bits.push("laatst " + relDays(lc));
      return `<li data-id="${h.id}" class="${h.id === state.selectedId ? "selected" : ""}">
        <i class="dot ${h.status}"></i>
        <div>
          <div class="name">${esc(h.name)}${isOverdue(h) ? '<span class="badge">actie te laat</span>' : ""}${h.lat == null ? '<span class="badge neutral">geen locatie</span>' : ""}</div>
          <div class="meta">${esc(bits.join(" · "))}</div>
          ${primary ? `<div class="meta">★ ${esc(primary.name)}</div>` : ""}
        </div>
      </li>`;
    }).join("");
  }
  $("#list").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) select(li.dataset.id, true);
  });

  function bindChips(containerSel, key) {
    $(containerSel).addEventListener("click", (e) => {
      const b = e.target.closest(".chip");
      if (!b) return;
      $(containerSel).querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === b));
      state.filter[key] = b.dataset[key];
      renderList();
      renderMarkers();
    });
  }
  bindChips("#statusFilters", "status");
  bindChips("#productFilters", "product");

  $("#search").addEventListener("input", (e) => {
    state.filter.query = e.target.value.trim();
    renderList();
    renderMarkers();
  });
  $("#search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = $("#list li[data-id]");
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
      <div class="kpi"><b style="color:var(--green)">${n("green")}</b><span>Verkoop</span></div>
      <div class="kpi"><b style="color:var(--orange)">${n("orange")}</b><span>In progress</span></div>
      <div class="kpi"><b style="color:var(--red)">${n("red")}</b><span>Geen contact</span></div>
      <div class="kpi"><b>${procs}</b><span>Procedures</span></div>
      <div class="kpi"><b>${demos}</b><span>Demo's</span></div>
      <div class="kpi"><b style="${late ? "color:var(--red)" : ""}">${late}</b><span>Acties te laat</span></div>`;
  }

  // ---------- selectie ----------
  function select(id, fly) {
    state.selectedId = id;
    if (state.dragId && state.dragId !== id) state.dragId = null;
    const h = sel();
    renderAll();
    if (fly && h && h.lat != null) map.flyTo([h.lat, h.lng], Math.max(map.getZoom(), 13), { duration: 0.6 });
  }
  function closeFiche() {
    state.selectedId = null;
    state.dragId = null;
    renderAll();
  }

  // ---------- fiche ----------
  function renderFiche() {
    const el = $("#fiche");
    const h = sel();
    el.hidden = !h;
    if (!h) { el.innerHTML = ""; return; }

    const lc = lastContact(h);
    const contacts = [...h.contacts].sort((a, b) => (b.primary - a.primary) || a.name.localeCompare(b.name));
    const acts = [...h.activities].sort((a, b) => b.date.localeCompare(a.date));
    const late = isOverdue(h);

    el.innerHTML = `
      <div class="fiche-head">
        <div class="row">
          <i class="dot ${h.status}" style="width:14px;height:14px"></i>
          <input class="fiche-title" data-field="name" value="${esc(h.name)}" aria-label="Naam">
          <button class="icon-btn" data-act="close" title="Sluiten">✕</button>
        </div>
        <div class="status-pick">
          ${Object.entries(STATUS).map(([k, label]) => `<button class="${k} ${h.status === k ? "active" : ""}" data-status="${k}" title="${label}"><i class="dot ${k}"></i>${label.split(" /")[0]}</button>`).join("")}
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
        </div>
      </div>

      <div class="section">
        <h3>Contactmomenten <button class="btn small primary" data-act="add-activity">+ Contactmoment</button></h3>
        ${acts.length ? `<ul class="timeline">${acts.map((a) => {
          const c = h.contacts.find((x) => x.id === a.contactId);
          const sub = [a.product, c && c.name, (a.type === "Procedure" || a.type === "Bestelling") && a.qty ? `aantal: ${a.qty}` : ""].filter(Boolean).join(" · ");
          return `<li>
            <div class="t-date">${fmtDate(a.date)}</div>
            <div class="t-body">
              <div class="t-type"><span class="type-pill" style="background:${ACT_TYPES[a.type] || "#999"}"></span>${esc(a.type)}</div>
              ${sub ? `<div class="t-sub">${esc(sub)}</div>` : ""}
              ${a.note ? `<div class="t-note">${esc(a.note)}</div>` : ""}
            </div>
            <div><button class="icon-btn" data-act="edit-activity" data-id="${a.id}" title="Bewerk">✎</button></div>
          </li>`;
        }).join("")}</ul>` : `<p class="muted">Nog geen contactmomenten. Voeg prospectie, telefoon, demo, procedure… toe.</p>`}
      </div>

      <div class="section">
        <h3>Contactpersonen <button class="btn small" data-act="add-contact">+ Contact</button></h3>
        ${contacts.length ? contacts.map((c) => `
          <div class="contact ${c.primary ? "primary" : ""}">
            <div class="c-actions">
              <button class="icon-btn" data-act="primary" data-id="${c.id}" title="${c.primary ? "Hoofdcontact" : "Maak hoofdcontact"}">${c.primary ? "★" : "☆"}</button>
              <button class="icon-btn" data-act="edit-contact" data-id="${c.id}" title="Bewerk">✎</button>
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
          <label class="field">Type
            <select data-field="kind">${["Ziekenhuis", "Kliniek", "Organisatie"].map((k) => `<option ${k === h.kind ? "selected" : ""}>${k}</option>`).join("")}</select>
          </label>
          <label class="field">Publiek / privé
            <select data-field="sector">${["", "Public", "Private", "University"].map((k) => `<option value="${k}" ${k === h.sector ? "selected" : ""}>${k || "—"}</option>`).join("")}</select>
          </label>
          <div class="field full"><span style="font-size:11px;color:var(--muted)">Producten</span>
            <div class="toggles">${PRODUCTS.map((p) => `<label><input type="checkbox" data-product="${p}" ${h.products.includes(p) ? "checked" : ""}>${p}</label>`).join("")}</div>
          </div>
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
        <button class="btn danger" data-act="delete">Verwijder ${esc(h.kind.toLowerCase())}</button>
        <button class="btn" data-act="close">Sluiten</button>
      </div>`;
  }

  // Velden in de fiche: opslaan zonder volledige herteken (focus blijft).
  $("#fiche").addEventListener("change", (e) => {
    const h = sel();
    if (!h) return;
    const t = e.target;
    if (t.dataset.field) {
      h[t.dataset.field] = t.value;
      if (t.dataset.field === "name" && !t.value.trim()) { h.name = "Naamloos"; t.value = h.name; }
    } else if (t.dataset.product) {
      const p = t.dataset.product;
      h.products = t.checked ? [...new Set([...h.products, p])] : h.products.filter((x) => x !== p);
    } else return;
    scheduleSave();
    renderList();
    renderKpis();
    if (["name", "nextActionDate", "kind"].includes(t.dataset.field)) { renderFiche(); renderMarkers(); }
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
        if (state.dragId) toast("Sleep de marker naar de juiste plek");
        return renderAll();
      case "delete":
        if (confirm(`"${h.name}" en alle contacten/contactmomenten definitief verwijderen?`)) {
          state.db.hospitals = state.db.hospitals.filter((x) => x.id !== h.id);
          scheduleSave();
          closeFiche();
        }
        return;
    }
  });

  function setStatus(h, status) {
    if (h.status === status) return;
    h.status = status;
    scheduleSave();
    renderAll();
  }

  // ---------- dialogen ----------
  function openDialog(html, onSubmit) {
    const dlg = $("#dialog");
    const form = $("#dialogForm");
    form.innerHTML = html;
    dlg.showModal();
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
      if (action === "delete") {
        if (!confirm(`${c.name} verwijderen?`)) return;
        h.contacts = h.contacts.filter((x) => x.id !== c.id);
        h.activities.forEach((a) => { if (a.contactId === c.id) a.contactId = ""; });
      } else {
        const rec = c || { id: uid() };
        Object.assign(rec, {
          name: data.name.trim(), role: data.role.trim(), phone: data.phone.trim(), email: data.email.trim(),
          address: data.address.trim(), product: data.product, notes: data.notes.trim(), primary: !!data.primary,
        });
        if (rec.primary) h.contacts.forEach((x) => { if (x !== rec) x.primary = false; });
        if (!c) h.contacts.push(rec);
        if (rec.product && rec.product !== "Beide" && !h.products.includes(rec.product)) h.products.push(rec.product);
      }
      scheduleSave();
      renderAll();
    });
  }

  function activityDialog(h, a) {
    const v = a || { date: today(), type: h.activities.length ? "Telefoon" : "Prospectie", product: h.products.length === 1 ? h.products[0] : "", contactId: (h.contacts.find((c) => c.primary) || {}).id || "", qty: "", note: "" };
    const form = openDialog(`
      <h2>${a ? "Contactmoment bewerken" : "Nieuw contactmoment"} · ${esc(h.name)}</h2>
      <div class="grid">
        <label class="field">Datum<input type="date" name="date" required value="${esc(v.date)}"></label>
        <label class="field">Type
          <select name="type">${Object.keys(ACT_TYPES).map((t) => `<option ${t === v.type ? "selected" : ""}>${t}</option>`).join("")}</select>
        </label>
        <label class="field">Product
          <select name="product">${["", ...PRODUCTS].map((p) => `<option value="${p}" ${p === v.product ? "selected" : ""}>${p || "—"}</option>`).join("")}</select>
        </label>
        <label class="field">Contactpersoon
          <select name="contactId"><option value="">—</option>${h.contacts.map((c) => `<option value="${c.id}" ${c.id === v.contactId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
        </label>
        <label class="field full" id="qtyField">Aantal <span id="qtyLabel"></span><input type="number" min="1" name="qty" value="${esc(v.qty)}" placeholder="1"></label>
        <label class="field full">Notitie<textarea name="note" rows="4" placeholder="Wat werd besproken, afspraken…">${esc(v.note)}</textarea></label>
      </div>
      <div class="actions">
        ${a ? '<button class="btn danger" value="delete" formnovalidate style="margin-right:auto">Verwijder</button>' : ""}
        <button class="btn" value="cancel" formnovalidate>Annuleer</button>
        <button class="btn primary" value="ok">Opslaan</button>
      </div>`, (data, action) => {
      if (action === "delete") {
        if (!confirm("Dit contactmoment verwijderen?")) return;
        h.activities = h.activities.filter((x) => x.id !== a.id);
      } else {
        const rec = a || { id: uid() };
        const hasQty = data.type === "Procedure" || data.type === "Bestelling";
        Object.assign(rec, { date: data.date, type: data.type, product: data.product, contactId: data.contactId, qty: hasQty ? Number(data.qty) || 1 : "", note: data.note.trim() });
        if (!a) {
          h.activities.push(rec);
          autoStatus(h, rec);
        }
      }
      scheduleSave();
      renderAll();
    });
    const sync = () => {
      const t = form.elements.type.value;
      const show = t === "Procedure" || t === "Bestelling";
      $("#qtyField", form).hidden = !show;
      $("#qtyLabel", form).textContent = t === "Procedure" ? "(procedures)" : "(naalden)";
    };
    form.elements.type.addEventListener("change", sync);
    sync();
  }

  // Kleur automatisch mee laten evolueren; manueel aanpassen blijft altijd mogelijk.
  function autoStatus(h, act) {
    if ((act.type === "Procedure" || act.type === "Bestelling") && h.status !== "green") {
      h.status = "green";
      if (["Prospect", "Eerste contact", "Meeting / bezoek", "Demo gepland", "Demo gedaan", "Proefperiode"].includes(h.stage)) h.stage = "Klant";
      toast("Status → groen (aan het verkopen)");
    } else if (h.status === "red") {
      h.status = "orange";
      if (h.stage === "Prospect") h.stage = "Eerste contact";
      toast("Status → oranje (in progress)");
    }
    if (act.type === "Demo" && ["Prospect", "Eerste contact", "Meeting / bezoek", "Demo gepland"].includes(h.stage)) h.stage = "Demo gedaan";
  }

  // ---------- nieuw ziekenhuis ----------
  $("#addHospitalBtn").addEventListener("click", () => {
    openDialog(`
      <h2>Nieuw ziekenhuis / organisatie</h2>
      <div class="grid">
        <label class="field full">Naam<input name="name" required></label>
        <label class="field">Type<select name="kind"><option>Ziekenhuis</option><option>Kliniek</option><option>Organisatie</option></select></label>
        <label class="field">Publiek / privé<select name="sector"><option value="">—</option><option>Public</option><option>Private</option><option>University</option></select></label>
        <label class="field full">Adres<input name="address"></label>
      </div>
      <p class="muted">Na het opslaan klik je op de kaart om de locatie te kiezen.</p>
      <div class="actions">
        <button class="btn" value="cancel" formnovalidate>Annuleer</button>
        <button class="btn primary" value="ok">Aanmaken</button>
      </div>`, (data) => {
      const h = normalize({
        id: uid(), name: data.name.trim(), kind: data.kind, sector: data.sector, address: data.address.trim(),
        lat: null, lng: null, status: "red", stage: "Prospect", products: [], nextAction: "", nextActionDate: "", notes: "",
      });
      state.db.hospitals.push(h);
      scheduleSave();
      select(h.id, false);
      startPlacing(h.id);
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
  const csv = (rows) => "﻿" + rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";")).join("\r\n");

  $("#exportBtn").addEventListener("click", () => {
    openDialog(`
      <h2>Exporteren</h2>
      <p class="muted">CSV-bestanden openen rechtstreeks in Excel. De JSON-back-up kan je later terug importeren.</p>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn" value="hospitals">Overzicht ziekenhuizen (CSV)</button>
        <button class="btn" value="contacts">Contactpersonen (CSV)</button>
        <button class="btn" value="activities">Contactmomenten (CSV)</button>
        <button class="btn" value="json">Volledige back-up (JSON)</button>
      </div>
      <div class="actions"><button class="btn" value="cancel">Sluiten</button></div>`, () => {});
    $("#dialogForm").onsubmit = (e) => {
      const kind = e.submitter && e.submitter.value;
      const hs = state.db.hospitals;
      const d = today();
      if (kind === "hospitals") {
        download(`ziekenhuizen-${d}.csv`, csv([
          ["Naam", "Type", "Sector", "Status", "Fase", "Producten", "Laatste contact", "Procedures", "Demo's", "Naalden besteld", "Volgende actie", "Actie op", "Hoofdcontact", "Adres", "Notities"],
          ...hs.map((h) => [h.name, h.kind, h.sector, STATUS[h.status], h.stage, h.products.join(", "), lastContact(h), countType(h, "Procedure"), countType(h, "Demo"), countType(h, "Bestelling"), h.nextAction, h.nextActionDate, (h.contacts.find((c) => c.primary) || {}).name, h.address, h.notes]),
        ]), "text/csv");
      } else if (kind === "contacts") {
        download(`contactpersonen-${d}.csv`, csv([
          ["Ziekenhuis", "Naam", "Functie", "Telefoon", "E-mail", "Adres", "Product", "Hoofdcontact", "Notities"],
          ...hs.flatMap((h) => h.contacts.map((c) => [h.name, c.name, c.role, c.phone, c.email, c.address, c.product, c.primary ? "ja" : "", c.notes])),
        ]), "text/csv");
      } else if (kind === "activities") {
        download(`contactmomenten-${d}.csv`, csv([
          ["Datum", "Ziekenhuis", "Type", "Product", "Contactpersoon", "Aantal", "Notitie"],
          ...hs.flatMap((h) => h.activities.map((a) => [a.date, h.name, a.type, a.product, (h.contacts.find((c) => c.id === a.contactId) || {}).name, a.qty, a.note]))
            .sort((a, b) => b[0].localeCompare(a[0])),
        ]), "text/csv");
      } else if (kind === "json") {
        download(`followup-vaseo-backup-${d}.json`, JSON.stringify(state.db, null, 2), "application/json");
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
      if (!Array.isArray(data.hospitals)) throw new Error("geen 'hospitals' gevonden");
      if (!confirm(`${data.hospitals.length} ziekenhuizen importeren? Dit vervangt alle huidige data.`)) return;
      data.hospitals.forEach(normalize);
      state.db = data;
      state.selectedId = null;
      scheduleSave();
      renderAll();
      fitAll();
      toast("Back-up geïmporteerd");
    } catch (err) {
      alert("Importeren mislukt: " + err.message);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#dialog").open) {
      if (state.placing) $("#cancelPlace").click();
      else if (state.selectedId) closeFiche();
    }
    if (e.key === "/" && document.activeElement === document.body) { e.preventDefault(); $("#search").focus(); }
  });

  // ---------- start ----------
  function renderAll() {
    renderKpis();
    renderList();
    renderMarkers();
    renderFiche();
    setTimeout(() => map.invalidateSize(), 0);
  }

  async function init() {
    try {
      const res = await fetch("/api/data", { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      state.db = await res.json();
      state.db.hospitals.forEach(normalize);
      $("#saveState").textContent = "✓ Opgeslagen";
    } catch (e) {
      showBanner("Kan de data niet laden. Start de website met: python3 server.py  en open http://localhost:8080");
    }
    renderAll();
    map.invalidateSize();
    fitAll();
  }
  init();
})();
