/* FollowUp Vaseo – gedeelde logica zonder scherm: definities, datums, controle van data en samenvoegen.
 * Wordt ook los getest: zie tests/core.test.js. */
(function (root) {
  "use strict";

  const STAGES = [
    "Prospect", "Eerste contact", "Meeting / bezoek", "Demo gepland", "Demo gedaan",
    "Proefperiode", "Klant", "On hold", "Niet geïnteresseerd",
  ];
  const FUNNEL = STAGES.slice(0, 7);
  const STATUS = {
    green: "Aan het verkopen",
    orange: "In progress",
    red: "Nog geen contact",
    grey: "Niet geïnteresseerd",
  };
  const ACT_TYPES = ["Prospectie", "Telefoon", "E-mail", "Bezoek", "Demo", "Procedure", "Bestelling", "Andere"];
  const AGE_GROUPS = ["<30", "30-39", "40-49", "50-59", "60-69", "70+"];
  const REGIONS = ["QLD", "NSW", "VIC", "TAS", "SA", "WA", "NT", "ACT", "Andere"];
  // Standaard winkans per fase; per ziekenhuis aan te passen.
  const WIN_CHANCE = { "Prospect": 5, "Eerste contact": 10, "Meeting / bezoek": 20, "Demo gepland": 30, "Demo gedaan": 40, "Proefperiode": 60, "Klant": 100, "On hold": 10, "Niet geïnteresseerd": 0 };
  const STALE_DAYS = 30;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Volumereductie in %, de standaardmaat voor RF-ablatie.
  const vrr = (d) => (d && d.volume && d.followupVolume ? (1 - d.followupVolume / d.volume) * 100 : null);

  // ---------- datums: altijd de kalenderdag van het toestel, nooit UTC ----------
  const pad = (n) => String(n).padStart(2, "0");
  const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function addDays(iso, n) {
    const [y, m, d] = iso.split("-").map(Number);
    return localDate(new Date(y, m - 1, d + n));
  }
  const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

  // ---------- definities: de fase bepaalt de status ----------
  function statusForStage(stage) {
    if (stage === "Klant") return "green";
    if (stage === "Prospect") return "red";
    if (stage === "Niet geïnteresseerd") return "grey";
    return "orange";
  }
  function setStage(h, stage, date) {
    if (h.stage !== stage) {
      h.stage = stage;
      h.stageHistory = [...(h.stageHistory || []), { stage, date }];
    }
    h.status = statusForStage(h.stage);
    if (stage !== "Niet geïnteresseerd") h.lostReason = "";
  }
  // Een contactmoment duwt de fase alleen vooruit, nooit achteruit.
  // Klant = eerste bestelling. Een procedure zonder bestelling is een proefperiode.
  function stageAfterActivity(stage, type) {
    const target = { "Bestelling": "Klant", "Procedure": "Proefperiode", "Demo": "Demo gedaan", "Bezoek": "Meeting / bezoek" }[type] || "Eerste contact";
    const now = FUNNEL.indexOf(stage);
    return now !== -1 && FUNNEL.indexOf(target) > now ? target : stage;
  }

  function ageGroup(age) {
    const n = Number(age);
    if (!n) return "";
    if (n < 30) return "<30";
    if (n >= 70) return "70+";
    const low = Math.floor(n / 10) * 10;
    return `${low}-${low + 9}`;
  }

  // ---------- data controleren ----------
  const SAFE_ID = /^[\w-]{1,64}$/;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const str = (v) => (v === null || v === undefined ? "" : String(v));
  const finite = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const uid = () => Math.random().toString(16).slice(2, 12);
  const safeId = (v) => (SAFE_ID.test(str(v)) ? str(v) : uid());
  const safeDate = (v) => (DATE.test(str(v)) ? str(v) : "");

  // Maakt een ziekenhuis veilig om te tonen, wat er ook binnenkomt (import, oudere versie, andere gebruiker).
  function normalize(h) {
    h.id = safeId(h.id);
    h.name = str(h.name).trim() || "Naamloos";
    for (const k of ["address", "sector", "notes", "nextAction", "owner", "region", "lostReason"]) h[k] = str(h[k]);
    h.nextActionDate = safeDate(h.nextActionDate);
    h.closeDate = safeDate(h.closeDate);
    h.createdAt = safeDate(h.createdAt);
    h.lat = finite(h.lat);
    h.lng = finite(h.lng);
    if (h.lat === null || h.lng === null) h.lat = h.lng = null;
    h.dealValue = finite(h.dealValue) ?? "";
    h.winChance = finite(h.winChance) ?? "";
    h.products = Array.isArray(h.products) ? h.products.map(str) : [];
    h.stage = STAGES.includes(h.stage) ? h.stage : "Prospect";
    h.status = statusForStage(h.stage);
    h.stageHistory = (Array.isArray(h.stageHistory) ? h.stageHistory : [])
      .filter((e) => e && STAGES.includes(e.stage) && DATE.test(str(e.date)))
      .map((e) => ({ stage: e.stage, date: e.date }));
    h.contacts = (Array.isArray(h.contacts) ? h.contacts : []).filter((c) => c && typeof c === "object").map((c) => {
      for (const k of ["name", "role", "phone", "email", "address", "product", "notes"]) c[k] = str(c[k]);
      c.id = safeId(c.id);
      c.primary = !!c.primary;
      return c;
    });
    h.activities = (Array.isArray(h.activities) ? h.activities : []).filter((a) => a && typeof a === "object").map((a) => {
      for (const k of ["type", "product", "contactId", "note", "createdBy"]) a[k] = str(a[k]);
      a.id = safeId(a.id);
      a.date = safeDate(a.date);
      if (a.details && typeof a.details !== "object") delete a.details;
      return a;
    });
    return h;
  }

  // Oude bestanden omzetten; de vroegere handmatige kleur blijft behouden via de fase.
  function migrate(db) {
    if (Number(db.version) >= 2) return false;
    for (const h of db.hospitals) {
      if (!h || typeof h !== "object") continue;
      const acts = Array.isArray(h.activities) ? h.activities : [];
      if (h.stage !== "Niet geïnteresseerd" && h.stage !== "On hold") {
        if (h.status === "green" && h.stage !== "Klant") h.stage = "Klant";
        else if (h.stage === "Prospect" || !h.stage) {
          if (h.status === "orange" || acts.length) h.stage = "Eerste contact";
        }
      }
      for (const a of acts) {
        if (!a || !a.details) continue;
        if (a.details.patientAge) a.details.ageGroup = ageGroup(a.details.patientAge);
        delete a.details.patientAge;
      }
    }
    db.version = 2;
    return true;
  }

  // Maakt een volledig document klaar voor gebruik. Geeft true terug als er iets omgezet werd.
  function prepare(db) {
    if (!db || !Array.isArray(db.hospitals)) throw new Error("geen 'hospitals' gevonden");
    db.hospitals = db.hospitals.filter((h) => h && typeof h === "object");
    const migrated = migrate(db);
    db.hospitals.forEach(normalize);
    return migrated;
  }

  // Controle vóór een import: geeft een lijst met problemen die de gebruiker moet zien.
  function checkImport(data) {
    if (!data || !Array.isArray(data.hospitals)) return ["Het bestand bevat geen 'hospitals'."];
    const problems = [];
    data.hospitals.forEach((h, i) => {
      if (!h || typeof h !== "object") problems.push(`Rij ${i + 1} is geen ziekenhuis.`);
      else if (!str(h.name).trim()) problems.push(`Ziekenhuis op rij ${i + 1} heeft geen naam.`);
    });
    return problems;
  }

  // ---------- samenvoegen: wijzigingen van twee toestellen combineren ----------
  const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const isRecords = (v) => Array.isArray(v) && v.every((x) => isObj(x) && "id" in x);
  function same(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
    if (isObj(a) && isObj(b)) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) if (!same(a[k], b[k])) return false;
      return true;
    }
    return false;
  }
  function mergeValue(base, mine, theirs) {
    if (same(mine, theirs)) return mine;
    if (same(base, mine)) return theirs;
    if (same(base, theirs)) return mine;
    if (isRecords(mine) && isRecords(theirs)) return mergeRecords(isRecords(base) ? base : [], mine, theirs);
    if (isObj(mine) && isObj(theirs)) return mergeObject(isObj(base) ? base : {}, mine, theirs);
    return mine; // zelfde veld op beide toestellen gewijzigd: de laatste opslag wint
  }
  function mergeObject(base, mine, theirs) {
    const out = {};
    for (const k of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
      const v = mergeValue(base[k], mine[k], theirs[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  // Lijsten met id's: per record samenvoegen. Verwijderen wint, behalve als de andere kant het record net wijzigde.
  function mergeRecords(base, mine, theirs) {
    const index = (list) => new Map(list.map((x) => [x.id, x]));
    const b = index(base), m = index(mine), t = index(theirs);
    const ids = [...t.keys(), ...[...m.keys()].filter((id) => !t.has(id))];
    const out = [];
    for (const id of ids) {
      const bb = b.get(id), mm = m.get(id), tt = t.get(id);
      if (!bb) out.push(mm && tt ? mergeObject({}, mm, tt) : mm || tt);
      else if (!mm) { if (!same(bb, tt)) out.push(tt); }
      else if (!tt) { if (!same(bb, mm)) out.push(mm); }
      else out.push(mergeObject(bb, mm, tt));
    }
    return out;
  }
  const merge = (base, mine, theirs) => mergeObject(base || {}, mine, theirs);

  // ---------- overzichten ----------
  const lastContact = (h) => h.activities.reduce((max, a) => (a.date > max ? a.date : max), "");
  const isOverdue = (h, today) => !!h.nextActionDate && h.nextActionDate < today;
  const isActive = (h) => h.stage !== "Niet geïnteresseerd" && h.stage !== "On hold";
  const isStale = (h, today) => {
    const lc = lastContact(h);
    return isActive(h) && h.stage !== "Prospect" && (!lc || daysBetween(lc, today) > STALE_DAYS);
  };
  const needsAction = (h) => isActive(h) && h.stage !== "Prospect" && !h.nextActionDate;

  // Wat vraagt nu aandacht? Elk ziekenhuis staat maar in één actiegroep; follow-ups staan apart.
  function dueGroups(hospitals, today) {
    const week = addDays(today, 7);
    const g = { overdue: [], today: [], week: [], followups: [], noAction: [], stale: [], uncontacted: 0 };
    for (const h of hospitals) {
      for (const a of h.activities) {
        const d = a.type === "Procedure" && a.details;
        if (d && d.followupDate && d.followupDate <= week && !d.followupVolume) g.followups.push({ hospital: h, activity: a });
      }
      if (h.nextActionDate && h.nextActionDate < today) g.overdue.push(h);
      else if (h.nextActionDate === today) g.today.push(h);
      else if (h.nextActionDate && h.nextActionDate <= week) g.week.push(h);
      else if (!h.nextActionDate) {
        if (isStale(h, today)) g.stale.push(h);
        else if (needsAction(h)) g.noAction.push(h);
      }
      if (h.stage === "Prospect") g.uncontacted++;
    }
    const byDate = (a, b) => a.nextActionDate.localeCompare(b.nextActionDate) || a.name.localeCompare(b.name);
    g.overdue.sort(byDate);
    g.week.sort(byDate);
    g.followups.sort((a, b) => a.activity.details.followupDate.localeCompare(b.activity.details.followupDate));
    return g;
  }

  // Trechter: hoeveel ziekenhuizen raakten minstens tot elke fase?
  // Wie afhaakte of on hold staat, telt mee tot de verste fase uit de historiek.
  function funnel(hospitals) {
    const reached = hospitals.map((h) => Math.max(0, FUNNEL.indexOf(h.stage), ...h.stageHistory.map((e) => FUNNEL.indexOf(e.stage))));
    return FUNNEL.map((stage, i) => ({ stage, count: reached.filter((r) => r >= i).length }));
  }
  function daysToCustomer(hospitals) {
    const out = [];
    for (const h of hospitals) {
      const won = h.stageHistory.find((e) => e.stage === "Klant");
      const start = h.createdAt || (h.stageHistory[0] && h.stageHistory[0].date);
      if (won && start && won.date >= start) out.push(daysBetween(start, won.date));
    }
    return out;
  }
  const winChance = (h) => (h.winChance === "" ? WIN_CHANCE[h.stage] : h.winChance);
  function pipelineValue(hospitals) {
    const open = hospitals.filter((h) => h.dealValue && h.stage !== "Klant" && h.stage !== "Niet geïnteresseerd");
    return {
      count: open.length,
      total: open.reduce((s, h) => s + h.dealValue, 0),
      weighted: open.reduce((s, h) => s + (h.dealValue * winChance(h)) / 100, 0),
    };
  }

  const api = {
    STAGES, FUNNEL, STATUS, ACT_TYPES, AGE_GROUPS, REGIONS, WIN_CHANCE, STALE_DAYS,
    esc, vrr, uid, localDate, addDays, daysBetween,
    statusForStage, setStage, stageAfterActivity, ageGroup,
    normalize, migrate, prepare, checkImport, same, merge,
    lastContact, isOverdue, isActive, isStale, needsAction, dueGroups, funnel, daysToCustomer, winChance, pipelineValue,
  };
  root.FollowUpCore = api;
})(typeof window !== "undefined" ? window : globalThis);
