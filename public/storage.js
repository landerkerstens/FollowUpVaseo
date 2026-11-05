/* FollowUp Vaseo – opslag.
 * Zonder Supabase-gegevens in config.js: lokale server (server.py, /api/data).
 * Met Supabase-gegevens: online databank met login. */
window.FollowUpStore = (() => {
  "use strict";
  const cfg = window.FOLLOWUP_CONFIG || {};
  const ROW = "main";
  const $ = (sel) => document.querySelector(sel);

  class ConflictError extends Error {}

  const local = {
    mode: "local",
    ConflictError,
    async ready() {},
    async load() {
      const res = await fetch("/api/data", { cache: "no-store" });
      if (!res.ok) throw new Error("Kan de data niet laden. Start de website met: python3 server.py en open http://localhost:8080");
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
  const stamp = (iso) => new Date(iso).toLocaleString("nl-BE", { dateStyle: "medium", timeStyle: "short" });

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
        const { error } = await client.auth.signInWithPassword({
          email: form.elements.email.value.trim(),
          password: form.elements.password.value,
        });
        btn.disabled = false;
        if (error) {
          err.textContent = "Aanmelden mislukt: " + (error.message === "Invalid login credentials" ? "verkeerd e-mailadres of wachtwoord" : error.message);
          return;
        }
        form.elements.password.value = "";
        box.hidden = true;
        resolve();
      };
    });
  }

  return {
    mode: "supabase",
    ConflictError,
    userEmail: "",
    async ready() {
      const { data } = await client.auth.getSession();
      if (!data.session) await showLogin();
      const { data: after } = await client.auth.getSession();
      this.userEmail = (after.session && after.session.user.email) || "";
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
      await client.auth.signOut();
      location.reload();
    },
  };
})();
