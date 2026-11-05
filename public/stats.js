/* FollowUp Vaseo – statistieken.
 * Grafieken in gewone HTML: één tooltip, kleur per product (Thyroid = reeks 1, Fibroid = reeks 2). */
window.FollowUpStats = (() => {
  "use strict";

  const PRODUCTS = ["Thyroid", "Fibroid"];
  const SERIES = { Thyroid: "var(--series-1)", Fibroid: "var(--series-2)", "": "var(--series-none)" };
  // Doelen uit ContactList.xlsx (marktaandeel Prion Medical, aantal procedures QLD).
  const DEFAULT_TARGETS = {
    2026: { Thyroid: 0, Fibroid: 0 },
    2027: { Thyroid: 19, Fibroid: 79 },
    2028: { Thyroid: 37, Fibroid: 158 },
    2029: { Thyroid: 56, Fibroid: 237 },
    2030: { Thyroid: 74, Fibroid: 316 },
  };
  const MONTHS = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
  const Core = window.FollowUpCore;
  const { STAGES, esc, vrr } = Core;
  const STATUS = Object.entries(Core.STATUS);
  const GOAL_REGION = "QLD"; // de doelen komen uit de marktanalyse voor Queensland

  const view = { year: String(new Date().getFullYear()), product: "all", region: "all" };
  let tip;

  const fmt = (n, d = 0) => (n == null || isNaN(n) ? "—" : Number(n).toLocaleString("nl-BE", { maximumFractionDigits: d, minimumFractionDigits: d }));
  const qty = (a) => Number(a.qty) || 1;
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);
  // Asmaxima waarvan de helft een rond getal is: 2, 4, 6, 8, 10 × 10^n
  function niceMax(v) {
    if (v <= 4) return 4;
    const p = 10 ** Math.floor(Math.log10(v));
    return [2, 4, 6, 8, 10].map((m) => m * p).find((m) => m >= v);
  }

  function targetsFor(db, year) {
    return { ...(DEFAULT_TARGETS[year] || { Thyroid: 0, Fibroid: 0 }), ...((db.targets || {})[year] || {}) };
  }

  // Alle contactmomenten, plat, met ziekenhuis erbij en gefilterd op jaar + product.
  // Toekomstige datums zijn nog niet gebeurd en tellen niet mee.
  const inRegion = (h) => view.region === "all" || h.region === view.region;
  function rows(db, { types, ignoreYear } = {}) {
    const out = [];
    const today = Core.localDate();
    for (const h of db.hospitals) {
      if (!inRegion(h)) continue;
      for (const a of h.activities) {
        if (a.date > today) continue;
        if (types && !types.includes(a.type)) continue;
        if (!ignoreYear && view.year !== "all" && !a.date.startsWith(view.year)) continue;
        if (view.product !== "all" && a.product !== view.product) continue;
        out.push({ ...a, hospital: h });
      }
    }
    return out;
  }

  // ---------- bouwstenen ----------
  function tile(value, label, sub) {
    return `<div class="s-tile"><b>${value}</b><span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;
  }

  function legend(series) {
    return `<div class="s-legend">${series.map((p) => `<span><i style="background:${SERIES[p]}"></i>${esc(p || "Geen product")}</span>`).join("")}</div>`;
  }

  // Verticale gestapelde staven (bv. per maand).
  function columns(buckets, series) {
    const max = niceMax(Math.max(1, ...buckets.map((b) => sum(series, (s) => b.values[s] || 0))));
    const ticks = [max, max / 2, 0];
    return `
      <div class="s-cols">
        <div class="s-yaxis">${ticks.map((t) => `<span>${fmt(t)}</span>`).join("")}</div>
        <div class="s-plot">
          ${ticks.map((t) => `<div class="s-grid" style="bottom:${(t / max) * 100}%"></div>`).join("")}
          <div class="s-bars">
            ${buckets.map((b) => {
              const total = sum(series, (s) => b.values[s] || 0);
              const tipText = [`${b.label}: ${total}`, ...series.filter((s) => b.values[s]).map((s) => `${s || "Geen product"}: ${b.values[s]}`)].join("\n");
              return `<div class="s-col" data-tip="${esc(tipText)}" tabindex="0">
                <div class="s-stack" style="height:${(total / max) * 100}%">
                  ${series.filter((s) => b.values[s]).map((s) => `<div style="flex:${b.values[s]};background:${SERIES[s]}"></div>`).join("")}
                </div>
                <span class="s-xlabel">${esc(b.short)}</span>
              </div>`;
            }).join("")}
          </div>
        </div>
      </div>`;
  }

  // Horizontale (gestapelde) staven met label links en totaal rechts.
  function hbars(items, series, empty) {
    if (!items.length) return `<p class="muted">${esc(empty)}</p>`;
    const max = Math.max(1, ...items.map((i) => i.total));
    return `<div class="s-hbars">${items.map((i) => {
      const tipText = [`${i.label}: ${i.total}`, ...(series ? series.filter((s) => i.values[s]).map((s) => `${s || "Geen product"}: ${i.values[s]}`) : [])].join("\n");
      return `<div class="s-hrow" data-tip="${esc(tipText)}" tabindex="0">
        <span class="s-hlabel">${esc(i.label)}</span>
        <div class="s-htrack"><div class="s-hbar" style="width:${(i.total / max) * 100}%">
          ${series
            ? series.filter((s) => i.values[s]).map((s) => `<div style="flex:${i.values[s]};background:${SERIES[s]}"></div>`).join("")
            : `<div style="flex:1;background:${i.color || "var(--series-1)"}"></div>`}
        </div></div>
        <span class="s-hval">${fmt(i.total)}</span>
      </div>`;
    }).join("")}</div>`;
  }

  function card(title, body, extra = "") {
    return `<section class="s-card ${extra}"><h3>${esc(title)}</h3>${body}</section>`;
  }

  function seriesIn(list) {
    const present = new Set(list.map((a) => a.product || ""));
    return [...PRODUCTS, ""].filter((p) => present.has(p));
  }

  // ---------- secties ----------
  function targetsCard(db) {
    const now = new Date();
    const year = view.year === "all" ? String(now.getFullYear()) : view.year;
    const t = targetsFor(db, year);
    // Doelen gelden voor QLD; ziekenhuizen zonder regio tellen mee tot ze een regio krijgen.
    const region = view.region;
    view.region = "all";
    const procs = rows(db, { types: ["Procedure"], ignoreYear: true });
    view.region = region;
    const byYear = procs.filter((a) => a.date.startsWith(year) && (a.hospital.region === GOAL_REGION || !a.hospital.region));
    const noProduct = sum(byYear.filter((a) => !a.product), qty);
    const yearStart = new Date(now.getFullYear(), 0, 1);
    const elapsed = (now - yearStart) / (new Date(now.getFullYear() + 1, 0, 1) - yearStart);
    const isThisYear = year === String(now.getFullYear());
    const products = view.product === "all" ? PRODUCTS : [view.product];
    return card(`Doel ${year}`, products.map((p) => {
      const done = sum(byYear.filter((a) => a.product === p), qty);
      const goal = Number(t[p]) || 0;
      const pct = goal ? Math.min(100, (done / goal) * 100) : 0;
      const pace = isThisYear && done ? Math.round(done / elapsed) : null;
      return `<div class="s-target">
        <div class="s-target-head">
          <span><i style="background:${SERIES[p]}"></i>${p}</span>
          <span><b>${fmt(done)}</b> van <input type="number" min="0" data-target-year="${year}" data-target-product="${p}" value="${goal}" aria-label="Doel ${p} ${year}"> procedures</span>
        </div>
        <div class="s-progress"><div style="width:${pct}%;background:${SERIES[p]}"></div></div>
        <small class="muted">${goal ? `${fmt((done / goal) * 100)}% van het doel` : "Geen doel ingesteld"}${pace !== null ? ` · op dit tempo ${fmt(pace)} tegen het jaareinde` : ""}</small>
      </div>`;
    }).join("") + (noProduct ? `<p class="muted"><b>${fmt(noProduct)} procedure(s) zonder product</b> tellen niet mee. Vul het product in om ze mee te tellen.</p>` : "")
      + `<p class="muted">Doelen uit je marktanalyse (marktaandeel Prion Medical in ${GOAL_REGION}). Ze tellen alleen procedures in ${GOAL_REGION} en ziekenhuizen zonder regio. Pas het getal aan om het doel te wijzigen.</p>`);
  }

  function monthsCard(procs) {
    let buckets;
    if (view.year === "all") {
      const now = new Date();
      buckets = Array.from({ length: 12 }, (_, i) => {
        const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        return { key, short: MONTHS[d.getMonth()], label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, values: {} };
      });
    } else {
      buckets = MONTHS.map((m, i) => ({ key: `${view.year}-${String(i + 1).padStart(2, "0")}`, short: m, label: `${m} ${view.year}`, values: {} }));
    }
    for (const a of procs) {
      const b = buckets.find((x) => a.date.startsWith(x.key));
      if (b) b.values[a.product || ""] = (b.values[a.product || ""] || 0) + qty(a);
    }
    const series = seriesIn(procs);
    const title = view.year === "all" ? "Procedures per maand (laatste 12 maanden)" : `Procedures per maand – ${view.year}`;
    return card(title, (series.length > 1 ? legend(series) : "") + columns(buckets, series.length ? series : ["Thyroid"]), "wide");
  }

  function hospitalsCard(procs) {
    const series = seriesIn(procs);
    const map = new Map();
    for (const a of procs) {
      const e = map.get(a.hospital.id) || { label: a.hospital.name, total: 0, values: {} };
      e.total += qty(a);
      e.values[a.product || ""] = (e.values[a.product || ""] || 0) + qty(a);
      map.set(a.hospital.id, e);
    }
    const items = [...map.values()].sort((a, b) => b.total - a.total);
    return card("Procedures per ziekenhuis", (series.length > 1 ? legend(series) : "") + hbars(items, series, "Nog geen procedures in deze periode."));
  }

  function pipelineCard(db) {
    const hs = scoped(db);
    const statusTiles = `<div class="s-status">${STATUS.map(([k, label]) =>
      `<div><i class="dot ${k}"></i><b>${hs.filter((h) => h.status === k).length}</b><span>${label}</span></div>`).join("")}</div>`;
    const items = STAGES.map((s) => ({ label: s, total: hs.filter((h) => h.stage === s).length })).filter((i) => i.total);
    return card("Pijplijn (ziekenhuizen)", statusTiles + hbars(items, null, "Geen ziekenhuizen."));
  }

  const scoped = (db) => db.hospitals.filter((h) => inRegion(h) && (view.product === "all" || h.products.includes(view.product)));
  const money = (n) => `A$ ${fmt(n)}`;

  // Klant = eerste bestelling: daarom is dit de enige plek waar "klant" geteld wordt, samen met de pijplijn.
  function funnelCard(db) {
    const hs = scoped(db);
    const steps = Core.funnel(hs);
    const days = Core.daysToCustomer(hs);
    const lost = {};
    for (const h of hs) if (h.stage === "Niet geïnteresseerd") lost[h.lostReason || "Geen reden opgegeven"] = (lost[h.lostReason || "Geen reden opgegeven"] || 0) + 1;
    const body = steps.map((s, i) => {
      const prev = i ? steps[i - 1].count : s.count;
      return { label: s.stage, total: s.count, note: i && prev ? `${fmt((s.count / prev) * 100)}% van de vorige fase` : "" };
    });
    return card("Conversie (ziekenhuizen per bereikte fase)",
      hbars(body.map((b) => ({ ...b, label: b.label })), null, "Geen ziekenhuizen.")
      + `<p class="muted">${body.filter((b) => b.note).map((b) => `${esc(b.label)}: ${esc(b.note)}`).join(" · ")}</p>`
      + `<dl class="s-dist">
          <dt>Tijd tot klant</dt><dd>${days.length ? `gemiddeld ${fmt(avg(days))} dagen (n = ${days.length})` : "Wordt gemeten vanaf nu, zodra een ziekenhuis klant wordt"}</dd>
          <dt>Afgehaakt</dt><dd>${Object.keys(lost).length ? Object.entries(lost).map(([r, n]) => `${esc(r)}: <b>${n}</b>`).join(" · ") : "—"}</dd>
        </dl>`);
  }

  function valueCard(db) {
    const hs = scoped(db);
    const p = Core.pipelineValue(hs);
    const prices = db.prices || {};
    const orders = rows(db, { types: ["Bestelling"] });
    const known = orders.filter((a) => a.product && prices[a.product]);
    const revenue = sum(known, (a) => qty(a) * prices[a.product]);
    const unknown = sum(orders, qty) - sum(known, qty);
    return card("Waarde", `
      <div class="s-tiles small">
        ${tile(money(p.total), "Open pijplijn", `${p.count} ziekenhuis/-huizen met waarde`)}
        ${tile(money(p.weighted), "Gewogen met winkans")}
        ${tile(money(revenue), "Omzet bestellingen", unknown ? `${fmt(unknown)} naalden zonder prijs of product` : "")}
      </div>
      <div class="s-prices">${PRODUCTS.map((pr) => `<label>Prijs per naald ${pr} (A$) <input type="number" min="0" step="1" data-price="${pr}" value="${esc(prices[pr] ?? "")}"></label>`).join("")}</div>
      <p class="muted">Waarde en winkans vul je in op de fiche van het ziekenhuis.</p>`);
  }

  function activityCard(db) {
    const acts = rows(db);
    const counts = {};
    for (const a of acts) counts[a.type] = (counts[a.type] || 0) + 1;
    const items = Object.entries(counts).map(([label, total]) => ({ label, total })).sort((a, b) => b.total - a.total);
    return card("Contactmomenten per type", hbars(items, null, "Nog geen contactmomenten in deze periode."));
  }

  function clinicalCard(procs) {
    const det = procs.map((a) => ({ ...a.details, product: a.product })).filter((d) => Object.keys(d).length > 1);
    const vol = det.map((d) => d.volume).filter(Boolean);
    const en = det.map((d) => d.energy).filter(Boolean);
    const epm = det.filter((d) => d.energy && d.volume).map((d) => d.energy / d.volume);
    const vr = det.map(vrr).filter((v) => v !== null);
    const comp = det.filter((d) => d.complication);
    const compBad = comp.filter((d) => d.complication !== "Geen");
    const dist = (key, values) => {
      const c = {};
      for (const d of det) if (d[key]) c[d[key]] = (c[d[key]] || 0) + 1;
      const shown = values.filter((v) => c[v]);
      return shown.length ? shown.map((v) => `${v}: <b>${c[v]}</b>`).join(" · ") : "—";
    };
    const showThy = view.product !== "Fibroid";
    const showFib = view.product !== "Thyroid";
    return card("Klinische gegevens", `
      <div class="s-tiles small">
        ${tile(fmt(det.length), "Procedures met gegevens")}
        ${tile(vol.length ? fmt(avg(vol), 1) + " ml" : "—", "Gem. uitgangsvolume", vol.length ? `n = ${vol.length}` : "")}
        ${tile(en.length ? fmt(avg(en), 1) + " kJ" : "—", "Gem. energie", en.length ? `n = ${en.length}` : "")}
        ${tile(epm.length ? fmt(avg(epm), 2) + " kJ/ml" : "—", "Energie per ml", epm.length ? `n = ${epm.length}` : "")}
        ${tile(vr.length ? fmt(avg(vr)) + "%" : "—", "Gem. volumereductie (VRR)", vr.length ? `n = ${vr.length} met follow-up` : "nog geen follow-up")}
        ${tile(comp.length ? fmt((compBad.length / comp.length) * 100) + "%" : "—", "Complicaties", comp.length ? `${compBad.length} van ${comp.length}` : "")}
      </div>
      <dl class="s-dist">
        ${showThy ? `<dt>TI-RADS</dt><dd>${dist("tirads", ["1", "2", "3", "4", "5"])}</dd>
        <dt>Type nodule</dt><dd>${dist("noduleType", ["Solide", "Overwegend solide", "Gemengd", "Overwegend cystisch", "Cystisch"])}</dd>
        <dt>Indicatie</dt><dd>${dist("indication", ["Symptomatisch", "Cosmetisch", "Autonoom (hot)", "Recidief", "Andere"])}</dd>` : ""}
        ${showFib ? `<dt>FIGO-type</dt><dd>${dist("figo", ["0", "1", "2", "3", "4", "5", "6", "7", "8", "2-5"])}</dd>
        <dt>Klachten</dt><dd>${dist("symptoms", ["Bloedingen", "Druk / pijn", "Fertiliteit", "Combinatie", "Andere"])}</dd>` : ""}
        <dt>Verdoving</dt><dd>${dist("anesthesia", ["Lokaal", "Sedatie", "Algemeen"])}</dd>
      </dl>`, "wide");
  }

  function tableCard(procs) {
    const list = [...procs].sort((a, b) => b.date.localeCompare(a.date));
    if (!list.length) return card("Alle procedures", `<p class="muted">Nog geen procedures in deze periode.</p>`, "wide");
    return card(`Alle procedures (${list.length})`, `
      <div class="s-table-wrap"><table class="s-table">
        <thead><tr><th>Datum</th><th>Ziekenhuis</th><th>Product</th><th>Arts</th><th class="num">Aantal</th><th class="num">Volume (ml)</th><th class="num">Energie (kJ)</th><th class="num">VRR</th><th>Complicaties</th></tr></thead>
        <tbody>${list.map((a) => {
          const d = a.details || {};
          const c = a.hospital.contacts.find((x) => x.id === a.contactId);
          const r = vrr(d);
          return `<tr><td>${esc(a.date)}</td><td>${esc(a.hospital.name)}</td><td>${esc(a.product || "—")}</td><td>${esc(c ? c.name : "—")}</td>
            <td class="num">${fmt(qty(a))}</td><td class="num">${d.volume ? fmt(d.volume, 1) : "—"}</td><td class="num">${d.energy ? fmt(d.energy, 1) : "—"}</td>
            <td class="num">${r !== null ? fmt(r) + "%" : "—"}</td><td>${esc(d.complication || "—")}</td></tr>`;
        }).join("")}</tbody>
      </table></div>`, "wide");
  }

  // ---------- render ----------
  function render(db, el, onTargetsChange) {
    const years = new Set([String(new Date().getFullYear()), ...Object.keys(DEFAULT_TARGETS)]);
    for (const h of db.hospitals) for (const a of h.activities) years.add(a.date.slice(0, 4));
    const procs = rows(db, { types: ["Procedure"] });
    const acts = rows(db);
    const hospitalsWithProc = new Set(procs.map((a) => a.hospital.id)).size;
    const det = procs.map((a) => a.details).filter(Boolean);
    const vr = det.map(vrr).filter((v) => v !== null);

    el.innerHTML = `
      <div class="s-head">
        <h2>Statistieken</h2>
        <div class="s-filters">
          <label>Jaar <select data-stat="year">
            <option value="all" ${view.year === "all" ? "selected" : ""}>Alle jaren</option>
            ${[...years].sort().reverse().filter((y) => /^\d{4}$/.test(y)).map((y) => `<option ${y === view.year ? "selected" : ""}>${y}</option>`).join("")}
          </select></label>
          <label>Regio <select data-stat="region">
            <option value="all">Alle</option>
            ${Core.REGIONS.map((r) => `<option ${r === view.region ? "selected" : ""}>${r}</option>`).join("")}
          </select></label>
          <div class="s-seg">${["all", ...PRODUCTS].map((p) => `<button data-stat-product="${p}" aria-pressed="${view.product === p}" class="${view.product === p ? "active" : ""}">${p === "all" ? "Alle" : p}</button>`).join("")}</div>
        </div>
      </div>
      <div class="s-tiles">
        ${tile(fmt(sum(procs, qty)), "Procedures")}
        ${tile(fmt(hospitalsWithProc), "Ziekenhuizen met procedures")}
        ${tile(fmt(acts.filter((a) => a.type === "Demo").length), "Demo's")}
        ${tile(fmt(sum(acts.filter((a) => a.type === "Bestelling"), qty)), "Naalden besteld")}
        ${tile(fmt(acts.length), "Contactmomenten")}
        ${tile(vr.length ? fmt(avg(vr)) + "%" : "—", "Gem. VRR", vr.length ? `n = ${vr.length}` : "nog geen follow-up")}
      </div>
      <div class="s-grid-cards">
        ${monthsCard(procs)}
        ${targetsCard(db)}
        ${hospitalsCard(procs)}
        ${pipelineCard(db)}
        ${funnelCard(db)}
        ${valueCard(db)}
        ${activityCard(db)}
        ${clinicalCard(procs)}
        ${tableCard(procs)}
      </div>`;

    el.querySelector("[data-stat=year]").onchange = (e) => { view.year = e.target.value; render(db, el, onTargetsChange); };
    el.querySelector("[data-stat=region]").onchange = (e) => { view.region = e.target.value; render(db, el, onTargetsChange); };
    el.querySelectorAll("[data-price]").forEach((inp) => (inp.onchange = () => {
      db.prices = { ...(db.prices || {}), [inp.dataset.price]: Math.max(0, Number(inp.value) || 0) };
      onTargetsChange();
      render(db, el, onTargetsChange);
    }));
    el.querySelectorAll("[data-stat-product]").forEach((b) => (b.onclick = () => { view.product = b.dataset.statProduct; render(db, el, onTargetsChange); }));
    el.querySelectorAll("[data-target-year]").forEach((inp) => (inp.onchange = () => {
      const y = inp.dataset.targetYear;
      db.targets ||= {};
      db.targets[y] = { ...targetsFor(db, y), [inp.dataset.targetProduct]: Math.max(0, Number(inp.value) || 0) };
      onTargetsChange();
      render(db, el, onTargetsChange);
    }));
    bindTooltip(el);
  }

  function bindTooltip(el) {
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "s-tip";
      tip.hidden = true;
      document.body.append(tip);
    }
    const show = (target, x, y) => {
      const lines = target.dataset.tip.split("\n");
      tip.replaceChildren(...lines.map((l, i) => {
        const div = document.createElement("div");
        if (i === 0) { const b = document.createElement("b"); b.textContent = l; div.append(b); } else div.textContent = l;
        return div;
      }));
      tip.hidden = false;
      const r = tip.getBoundingClientRect();
      tip.style.left = Math.min(x + 14, innerWidth - r.width - 8) + "px";
      tip.style.top = Math.max(8, y - r.height - 10) + "px";
    };
    el.onpointermove = (e) => {
      const t = e.target.closest("[data-tip]");
      if (t) show(t, e.clientX, e.clientY); else tip.hidden = true;
    };
    el.onpointerleave = () => (tip.hidden = true);
    el.onfocusin = (e) => {
      const t = e.target.closest("[data-tip]");
      if (t) { const r = t.getBoundingClientRect(); show(t, r.left + r.width / 2, r.top); }
    };
    el.onfocusout = () => (tip.hidden = true);
  }

  return { render, hideTip: () => tip && (tip.hidden = true) };
})();
