/* Testen van public/core.js. Start met: tests/run.sh */
const C = globalThis.FollowUpCore;
let failed = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; print(`FOUT  ${name}: ${e.message}`); }
}
function eq(actual, expected) {
  if (!C.same(actual, expected)) throw new Error(`kreeg ${JSON.stringify(actual)}, verwachtte ${JSON.stringify(expected)}`);
}
const hospital = (o = {}) => C.normalize({ id: "h1", name: "Test", ...o });

test("localDate gebruikt de kalenderdag van het toestel", () => {
  eq(C.localDate(new Date(2026, 10, 5, 8, 30)), "2026-11-05");
  eq(C.localDate(new Date(2026, 10, 5, 23, 59)), "2026-11-05");
});
test("addDays gaat over maand en jaar heen", () => {
  eq(C.addDays("2026-12-30", 7), "2027-01-06");
});

test("status volgt altijd de fase", () => {
  eq(C.statusForStage("Klant"), "green");
  eq(C.statusForStage("Prospect"), "red");
  eq(C.statusForStage("Demo gedaan"), "orange");
  eq(C.statusForStage("Niet geïnteresseerd"), "grey");
  eq(hospital({ stage: "Klant", status: "red" }).status, "green");
});
test("een procedure maakt geen klant, een bestelling wel", () => {
  eq(C.stageAfterActivity("Prospect", "Procedure"), "Proefperiode");
  eq(C.stageAfterActivity("Proefperiode", "Procedure"), "Proefperiode");
  eq(C.stageAfterActivity("Proefperiode", "Bestelling"), "Klant");
});
test("een contactmoment zet de fase nooit achteruit", () => {
  eq(C.stageAfterActivity("Klant", "Telefoon"), "Klant");
  eq(C.stageAfterActivity("Demo gedaan", "Bezoek"), "Demo gedaan");
  eq(C.stageAfterActivity("Niet geïnteresseerd", "Bestelling"), "Niet geïnteresseerd");
  eq(C.stageAfterActivity("Eerste contact", "Bezoek"), "Meeting / bezoek");
});
test("setStage houdt de historiek bij", () => {
  const h = hospital();
  C.setStage(h, "Demo gedaan", "2026-01-02");
  C.setStage(h, "Demo gedaan", "2026-01-03");
  eq(h.stageHistory, [{ stage: "Demo gedaan", date: "2026-01-02" }]);
  eq(h.status, "orange");
});

test("leeftijdsklassen", () => {
  eq([C.ageGroup(25), C.ageGroup(30), C.ageGroup(47), C.ageGroup(69), C.ageGroup(70), C.ageGroup("")], ["<30", "30-39", "40-49", "60-69", "70+", ""]);
});
test("migratie: groene status blijft groen, leeftijd wordt klasse", () => {
  const db = { version: 1, hospitals: [
    { id: "a", name: "A", status: "green", stage: "Demo gedaan" },
    { id: "b", name: "B", status: "orange", stage: "Prospect" },
    { id: "c", name: "C", status: "red", stage: "Prospect" },
    { id: "d", name: "D", status: "green", stage: "Niet geïnteresseerd" },
    { id: "e", name: "E", status: "red", stage: "Prospect", activities: [{ id: "x", date: "2026-01-01", type: "Procedure", details: { patientAge: 47, volume: 5 } }] },
  ] };
  eq(C.prepare(db), true);
  eq(db.hospitals.map((h) => [h.stage, h.status]), [["Klant", "green"], ["Eerste contact", "orange"], ["Prospect", "red"], ["Niet geïnteresseerd", "grey"], ["Eerste contact", "orange"]]);
  eq(db.hospitals[4].activities[0].details, { ageGroup: "40-49", volume: 5 });
  eq(db.version, 2);
  eq(C.prepare(db), false);
});

test("onveilige waarden worden onschadelijk", () => {
  const h = C.normalize({ id: '"><img src=x onerror=alert(1)>', name: 5, status: "<script>", stage: "bestaat niet", lat: "abc", lng: 3,
    contacts: [{ id: '"x', name: null }, null], activities: [{ id: "a b", date: "gisteren" }, "fout"] });
  eq(/^[\w-]+$/.test(h.id), true);
  eq(h.name, "5");
  eq(h.status, "red");
  eq(h.stage, "Prospect");
  eq([h.lat, h.lng], [null, null]);
  eq(h.contacts.length, 1);
  eq(/^[\w-]+$/.test(h.contacts[0].id), true);
  eq(h.activities.length, 1);
  eq(h.activities[0].date, "");
});
test("import: naamloos ziekenhuis wordt gemeld", () => {
  eq(C.checkImport({ hospitals: [{ name: "A" }] }), []);
  eq(C.checkImport({ hospitals: [{ name: " " }] }).length, 1);
  eq(C.checkImport({ hospitals: [null] }).length, 1);
  eq(C.checkImport({}).length, 1);
  eq(C.checkImport(null).length, 1);
});
test("esc", () => {
  eq(C.esc(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
});

const doc = (hospitals) => ({ version: 2, hospitals });
const H = (id, o = {}) => ({ id, name: id, notes: "", activities: [], contacts: [], ...o });
test("samenvoegen: verschillende velden blijven allebei", () => {
  const base = doc([H("a")]);
  const r = C.merge(base, doc([H("a", { notes: "gsm" })]), doc([H("a", { name: "desktop" })]));
  eq(r.hospitals[0].notes, "gsm");
  eq(r.hospitals[0].name, "desktop");
});
test("samenvoegen: nieuwe contactmomenten van twee toestellen blijven allebei", () => {
  const base = doc([H("a")]);
  const m = doc([H("a", { activities: [{ id: "1", note: "gsm" }] })]);
  const t = doc([H("a", { activities: [{ id: "2", note: "desktop" }] })]);
  eq(C.merge(base, m, t).hospitals[0].activities.map((a) => a.id).sort(), ["1", "2"]);
});
test("samenvoegen: nieuw ziekenhuis aan beide kanten", () => {
  const r = C.merge(doc([]), doc([H("a")]), doc([H("b")]));
  eq(r.hospitals.map((h) => h.id).sort(), ["a", "b"]);
});
test("samenvoegen: verwijderen wint als de andere kant niets wijzigde", () => {
  const base = doc([H("a"), H("b")]);
  eq(C.merge(base, doc([H("b")]), base).hospitals.map((h) => h.id), ["b"]);
  eq(C.merge(base, base, doc([H("b")])).hospitals.map((h) => h.id), ["b"]);
});
test("samenvoegen: een gewijzigd record overleeft een verwijdering", () => {
  const base = doc([H("a")]);
  eq(C.merge(base, doc([]), doc([H("a", { notes: "belangrijk" })])).hospitals[0].notes, "belangrijk");
  eq(C.merge(base, doc([H("a", { notes: "belangrijk" })]), doc([])).hospitals[0].notes, "belangrijk");
});
test("samenvoegen: zelfde veld, dan wint de laatste opslag", () => {
  const r = C.merge(doc([H("a")]), doc([H("a", { notes: "mijn" })]), doc([H("a", { notes: "hun" })]));
  eq(r.hospitals[0].notes, "mijn");
});
test("samenvoegen zonder wijzigingen levert exact de andere kant", () => {
  const base = doc([H("a")]);
  const theirs = doc([H("a", { notes: "nieuw" }), H("c")]);
  eq(C.merge(base, base, theirs), theirs);
});
test("samenvoegen: doelen en detailvelden per sleutel", () => {
  const base = { hospitals: [], targets: { 2027: { Thyroid: 1 } } };
  const r = C.merge(base, { hospitals: [], targets: { 2027: { Thyroid: 2 } } }, { hospitals: [], targets: { 2027: { Thyroid: 1 }, 2028: { Fibroid: 9 } } });
  eq(r.targets, { 2027: { Thyroid: 2 }, 2028: { Fibroid: 9 } });
});

const today = "2026-11-05";
test("dueGroups verdeelt ziekenhuizen over de juiste groepen", () => {
  const hs = [
    hospital({ id: "late", stage: "Demo gedaan", nextActionDate: "2026-11-01", activities: [{ id: "1", date: today, type: "Bezoek" }] }),
    hospital({ id: "now", stage: "Demo gedaan", nextActionDate: today }),
    hospital({ id: "soon", stage: "Demo gedaan", nextActionDate: "2026-11-12" }),
    hospital({ id: "far", stage: "Demo gedaan", nextActionDate: "2027-01-01" }),
    hospital({ id: "none", stage: "Klant", activities: [{ id: "1", date: "2026-11-01", type: "Bezoek" }] }),
    hospital({ id: "quiet", stage: "Klant", activities: [{ id: "1", date: "2026-01-01", type: "Bezoek" }] }),
    hospital({ id: "new", stage: "Prospect" }),
    hospital({ id: "lost", stage: "Niet geïnteresseerd" }),
  ];
  const g = C.dueGroups(hs, today);
  eq(g.overdue.map((h) => h.id), ["late"]);
  eq(g.today.map((h) => h.id), ["now"]);
  eq(g.week.map((h) => h.id), ["soon"]);
  eq(g.noAction.map((h) => h.id), ["none"]);
  eq(g.stale.map((h) => h.id), ["quiet"]);
  eq(g.uncontacted, 1);
});
test("dueGroups: follow-up zonder resultaat komt op de lijst, met resultaat niet", () => {
  const hs = [hospital({ activities: [
    { id: "1", date: "2026-05-01", type: "Procedure", details: { followupDate: "2026-11-01" } },
    { id: "2", date: "2026-05-01", type: "Procedure", details: { followupDate: "2026-11-01", followupVolume: 2 } },
    { id: "3", date: "2026-05-01", type: "Procedure", details: { followupDate: "2027-05-01" } },
  ] })];
  eq(C.dueGroups(hs, today).followups.map((f) => f.activity.id), ["1"]);
});
test("trechter telt ook wie later afhaakte", () => {
  const hs = [hospital({ stage: "Klant" }), hospital({ stage: "Prospect" }),
    hospital({ stage: "Niet geïnteresseerd", stageHistory: [{ stage: "Demo gedaan", date: today }, { stage: "Niet geïnteresseerd", date: today }] })];
  const f = C.funnel(hs);
  eq(f[0], { stage: "Prospect", count: 3 });
  eq(f[4], { stage: "Demo gedaan", count: 2 });
  eq(f[6], { stage: "Klant", count: 1 });
});
test("doorlooptijd tot klant", () => {
  const hs = [hospital({ createdAt: "2026-01-01", stage: "Klant", stageHistory: [{ stage: "Klant", date: "2026-01-11" }] }), hospital()];
  eq(C.daysToCustomer(hs), [10]);
});
test("pijplijnwaarde: klanten en afgehaakten tellen niet mee", () => {
  const p = C.pipelineValue([
    hospital({ stage: "Proefperiode", dealValue: 1000 }),
    hospital({ stage: "Demo gedaan", dealValue: 1000, winChance: 50 }),
    hospital({ stage: "Klant", dealValue: 9999 }),
    hospital({ stage: "Niet geïnteresseerd", dealValue: 9999 }),
    hospital({ stage: "Prospect" }),
  ]);
  eq(p, { count: 2, total: 2000, weighted: 1100 });
});

print(`${passed} geslaagd, ${failed} mislukt`);
if (failed) throw new Error("tests mislukt");
