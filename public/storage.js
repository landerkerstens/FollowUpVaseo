/* FollowUp Vaseo – opslag.
 * Zonder Supabase-gegevens in config.js: lokale server (server.py, /api/data).
 * Met Supabase-gegevens: online databank met login en rollen (zie supabase/schema.sql). */
window.FollowUpStore = (() => {
  "use strict";
  const cfg = window.FOLLOWUP_CONFIG || {};
  const t = (k, v) => window.FollowUpI18n.t(k, v);
  const ROW = "main";
  const ME_KEY = "followup-me";
  const $ = (sel) => document.querySelector(sel);

  class ConflictError extends Error {}

  // Wat elke rol mag. app.js en stats.js vergelijken nergens zelf rollen: die lezen alleen store.can.
  // De databank dwingt "niet schrijven" (kijker) en "gebruikers beheren" (beheerder) af;
  // "niet verwijderen" en "niet importeren" (bijdrager) gelden alleen in de app.
  const RIGHTS = {
    admin: { write: true, remove: true, importData: true, manageUsers: true },
    editor: { write: true, remove: true, importData: true, manageUsers: false },
    contributor: { write: true, remove: false, importData: false, manageUsers: false },
    viewer: { write: false, remove: false, importData: false, manageUsers: false },
    none: { write: false, remove: false, importData: false, manageUsers: false },
  };
  const ROLES = Object.keys(RIGHTS);

  // Tot ready() klaar is geldt het krapste recht: liever een knop die te laat verschijnt dan een die te vroeg werkt.
  let me = { id: "", name: "", email: "", role: "viewer" };
  const can = { ...RIGHTS.viewer, noAccess: false };
  function setMe(u) {
    me = { id: u.id || "", name: u.name || "", email: u.email || "", role: RIGHTS[u.role] ? u.role : "viewer" };
    Object.assign(can, RIGHTS[me.role], { noAccess: me.role === "none" });
  }

  const local = {
    mode: "local",
    ConflictError,
    ROLES,
    can,
    me: () => me,
    async ready() {
      // Lokaal is er geen login: één gebruiker aan de eigen computer, en die mag alles behalve gebruikers beheren.
      setMe({ id: cfg.localUser || "", name: cfg.localUser || "", role: "admin" });
      can.manageUsers = false;
    },
    async users() { return []; },
    async saveUser() { throw new Error(t("users.localOnly")); },
    async load() {
      const res = await fetch("/api/data", { cache: "no-store" });
      if (!res.ok) throw new Error(t("store.localFail"));
      return { db: await res.json(), empty: false };
    },
    async save(db) {
      const res = await fetch("/api/data", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(db),
      });
      if (!res.ok) throw new Error((await res.json()).error || res.status);
    },
    async backups() {
      const res = await fetch("/api/backups", { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      return (await res.json()).map((day) => ({ key: day, label: day }));
    },
    async backup(key) {
      const res = await fetch(`/api/backups/${encodeURIComponent(key)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      return res.json();
    },
    async signOut() {},
  };

  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) return local;

  const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  let lastUpdated = null; // versie die we laatst gelezen/geschreven hebben
  const stamp = (iso) => new Date(iso).toLocaleString(window.FollowUpI18n.locale, { dateStyle: "medium", timeStyle: "short" });

  function showLogin() {
    return new Promise((resolve) => {
      const box = $("#login");
      const form = $("#loginForm");
      const err = $("#loginError");
      box.hidden = false;
      form.elements.email.focus();
      form.onsubmit = async (e) => {
        e.preventDefault();
        err.textContent = "";
        const btn = form.querySelector("button");
        btn.disabled = true;
        let error = null;
        try {
          ({ error } = await client.auth.signInWithPassword({
            email: form.elements.email.value.trim(),
            password: form.elements.password.value,
          }));
        } catch (ex) {
          error = ex; // geen netwerk: de knop mag niet uit blijven staan
        }
        btn.disabled = false;
        if (error) {
          err.textContent = t("login.failed", { msg: error.message === "Invalid login credentials" ? t("login.badCredentials") : error.message });
          return;
        }
        form.elements.password.value = "";
        box.hidden = true;
        resolve();
      };
    });
  }

  // Rol ophalen uit app_users.
  // - Tabel bestaat nog niet (schema.sql nog niet opnieuw uitgevoerd): de app werkt zoals voorheen,
  //   iedereen die de databank toelaat mag alles; alleen het gebruikersbeheer ontbreekt.
  // - Geen verbinding: de rol van de vorige keer op dit toestel.
  // - Geen rij of rol "none": geen toegang, en dat zegt de app met zoveel woorden.
  async function loadMe() {
    const { data: s } = await client.auth.getSession();
    const user = s.session && s.session.user;
    if (!user) return;
    const base = { id: user.id, email: user.email || "", name: user.email || "" };
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(ME_KEY)); } catch (e) { /* privévenster */ }
    if (!cached || cached.id !== user.id) cached = null;
    let data = null, error = null;
    try {
      ({ data, error } = await client.from("app_users").select("name, role").eq("id", user.id).maybeSingle());
    } catch (e) {
      error = e;
    }
    if (error) {
      const missing = error.code === "PGRST205" || error.code === "42P01" || /app_users/.test(error.message || "");
      if (!missing && cached) return setMe({ ...base, name: cached.name || base.name, role: cached.role });
      setMe({ ...base, role: "editor" });
      can.legacy = true;
      return;
    }
    setMe({ ...base, name: (data && data.name) || base.name, role: data ? data.role : "none" });
    try { localStorage.setItem(ME_KEY, JSON.stringify({ id: me.id, name: me.name, role: me.role })); } catch (e) { /* privévenster */ }
  }

  return {
    mode: "supabase",
    ConflictError,
    ROLES,
    can,
    me: () => me,
    async ready() {
      const { data } = await client.auth.getSession();
      if (!data.session) await showLogin();
      await loadMe();
    },
    // De hele lijst: voor het beheerscherm en om een naam bij een contactmoment te zetten.
    async users() {
      const { data, error } = await client.from("app_users").select("id, name, role").order("name");
      if (error) throw new Error(error.message);
      return data || [];
    },
    // Enkel een beheerder komt hier door; de rij-beveiliging weigert de rest.
    async saveUser(u) {
      const { data, error } = await client.from("app_users").update({ name: u.name, role: u.role }).eq("id", u.id).select("id");
      if (error) throw new Error(/laatste beheerder/.test(error.message) ? t("users.lastAdmin") : error.message);
      if (!data.length) throw new Error(t("users.notAllowed"));
    },
    async load() {
      const { data, error } = await client.from("app_state").select("data, updated_at").eq("id", ROW).maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) {
        lastUpdated = null;
        return { db: { version: 1, hospitals: [] }, empty: true };
      }
      lastUpdated = data.updated_at;
      return { db: data.data, empty: false };
    },
    async save(db) {
      const now = new Date().toISOString();
      if (lastUpdated === null) {
        const { error } = await client.from("app_state").insert({ id: ROW, data: db, updated_at: now });
        if (error) throw error.code === "23505" ? new ConflictError() : new Error(error.message);
      } else {
        // Enkel overschrijven als niemand anders (bv. je gsm) ondertussen opsloeg.
        const { data, error } = await client.from("app_state")
          .update({ data: db, updated_at: now })
          .eq("id", ROW).eq("updated_at", lastUpdated)
          .select("updated_at");
        if (error) throw new Error(error.message);
        if (!data.length) throw new ConflictError();
      }
      lastUpdated = now;
    },
    // Automatische versies: de nieuwe historiek als die al bestaat (zie schema.sql), anders de dagkopieën.
    async backups() {
      const hist = await client.from("app_state_history").select("seq, saved_at").eq("id", ROW).order("saved_at", { ascending: false }).limit(60);
      if (!hist.error) return hist.data.map((b) => ({ key: `h${b.seq}`, label: stamp(b.saved_at) }));
      const { data, error } = await client.from("app_state_backups").select("day, saved_at").eq("id", ROW).order("day", { ascending: false }).limit(60);
      if (error) throw new Error(error.message);
      return data.map((b) => ({ key: `d${b.day}`, label: stamp(b.saved_at) }));
    },
    async backup(key) {
      const value = key.slice(1);
      const query = key[0] === "h"
        ? client.from("app_state_history").select("data").eq("seq", value)
        : client.from("app_state_backups").select("data").eq("id", ROW).eq("day", value);
      const { data, error } = await query.single();
      if (error) throw new Error(error.message);
      return data.data;
    },
    async signOut() {
      try { localStorage.removeItem(ME_KEY); } catch (e) { /* privévenster */ }
      await client.auth.signOut();
      location.reload();
    },
  };
})();
