/* ============================================================
   ECW Pilot — shared/history.js   (same for every client)
   Loads the patient's past visits and shares them on the page as
   window.__ecwPatientHistory for the coding panel and other modules.
   Loaded by the ECW Pilot loader. To release a change: edit this file,
   then raise "history" -> "version" in manifest.json.

   v2.0 — no page text, no note reading:
     • patient + visit list ...... eCW's Angular data (or the visit picked
                                   on the schedule)
     • CPT / E&M codes ........... /emr/ov/getEncAddtlBillingData, 25 visits
                                   per request (per-visit XML as fallback)
     • diagnoses ................. getAssessment.jsp per visit (XML)
     • insurance per visit ....... the visit's claim (or, not billed yet,
                                   the patient's current insurance). Fetched
                                   first only for the visits the rules need
                                   (same calendar year / last 60 days);
                                   History is ready then, and the rest fills
                                   in the background.
   ============================================================ */
(function () {
  "use strict";
  if (window.__ecwPatientHistory) return;   // already running on this page

  // ─── CONFIG ──────────────────────────────────────────────────────────────────
  const MAX_HISTORY_ENCOUNTERS = 50;
  const FETCH_CONCURRENCY      = 6;
  const FETCH_TIMEOUT_MS       = 12000;
  const BILLING_BATCH_SIZE     = 25;
  const PRIORITY_DAYS          = 60;     // insurance needed first for visits this recent…
  const WATCH_INTERVAL_MS      = 1500;   // …or in the same calendar year as the visit
  const CACHE_MAX              = 400;
  const EP = {
    assessment:   "/mobiledoc/jsp/catalog/xml/getAssessment.jsp",
    billingBatch: "/mobiledoc/emr/ov/getEncAddtlBillingData",
    billingOne:   "/mobiledoc/jsp/catalog/xml/getEncAddtlBillingData.jsp",
    claimForEnc:  "/mobiledoc/jsp/catalog/xml/CheckClaimForEnc.jsp",
    claimDetail:  "/mobiledoc/jsp/rcm/claims/getClaimDetail.jsp",
    claimIns:     "/mobiledoc/jsp/catalog/xml/edi/getInvInsList.jsp",
    ptIns:        "/mobiledoc/jsp/catalog/xml/getPtInsurances.jsp"
  };

  // ─── STATE ───────────────────────────────────────────────────────────────────
  let data = null, loading = false, loadPromise = null;
  let currentPatientKey = "", loadedKey = "", token = 0, revision = 0;
  let progress = { total: 0, completed: 0, current: "", currentDos: "", errors: 0, partial: [] };
  let scheduleTarget = null;             // { pid, encId, dos, encIds: {id: date} } — schedule mode
  const cache = new Map();               // encounterId -> { codes, assessments, insurance… } (older visits)

  // ─── ANGULAR CONTEXT (no page text) ──────────────────────────────────────────
  function ngScopeOf(sel) {
    const el = document.querySelector(sel);
    if (!el || !window.angular) return null;
    try { const a = angular.element(el); return a.isolateScope() || a.scope(); } catch (e) { return null; }
  }
  function scopeValue(key) {
    if (!window.angular) return null;
    for (const el of document.querySelectorAll(".ng-scope")) {
      try { for (let s = angular.element(el).scope(); s; s = s.$parent) if (s[key] != null) return s[key]; } catch (e) {}
    }
    return null;
  }
  // The open chart: patient, open visit, visit list — from Angular.
  function chartContext() {
    const tabs = ngScopeOf("#tabspanel"), pn = ngScopeOf("#pnController");
    let pid = tabs && tabs.patientId || pn && pn.patientId;
    let encid = String(tabs && (tabs.currentEnc && tabs.currentEnc.encounterId || tabs.encounterId) || pn && pn.encounterId || "");
    let list = tabs && Array.isArray(tabs.patientEncounters) ? tabs.patientEncounters : null;
    if (!pid || !encid) {
      const ras = scopeValue("roomAndStatus"), enc = ras && ras.encounterObj;
      if (enc) { pid = pid || enc.patientId; encid = encid || String(enc.encounterId || ""); }
    }
    if (!list) { const l = scopeValue("patientEncounters"); list = Array.isArray(l) ? l : []; }
    if (!pid || !encid) return null;
    return { pid: String(pid), encid, list };
  }
  function context() {
    const c = chartContext();
    if (c) return c;                                   // a chart is open: always the chart
    if (scheduleTarget) return { pid: String(scheduleTarget.pid), encid: String(scheduleTarget.encId), list: null, target: scheduleTarget };
    return null;
  }

  // ─── HELPERS ─────────────────────────────────────────────────────────────────
  function normDate(s) {
    const t = String(s || "").trim();
    let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[1].padStart(2, "0")}/${m[2].padStart(2, "0")}/${m[3]}`;
    m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[2]}/${m[3]}/${m[1]}` : "";
  }
  function ts(s) { const m = normDate(s).match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? +new Date(+m[3], +m[1] - 1, +m[2]) : 0; }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const yieldToBrowser = () => new Promise(r => ("requestIdleCallback" in window ? requestIdleCallback(r, { timeout: 200 }) : setTimeout(r, 0)));
  const userId = () => (window.global && window.global.TrUserId) || document.querySelector("#userProId")?.value || "";

  async function xfetch(url, opts = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(url, { credentials: "include", ...opts, signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } finally { clearTimeout(t); }
  }
  async function pool(items, fn, n) {
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    }));
    return out;
  }
  const xp = new DOMParser();
  const parseXml = t => { const d = xp.parseFromString(String(t || ""), "text/xml"); return d.querySelector("parsererror") ? null : d; };
  const child = (n, tag) => { for (const c of n.children) if (c.nodeName === tag) return (c.textContent || "").trim(); return ""; };

  // ─── PARSERS (structured XML / JSON only) ────────────────────────────────────
  function parseAssessments(text) {
    const doc = parseXml(text); if (!doc) return [];
    const out = [], seen = new Set();
    for (const grp of ["primary", "secondary"]) for (const g of doc.getElementsByTagName(grp)) for (const c of g.children) {
      if (c.nodeName !== "code") continue;
      const code = child(c, "medicalcode").toUpperCase();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      out.push({ code, details: child(c, "name"), modifiers: "", primary: grp === "primary", order: Number(child(c, "displayindex") || child(c, "displayIndex")) || 999 });
    }
    return out.sort((a, b) => (b.primary - a.primary) || (a.order - b.order));
  }
  function parseBilling(text) {
    const res = { visit_codes: [], procedure_codes: [] };
    const doc = parseXml(text); if (!doc) return res;
    const seen = new Set();
    for (const it of doc.getElementsByTagName("item")) {
      const code = child(it, "code").toUpperCase(); if (!code) continue;
      const mods = ["mod1", "mod2", "mod3", "mod4"].map(m => child(it, m)).filter(Boolean);
      const key = code + "|" + mods.join(","); if (seen.has(key)) continue; seen.add(key);
      const row = { code, details: child(it, "name"), modifiers: mods.join(", "), units: child(it, "units") };
      (child(it, "codeFlag") === "E" ? res.visit_codes : res.procedure_codes).push(row);
    }
    return res;
  }

  // ─── LOADERS ─────────────────────────────────────────────────────────────────
  async function loadBillingMap(ids) {
    const map = new Map();
    for (let i = 0; i < ids.length; i += BILLING_BATCH_SIZE) {
      const chunk = ids.slice(i, i + BILLING_BATCH_SIZE);
      try {
        const j = await (await xfetch(EP.billingBatch, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ encounterIds: chunk.map(Number) }) })).json();
        for (const id of chunk) { const v = j && j[id]; if (typeof v === "string" && v.trim()) map.set(id, parseBilling(v)); }
      } catch (e) { /* fall back per visit below */ }
    }
    const missing = ids.filter(id => !map.has(id));
    await pool(missing, async id => {
      try { map.set(id, parseBilling(await (await xfetch(`${EP.billingOne}?Id=${encodeURIComponent(id)}`)).text())); }
      catch (e) { map.set(id, { visit_codes: [], procedure_codes: [], error: true }); }
    }, FETCH_CONCURRENCY);
    return map;
  }
  async function loadAssessments(id) {
    return parseAssessments(await (await xfetch(`${EP.assessment}?Id=${encodeURIComponent(id)}&TrUserId=${encodeURIComponent(userId())}&Device=webemr`)).text());
  }
  // Insurance billed on the visit's claim ('' when there is no claim yet).
  async function loadClaimInsurance(encId) {
    const d = parseXml(await (await xfetch(EP.claimForEnc, { method: "POST", body: new URLSearchParams({ encounterId: encId }) })).text());
    const claimId = (d && d.getElementsByTagName("claimId")[0]?.textContent || "").trim();
    if (!claimId || claimId === "0") return { claimId: "", name: "" };
    let name = "";
    try {
      const j = await (await xfetch(`${EP.claimDetail}?claimId=${encodeURIComponent(claimId)}`)).json();
      if (j && String(j.status).toLowerCase() === "success") {
        const ins = (j.insurance || []).map(i => ({ name: String(i.name || "").trim(), seq: Number(i.sequence) || 99 })).filter(i => i.name).sort((a, b) => a.seq - b.seq);
        name = ins[0] ? ins[0].name : "";
      }
    } catch (e) {}
    if (!name) {
      try {
        const x = parseXml(await (await xfetch(`${EP.claimIns}?InvId=${encodeURIComponent(claimId)}`)).text());
        const rows = x ? [...x.getElementsByTagName("InsName")].map(n => ({ name: (n.textContent || "").trim(), seq: Number(child(n.parentNode, "SeqNo")) || 99 })).filter(r => r.name) : [];
        rows.sort((a, b) => a.seq - b.seq);
        name = rows[0] ? rows[0].name : "";
      } catch (e) {}
    }
    return { claimId, name };
  }
  // The patient's current primary insurance (for visits not billed yet).
  async function loadCurrentInsurance(pid) {
    const p = scopeValue("patientobj");
    const fromAngular = p && (String(p.insurance || "").trim() || String(p.insurances || "").split(/[,;|\n]/).map(x => x.trim()).filter(Boolean)[0]);
    if (fromAngular && !scheduleTarget) return fromAngular;
    try {
      const d = parseXml(await (await xfetch(`${EP.ptIns}?patientid=${encodeURIComponent(pid)}`)).text());
      if (!d) return fromAngular || "";
      const rows = [...d.getElementsByTagName("*")].filter(n => [...n.children].some(c => c.nodeName === "insuranceName"))
        .map(n => ({ name: child(n, "insuranceName"), seq: Number(child(n, "SeqNo")) || 99, active: child(n, "ActiveIns") !== "0" }))
        .filter(r => r.name && r.active).sort((a, b) => a.seq - b.seq);
      return rows[0] ? rows[0].name : (fromAngular || "");
    } catch (e) { return fromAngular || ""; }
  }

  // ─── VISIT LIST ──────────────────────────────────────────────────────────────
  // The open visit and the older ones (newest first), up to 50.
  function visitList(c) {
    let rows;
    if (c.target) {
      rows = Object.entries(c.target.encIds || {}).map(([id, dos]) => ({ id: String(id), dos: normDate(dos) }));
    } else {
      const all = (c.list || []).filter(e => e && e.encounterID);
      const idx = all.findIndex(e => String(e.encounterID) === c.encid);
      rows = (idx >= 0 ? all.slice(idx) : all).map(e => ({ id: String(e.encounterID), dos: normDate(e.date), visitType: e.visitType || "" }));
    }
    if (!rows.some(r => r.id === c.encid)) rows.unshift({ id: c.encid, dos: c.target ? normDate(c.target.dos) : "" });
    rows.sort((a, b) => (ts(b.dos) - ts(a.dos)) || (Number(b.id) - Number(a.id)));
    const cur = rows.find(r => r.id === c.encid);
    const curTs = cur ? ts(cur.dos) : 0;
    return rows.filter(r => r.id === c.encid || !curTs || !ts(r.dos) || ts(r.dos) <= curTs).slice(0, MAX_HISTORY_ENCOUNTERS);
  }
  // Visits whose insurance the rules need: same calendar year as the open
  // visit, or within PRIORITY_DAYS before it.
  function isPriority(v, curDos) {
    if (!curDos || !v.dos) return true;
    const a = ts(v.dos), b = ts(curDos);
    return new Date(a).getFullYear() === new Date(b).getFullYear() || (b - a) <= PRIORITY_DAYS * 864e5;
  }

  // ─── BUILD ───────────────────────────────────────────────────────────────────
  async function build(tk, c) {
    const encs = visitList(c);
    const cur = c.encid, curDos = (encs.find(e => e.id === cur) || {}).dos || "";
    progress = { total: encs.length, completed: 0, current: "", currentDos: "", errors: 0, partial: [] };
    const currentInsP = loadCurrentInsurance(c.pid);

    // 1-3 run at the same time: codes (batch), diagnoses (per visit) and the
    // insurance of the visits the rules need. Older visits' insurance fills in
    // afterwards in the background.
    const needCodes = encs.filter(e => e.id === cur || !cache.has(e.id)).map(e => e.id);
    const billP = needCodes.length ? loadBillingMap(needCodes) : Promise.resolve(new Map());
    const insOf = new Map();                               // encounterId -> { name, source }
    const fetchIns = async e => {
      if (insOf.has(e.id)) return;
      const cached = e.id !== cur && cache.get(e.id);
      if (cached && cached.insurance_source === "claim") { insOf.set(e.id, { name: cached.insurance_name, source: "claim" }); return; }
      let ci = { name: "" };
      try { ci = await loadClaimInsurance(e.id); } catch (err) {}
      const currentIns = await currentInsP;
      insOf.set(e.id, ci.name ? { name: ci.name, source: "claim" } : { name: currentIns || "", source: currentIns ? "patient-current" : "" });
    };
    const nowEncs = encs.filter(e => e.id === cur || isPriority(e, curDos));
    const laterEncs = encs.filter(e => !nowEncs.includes(e));
    const insNowP = pool(nowEncs, fetchIns, 3);
    const asmP = pool(encs, async e => {
      if (tk !== token) return null;
      progress.current = e.id; progress.currentDos = e.dos;
      try {
        if (e.id !== cur && cache.has(e.id)) return { e, cached: Object.assign({}, cache.get(e.id)) };
        const assessments = await loadAssessments(e.id);
        await yieldToBrowser();
        return { e, assessments };
      } catch (err) { progress.errors++; return { e, error: String(err && err.message || err) }; }
      finally { progress.completed++; }
    }, FETCH_CONCURRENCY);
    const [bill, asm] = await Promise.all([billP, asmP]);
    if (tk !== token) return null;
    progress.currentDos = "Insurance…";
    await insNowP;
    if (tk !== token) return null;
    const rowOf = x => {
      if (!x) return null;
      if (x.cached) return x.cached;
      const e = x.e, b = bill.get(e.id) || { visit_codes: [], procedure_codes: [] }, ins = insOf.get(e.id) || { name: "", source: "" };
      const row = { encounter_id: e.id, encounter_date: e.dos, visit_type: e.visitType || "", insurance_name: ins.name, insurance_source: ins.source,
        assessments: x.assessments || [], visit_codes: b.visit_codes, procedure_codes: b.procedure_codes };
      if (x.error) row.error = x.error; else if (b.error) row.error = "codes unavailable";
      if (e.id !== cur && !row.error && row.insurance_source === "claim") { if (cache.size >= CACHE_MAX) cache.clear(); cache.set(e.id, Object.assign({}, row)); }
      return row;
    };
    const list = asm.map(rowOf).filter(Boolean);
    progress.partial = list;
    // background: older visits' insurance (rules don't wait for these)
    const later = list.filter(r => laterEncs.some(e => e.id === r.encounter_id) && !r.insurance_source);
    if (later.length) {
      (async () => {
        await pool(later, async r => {
          await fetchIns({ id: r.encounter_id });
          const ins = insOf.get(r.encounter_id);
          if (ins) { r.insurance_name = ins.name; r.insurance_source = ins.source; }
          if (r.encounter_id !== cur && !r.error && r.insurance_source === "claim") { if (cache.size >= CACHE_MAX) cache.clear(); cache.set(r.encounter_id, Object.assign({}, r)); }
        }, 3);
        if (tk === token) revision++;
      })();
    }
    progress.currentDos = "";
    list.sort((a, b) => (ts(b.encounter_date) - ts(a.encounter_date)) || (Number(b.encounter_id) - Number(a.encounter_id)));
    return list;
  }

  function load(force) {
    const c = context();
    if (!c) return Promise.resolve([]);
    const key = `pid_${c.pid}`, encKey = `${key}|${c.encid}`;
    if (!force && data && loadedKey === encKey) return Promise.resolve(data);
    currentPatientKey = key; loadedKey = encKey;
    loading = true; data = null; revision++;
    const tk = ++token;
    loadPromise = (async () => {
      try { const d = await build(tk, c); if (tk === token && d) data = d; return d || []; }
      catch (e) { console.warn("[ECW Pilot] history failed", e); if (tk === token) data = []; return []; }
      finally { if (tk === token) { loading = false; loadPromise = null; revision++; } }
    })();
    return loadPromise;
  }

  // ─── WATCHER: reload when the patient or the open visit changes ──────────────
  function tick() {
    const c = context();
    if (!c) return;
    const encKey = `pid_${c.pid}|${c.encid}`;
    if (encKey !== loadedKey) load(true);
  }
  setInterval(tick, WATCH_INTERVAL_MS);
  setTimeout(tick, 300);

  // ─── BRIDGE (same as before, plus getRevision) ───────────────────────────────
  window.__ecwPatientHistory = {
    getData: () => data,
    isLoading: () => loading,
    getErrors: () => progress.errors || 0,
    getCurrentKey: () => currentPatientKey,
    getEncounterCount: () => (data ? data.length : 0),
    getProgress: () => progress,
    getCurrentEncounterId: () => { const c = context(); return c ? c.encid : ""; },
    // changes whenever the data changes (incl. background insurance fill)
    getRevision: () => revision,
    reload: () => load(true),
    // Schedule mode (ECW Pilot): load a patient picked on the schedule.
    // Ignored whenever a chart is open, so the chart's History is never affected.
    setScheduleTarget: t => { scheduleTarget = t || null; return t ? load(true) : null; },
    getScheduleTarget: () => scheduleTarget
  };
})();
