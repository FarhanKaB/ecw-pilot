// ==UserScript==
// @name         ECW Pilot
// @namespace    ecw-pilot
// @version      1.0
// @description  Loads ECW Pilot for your practice from GitHub: coding panel, patient history, Sort, Link and Claim Link.
// @match        *://*.ecwcloud.com/*
// @match        *://*.eclinicalworks.com/*
// @match        *://*.eclinicalweb.com/*
// @match        https://*.com/mobiledoc/jsp/webemr/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/FarhanKaB/ecw-pilot/main/loader/ECW_Pilot.user.js
// @downloadURL  https://raw.githubusercontent.com/FarhanKaB/ecw-pilot/main/loader/ECW_Pilot.user.js
// ==/UserScript==

/*  ECW Pilot loader — the ONE script everyone installs.
    On each eCW page it:
      1. reads manifest.json from GitHub,
      2. works out the client from the eCW address (manifest -> clients -> hosts),
      3. runs shared/history.js, then that client's coding.js,
      4. runs Sort / Link / Claim Link if they're turned on (settings menu),
      5. keeps the last good copy of every file, so it still works if GitHub
         can't be reached,
      6. checks for a newer version every 20 minutes (only while the tab is
         visible) and tells the panel, which shows "refresh to update".
    Files are only downloaded again when their version in manifest.json
    goes up — so a normal page load downloads just the small manifest.     */

(function () {
    'use strict';

    // ===================== EDIT THIS ONE LINE =====================
    const REPO_ROOT = 'https://raw.githubusercontent.com/FarhanKaB/ecw-pilot/';
    // ==============================================================

    const LOADER_VERSION = '1.0';
    const CHECK_EVERY_MIN = 20;
    const FETCH_TIMEOUT_MS = 10000;

    if (window.top !== window.self) return;     // top page only, never inside frames
    if (window.ECWPilot) return;                // one loader per page

    // Testers: localStorage.setItem('ecwpilot:branch', 'beta') then refresh.
    const BRANCH = safeGet('ecwpilot:branch') || 'main';
    const REPO = REPO_ROOT + BRANCH + '/';

    const SETTINGS_KEY = 'ecwpilot:settings';
    const CACHE_PREFIX = 'ecwpilot:cache:';
    const SEEN_KEY = 'ecwpilot:seen';
    const MANIFEST_CACHE = 'ecwpilot:manifest';

    function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function safeSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
    function readJSON(k, fallback) { try { const v = safeGet(k); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } }

    async function fetchText(url) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return await res.text();
        } finally { clearTimeout(timer); }
    }

    async function getManifest(fresh) {
        try {
            const text = await fetchText(REPO + 'manifest.json?t=' + Date.now());
            const m = JSON.parse(text);
            safeSet(MANIFEST_CACHE, text);
            return m;
        } catch (e) {
            if (fresh) return null;
            console.warn('ECW Pilot: GitHub not reachable — using the last saved manifest', e);
            return readJSON(MANIFEST_CACHE, null);
        }
    }

    function findClient(manifest) {
        const host = location.hostname.toLowerCase();
        const forced = safeGet('ecwpilot:client');
        for (const [id, c] of Object.entries(manifest.clients || {})) {
            if (forced ? forced === id : (c.hosts || []).some(h => host === h.toLowerCase())) return Object.assign({ id }, c);
        }
        return null;
    }

    // Every loadable file: shared ones plus this client's own.
    function fileTable(manifest, client) {
        const t = {};
        for (const [k, f] of Object.entries(manifest.shared || {})) t[k] = Object.assign({ key: k, scope: 'shared' }, f);
        for (const [k, f] of Object.entries((client && client.files) || {})) t[k] = Object.assign({ key: k, scope: client.id }, f);
        return t;
    }

    // Cached by path + version: only downloaded again when the version changes.
    async function getCode(entry) {
        const cacheKey = CACHE_PREFIX + entry.path;
        const cached = readJSON(cacheKey, null);
        if (cached && cached.version === entry.version && cached.code) return cached.code;
        try {
            const code = await fetchText(REPO + entry.path + '?v=' + encodeURIComponent(entry.version));
            if (!safeSet(cacheKey, JSON.stringify({ version: entry.version, code }))) {
                console.warn('ECW Pilot: browser storage full — ' + entry.path + ' not saved for offline use');
            }
            return code;
        } catch (e) {
            if (cached && cached.code) {
                console.warn(`ECW Pilot: couldn't download ${entry.path} v${entry.version} — using saved v${cached.version}`, e);
                return cached.code;
            }
            throw e;
        }
    }

    function run(code, label) {
        // Runs in the page, the same way the files would run as their own
        // @grant none userscripts. `window` and `ECWPilot` are passed in.
        try {
            new Function('window', 'ECWPilot', code + '\n//# sourceURL=ecw-pilot/' + label + '.js')(window, window.ECWPilot);
            return true;
        } catch (e) {
            console.error('ECW Pilot: ' + label + ' failed to start', e);
            return false;
        }
    }

    function showNotice(text) {
        const el = document.createElement('div');
        el.textContent = text;
        el.setAttribute('role', 'status');
        Object.assign(el.style, {
            position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483000', maxWidth: '360px',
            padding: '10px 14px', borderRadius: '8px', background: '#1b2a2f', color: '#fff',
            font: '12.5px "Segoe UI", Arial, sans-serif', boxShadow: '0 6px 20px rgba(0,0,0,.25)'
        });
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 8000);
    }

    (async function start() {
        const manifest = await getManifest(false);
        if (!manifest) { console.error('ECW Pilot: no manifest available (GitHub unreachable and nothing saved yet)'); return; }
        const client = findClient(manifest);
        if (!client) {
            console.warn('ECW Pilot: ' + location.hostname + ' is not set up for any client in manifest.json');
            if (/\/mobiledoc\//.test(location.pathname)) showNotice("ECW Pilot isn't set up for this eCW site yet.");
            return;
        }

        const files = fileTable(manifest, client);
        const defaults = client.defaults || {};
        const loaded = new Set();
        const seen = readJSON(SEEN_KEY, {});
        const justUpdated = [];

        const settings = {
            get(key) {
                const s = readJSON(SETTINGS_KEY, {});
                return Object.prototype.hasOwnProperty.call(s, key) ? !!s[key] : !!defaults[key];
            },
            set(key, value) {
                const s = readJSON(SETTINGS_KEY, {});
                s[key] = !!value;
                safeSet(SETTINGS_KEY, JSON.stringify(s));
            }
        };

        async function load(key) {
            const entry = files[key];
            if (!entry) return false;
            if (loaded.has(key)) return true;
            let code;
            try { code = await getCode(entry); }
            catch (e) { console.error(`ECW Pilot: couldn't load ${entry.path}`, e); return false; }
            if (!run(code, `${entry.scope}/${key}`)) return false;
            loaded.add(key);
            const seenKey = `${client.id}/${key}`;
            if (seen[seenKey] && seen[seenKey] !== entry.version) {
                justUpdated.push({ key, label: entry.label || key, from: seen[seenKey], to: entry.version, notes: entry.notes || [] });
            }
            if (!seen[seenKey]) { seen[seenKey] = entry.version; safeSet(SEEN_KEY, JSON.stringify(seen)); }
            return true;
        }

        window.ECWPilot = {
            loaderVersion: LOADER_VERSION,
            branch: BRANCH,
            client: { id: client.id, name: client.name || client.id },
            settings,
            versionOf: key => (files[key] ? files[key].version : null),
            hasModule: key => !!files[key],
            isEnabled: key => settings.get(key),
            isLoaded: key => loaded.has(key),
            loadModule: key => load(key),
            justUpdated,
            ackUpdate() {
                for (const u of justUpdated) seen[`${client.id}/${u.key}`] = u.to;
                safeSet(SEEN_KEY, JSON.stringify(seen));
                justUpdated.length = 0;
            },
            updateAvailable: false
        };

        // History first (the coding panel reads it), then the coding panel,
        // then whichever modules are turned on.
        await load('history');
        await load('coding');
        for (const key of ['sort', 'link', 'claimLink']) {
            if (files[key] && settings.get(key)) await load(key);
        }

        // Newer version on GitHub? Check every CHECK_EVERY_MIN minutes,
        // only while the tab is visible; the manifest is a tiny file.
        setInterval(async () => {
            if (document.hidden || window.ECWPilot.updateAvailable) return;
            const fresh = await getManifest(true);
            if (!fresh) return;
            const freshFiles = fileTable(fresh, findClient(fresh));
            const newer = [...loaded].some(k => freshFiles[k] && freshFiles[k].version !== files[k].version);
            if (newer) {
                window.ECWPilot.updateAvailable = true;
                window.dispatchEvent(new Event('ecwpilot:update-available'));
            }
        }, CHECK_EVERY_MIN * 60 * 1000);
    })();
})();
