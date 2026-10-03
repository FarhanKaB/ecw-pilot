/* ============================================================
   ECW Pilot — clients/highland/coding.js   (HighLand's rules + pills)
   Loaded by the ECW Pilot loader. To release a change: edit this file,
   then raise clients -> highland -> files -> coding -> version in
   manifest.json. Patient history comes from shared/history.js.
   ============================================================ */
/* ============================================================
   CODING PANEL
   One right-side panel with two tabs:
     Coding  — current vs. after-changes ICD and CPT lists, each
               proposed change tickable, then Add to EMR.
     History — past visits from Module 1's loader.
   Collapses to a small launcher on the right edge.
   ============================================================ */
(function () {
    'use strict';

    // Small, unobtrusive version readout so you can confirm which build is
    // actually running in this browser vs. the latest pushed to the repo,
    // without touching the loader at all — this just reads the @version
    // already declared in this file's own userscript header above.
    const PILOT = window.ECWPilot || null;   // set up by the ECW Pilot loader
    const SCRIPT_VERSION = (PILOT && PILOT.versionOf && PILOT.versionOf('coding')) || '1.0';
    const CLIENT_NAME = (PILOT && PILOT.client && PILOT.client.name) || 'HighLand';

    // ====================== EXCLUDED CODES (edit per client) ======================
    // Codes listed here are NEVER added or removed by ECW Pilot — not by the
    // rules, not by PV / P-C / SM / OB, not by Add to EMR. Whatever is on the
    // chart stays; nothing new is proposed. Example: 'Z68.1', '99051'.
    const EXCLUDE_ICD = [
    ];
    const EXCLUDE_CPT = [
    ];
    const EXCLUDED_ICD_SET = new Set(EXCLUDE_ICD.map(c => String(c).trim().toUpperCase()));
    const EXCLUDED_CPT_SET = new Set(EXCLUDE_CPT.map(c => String(c).trim().toUpperCase()));
    function isExcludedCode(item) {
        const c = String(item && item.code || '').trim().toUpperCase();
        return item && item.kind === 'icd' ? EXCLUDED_ICD_SET.has(c) : EXCLUDED_CPT_SET.has(c);
    }

    // ====================== SCREENING PILLS (edit per client) ======================
    // One line per pill, shown in this order under BP/BMI. `source` is the
    // screening the note is read for: alcohol, depression, smoking,
    // otherTobacco or socialNeeds. Green = negative, red = positive,
    // grey = not screened (social needs: green = done, red = G0136 already
    // billed in the last 6 months). Remove a line to hide that pill.
    const SCREENING_PILLS = [
        { label: 'AS',  name: 'Alcohol screening',           source: 'alcohol',      neg: 'negative',         pos: 'positive' },
        { label: 'DS',  name: 'Depression screening',        source: 'depression',   neg: 'negative',         pos: 'positive' },
        { label: 'TS',  name: 'Tobacco (smoking) screening', source: 'smoking',      neg: 'non-smoker',       pos: 'current smoker' },
        { label: 'OTS', name: 'Other tobacco screening',     source: 'otherTobacco', neg: 'no other tobacco', pos: 'other tobacco user' },
        { label: 'SC',  name: 'Social care (SDOH) screening', source: 'socialNeeds' }
    ];

    let panel = null;           // the single ECW Pilot panel (#smcPanel)

    // ---- Auto-coding analysis state ----
    let analysisState = null;   // { toAdd:[{code,reason}], toDelete:[{code,row,reason}] }
    let analysisRunning = false;
    let actionRunning = false;  // true while Add to EMR is applying changes
    // Formerly set by Auto Link / Claim Link (removed in 1.96). Kept so the
    // popup-dismiss helpers below keep their existing gating logic; it now
    // always stays false, so those helpers only act during quick actions
    // and Start Action.
    let extensionBusy = false;
    let actionLog = [];         // [{code, action:'add'|'delete', status:'success'|'fail', message}]

    // Caches SOAP-note text from the last time it was visible (billing tab
    // hides it from innerText), so analysis stays correct on either tab.
    let cachedEncounterText = "";
    let cachedEncounterKey = "";

    // NOTE: the three selectors below are best-effort heuristics because the
    // exact CPT grid table / delete-confirm dialog HTML wasn't available when
    // this was written. Verify these on a live page and adjust if needed.
    const CONFIG = {
        CPT_INPUT_SELECTOR: '#CPTCode',
        DROPDOWN_ITEM_SELECTOR: 'span[ng-bind="item.Code"]',
        DROPDOWN_TIMEOUT_MS: 4000,
        SEARCH_WAIT_MS: 200,
        POLL_MS: 100
    };

    // ====================== STYLES (v1.98 single panel) ======================
    // Everything is scoped under #smcPanel / #smcLauncher / #smcToast so
    // none of it can leak into eCW's own page styles.
    const style = document.createElement('style');
    style.id = 'smcStyles';
    style.textContent = `
        #smcPanel, #smcLauncher, #smcToast {
            --smc-panel: #f4f6f5; --smc-surface: #ffffff; --smc-sunk: #eef2f1;
            --smc-ink: #1b2a2f; --smc-ink-2: #4a5b60; --smc-ink-3: #7f8d91;
            --smc-line: #d9e0de; --smc-line-2: #e8edeb;
            --smc-brand: #0e6e6a; --smc-brand-soft: #e1f0ee;
            --smc-add: #2f7d4f; --smc-add-soft: #e4f3e9;
            --smc-del: #b3372f; --smc-del-soft: #fbe8e6;
            --smc-warn: #8f5b00; --smc-warn-soft: #fff1d1;
            --smc-sans: "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, Arial, sans-serif;
            --smc-mono: Consolas, "SFMono-Regular", Menlo, monospace;
        }
        #smcPanel *, #smcPanel *::before, #smcPanel *::after { box-sizing: border-box; }
        #smcPanel {
            position: fixed; top: 0; right: 0; bottom: 0; width: 480px; max-width: 96vw;
            z-index: 999998; display: none; flex-direction: column;
            background: var(--smc-panel); color: var(--smc-ink);
            font-family: var(--smc-sans); font-size: 13px; line-height: 1.35; text-align: left;
            box-shadow: 0 0 0 1px rgba(27,42,47,.06), -14px 0 36px rgba(27,42,47,.16);
        }
        #smcPanel.open { display: flex; }
        #smcPanel button { font-family: inherit; }
        #smcPanel :focus-visible { outline: 2px solid var(--smc-brand); outline-offset: 2px; border-radius: 4px; }
        #smcPanel .smc-resize { position: absolute; left: 0; top: 0; bottom: 0; width: 5px; cursor: col-resize; z-index: 3; }
        /* v1.14: docked on the left */
        #smcPanel.side-left { right: auto; left: 0; box-shadow: 0 0 0 1px rgba(27,42,47,.06), 14px 0 36px rgba(27,42,47,.16); }
        #smcPanel.side-left .smc-resize { left: auto; right: 0; }
        #smcPanel .smc-top .smc-icon-btn + .smc-icon-btn { margin-left: -2px; }
        #smcPanel .smc-resize:hover { background: rgba(14,110,106,.3); }
        /* settings menu */
        #smcPanel .smc-top { position: relative; }
        #smcPanel .smc-menu { position: absolute; top: 34px; right: 0; z-index: 5; width: 220px; background: var(--smc-surface); border: 1px solid var(--smc-line); border-radius: 10px; box-shadow: 0 10px 28px rgba(27,42,47,.18); padding: 8px 0; }
        #smcPanel .smc-menu[hidden] { display: none; }
        #smcPanel .smc-menu-h { padding: 4px 14px 6px; font-size: 10.5px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; color: var(--smc-ink-3); }
        #smcPanel .smc-menu-row { display: flex; align-items: center; justify-content: space-between; padding: 7px 14px; font-size: 12.5px; cursor: pointer; margin: 0; font-weight: 500; }
        #smcPanel .smc-menu-row:hover { background: var(--smc-sunk); }
        #smcPanel .smc-menu-row .smc-switch input:disabled + .track { opacity: .4; }
        #smcPanel .smc-menu-link { cursor: default; }
        #smcPanel .smc-seg { display: inline-flex; border: 1px solid var(--smc-line); border-radius: 7px; overflow: hidden; }
        #smcPanel .smc-seg button { border: 0; background: var(--smc-surface); color: var(--smc-ink-2); font-size: 11.5px; font-weight: 600; padding: 4px 8px; cursor: pointer; }
        #smcPanel .smc-seg button + button { border-left: 1px solid var(--smc-line); }
        #smcPanel .smc-seg button.on { background: var(--smc-brand); color: #fff; }
        #smcPanel .smc-seg button:disabled { opacity: .45; cursor: not-allowed; }
        #smcPanel .smc-menu { width: 250px; }
        #smcPanel .smc-menu-note { padding: 0 14px; font-size: 11px; color: var(--smc-ink-3); min-height: 0; }
        #smcPanel .smc-menu-note:not(:empty) { padding: 4px 14px 2px; }
        #smcPanel .smc-menu-sep { height: 1px; background: var(--smc-line-2); margin: 6px 0; }
        #smcPanel .smc-menu-btn { display: block; width: 100%; text-align: left; background: none; border: 0; padding: 8px 14px; font-size: 12.5px; color: var(--smc-ink); cursor: pointer; }
        #smcPanel .smc-menu-btn:hover { background: var(--smc-sunk); }
        #smcPanel.side-left .smc-menu { right: auto; left: auto; right: 0; }
        /* update bar */
        #smcPanel .smc-update { flex-shrink: 0; padding: 7px 18px; background: var(--smc-brand-soft); color: var(--smc-brand); font-size: 12px; font-weight: 600; border-bottom: 1px solid var(--smc-line-2); }
        #smcPanel .smc-update[hidden] { display: none; }

        /* header */
        #smcPanel .smc-head { background: var(--smc-surface); border-bottom: 1px solid var(--smc-line); padding: 12px 14px 0 18px; flex-shrink: 0; }
        #smcPanel .smc-top { display: flex; gap: 8px; align-items: flex-start; }
        #smcPanel .smc-pt { flex: 1; min-width: 0; }
        #smcPanel .smc-pt-name { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        #smcPanel .smc-pt-meta { margin-top: 3px; display: flex; flex-wrap: wrap; gap: 3px 12px; color: var(--smc-ink-2); font-size: 12px; }
        #smcPanel .smc-pt-meta b { color: var(--smc-ink); font-weight: 600; }
        #smcPanel .smc-icon-btn {
            width: 28px; height: 28px; border-radius: 7px; border: 1px solid var(--smc-line); background: var(--smc-surface);
            color: var(--smc-ink-2); font-size: 16px; line-height: 1; cursor: pointer; display: grid; place-items: center; flex-shrink: 0; padding: 0;
        }
        #smcPanel .smc-icon-btn:hover { color: var(--smc-ink); border-color: var(--smc-ink-3); }
        #smcPanel .smc-tabs { display: flex; gap: 24px; margin-top: 12px; align-items: flex-end; }
        #smcPanel .smc-tabs #ecwLinkBtnNoDelete { margin-left: -8px !important; }
        #smcPanel .smc-tabs #ecwClaimLinkBtn { margin-left: -16px !important; }
        #smcPanel .smc-tab {
            appearance: none; border: 0; background: none; padding: 8px 0 10px; cursor: pointer; margin-bottom: -1px;
            font-size: 13px; font-weight: 600; color: var(--smc-ink-3); border-bottom: 2px solid transparent;
            display: inline-flex; align-items: center; gap: 6px;
        }
        #smcPanel .smc-tab.on { color: var(--smc-ink); border-bottom-color: var(--smc-brand); }
        #smcPanel .smc-badge { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--smc-brand); color: #fff; font-size: 11px; font-weight: 700; display: inline-grid; place-items: center; }
        #smcPanel .smc-badge:empty { display: none; }
        #smcPanel .smc-tab .smc-muted { font-weight: 500; color: var(--smc-ink-3); font-size: 12px; }

        #smcPanel .smc-progress { height: 3px; background: var(--smc-line-2); position: relative; overflow: hidden; visibility: hidden; flex-shrink: 0; }
        #smcPanel .smc-progress i { position: absolute; top: 0; bottom: 0; left: 0; width: 0; background: var(--smc-brand); transition: width .25s; }
        #smcPanel.busy .smc-progress { visibility: visible; }

        #smcPanel .smc-body { flex: 1; overflow-y: auto; min-height: 0; }
        #smcPanel .smc-view { display: none; }
        #smcPanel .smc-view.on { display: block; }

        /* context */
        #smcPanel .smc-ctx { padding: 12px 18px; display: grid; gap: 10px; border-bottom: 1px solid var(--smc-line-2); }
        #smcPanel .smc-cc { color: var(--smc-ink-2); }
        #smcPanel .smc-cc-label { display: block; color: var(--smc-ink); font-weight: 600; font-size: 12px; margin-bottom: 3px; }
        #smcPanel .smc-cc ul { margin: 0; padding-left: 18px; list-style: disc; }
        #smcPanel .smc-cc li { margin: 1px 0; line-height: 1.4; overflow-wrap: anywhere; }
        #smcPanel .smc-cc li::marker { color: var(--smc-ink-3); }
        #smcPanel .smc-cc .smc-cc-none { color: var(--smc-ink-3); }
        #smcPanel .smc-chips { display: flex; flex-wrap: wrap; gap: 6px; }
        #smcPanel .smc-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px; background: var(--smc-surface); border: 1px solid var(--smc-line); font-size: 11.5px; color: var(--smc-ink-2); }
        #smcPanel .smc-chip b { color: var(--smc-ink); font-weight: 600; }
        #smcPanel .smc-chip small { font-size: 10.5px; color: var(--smc-ink-3); font-family: var(--smc-mono); }
        #smcPanel .smc-chip.good { background: var(--smc-add-soft); border-color: transparent; color: var(--smc-add); }
        #smcPanel .smc-chip.bad { background: var(--smc-del-soft); border-color: transparent; color: var(--smc-del); }
        #smcPanel .smc-chip.warn { background: var(--smc-warn-soft); border-color: transparent; color: var(--smc-warn); }
        #smcPanel .smc-chip.dim { color: var(--smc-ink-3); }
        /* v1.6 screening pills: short labels, same width, colour = result */
        #smcPanel .smc-scr { min-width: 40px; justify-content: center; font-weight: 700; letter-spacing: .3px; cursor: help; }
        /* v1.8: sharper outline — solid 1.5px border in the pill's own colour, squarer corners */
        #smcPanel .smc-chip.smc-scr { border-radius: 5px; border: 1.5px solid; padding: 2px 8px; }
        #smcPanel .smc-chip.smc-scr.good { border-color: var(--smc-add); }
        #smcPanel .smc-chip.smc-scr.bad { border-color: var(--smc-del); }
        #smcPanel .smc-chip.smc-scr.dim { background: var(--smc-sunk); border-color: var(--smc-ink-3); }
        #smcPanel .smc-note { padding: 7px 10px; border-radius: 8px; font-size: 12px; background: var(--smc-warn-soft); color: var(--smc-warn); font-weight: 600; }
        #smcPanel .smc-qa { display: flex; gap: 6px; align-items: center; }
        /* v2.27: PV / P-C / SM / OB + Weekend stay pinned at the top while the
           Coding tab scrolls. */
        #smcPanel .smc-qa-bar {
            position: sticky; top: 0; z-index: 2; padding: 8px 18px;
            background: var(--smc-panel); border-bottom: 1px solid var(--smc-line-2);
            box-shadow: 0 4px 8px -6px rgba(27,42,47,.25);
        }
        /* v2.13: available = green, in the proposal = solid green with ✓,
           not available = grey */
        #smcPanel .smc-qa-btn { border: 1px solid #86efac; background: #dcfce7; color: #166534; border-radius: 7px; padding: 5px 11px; font-size: 12px; font-weight: 700; cursor: pointer; transition: background .12s, border-color .12s; }
        #smcPanel .smc-qa-btn:hover:not(:disabled) { background: #bbf7d0; border-color: #22c55e; }
        #smcPanel .smc-qa-btn.on { background: #16a34a; border-color: #15803d; color: #fff; }
        #smcPanel .smc-qa-btn.on::before { content: "✓ "; }
        #smcPanel .smc-qa-btn.on:hover { background: #15803d; }
        #smcPanel .smc-qa-btn:disabled { background: #f1f5f9; border-color: var(--smc-line); color: #94a3b8; font-weight: 600; cursor: not-allowed; }
        #smcPanel .smc-spacer { flex: 1; }
        #smcPanel .smc-switch { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--smc-ink-2); cursor: pointer; position: relative; }
        #smcPanel .smc-switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
        #smcPanel .smc-switch .track { width: 28px; height: 16px; border-radius: 99px; background: var(--smc-line); position: relative; transition: background .15s; }
        #smcPanel .smc-switch .track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.3); transition: transform .15s; }
        #smcPanel .smc-switch input:checked + .track { background: var(--smc-brand); }
        #smcPanel .smc-switch input:checked + .track::after { transform: translateX(12px); }

        /* results notice */
        #smcPanel .smc-result { margin: 12px 18px 0; padding: 9px 12px; border-radius: 8px; font-size: 12px; display: flex; gap: 10px; align-items: flex-start; }
        #smcPanel .smc-result.ok { background: var(--smc-add-soft); color: var(--smc-add); }
        #smcPanel .smc-result.fail { background: var(--smc-del-soft); color: var(--smc-del); }
        #smcPanel .smc-result div { flex: 1; }
        #smcPanel .smc-result ul { margin: 4px 0 0; padding-left: 18px; }
        #smcPanel .smc-x { background: none; border: 0; color: inherit; cursor: pointer; font-size: 15px; line-height: 1; padding: 0; }

        /* diff blocks */
        #smcPanel .smc-block { padding: 14px 18px 6px; }
        #smcPanel .smc-block + .smc-block { border-top: 1px solid var(--smc-line-2); }
        #smcPanel .smc-block-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
        #smcPanel .smc-block-head h2 { font-size: 13.5px; font-weight: 700; margin: 0; color: var(--smc-ink); }
        #smcPanel .smc-sum { font-size: 12px; color: var(--smc-ink-3); }
        #smcPanel .smc-sum .a { color: var(--smc-add); font-weight: 700; }
        #smcPanel .smc-sum .d { color: var(--smc-del); font-weight: 700; }
        #smcPanel .smc-sum .o { color: var(--smc-brand); font-weight: 600; }
        #smcPanel .smc-diff { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid var(--smc-line); border-radius: 10px; overflow: hidden; background: var(--smc-surface); }
        #smcPanel .smc-col { min-width: 0; }
        #smcPanel .smc-col + .smc-col { border-left: 1px solid var(--smc-line); }
        #smcPanel .smc-col-h { padding: 7px 10px; font-size: 11.5px; font-weight: 600; color: var(--smc-ink-2); background: var(--smc-sunk); border-bottom: 1px solid var(--smc-line); display: flex; justify-content: space-between; }
        #smcPanel .smc-col-h span { color: var(--smc-ink-3); font-weight: 500; }
        #smcPanel .smc-row { display: grid; grid-template-columns: 18px 1fr; gap: 7px; align-items: start; padding: 7px 10px; border-bottom: 1px solid var(--smc-line-2); min-height: 40px; margin: 0; font-weight: 400; }
        #smcPanel .smc-row:last-child { border-bottom: 0; }
        #smcPanel label.smc-row { cursor: pointer; }
        #smcPanel .smc-row .mk { width: 18px; height: 18px; display: grid; place-items: center; margin-top: 1px; }
        #smcPanel .smc-row input[type=checkbox] { width: 15px; height: 15px; margin: 0; cursor: pointer; }
        #smcPanel .smc-num { font-family: var(--smc-mono); font-size: 10.5px; font-weight: 700; color: var(--smc-ink-3); }
        #smcPanel .smc-code { font-family: var(--smc-mono); font-weight: 700; font-size: 12.5px; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
        #smcPanel .smc-tag { font-family: var(--smc-sans); font-size: 10.5px; font-weight: 600; padding: 0 5px; border-radius: 4px; background: var(--smc-sunk); color: var(--smc-ink-3); }
        #smcPanel .smc-name { color: var(--smc-ink-2); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        #smcPanel .smc-why { font-size: 11px; margin-top: 2px; }
        #smcPanel .smc-row.del { background: var(--smc-del-soft); }
        #smcPanel .smc-row.del .smc-code > b { color: var(--smc-del); text-decoration: line-through; }
        #smcPanel .smc-row.del .smc-why { color: var(--smc-del); }
        #smcPanel .smc-row.del input { accent-color: var(--smc-del); }
        #smcPanel .smc-row.del.off { background: transparent; }
        #smcPanel .smc-row.del.off .smc-code > b { color: var(--smc-ink); text-decoration: none; }
        #smcPanel .smc-row.del.off .smc-why { color: var(--smc-ink-3); }
        #smcPanel .smc-row.add { background: var(--smc-add-soft); }
        #smcPanel .smc-row.add .smc-code > b { color: var(--smc-add); }
        #smcPanel .smc-row.add .smc-why { color: var(--smc-add); }
        #smcPanel .smc-row.add input { accent-color: var(--smc-add); }
        #smcPanel .smc-row.add.off { background: transparent; }
        #smcPanel .smc-row.add.off .smc-code > b, #smcPanel .smc-row.add.off .smc-why { color: var(--smc-ink-3); }
        /* primary diagnosis: gold tag + gold bar on the row's left edge */
        #smcPanel .smc-row.primary { box-shadow: inset 3px 0 0 #c9a227; }
        #smcPanel .smc-tag.smc-prim { background: #fbf1cf; color: #7a5c00; font-weight: 700; letter-spacing: .3px; border: 1px solid #e8d48a; }
        #smcPanel .smc-row.review .smc-why { color: var(--smc-warn); font-weight: 600; }
        #smcPanel .smc-result-sum { margin-top: 3px; font-weight: 600; }
        #smcPanel .smc-review-head { margin: 12px 18px 0; font-size: 12px; color: var(--smc-ink-2); }
        #smcPanel .smc-mark { font: 800 14px/1 var(--smc-sans); }
        #smcPanel .smc-row.add .smc-mark { color: var(--smc-add); }
        #smcPanel .smc-row.del .smc-mark { color: var(--smc-del); }
        #smcPanel .smc-empty { padding: 12px 10px; color: var(--smc-ink-3); font-size: 12px; }
        #smcPanel .smc-legend { display: flex; flex-wrap: wrap; gap: 14px; padding: 8px 2px 4px; font-size: 11.5px; color: var(--smc-ink-3); }
        #smcPanel .smc-legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
        #smcPanel .smc-rules { margin: 4px 2px 10px; font-size: 11.5px; color: var(--smc-ink-3); }
        #smcPanel .smc-rules summary { cursor: pointer; color: var(--smc-ink-2); font-weight: 600; }
        #smcPanel .smc-rules p { margin: 6px 0 0; }
        #smcPanel .smc-rules ol { margin: 6px 0 2px; padding-left: 20px; columns: 2; column-gap: 20px; }
        #smcPanel .smc-mods { width: 100%; border-collapse: separate; border-spacing: 0; border: 1px solid var(--smc-line); border-radius: 10px; overflow: hidden; background: var(--smc-surface); font-size: 12.5px; margin-bottom: 8px; }
        #smcPanel .smc-mods th { text-align: left; padding: 7px 10px; font-size: 11.5px; font-weight: 600; color: var(--smc-ink-2); background: var(--smc-sunk); border-bottom: 1px solid var(--smc-line); }
        #smcPanel .smc-mods td { padding: 7px 10px; border-bottom: 1px solid var(--smc-line-2); font-family: var(--smc-mono); vertical-align: top; }
        #smcPanel .smc-mods tr:last-child td { border-bottom: 0; }
        #smcPanel .smc-mods th:first-child, #smcPanel .smc-mods td.smc-mod { width: 96px; font-weight: 700; }
        #smcPanel .smc-mods td.smc-empty { font-family: var(--smc-sans); }
        #smcPanel .smc-blank { padding: 28px 18px; color: var(--smc-ink-3); text-align: center; line-height: 1.5; }
        #smcPanel .smc-blank b { color: var(--smc-ink-2); }

        /* footer */
        #smcPanel .smc-foot { border-top: 1px solid var(--smc-line); background: var(--smc-surface); padding: 10px 18px 12px; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
        #smcPanel .smc-foot-sum { flex: 1; min-width: 0; font-size: 12px; color: var(--smc-ink-2); }
        #smcPanel .smc-foot-sum b { color: var(--smc-ink); }
        #smcPanel .smc-link { background: none; border: 0; padding: 0; color: var(--smc-brand); font-size: 12px; font-weight: 600; cursor: pointer; }
        #smcPanel .smc-primary { border: 0; border-radius: 8px; padding: 10px 20px; background: var(--smc-brand); color: #fff; font-size: 13px; font-weight: 700; cursor: pointer; white-space: nowrap; }
        #smcPanel .smc-primary:hover:not(:disabled) { filter: brightness(1.08); }
        #smcPanel .smc-primary:disabled { opacity: .42; cursor: not-allowed; }
        #smcPanel .smc-version { font-size: 10px; color: var(--smc-ink-3); }

        /* history */
        #smcPanel .smc-hsearch { padding: 7px 10px; position: sticky; top: 0; background: #f8fafc; z-index: 1; border-bottom: 1px solid #e8edf4; }
        #smcPanel .smc-hsearch-box { position: relative; }
        #smcPanel .smc-hsearch-box svg { position: absolute; left: 9px; top: 50%; transform: translateY(-50%); color: #94a3b8; pointer-events: none; }
        #smcPanel .smc-hsearch-box input { padding-left: 28px !important; border-color: #cbd5e1 !important; border-radius: 7px !important; font-size: 12px !important; }
        #smcPanel .smc-hsearch-box input:focus { outline: none; border-color: #3b82f6 !important; box-shadow: 0 0 0 3px rgba(59,130,246,.12); }
        #smcPanel .smc-hsearch input { width: 100%; height: 32px; border: 1px solid var(--smc-line); border-radius: 8px; padding: 0 10px; font: 13px var(--smc-sans); background: var(--smc-surface); color: var(--smc-ink); }
        #smcPanel .smc-visits { padding: 0 18px 18px; }
        #smcPanel .smc-visit { border-bottom: 1px solid var(--smc-line); padding: 13px 0; }
        #smcPanel .smc-visit-h { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; min-width: 0; }
        #smcPanel .smc-visit-date { font-weight: 700; flex-shrink: 0; }
        #smcPanel .smc-visit-sub { color: var(--smc-ink-3); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        #smcPanel .smc-visit-sub.changed { color: var(--smc-warn); font-weight: 600; }
        #smcPanel .smc-visit-g { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        #smcPanel .smc-visit-g h3 { margin: 0 0 4px; font-size: 11.5px; font-weight: 600; color: var(--smc-ink-3); }
        #smcPanel .smc-hc { display: flex; gap: 8px; padding: 2px 0; align-items: baseline; min-width: 0; }
        #smcPanel .smc-hc .c { font-family: var(--smc-mono); font-weight: 700; font-size: 12px; flex-shrink: 0; cursor: copy; }
        #smcPanel .smc-hc .c sup { font-family: var(--smc-sans); font-weight: 400; font-size: 9px; color: var(--smc-ink-3); margin-left: 1px; }
        #smcPanel .smc-hc .smc-name { font-size: 11.5px; }
        #smcPanel .smc-hc.watch .c { background: var(--smc-warn-soft); color: var(--smc-warn); padding: 0 4px; border-radius: 3px; }
        #smcPanel mark { background: var(--smc-warn-soft); color: inherit; border-radius: 2px; }
        #smcPanel .smc-loading { padding: 24px 18px; color: var(--smc-ink-2); }
        #smcPanel .smc-loading .bar { height: 5px; background: var(--smc-line-2); border-radius: 99px; overflow: hidden; margin-top: 8px; }
        #smcPanel .smc-loading .bar i { display: block; height: 100%; background: var(--smc-brand); transition: width .3s; }

        /* launcher (v2.15): floating icon button, right side, drag up/down.
           Badge = proposed changes (green) or spinner while history loads. */
        #smcLauncher {
            position: fixed; right: 12px; z-index: 999997; width: 44px; height: 44px; padding: 0; margin: 0;
            border: 0; border-radius: 14px; background: #0e6e6a; color: #fff; cursor: pointer;
            display: none; align-items: center; justify-content: center; user-select: none;
            box-shadow: 0 6px 18px rgba(14,110,106,.35), 0 1px 3px rgba(0,0,0,.18);
            transition: transform .15s ease, box-shadow .15s ease, background .15s ease;
        }
        #smcLauncher.show { display: flex; }
        #smcLauncher.side-left { right: auto; left: 12px; }
        #smcLauncher.side-left:hover { transform: translateX(2px) scale(1.05); }
        #smcLauncher:hover { background: #0b5d59; transform: translateX(-2px) scale(1.05); box-shadow: 0 8px 22px rgba(14,110,106,.45), 0 1px 3px rgba(0,0,0,.2); }
        #smcLauncher:focus-visible { outline: 2px solid #5eead4; outline-offset: 3px; }
        #smcLauncher.dragging { transition: none; cursor: grabbing; transform: scale(1.05); }
        #smcLauncher svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
        #smcLauncher .smc-l-badge {
            position: absolute; top: -6px; right: -6px; min-width: 20px; height: 20px; padding: 0 5px; box-sizing: border-box;
            border-radius: 10px; border: 2px solid #fff; background: #16a34a; color: #fff;
            font: 700 11px/16px "Segoe UI", Arial, sans-serif; text-align: center; display: none;
        }
        #smcLauncher.has-count .smc-l-badge { display: block; }
        #smcLauncher.loading .smc-l-badge { display: block; background: #e2e8f0; padding: 0; width: 20px; }
        #smcLauncher.loading .smc-l-badge::after {
            content: ""; position: absolute; inset: 3px; border-radius: 50%;
            border: 2px solid #94a3b8; border-top-color: transparent; animation: smcLSpin .8s linear infinite;
        }
        @keyframes smcLSpin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { #smcLauncher { transition: none; } #smcLauncher.loading .smc-l-badge::after { animation-duration: 3s; } }

        #smcToast {
            position: fixed; left: 50%; bottom: 90px; transform: translateX(-50%) translateY(12px); opacity: 0; z-index: 9999999;
            background: var(--smc-ink); color: #fff; padding: 8px 14px; border-radius: 8px; font: 12.5px var(--smc-sans);
            transition: opacity .2s, transform .2s; pointer-events: none; max-width: 90vw;
        }
        #smcToast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

        /* v2.08 — descriptions must never spill into the next column: grid
           and flex children default to min-width:auto, so a long one-line
           name couldn't shrink and overlapped its neighbour. Names now wrap
           to at most two lines inside their own cell. */
        #smcPanel .smc-row { overflow: hidden; }
        #smcPanel .smc-row > div { min-width: 0; }
        #smcPanel .smc-row .smc-name {
            white-space: normal; overflow: hidden; word-break: break-word;
            display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
        }
        #smcPanel .smc-row .smc-why { overflow-wrap: anywhere; }

        /* v2.08 — History tab in the original Patient Visit History design */
        #smcPanel [data-view="history"] { background: #f1f5f9; min-height: 100%; }
        #smcPanel .smc-visits { padding: 8px 10px 14px; }
        #smcPanel .dp-count { font-size: 10.5px; color: #94a3b8; margin: 0 2px 6px; }
        #smcPanel .dp-err { color: #f87171; }
        #smcPanel .dp-none { padding: 40px 0; text-align: center; color: #94a3b8; font-size: 13px; }
        #smcPanel .dp-empty { color: #94a3b8; font-size: 12px; }
        #smcPanel .dp-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; margin-bottom: 9px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.05); transition: box-shadow .15s; }
        #smcPanel .dp-card:hover { box-shadow: 0 3px 10px rgba(0,0,0,.09); }
        #smcPanel .dp-card-header { display: flex; flex-direction: row-reverse; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; background: linear-gradient(90deg, #f0f9ff 0%, #e0f2fe 100%); border-bottom: 1px solid #e2e8f0; overflow: hidden; }
        #smcPanel .dp-card-date { font-size: 13px; font-weight: 800; color: #0f172a; letter-spacing: .2px; white-space: nowrap; flex-shrink: 0; }
        #smcPanel .dp-card-meta { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; min-width: 0; overflow: hidden; flex: 1 1 0%; }
        #smcPanel .dp-badge { font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 20px; white-space: nowrap; letter-spacing: .2px; min-width: 0; overflow: hidden; text-overflow: ellipsis; flex-shrink: 1; display: inline-flex; align-items: center; max-width: 100%; }
        #smcPanel .dp-badge-ins { background: #fff; color: #747474; }
        #smcPanel .dp-badge-pcp { background: #fff; color: #527898; }
        #smcPanel .dp-card-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
        #smcPanel .dp-section { padding: 9px 12px; min-width: 0; }
        #smcPanel .dp-section + .dp-section { border-left: 1px solid #f1f5f9; }
        #smcPanel .dp-section-title { font-size: 9.5px; font-weight: 800; letter-spacing: .7px; text-transform: uppercase; margin-bottom: 6px; display: flex; align-items: center; gap: 4px; }
        #smcPanel .dp-code-row { display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: 5px; align-items: center; padding: 2px 0; border-bottom: 1px solid #f8fafc; min-width: 0; }
        #smcPanel .dp-code-row:last-child { border-bottom: none; }
        #smcPanel .dp-code { font-size: 11.5px; font-weight: 800; white-space: nowrap; cursor: pointer; position: relative; display: inline-block; border-radius: 3px; padding: 1px 3px; transition: background .15s, color .15s; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
        #smcPanel .dp-code:hover { background: rgba(0,0,0,.06); }
        #smcPanel .dp-code.dp-watched { display: inline-flex; align-items: center; gap: 3px; background: #fef3c7; color: #92400e !important; border: 1px solid #f59e0b; font-weight: 900; box-shadow: 0 0 0 1px rgba(245,158,11,.25); }
        #smcPanel .dp-code.dp-watched:hover { background: #fde68a; }
        #smcPanel .dp-watched-icon { flex: 0 0 auto; line-height: 1; }
        #smcPanel .dp-code-row.dp-watched-row { background: rgba(254,243,199,.45); border-radius: 4px; }
        #smcPanel .dp-mod { font-size: 9px; font-weight: 200; color: #929292; vertical-align: super; margin-left: 1px; }
        #smcPanel .dp-desc { font-size: 11.5px; color: #475569; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
        #smcPanel .dp-cpt-group + .dp-cpt-group { margin-top: 6px; }
        #smcPanel .dp-cpt-label { font-size: 9px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; color: #94a3b8; margin-bottom: 3px; }
        #smcPanel mark.dp-hl { background: #ff0000; color: #fff; border-radius: 2px; padding: 0 1px; font-style: normal; }
        #smcPanel .dp-loading { padding: 20px 6px 0; }
        #smcPanel .dp-loading-top { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
        #smcPanel .dp-spinner { width: 22px; height: 22px; flex-shrink: 0; border: 3px solid #e2e8f0; border-top-color: #3b82f6; border-radius: 50%; animation: smcdpSpin .8s linear infinite; }
        #smcPanel .dp-loading-title { font-size: 12px; font-weight: 700; color: #1e293b; }
        #smcPanel .dp-loading-sub { font-size: 11px; color: #64748b; margin-top: 1px; }
        #smcPanel .dp-loading-sub b { color: #3b82f6; }
        #smcPanel .dp-loading-pct { margin-left: auto; font-size: 11px; font-weight: 700; color: #3b82f6; }
        #smcPanel .dp-bar { height: 5px; background: #e2e8f0; border-radius: 99px; overflow: hidden; margin-bottom: 4px; }
        #smcPanel .dp-bar i { display: block; height: 100%; background: linear-gradient(90deg, #3b82f6, #6366f1); border-radius: 99px; transition: width .3s ease; }
        #smcPanel .dp-loading-count { font-size: 10px; color: #94a3b8; text-align: right; }
        #smcPanel .dp-partial-label { font-size: 10px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; color: #94a3b8; margin: 12px 2px 6px; }
        @keyframes smcdpSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes smcdpBurst { 0% { transform: scale(1); } 25% { transform: scale(1.28); } 60% { transform: scale(.94); } 100% { transform: scale(1); } }
        @keyframes smcdpRipple { 0% { transform: scale(.6); opacity: .7; } 100% { transform: scale(2.6); opacity: 0; } }
        @keyframes smcdpParticle { 0% { opacity: 1; } 100% { opacity: 0; } }
        @keyframes smcdpCheckIn { 0% { opacity: 0; transform: translateX(-50%) translateY(-50%) scale(.4); } 60% { opacity: 1; transform: translateX(-50%) translateY(-50%) scale(1.15); } 100% { opacity: 1; transform: translateX(-50%) translateY(-50%) scale(1); } }
        #smcPanel .dp-code.dp-copied { animation: smcdpBurst .35s cubic-bezier(.36,.07,.19,.97) both; }
        .smcdp-ripple { position: fixed; border-radius: 50%; background: rgba(34,197,94,.45); pointer-events: none; z-index: 9999999; transform: scale(.6); animation: smcdpRipple .5s ease-out forwards; }
        .smcdp-particle { position: fixed; border-radius: 50%; pointer-events: none; z-index: 9999999; animation: smcdpParticle .55s ease-out forwards; transition: transform .5s ease-out; }
        .smcdp-check { position: fixed; pointer-events: none; z-index: 9999999; font: 800 11px "Segoe UI", Arial, sans-serif; color: #fff; background: #16a34a; border-radius: 99px; padding: 1px 6px; white-space: nowrap; box-shadow: 0 2px 8px rgba(22,163,74,.45); opacity: 0; transform: translateX(-50%) translateY(-50%) scale(.4); animation: smcdpCheckIn .28s .08s cubic-bezier(.34,1.56,.64,1) forwards; }
        @media (prefers-reduced-motion: reduce) { #smcPanel .dp-spinner, #smcPanel .dp-code.dp-copied, .smcdp-ripple, .smcdp-particle, .smcdp-check { animation-duration: .01s !important; } }
        @media (prefers-reduced-motion: reduce) {
            #smcPanel *, #smcLauncher, #smcToast { transition: none !important; animation: none !important; }
        }
    `;
    document.head.appendChild(style);

    // ====================== AGE EXTRACTION ======================
    // Old approach: just read whatever "(43 yo)" text eCW already prints on
    // the page. Problem: that age is computed as of TODAY (whenever the
    // page rendered), not as of the DOS being coded — wrong for anything
    // that isn't same-day charting (a late note, a back-dated encounter,
    // etc.), which matters since age drives Z00.01/Z00.121, Z71.82/89,
    // Preventive Medicine code selection, and more. Now computed directly
    // from DOB + current DOS instead, with the old text-scan kept only as
    // a fallback if DOB parsing fails.
    function getAge(text) {
        const patterns = [
            /\((\d{1,3})\s*yo/i,
            /\bAge[:\s]+(\d{1,3})/i,
            /(\d{1,3})\s*(?:yo|year[- ]?old)/i,
            /\b(\d{1,3})\s*y(?:ears?)?\b/i
        ];
        for (let regex of patterns) {
            const match = text.match(regex);
            if (match && match[1]) {
                const age = parseInt(match[1]);
                if (age > 0 && age < 150) return age.toString();
            }
        }
        return "";
    }

    // Matches "Jan 7, 1983" / "Jul 31, 1975" style DOB shown next to the
    // patient name/header.
    function parseDOBFromPage(text) {
        // Primary: direct DOM read of the Angular-bound DOB span, format
        // MM/DD/YYYY (e.g. "11/07/1992"). Same reliability as the
        // GENDERINITIALS span used for gender — a live DOM query, so it
        // isn't affected by getEncounterText()'s cached-text limitations.
        const dobSpan = document.querySelector('span[ng-bind="patientobj.DATE_OF_BIRTH"]');
        if (dobSpan) {
            const m = dobSpan.textContent.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
            if (m) {
                const dob = new Date(parseInt(m[3], 10), parseInt(m[1], 10) - 1, parseInt(m[2], 10));
                if (!isNaN(dob.getTime())) return dob;
            }
        }

        // Fallback: "Jan 7, 1983" style text elsewhere on the page.
        const m2 = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),\s*(\d{4})\b/i);
        if (!m2) return null;
        const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
        const monthIdx = months[m2[1].toLowerCase().slice(0, 3)];
        if (monthIdx == null) return null;
        const dob = new Date(parseInt(m2[3], 10), monthIdx, parseInt(m2[2], 10));
        return isNaN(dob.getTime()) ? null : dob;
    }

    function calculateAgeAtDate(dob, atDate) {
        if (!dob || !atDate) return null;
        let age = atDate.getFullYear() - dob.getFullYear();
        const hadBirthdayYet =
            atDate.getMonth() > dob.getMonth() ||
            (atDate.getMonth() === dob.getMonth() && atDate.getDate() >= dob.getDate());
        if (!hadBirthdayYet) age--;
        return age;
    }

    // Primary age source for all age-dependent logic: DOB parsed from the
    // page, computed as of the current DOS (not today's real-world date).
    // Falls back to the old "(43 yo)" text-scan only if DOB parsing fails.
    function getAgeAtDOS(text) {
        const dob = parseDOBFromPage(text);
        if (dob) {
            const age = calculateAgeAtDate(dob, getCurrentDosDate());
            if (age != null && age >= 0 && age < 150) return age;
        }
        const textAge = getAge(text);
        return textAge ? parseInt(textAge) : null;
    }

    function snapshotExtract(str, regex) {
        const m = str.match(regex);
        return m ? m[1].trim() : "";
    }

    // ====================== GENDER EXTRACTION ======================
    // GENDERINITIALS span sits next to the age span in the patient header;
    // read it off the DOM with text fallbacks.
    function getGenderFromDOM() {
        const genderSpan = document.querySelector('span[ng-bind*="GENDERINITIALS"]');
        if (genderSpan) {
            const t = (genderSpan.textContent || "").replace(/^[,\s]+/, "").trim().toUpperCase();
            if (/^[MFOU]$/.test(t)) return t;
        }
        // Fallback: the FULL_NAME span's title attribute ends with ", F" / ", M"
        const nameSpan = document.querySelector('span[ng-bind*="FULL_NAME"]');
        if (nameSpan) {
            const title = (nameSpan.getAttribute("title") || nameSpan.textContent || "").trim();
            const m = title.match(/,\s*([MFOU])\s*$/i);
            if (m) return m[1].toUpperCase();
        }
        // Last-resort text fallback: ", 49 Y, M" pattern in the header text
        const h2 = document.querySelector("h2");
        const fallbackText = h2 ? (h2.textContent || "") : (document.body.innerText || "");
        const m2 = fallbackText.match(/,\s*\d{1,3}\s*Y\s*,\s*([MFOU])\b/i);
        return m2 ? m2[1].toUpperCase() : "";
    }

    function genderLabel(g) {
        if (g === "M") return "Male";
        if (g === "F") return "Female";
        if (g === "O") return "Other";
        if (g === "U") return "Unknown";
        return "";
    }

    // ====================== INSURANCE EXTRACTION ======================
    const RE_PAYER_ID_SNAP = /\s*Payer\s*ID\s*:?\s*\d+[\s\S]*$/i;
    const RE_INS_AFTER_SNAP = /Insurance:\s*([^\n\r]+?)(?:\s*(?:Referring:|Appointment Facility:|Account Number:|Guarantor:|Payer\s*ID)|$)/i;

    function cleanInsuranceTextSnap(str) {
        return String(str || "")
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/gi, " ")
            .replace(/&amp;/gi, "&")
            .replace(/&quot;/gi, '"')
            .replace(/&#039;/gi, "'")
            .replace(/\u00a0/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    function cleanInsuranceNameSnap(str) {
        const t = str.replace(RE_PAYER_ID_SNAP, "").trim();
        return t.length > 32 ? t.substring(0, 32).trim() : t;
    }

    // Same source the Patient History feature already uses (fetches the
    // real encounter print-page) — more reliable than scanning the live
    // DOM, which can be covered by modals (Billing, Claim, etc). Finds the
    // entry matching the current DOS and reuses its insurance_name.
    function getInsuranceFromHistoryForCurrentDos() {
        const api = window.__ecwPatientHistory;
        const data = api && api.getData ? api.getData() : null;
        if (!data || !data.length) return "";
        const currentDosStr = document.querySelector("#encDropDownItem")?.title?.match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0] || "";
        if (!currentDosStr) return "";
        const match = data.find(enc => enc.encounter_date === currentDosStr);
        return (match && match.insurance_name) ? match.insurance_name : "";
    }

    function parseInsuranceFromPage(text) {
        const fromHistory = getInsuranceFromHistoryForCurrentDos();
        if (fromHistory) return fromHistory;

        const cells = document.querySelectorAll("tr.PatientData td, tr.PtData td");
        for (const cell of cells) {
            const raw = cell.textContent || "";
            if (/Insurance:/i.test(raw)) {
                const norm = raw.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
                const m = norm.match(/Insurance:\s*([^]+?)(?:\s*(?:Referring:|Appointment Facility:|Account Number:|Guarantor:|Payer\s*ID)|$)/i);
                if (m) {
                    const name = cleanInsuranceNameSnap(cleanInsuranceTextSnap(m[1]));
                    if (name) return name;
                }
            }
        }
        const headerSpan = document.querySelector("tr.patient_header_tr span");
        if (headerSpan) {
            const norm = headerSpan.textContent.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
            const m = norm.match(/Insurance:\s*([^]+?)(?:\s*(?:Referring:|Account Number:|Guarantor:|PCP:|Payer\s*ID)|$)/i);
            if (m) {
                const name = cleanInsuranceNameSnap(cleanInsuranceTextSnap(m[1]));
                if (name) return name;
            }
        }
        const afterMatch = text.match(RE_INS_AFTER_SNAP);
        if (afterMatch) {
            const name = cleanInsuranceNameSnap(cleanInsuranceTextSnap(afterMatch[1]));
            if (name) return name;
        }
        const htmlMatch = (document.body.innerHTML || "").match(/Insurance:(?:&nbsp;|\s)*([\s\S]*?)<\/td>/i);
        const htmlName = cleanInsuranceNameSnap(cleanInsuranceTextSnap(htmlMatch?.[1] || ""));
        if (htmlName) return htmlName;

        // Fallback: the "Billing Details" sidebar widget uses the short
        // label "Ins:" instead of "Insurance:" — try that too.
        const bodyText = document.body.textContent || "";
        const shortMatch = bodyText.match(/\bIns\s*:\s*([^\n\r]+?)(?:\s*(?:Acc\s*Bal|Guar|Gr\s*Bal)\s*:|$)/i);
        if (shortMatch) {
            const name = cleanInsuranceNameSnap(cleanInsuranceTextSnap(shortMatch[1]));
            if (name) return name;
        }
        return "";
    }

    // ====================== HISTORY INTEGRATION ======================
    function parseUSDateSnap(str) {
        const m = String(str || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        return m ? +new Date(+m[3], +m[1] - 1, +m[2]) : 0;
    }

    function normForCompare(str) {
        return String(str || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    }

    function renderHistoryIntegration(currentInsurance) {
        const api = window.__ecwPatientHistory;
        if (!api) return "";

        if (api.isLoading && api.isLoading()) {
            return `<div class="hist-integration hist-loading">⏳ Loading visit history…</div>`;
        }

        const data = api.getData ? api.getData() : null;
        if (!data || !data.length) return "";

        const sorted = [...data]
            .filter(r => r.encounter_date)
            .sort((a, b) => parseUSDateSnap(b.encounter_date) - parseUSDateSnap(a.encounter_date));
        const last = sorted[0];
        if (!last) return "";

        // NOTE: last.encounter_date is intentionally kept for internal date
        // comparisons only (e.g. annual G-code year eligibility) — per current
        // requirements we no longer render the last visit date, ICD/CPT
        // counts, or provider/practice name on the snapshot panel.
        let warnHtml = "";
        if (currentInsurance && last.insurance_name &&
            normForCompare(currentInsurance) !== normForCompare(last.insurance_name)) {
            warnHtml = `<div class="hist-warn">⚠️ Insurance differs from last visit (${escapeHtml(last.insurance_name)})</div>`;
        }

        return warnHtml;
    }

    // ====================== ANNUAL SCREENING G-CODE HELPERS ======================
    // G0444/G0442: once-per-year, never for Medicaid/Medicare/UHC. Check if
    // already used this DOS year before proposing again.
    function getCurrentDosYear() {
        const title = document.querySelector("#encDropDownItem")?.title || "";
        const m = title.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
        if (m) return parseInt(m[3], 10);
        return new Date().getFullYear();
    }

    function getCurrentDosDate() {
        const title = document.querySelector("#encDropDownItem")?.title || "";
        const m = title.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
        if (m) return new Date(parseInt(m[3], 10), parseInt(m[1], 10) - 1, parseInt(m[2], 10));
        return new Date();
    }

    // ====================== HEALTH PROMOTION / CANCER SCREENING PARSING ======================
    // Finds the Social History category div by its heading text (ids like
    // readOnlyCategory_477148 are per-encounter, not fixed).
    function findHealthPromotionCategoryDiv() {
        const candidates = document.querySelectorAll('div[id^="readOnlyCategory_"]');
        for (const div of candidates) {
            const heading = div.querySelector('.cattablink');
            const headingText = (heading ? heading.textContent : div.textContent) || "";
            if (/HEALTH PROMOTION AND DISEASE PREVENTION/i.test(headingText)) {
                return div;
            }
        }
        return null;
    }

    // Reads via .textContent (not innerText) so it works even if this
    // section is hidden behind the billing tab.
    function getHealthPromotionSectionText(text) {
        const domDiv = findHealthPromotionCategoryDiv();
        if (domDiv) return domDiv.textContent || "";

        // Fallback: text-based extraction, in case this encounter's markup
        // doesn't use the expected readOnlyCategory_* container.
        const idx = text.search(/HEALTH PROMOTION AND DISEASE PREVENTION/i);
        if (idx === -1) return "";
        const rest = text.slice(idx);
        const m = rest.match(/^HEALTH PROMOTION AND DISEASE PREVENTION([\s\S]*?)(?=\n[A-Z][A-Z \/&-]{3,}\n|$)/i);
        return m ? m[1] : rest;
    }

    function parseUSDateParts(dateStr) {
        const m = String(dateStr || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (!m) return null;
        return new Date(parseInt(m[3], 10), parseInt(m[1], 10) - 1, parseInt(m[2], 10));
    }

    // Rolling window: pastDate must fall within the last `years` years,
    // ending at (and including) the current DOS.
    function isWithinYearsOfDos(pastDateStr, dosDate, years) {
        const pastDate = parseUSDateParts(pastDateStr);
        if (!pastDate) return false;
        const cutoff = new Date(dosDate.getFullYear() - years, dosDate.getMonth(), dosDate.getDate());
        return pastDate >= cutoff && pastDate <= dosDate;
    }

    // Same calendar year as the current DOS (used for the breast screening rule).
    function isSameYearAsDos(pastDateStr, dosDate) {
        const pastDate = parseUSDateParts(pastDateStr);
        if (!pastDate) return false;
        return pastDate.getFullYear() === dosDate.getFullYear();
    }

    function getCancerScreeningDates(text) {
        const hpText = getHealthPromotionSectionText(text);
        const cervical = hpText.match(/Cervical Cancer Screening[^:]*:\s*Last PAP Completed [Oo]n\s*(\d{2}\/\d{2}\/\d{4})/i);
        // 3017F applies regardless of which colorectal test was done.
        const colorectal = hpText.match(/Colorectal Cancer Screening[^:]*:\s*Last\s+(?:Colonoscopy|FIT|Sigmoidoscopy|Cologuard|FOBT|Fecal Occult Blood Test|CT Colonography)\s+Completed [Oo]n\s*(\d{2}\/\d{2}\/\d{4})/i);
        const breast = hpText.match(/Breast Cancer Screening[^:]*:\s*Last Mammogram Completed [Oo]n\s*(\d{2}\/\d{2}\/\d{4})/i);
        return {
            cervical: cervical ? cervical[1] : null,
            colorectal: colorectal ? colorectal[1] : null,
            breast: breast ? breast[1] : null
        };
    }

    // A1c extraction/control-CPT logic removed entirely (not used).

    // Exact list of pain-related ICD-10 codes — supplements the broader
    // M-code-by-default rule below for non-M codes (nerve pain, headache,
    // chest/abdominal pain, etc.).
    const PAIN_RELATED_ICD_CODES = new Set([
        "R52", "R52.0", "R52.1", "R52.2", "R52.9", "R51",
        "G44.1", "G44.209", "G44.401", "G44.501",
        "R07.0", "R07.1", "R07.2", "R07.9",
        "M54.2", "M54.5", "M54.4", "M54.8", "M54.9", "M54.59", "M54.50", "M54.12",
        "M25.5", "M25.51", "M25.52", "M25.53", "M25.54", "M25.55", "M25.56", "M25.57", "M25.58", "M25.59",
        "M25.511", "M25.512", "M25.519", "M25.521", "M25.522", "M25.529", "M25.531", "M25.532", "M25.539", "M25.541", "M25.542", "M25.549",
        "M25.551", "M25.552", "M25.559", "M25.561", "M25.562", "M25.569", "M25.571", "M25.572", "M25.579",
        "M79.6", "M79.1", "M79.2", "M79.7",
        "G89.0", "G89.2", "G89.3", "G89.4", "G89.21", "G89.22", "G89.29",
        "G50.1", "G56.0", "G57.0",
        "R10.0", "R10.2", "R10.30", "R10.4", "M17.0",
        "N94.4", "N94.5", "N94.6","M72.2",
        "R52.81", "R52.82", "R52.89", "M54.16", "M10.9", "M17.12", "M79.10","M85.80","R25.2","M43.16","K59.4",
        "T14.0", "T79.8XXA",
        "K52.9",
        "R11.2"
    ]);

    // M-codes are treated as pain-related BY DEFAULT, except this specific
    // exclude list — structural deformities, stiffness/contracture/
    // ankylosis, asymptomatic bone-density findings, and instability-not-
    // pain joint findings. Everything else under M is pain-related unless
    // listed here.
    const NON_PAIN_M_EXACT_CODES = new Set([
        "M67.4", "M72.0", "M79.3",
        "M81.0", "M81.6", "M81.8",
        "M22.0", "M22.1", "M24.4", "M24.5", "M24.6", "M25.6", "M62.4", "M62.81", "M89.7"
    ]);
    const NON_PAIN_M_PREFIXES = [
        "M20.", "M21.", "M40.", "M41.", "M43.0", "M43.1", "M85.", "M95.", "M96.", "M88"
    ];

    function isNonPainMCode(code) {
        const c = (code || "").toUpperCase().trim();
        if (NON_PAIN_M_EXACT_CODES.has(c)) return true;
        return NON_PAIN_M_PREFIXES.some(p => c.startsWith(p));
    }

    // Used for the Z71.82-vs-Z71.89 decision and the 1125F/1126F
    // correction logic. Pain-related if: it's on the exact list above,
    // OR the literal word "pain" is in the diagnosis name, OR it's any
    // M-code that ISN'T on the non-pain-M exclude list above. S-codes
    // (injury) do NOT count here — those are handled separately.
    function isPainRelatedICDEntry(code, name) {
        const c = (code || "").toUpperCase().trim();
        if (PAIN_RELATED_ICD_CODES.has(c)) return true;
        if (/\bpain\b/i.test(name || "")) return true;
        if (/^M/i.test(c)) return !isNonPainMCode(c);
        return false;
    }

    // Injury/trauma (S-codes). Used only to route Z71.82-vs-Z71.89 to
    // Z71.89 — exercise counseling isn't appropriate with a fresh injury.
    function isInjuryICDEntry(code) {
        return /^S\d{2}/i.test(code || "");
    }

    function isMedicaidOrMedicareIns(insurance) {
        if (!insurance) return false;
        const name = insurance.trim();
        // MetroPlus is its own distinct payer (G0444/G0442 ARE billable for
        // it) even though it's administratively Medicaid — never exclude it.
        if (/metro\s*plus/i.test(name)) return false;
        return /^\s*medicaid\b/i.test(name) || /^\s*medicare\b/i.test(name);
    }

    // v2.29: straight Medicare = the insurance name STARTS with "Medicare"
    // (same test as the Preventive Counseling rule). Medicare plans run by
    // another payer (e.g. "Healthfirst Medicare Plan") are not included.
    function isStraightMedicareIns(insurance) {
        return !!insurance && /^\s*medicare\b/i.test(insurance);
    }

    function isUHCInsurance(insurance) {
        if (!insurance) return false;
        // Normalize: trim, lowercase, drop periods/commas, collapse whitespace/
        // hyphens to single spaces — so "United-Health Care", "United  Health
        // One", "UnitedHealthcare", "UnitedHealthOne" etc. all normalize the
        // same way, and a spacing/hyphenation quirk in the payer name never
        // causes a miss.
        const name = insurance.trim().toLowerCase()
            .replace(/[.,]/g, '')
            .replace(/[\s-]+/g, ' ')
            .trim();

        // Core rule: ANY insurance name starting with "united" is treated as
        // United Healthcare family — covers UnitedHealthcare, United Health
        // Care, United-Health-Care, UnitedHealthOne, United Health One,
        // UnitedHealthcare Community Plan of NJ/MO/NM/OH/TN/MI/KS/AZ,
        // UnitedHealthcare Student Resources, UnitedHealthcare All Savers
        // Insurance, UnitedHealthcare Neighborhood Health Partnership,
        // UnitedHealthcare Oxford, UnitedHealthcare Global, etc. — every
        // "United..." branded plan, regardless of spacing.
        // NOTE: deliberately NOT using \b after "united" — once normalized,
        // "UnitedHealthcare" becomes one continuous word ("unitedhealthcare"),
        // and \b never fires between "united" and "healthcare" in that case,
        // so a word-boundary anchor here would silently miss every no-space
        // brand name.
        if (/^united/.test(name)) return true;

        // Plain "UHC" abbreviation.
        if (/^uhc\b/.test(name)) return true;

        // UHC-owned/underwritten brands that do NOT start with "United" in
        // the payer name, so the rule above can't catch them.
        const UHC_BRAND_PATTERNS = [
            /^surest\b/,
            /^aarp\s+supplemental\s+health\b/,
            /^golden\s+rule\b/,
            /^umr\b/,
            /^preferred\s+care\s+partners\b/,
            /^health\s+plan\s+of\s+nv\b/,
            /^sierra\s+health\s+and\s+life\b/,
            /^medica\s+health\s+plans\b/,
            /^all\s+savers\b/,
            /^neighborhood\s+health\s+partnership\b/,
            /^oxford\b/,
            /^flexwork\b/,
            /\busnas\b/
        ];

        return UHC_BRAND_PATTERNS.some(re => re.test(name));
    }

    // Eligible unless insurance starts with Medicaid/Medicare or is
    // UHC/United Health Care. Unknown/unparsed insurance defaults eligible
    // (previously required truthy insurance, which wrongly blocked/removed
    // G0444/G0442 whenever parsing came back empty).
    function annualGCodesEligible(insurance) {
        return !isMedicaidOrMedicareIns(insurance) && !isUHCInsurance(insurance);
    }

    // Plan-variant words stripped out when deriving a payer "brand" key —
    // used to tell a genuine insurance CHANGE (MetroPlus -> Healthfirst)
    // apart from a same-payer plan-name variation (Healthfirst ->
    // Healthfirst PPO / Healthfirst Leaf Premier). Only used for the
    // insurance-change carve-out below; does not affect any other payer
    // matching elsewhere in this file (isUHCInsurance, etc.).
    const INSURANCE_PLAN_VARIANT_WORDS = new Set([
        'ppo', 'hmo', 'epo', 'pos', 'hdhp', 'plan', 'choice', 'advantage',
        'gold', 'silver', 'bronze', 'platinum', 'essential', 'elite',
        'complete', 'premier', 'leaf', 'select', 'value', 'basic',
        'standard', 'preferred', 'network', 'of', 'ny', 'nyc', 'the',
        'insurance', 'health', 'care', 'plus'
    ]);
    function getPayerBrand(insuranceName) {
        if (!insuranceName) return "";
        const words = insuranceName.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
        if (!words.length) return "";
        const significant = words.filter(w => !INSURANCE_PLAN_VARIANT_WORDS.has(w));
        // If every word got stripped (e.g. name was ALL plan-variant
        // words), fall back to the unfiltered words rather than losing
        // the brand entirely.
        return (significant.length ? significant : words)[0];
    }

    // True if `pastInsuranceName` should be treated as a DIFFERENT payer
    // than the current encounter's insurance, for the purpose of the
    // preventive/counseling timeline carve-out below. Unknown/unparsed
    // insurance on either side is treated conservatively as SAME payer
    // (i.e. still counts against the timeline) so missing data never
    // opens up a duplicate-billing gap.
    function isDifferentPayerThanCurrent(pastInsuranceName) {
        const currentInsurance = parseInsuranceFromPage(getEncounterText());
        if (!currentInsurance || !pastInsuranceName) return false; // unknown -> treat as same, conservative
        const currentBrand = getPayerBrand(currentInsurance);
        const pastBrand = getPayerBrand(pastInsuranceName);
        if (!currentBrand || !pastBrand) return false;
        return currentBrand !== pastBrand;
    }

    // Was `code` already billed in a PRIOR encounter this `year`? Excludes
    // the currently-open encounter's own date, so today's own claim doesn't
    // count against a genuinely new instance later in the year.
    //
    // Insurance-change carve-out: if that prior encounter was billed under
    // a DIFFERENT payer than the current encounter's insurance, it does
    // NOT count against this year's timeline — e.g. MetroPlus billed
    // G0442 in 2026, patient's insurance is now Healthfirst -> Healthfirst
    // can still bill G0442 this year, since it never used it. An
    // established patient stays established regardless of this — that
    // status isn't derived from this function.
    function codeUsedInYear(code, year) {
        const api = window.__ecwPatientHistory;
        const data = api && api.getData ? api.getData() : null;
        if (!data || !data.length) return false;
        const upperCode = code.toUpperCase();
        const currentDos = document.querySelector("#encDropDownItem")?.title?.match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0] || "";
        return data.some(enc => {
            if (currentDos && enc.encounter_date === currentDos) return false;
            const ts = parseUSDateSnap(enc.encounter_date);
            if (!ts) return false;
            if (new Date(ts).getFullYear() !== year) return false;
            if (isDifferentPayerThanCurrent(enc.insurance_name)) return false;
            const codes = [
                ...(enc.visit_codes || []),
                ...(enc.procedure_codes || [])
            ].map(c => (c.code || "").toUpperCase());
            return codes.includes(upperCode);
        });
    }

    // Was `code` billed in any PRIOR encounter within the last `days` days
    // of the current DOS? Excludes the currently-open encounter's own date.
    // Used for the 99214 "not used in the last 30 days" rule.
    //
    // Same insurance-change carve-out as codeUsedInYear above: a prior
    // encounter billed under a different payer than the current
    // encounter's insurance doesn't count against the day window.
    // G0136 (social needs / SDOH risk assessment): once every 6 CALENDAR
    // months, looking back from the current DOS only — same window as the
    // Patient History script 2026-09-29.4: the cutoff is the same day of
    // the month 6 months earlier (clamped to that month's length, e.g.
    // 08/31 -> 02/28), inclusive; the current encounter and anything dated
    // after it never count. Same insurance-change carve-out as the other
    // timeline gates here (a prior G0136 under a different payer doesn't
    // count). Returns { date } of the blocking G0136, or null.
    function findG0136UseWithinSixMonths() {
        const api = window.__ecwPatientHistory;
        const data = api && api.getData ? api.getData() : null;
        if (!data || !data.length) return null;
        const dos = parseUSDateSnap(getCurrentDOSStr());
        if (!dos) return null;
        const src = new Date(dos);
        const cutoff = new Date(dos);
        cutoff.setDate(1);
        cutoff.setMonth(cutoff.getMonth() - 6);
        const lastDay = new Date(cutoff.getFullYear(), cutoff.getMonth() + 1, 0).getDate();
        cutoff.setDate(Math.min(src.getDate(), lastDay));
        const cutoffMs = +cutoff;
        for (const enc of data) {
            const t = parseUSDateSnap(enc.encounter_date);
            if (!t || t < cutoffMs || t >= dos) continue;
            if (isDifferentPayerThanCurrent(enc.insurance_name)) continue;
            const codes = [...(enc.visit_codes || []), ...(enc.procedure_codes || [])]
                .map(c => String(c.code || '').trim().toUpperCase());
            if (codes.includes('G0136')) return { date: enc.encounter_date };
        }
        return null;
    }

    function codeUsedInLastDays(code, days) {
        const api = window.__ecwPatientHistory;
        const data = api && api.getData ? api.getData() : null;
        if (!data || !data.length) return false;
        const upperCode = code.toUpperCase();
        const currentDosStr = document.querySelector("#encDropDownItem")?.title?.match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0] || "";
        const currentTs = currentDosStr ? parseUSDateSnap(currentDosStr) : null;
        if (!currentTs) return false;
        return data.some(enc => {
            if (currentDosStr && enc.encounter_date === currentDosStr) return false;
            const ts = parseUSDateSnap(enc.encounter_date);
            if (!ts) return false;
            const diffDays = Math.abs(currentTs - ts) / 86400000;
            if (diffDays > days) return false;
            if (isDifferentPayerThanCurrent(enc.insurance_name)) return false;
            const codes = [
                ...(enc.visit_codes || []),
                ...(enc.procedure_codes || [])
            ].map(c => (c.code || "").toUpperCase());
            return codes.includes(upperCode);
        });
    }

    // Vitals documented: at least one real reading (BP, weight, height,
    // pulse, temp, resp rate, O2 sat) anywhere in the note. Used for the
    // 99212 ("no vitals documented") rule.
    //
    // The "Patient Info" sidebar widget always shows a cached Wt/Ht (e.g.
    // "Wt: 253 lbs (on 07/13/26)") regardless of whether vitals were taken
    // THIS visit — scanning the raw page text made this check always true.
    // Strip that widget's text out first.
    function isVitalsDocumented(text) {
        const cleaned = (text || "").replace(/Patient Info\b[\s\S]{0,300}?(?=Billing Details\b|Notes\b|Secure Notes\b|Healow\b|$)/i, '');
        return /\bBP\s*:?\s*\d{2,3}\s*\/\s*\d{2,3}\b/i.test(cleaned) ||
               /\b(?:Wt|Weight)\s*:?\s*\d/i.test(cleaned) ||
               /\b(?:Ht|Height)\s*:?\s*\d/i.test(cleaned) ||
               /\b(?:Pulse|HR)\s*:?\s*\d/i.test(cleaned) ||
               /\bTemp(?:erature)?\s*:?\s*\d/i.test(cleaned) ||
               /\b(?:Resp|RR)\s*:?\s*\d/i.test(cleaned) ||
               /\b(?:O2\s*Sat|SpO2)\s*:?\s*\d/i.test(cleaned);
    }

    // Drives the "Tob" flag chip (red = false) and the Smoking button. A
    // literal "smoker" word confirms active smoking on its own; other
    // tobacco language (smokeless, chewing tobacco, cigar) without that word
    // needs a prior F17.210 in history to confirm. Returns true = NOT a
    // confirmed smoker (green), false = confirmed (red).
    // "Smoker" not preceded by a negation word (not/denies/no/former/past)
    // or "non-"/"non " — used for both checks below.
    const NEG_BEFORE_SMOKER = "(?<!(?:not|denies|no|former|past)\\s)(?<!non[\\s-])";

    function isConfirmedNonSmoker(socText) {
        // "current ... smoker" wins over other text in the section (eCW
        // sometimes appends a contradicting trailing summary). Allows a
        // short gap for phrasing like "current every day smoker". The
        // negation lookbehind must guard the word "smoker" itself, not
        // "current" — otherwise "Current non-smoker" (current tense of a
        // non-smoker finding) matches "current" + "smoker" and gets
        // misread as an active smoker, when "non-" right before "smoker"
        // is exactly the negation this guard exists to catch.
        if (new RegExp(`\\bcurrent\\b[\\s\\S]{0,25}?${NEG_BEFORE_SMOKER}\\bsmoker\\b`, "i").test(socText)) return false;

        const explicitNegative = /non[\s-]?smoker|former\s+smoker|other\s+tobacco.*No/i.test(socText);

        // When an explicit "Former smoker" / "non-smoker" answer already
        // exists, a later "<product type> smoker" phrase (e.g. "Pipe
        // smoker", "Cigar smoker", "Cigarette smoker") coming from a
        // SEPARATE "Additional Findings: Tobacco user" sub-question is
        // just describing what type of tobacco they used/use — it is not
        // a fresh, independent affirmation of CURRENT smoking, and must
        // not override the former/non-smoker answer. Without this,
        // "Tobacco use: Former smoker, ... Additional Findings: Tobacco
        // user Pipe smoker" was being flagged as a confirmed CURRENT
        // smoker even though the patient explicitly answered "Former
        // smoker".
        const textForBareSmokerCheck = explicitNegative
            ? socText.replace(/\b(?:pipe|cigar|cigarette|cigarillo|hookah|chew(?:ing)?)\s+smoker\b/gi, '')
            : socText;

        // Bare "smoker" mention (e.g. "Light cigarette smoker") — checked
        // before "other tobacco use? No" below, since that question is
        // about smokeless/chewing tobacco, not cigarettes.
        if (new RegExp(`${NEG_BEFORE_SMOKER}\\bsmoker\\b`, "i").test(textForBareSmokerCheck)) return false;

        if (explicitNegative) return true;

        const otherTobaccoUse = /smokeless|chewing tobacco|tobacco user(?!\?\s*No)|\bcigar\b/i.test(socText);
        if (otherTobaccoUse) {
            const api = window.__ecwPatientHistory;
            const data = api && api.getData ? api.getData() : null;
            const confirmedByHistory = !!data && data.some(enc =>
                [...(enc.assessments || []), ...(enc.visit_codes || []), ...(enc.procedure_codes || [])]
                    .some(c => (c.code || "").toUpperCase().startsWith("F17.210"))
            );
            return !confirmedByHistory; // unconfirmed -> treat as not-a-confirmed-smoker
        }

        return true; // no positive indicators found
    }

    // ====================== SHARED CLINICAL FLAG EXTRACTION ======================
    // v2.01: screening detection ported from "ECW - Patient ICD/CPT History"
    // 2026-09-29.4 — a structured reader for eCW's Social History category
    // (question/answer pairs), AUDIT-C scoring, and separate smoker / other-
    // tobacco answers. The older free-text rules are kept as fallbacks for
    // notes that don't use those templates. Used by both the Coding tab chips
    // AND the rule engine, so the two never disagree.

    // Social History category blocks on the live note (never our own panel).
    function socialHistoryBlocks() {
        const out = [];
        for (const el of document.querySelectorAll('span.cattablink[cattabitemname]')) {
            if (el.closest('#smcPanel')) continue;
            const section = (el.getAttribute('cattabitemname') || '').trim();
            if (!/^Social\s+History:?$/i.test(section)) continue;
            const host = el.closest("div[id^='readOnlyCategory_']") || el.parentElement;
            if (host && !out.includes(host)) out.push(host);
        }
        return out;
    }

    const shNormKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const shNodeText = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

    function splitQaSegments(raw) {
        const text = String(raw || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
        const parts = [];
        for (const chunk of text.split(',')) {
            const seg = chunk.trim().replace(/\.$/, '');
            if (!seg) continue;
            const at = seg.search(/:+/);
            if (at === -1) {
                if (parts.length) parts[parts.length - 1].answer += ', ' + seg;
                continue;
            }
            const question = seg.slice(0, at).replace(/\?$/, '').trim();
            const answer = seg.slice(at).replace(/^:+/, '').trim();
            if (question) parts.push({ question, answer });
        }
        return parts;
    }

    function collectSocialHistoryFields() {
        const fields = [];
        for (const host of socialHistoryBlocks()) {
            for (const tr of host.querySelectorAll('tr')) {
                const labelEl = tr.querySelector('.fontw600');
                const label = labelEl ? shNodeText(labelEl) : '';
                const group = label.replace(/:$/, '');
                const valueEl = tr.querySelector('.normaltext') || tr.querySelector('td:last-child');
                if (!valueEl) continue;
                let value = shNodeText(valueEl);
                if (label && value.startsWith(label)) value = value.slice(label.length).replace(/^\s*:+\s*/, '');
                const qas = splitQaSegments(value);
                if (qas.length) {
                    for (const qa of qas) fields.push(Object.assign({ group }, qa));
                } else if (value && group) {
                    fields.push({ group, question: group, answer: value.replace(/\.$/, '').trim() });
                }
            }
        }
        return fields;
    }

    function findSocialField(fields, groupHints, questionHints) {
        for (const f of fields) {
            const g = shNormKey(f.group), q = shNormKey(f.question);
            if (groupHints.length && !groupHints.some(h => g.includes(h))) continue;
            if (questionHints.some(h => q.includes(h))) return f;
        }
        return null;
    }

    // Ordered — first match wins ("former smoker" before bare "smoker").
    // true = not a smoker, false = smoker, null = unknown.
    const SMOKER_ANSWERS = [
        ['current every day smoker', false], ['current some day smoker', false], ['current smoker', false],
        ['every day smoker', false], ['some day smoker', false],
        ['never smoker', true], ['never smoked', true], ['non smoker', true], ['nonsmoker', true],
        ['former smoker', true], ['ex smoker', true], ['quit', true],
        ['unknown', null], ['not asked', null], ['declined', null],
        ['smoker', false]
    ];
    const YES_NO_ANSWERS = [
        ['no', true], ['never', true], ['none', true], ['denies', true], ['unknown', null], ['yes', false]
    ];
    function classifyAnswer(answer, table) {
        const a = shNormKey(answer);
        if (!a) return null;
        for (const [needle, verdict] of table) if (a.includes(needle)) return verdict;
        return null;
    }

    function getSocialHistoryText(fullText) {
        const parts = socialHistoryBlocks().map(host => host.innerText || host.textContent || '');
        if (parts.length) return parts.join('\n');
        const m = String(fullText || '').match(/Social History\s*[:\*]?([\s\S]*?)(?=\n\s*(?:Family History|Medical History|Surgical History|Review of Systems|Objective|Assessment|Plan|HPI|Subjective)\b|$)/i);
        return m ? m[1] : '';
    }

    // Pre-2.01 alcohol reader for the "Drugs/Alcohol:" template — used only
    // when neither an AUDIT-C block nor the free-text fallback gives an answer.
    function legacyAlcoholFlag(text) {
        const drugsAlcMatch = text.match(/Drugs?\/Alcohol:([\s\S]*?)(?=\n\s*\*[A-Za-z]|\n\s*(?:Screening:|ROS:|Social History Verified)|$)/i);
        const drugsAlcText = drugsAlcMatch ? drugsAlcMatch[1] : '';
        if (!drugsAlcMatch || !/alcohol|drink/i.test(drugsAlcText)) return null;
        // v2.37: Interpretation first; points only when there's none.
        const auditInterp = drugsAlcText.match(/Interpretation\s*:?\s*(Negative|Positive)\b/i);
        if (auditInterp) return /negative/i.test(auditInterp[1]);
        const pointsMatches = [...drugsAlcText.matchAll(/\bPoints\s+(\d+)/gi)];
        if (pointsMatches.some(m => Number(m[1]) > 0)) return false;
        let officialResult = null;
        const scoredInterp = drugsAlcText.match(/Interpretation of Score:\s*(No[nz]e|Low|Minimal|Mild|Moderate|Substantial|Severe|High)/i);
        if (scoredInterp) {
            const isLow = /no[nz]e|low|minimal/.test(scoredInterp[1].toLowerCase());
            officialResult = officialResult === false ? false : isLow;
        }
        if (officialResult !== null) return officialResult;
        const positiveUse = /\bAdmits\b|\byes\b(?!\s*no)|\bcurrent(ly)?\s+(drink|use)|drinks?\s+per\s+(week|day)|\bAUDIT\b.*(?:[1-9]\d*\s*$|positive)/i.test(drugsAlcText);
        return !positiveUse && /\bNo\b/i.test(drugsAlcText);
    }

    function extractClinicalFlags(text) {
        const socText = getSocialHistoryText(text);
        const sdFields = collectSocialHistoryFields();

        // ---- Depression: first "Total Score" of the PHQ block; 0 = negative.
        // Read from the HPI/Subjective section when the screening is there,
        // otherwise from the whole note.
        const hpiMatch = text.match(/(?:HPI|History of Present Illness|Subjective)\s*[:\*]?([\s\S]*?)(?=\n\s*(?:Objective|Assessment|Plan|Social History|Review of Systems|Physical Exam)\b|$)/i);
        const hpiSection = hpiMatch ? hpiMatch[1] : '';
        const depSrc = /Depression Screening|PHQ-?\d/i.test(hpiSection) ? hpiSection : text;
        const depPresent = /Depression Screening|PHQ-?\d/i.test(depSrc);
        const depTotal = depSrc.match(/Total\s+Score\s+(\d+)/i);
        const hasDep = depPresent ? (depTotal ? Number(depTotal[1]) === 0 : null) : null;

        // ---- Smoking status and other tobacco (true = no, false = yes) ----
        const smokerField = findSocialField(sdFields, ['smok', 'tobacco'],
            ['are you a', 'are you an', 'smoking status', 'tobacco use', 'current status']);
        let hasSmoker = smokerField ? classifyAnswer(smokerField.answer, SMOKER_ANSWERS) : null;
        const tobField = findSocialField(sdFields, ['smok', 'tobacco'],
            ['other tobacco user', 'other tobacco', 'smokeless', 'chew', 'snuff']);
        let hasOtherTobacco = tobField ? classifyAnswer(tobField.answer, YES_NO_ANSWERS) : null;
        if (!sdFields.length) {
            if (hasSmoker === null) {
                const m = socText.match(/(?:Are\s+you\s+an?\b[\s:]*|Smoking\s*[\s:]+|Tobacco\s*use\s*[\s:]+)([a-z][a-z\s-]*smoker)/i);
                if (m) hasSmoker = classifyAnswer(m[1], SMOKER_ANSWERS);
            }
            if (hasOtherTobacco === null) {
                const m = socText.match(/other tobacco user\s*\??\s*:*\s*(yes|no)/i);
                if (m) hasOtherTobacco = classifyAnswer(m[1], YES_NO_ANSWERS);
            }
        }
        // Older free-text template ("Tobacco Use: ...") — pre-2.01 reader.
        if (hasSmoker === null && /Tobacco Use:/i.test(socText)) hasSmoker = isConfirmedNonSmoker(socText);
        // Tobacco screening result (G9275/G9276, 1036F/1000F): any smoking or
        // other tobacco use counts as positive.
        const hasTob = (hasSmoker === false || hasOtherTobacco === false) ? false
            : ((hasSmoker === true || hasOtherTobacco === true) ? true : null);

        // ---- Alcohol (AUDIT-C) — v2.37: the note's "Interpretation" decides
        // (Negative = negative, Positive = positive, points don't matter).
        // Without an Interpretation line: total score, then the sum of
        // per-item "(N point)" values, then the first question's Yes/No.
        // Social History first, then the rest of the note. The block starts
        // at "AUDIT" or at "Did you have a drink containing alcohol".
        const alcSrc = /AUDIT|drink\s+containing\s+alcohol/i.test(socText) ? socText : text;
        const auditBlock = (alcSrc.match(/(?:AUDIT|drink\s+containing\s+alcohol)[\s\S]{0,1500}?(?:Interpretation\s*:?\s*\w+|$)/i) || [])[0] || '';
        let hasAlc = null;
        if (auditBlock) {
            // v2.37: the note's Interpretation decides — "Interpretation
            // Negative" = negative, "Positive" = positive, whatever the points.
            // Points / per-item points / first question are used only when
            // there's no Interpretation line.
            const interp = auditBlock.match(/Interpretation\s*:?\s*(Negative|Positive)\b/i);
            const totals = [...auditBlock.matchAll(/\b(?:Points?|Total\s+Score|Score)\s*:?\s*(\d+)\b/gi)];
            const items = [...auditBlock.matchAll(/\((\d+)\s*points?\)/gi)];
            const first = auditBlock.match(/drink\s+containing\s+alcohol\s+in\s+the\s+past\s+year\s*\?*\s*:*\s*(Yes|No)\b/i);
            if (interp) hasAlc = /negative/i.test(interp[1]);
            else if (totals.length) hasAlc = Number(totals[totals.length - 1][1]) === 0;
            else if (items.length) hasAlc = items.reduce((sum, m) => sum + Number(m[1]), 0) === 0;
            else if (first) hasAlc = /^no$/i.test(first[1]);
        }
        if (hasAlc === null) {
            const alcPresent = /drink.*alcohol/i.test(socText) || /\bEtOH\b/i.test(socText) ||
                /drinks?\s*(?:per|a)\s*(?:week|day|month)/i.test(socText) || /Consume\s+Alcohol/i.test(socText);
            if (alcPresent) {
                hasAlc = /drink.*alcohol.*\?*:*\s*No\b/i.test(socText) ||
                    /\b(?:etoh|drinks?)\s*[:\s]+0\b/i.test(socText) ||
                    /alcohol\s+use\s*[:\-]\s*no/i.test(socText);
            }
        }
        if (hasAlc === null) hasAlc = legacyAlcoholFlag(text);

        // ---- Social needs (G0136): SCN / Social Needs / Social Determinants ----
        let hasSocialNeeds = /Social Needs Screening|SCN\s*Screening|Social\s*Determinants?\b/i.test(socText);
        if (!hasSocialNeeds) {
            hasSocialNeeds = [...document.querySelectorAll('span.cattablink[cattabitemname]')]
                .filter(el => !el.closest('#smcPanel') && /^Social\s+History:?$/i.test((el.getAttribute('cattabitemname') || '').trim()))
                .some(el => /Social\s*Determinants?\b/i.test(el.textContent || ''));
        }

        // hpiText stays the whole note: televisit detection searches it.
        return { hasDep, hasTob, hasSmoker, hasOtherTobacco, hasAlc, hasSocialNeeds, hpiText: text, socText };
    }

    // ====================== AUTO-CODING ANALYSIS ENGINE ======================
    // Ported from the working ICD auto-add/delete script (Button_Disabled_v2_1),
    // same technique applied to the CPT side: real table IDs, the real
    // autosuggest-link selector (not just the bare span), and the proven
    // bootbox "Yes" button selectors.

    // Codes this engine actively manages: present but not in "desired" =
    // flagged for deletion. 3014F/3015F/3017F/99000 are add-only, never
    // deleted (not in this set on purpose). G0444/G0442 also excluded —
    // once-per-year codes, left alone if already on the chart.
    const MANAGED_CODES = new Set([
        '3008F', 'G8418', 'G8420', 'G8417',
        '3074F', '3075F', '3077F',
        '3078F', '3079F', '3080F',
        'G8752', 'G8753', 'G8754', 'G8755',
        '1159F', '1160F',
        '1125F', '1126F',
        '1157F', '1158F', '1170F',
        'G8510', 'G8431', 'G9622', '3016F',
        'G9275', 'G9276', '1036F', '1000F',
        'G0136', 'G9744', '99051'
        // NOTE: G0444 / G0442 are also deliberately NOT in this set.
    ]);

    function getCPTRows() {
        return Array.from(document.querySelectorAll('#billingTbl4 tbody tr'));
    }

    // ICD grid: #billingTbl2, code lives in the 3rd <td> (title + text = the
    // code itself, e.g. "M54.5"), diagnosis name lives in the 4th <td>.
    function getICDRows() {
        return Array.from(document.querySelectorAll('#billingTbl2 tbody tr')).map(row => {
            const cells = row.querySelectorAll('td');
            const code = (cells[2]?.textContent || '').trim();
            const name = (cells[3]?.textContent || '').trim();
            return { row, code, name };
        }).filter(r => r.code);
    }

    function getCPTRowByCode(code) {
        return getCPTRows().find(r =>
            r.querySelector('td:nth-child(2)')?.textContent.trim().toUpperCase() === code.toUpperCase()
        );
    }

    // ====================== VACCINE ADMINISTRATION CODING ======================
    // Component counts per vaccine product CPT code (from the AAP
    // "Component Count" reference). Used to compute 90460/90461 units for
    // patients under 18. Anything not listed defaults to 1 component.
    const VACCINE_COMPONENT_MAP = {
        '90589': 1, '90700': 3, '90702': 2, '90696': 4, '90697': 6,
        '90723': 5, '90698': 5, '90633': 1, '90740': 1, '90743': 1,
        '90744': 1, '90746': 1, '90747': 1, '90647': 1, '90648': 1,
        '90651': 1, '90707': 3, '90710': 4, '90619': 1, '90620': 1,
        '90621': 1, '90623': 1, '90624': 1, '90734': 1, '90670': 1,
        '90671': 1, '90677': 1, '90732': 1, '90713': 1, '90680': 1,
        '90681': 1, '90714': 2, '90715': 3, '90716': 1, '90622': 1,
        '90611': 2,
        // Influenza (all single-component)
        '90656': 1, '90657': 1, '90658': 1, '90660': 1, '90661': 1,
        '90672': 1, '90674': 1, '90682': 1, '90685': 1, '90686': 1,
        '90687': 1, '90688': 1, '90756': 1
    };
    // COVID vaccines are never counted via 90460-90474 — always 90480,
    // for every patient regardless of age or payer.
    const COVID_VACCINE_CODES = new Set(['91319', '91320', '91321', '91322', '91323', '91304']);
    // Medicare-only overrides (no age limit) — these use their own G-codes
    // instead of the standard 90460-90474 scheme, for Medicare patients only.
    const FLU_VACCINE_CODES = new Set(['90656', '90657', '90658', '90660', '90661', '90672', '90674', '90682', '90685', '90686', '90687', '90688', '90756']);
    const PNEUMOCOCCAL_VACCINE_CODES = new Set(['90670', '90671', '90677', '90732']);
    const HEPB_VACCINE_CODES = new Set(['90740', '90743', '90744', '90746', '90747']);
    // Every admin code this feature manages — used to find stale/wrong ones.
    const VACCINE_ADMIN_CODE_UNIVERSE = ['90460', '90461', '90471', '90472', '90473', '90474', 'G0008', 'G0009', 'G0010', '90480'];

    function getCPTRowUnits(row) {
        const input = row.querySelector('input[data-fieldname="units"]');
        if (!input) return null;
        const n = parseFloat(input.value);
        return isNaN(n) ? null : n;
    }

    // Sets the Units field on an existing CPT row (the ng-model="cpt.units"
    // input eCW renders per row) — tries the Angular scope first, falls
    // back to a manual input + event dispatch.
    async function setCPTUnitsByCode(code, units) {
        const row = getCPTRowByCode(code);
        if (!row) return { ok: false };
        const unitsStr = Number(units).toFixed(2); // eCW displays units as "1.00", "2.00", etc.
        try {
            const ng = pageGlobal('angular');
            const scope = ng && ng.element ? ng.element(row).scope() : null;
            if (scope && scope.cpt) {
                scope.$applyAsync(() => { scope.cpt.units = unitsStr; });
                await new Promise(r => setTimeout(r, 300));
                return { ok: true };
            }
        } catch (e) { /* fall through to manual input path */ }
        const unitsInput = row.querySelector('input[data-fieldname="units"]');
        if (unitsInput) {
            unitsInput.focus();
            unitsInput.value = unitsStr;
            unitsInput.dispatchEvent(new Event('input', { bubbles: true }));
            unitsInput.dispatchEvent(new Event('change', { bubbles: true }));
            unitsInput.blur();
            await new Promise(r => setTimeout(r, 300));
            return { ok: true };
        }
        return { ok: false };
    }

    // Pure planning function: given the vaccine PRODUCT rows currently on
    // the chart, works out which administration code(s) apply and at what
    // unit count. `rows` is an array of {code, row} (from currentRows).
    function computeVaccineAdminPlan(rows, age, isMedicareIns) {
        const covidRows = [];
        const fluRows = [];
        const pneumoRows = [];
        const hepbRows = [];
        const otherVaccineRows = [];

        rows.forEach(r => {
            const code = r.code;
            if (COVID_VACCINE_CODES.has(code)) { covidRows.push(r); return; }
            if (!(code in VACCINE_COMPONENT_MAP)) return; // not a vaccine product code
            if (isMedicareIns && FLU_VACCINE_CODES.has(code)) { fluRows.push(r); return; }
            if (isMedicareIns && PNEUMOCOCCAL_VACCINE_CODES.has(code)) { pneumoRows.push(r); return; }
            if (isMedicareIns && HEPB_VACCINE_CODES.has(code)) { hepbRows.push(r); return; }
            otherVaccineRows.push(r);
        });

        const plan = []; // { code, units, reason }

        if (covidRows.length) {
            plan.push({ code: '90480', units: 1, reason: 'COVID-19 vaccine administration' });
        }
        if (fluRows.length) {
            plan.push({ code: 'G0008', units: 1, reason: 'Medicare — Influenza vaccine administration' });
        }
        if (pneumoRows.length) {
            plan.push({ code: 'G0009', units: 1, reason: 'Medicare — Pneumococcal vaccine administration' });
        }
        if (hepbRows.length) {
            plan.push({ code: 'G0010', units: 1, reason: 'Medicare — Hepatitis B vaccine administration (high/intermediate risk)' });
        }

        if (otherVaccineRows.length) {
            const vaccineCount = otherVaccineRows.length;
            if (age != null && age >= 18) {
                plan.push({ code: '90471', units: 1, reason: `${vaccineCount} vaccine(s) — first/only vaccine administered` });
                if (vaccineCount > 1) {
                    plan.push({ code: '90472', units: vaccineCount - 1, reason: `${vaccineCount} vaccine(s) — each additional vaccine` });
                }
            } else if (age != null) {
                const totalComponents = otherVaccineRows.reduce((sum, r) => sum + (VACCINE_COMPONENT_MAP[r.code] || 1), 0);
                plan.push({ code: '90460', units: vaccineCount, reason: `${vaccineCount} vaccine(s), ${totalComponents} total component(s) — first component of each` });
                const extra = totalComponents - vaccineCount;
                if (extra > 0) {
                    plan.push({ code: '90461', units: extra, reason: `${totalComponents} total component(s) across ${vaccineCount} vaccine(s) — additional components` });
                }
            }
        }

        return plan;
    }

    // Same selector set the working ICD script uses for eCW's bootbox confirm dialog.
    function clickAnyYesButton() {
        const yesBtn =
            document.querySelector('button[data-bb-handler="Yes"].btn-yes') ||
            document.querySelector('#balloon-alertMessage-tpl-yes') ||
            document.querySelector('.bootbox .btn-primary') ||
            Array.from(document.querySelectorAll('button, a')).find(
                b => b.offsetParent !== null && ['yes', 'delete'].includes(b.textContent.trim().toLowerCase())
            );
        if (yesBtn) { yesBtn.click(); return true; }
        return false;
    }

    // ====================== REMOVE WITHOUT eCW's WARNING (v1.5) ======================
    // eCW's delete buttons call removeData(index, 'icd' | 'cpt').
    //  - ICD: removeData has a deleteWithoutConfirming option. With it, eCW
    //    skips the "Are you sure?" balloon and runs its full removal itself
    //    (form lock, associated CPTs, primary moved to the next diagnosis,
    //    splice, row renumbering).
    //  - CPT: the warning's Yes button runs removeCpt(index) — called directly.
    // A code whose delete button eCW has disabled (no permission, or a CPT
    // mapped in Patient Tracking) is never removed. There is no click-and-Yes
    // fallback any more (removed in v1.5).
    function findBillingFnScope(tableSel, fnName) {
        const ng = pageGlobal('angular');
        const el = document.querySelector(`${tableSel} tbody tr[ng-repeat]`) || document.querySelector(tableSel);
        if (!el || !ng || !ng.element) return null;
        let sc = null;
        try { sc = ng.element(el).scope(); } catch (e) { return null; }
        while (sc && typeof sc[fnName] !== 'function') sc = sc.$parent;
        return sc || null;
    }
    function deleteButtonBlocked(tableSel, index) {
        const tr = document.querySelectorAll(`${tableSel} tbody tr[ng-repeat]`)[index];
        const btn = tr && tr.querySelector('.blue-delete, i.blue-delete, button');
        return !!(btn && (btn.classList.contains('disabledDeleteButton') || btn.classList.contains('per')));
    }
    async function waitUntilCodeGone(kind, code, timeoutMs) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const sc = getBillingScope();
            const inScope = kind === 'icd' ? (sc && ecwScopeHasICD(sc, code)) : (sc && ecwScopeHasCPT(sc, code));
            const inGrid = kind === 'icd' ? !!findICDRowByCodeFast(code) : !!getCPTRowByCode(code);
            if (!inScope && !inGrid) return true;
            await ecwApiSleep(150);
        }
        return false;
    }
    // { ok, blocked, unavailable }
    async function ecwRemoveCodeNoWarning(kind, code) {
        code = String(code).trim().toUpperCase();
        const tableSel = kind === 'icd' ? '#billingTbl2' : '#billingTbl4';
        const fnName = kind === 'icd' ? 'removeData' : 'removeCpt';
        const sc = findBillingFnScope(tableSel, fnName);
        const list = sc && (kind === 'icd' ? sc.icdData : sc.cptData);
        if (!sc || !Array.isArray(list)) return { ok: false, unavailable: true };
        const index = list.findIndex(x => x && String((kind === 'icd' ? x.medicalcode : x.code) || '').trim().toUpperCase() === code);
        if (index === -1) return { ok: true };                      // already gone
        if (deleteButtonBlocked(tableSel, index)) return { ok: false, blocked: true };
        try {
            ecwSafeApply(sc, () => {
                if (kind === 'icd') sc.removeData(index, 'icd', null, true);
                else sc.removeCpt(index);
            });
        } catch (e) {
            console.warn(`ECW Pilot: eCW remove of ${code} failed`, e);
            return { ok: false, unavailable: true };
        }
        // ICD removal waits on eCW's form lock, so give it a moment.
        return { ok: await waitUntilCodeGone(kind, code, 6000) };
    }

    // The visible #CPTCode box (eCW's markup can have more than one element
    // sharing this id — pick the one that's actually visible/usable).
    function getCPTSearchInput() {
        const inputs = Array.from(document.querySelectorAll(CONFIG.CPT_INPUT_SELECTOR));
        return inputs.find(i => i.offsetParent !== null) || inputs[0];
    }

    // Mirrors waitForSuggestion() from the working ICD script: the real
    // clickable element is the <a id="...AutoSuggest-tplLink..."> wrapping the
    // code span inside #cptmaintable, not the bare span.
    function waitForCPTSuggestion(code, timeoutMs) {
        return new Promise(resolve => {
            const start = Date.now();
            const check = () => {
                const links = document.querySelectorAll('#cptmaintable a[id*="AutoSuggest-tplLink"]');
                let match = Array.from(links).find(a => {
                    const span = a.querySelector(CONFIG.DROPDOWN_ITEM_SELECTOR) || a.querySelector('span');
                    return span && span.textContent.trim() === code;
                });
                if (!match) {
                    // fallback: bare span match, walk up to the nearest <a> if present
                    const span = Array.from(document.querySelectorAll(CONFIG.DROPDOWN_ITEM_SELECTOR))
                        .find(s => s.textContent.trim() === code);
                    if (span) match = span.closest('a') || span;
                }
                if (match) return resolve(match);
                if (Date.now() - start > timeoutMs) return resolve(null);
                setTimeout(check, 120);
            };
            check();
        });
    }

    function waitForCPTRowAppear(code, timeoutMs) {
        return new Promise(resolve => {
            const start = Date.now();
            const timer = setInterval(() => {
                if (getCPTRowByCode(code)) { clearInterval(timer); resolve(true); return; }
                if (Date.now() - start > timeoutMs) { clearInterval(timer); resolve(false); }
            }, 100);
        });
    }

    async function addSingleCPT(code) {
        if (getCPTRowByCode(code)) return { ok: true, message: 'Already present' };

        // v1.97: eCW Billing API method first (lookup + scope add).
        if (ecwApiAvailable()) {
            try {
                return await ecwAddCPTViaApi(code, isEmCode(code));
            } catch (e) {
                return { ok: false, message: `API add failed: ${e.message || e}` };
            }
        }
        // Fallback (Billing scope/XML helpers not on this page): old DOM method.

        // A confirm dialog left open from an earlier delete blocks every
        // click on the page, including typing into the search box below.
        clickAnyYesButton();

        const input = getCPTSearchInput();
        if (!input) return { ok: false, message: 'CPT search box not found/visible' };

        input.focus();
        input.value = code;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        // autocompleteData is bound to ng-keyup, so a real keyup event is required
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: code.slice(-1) }));

        const suggestion = await waitForCPTSuggestion(code, CONFIG.DROPDOWN_TIMEOUT_MS);
        if (!suggestion) return { ok: false, message: 'No autosuggest match found' };

        suggestion.click();
        // small settle delay so eCW finishes inserting the row before we check
        await new Promise(r => setTimeout(r, CONFIG.SEARCH_WAIT_MS));

        const appeared = await waitForCPTRowAppear(code, 3000);
        return { ok: appeared, message: appeared ? null : 'Selected but not confirmed in grid' };
    }

    // Current-medication rules removed entirely (not used).

    function computeAnalysis() {
        const text = getEncounterText();
        const insurance = parseInsuranceFromPage(text);
        const bp = snapshotExtract(text, /BP:\s*(\d{2,3}\/\s*\d{2,3})/i);
        const bmi = snapshotExtract(text, /BMI:\s*(\d{1,3}(?:\.\d{1,2})?)/i);
        const bmiPercentile = snapshotExtract(text, /BMI\s*%:\s*(\d{1,3}(?:\.\d{1,2})?)\s*%/i);
        const age = getAgeAtDOS(text) ?? 0;
        const gender = getGenderFromDOM();

        // Insurance sometimes renders as "Health First" (with a space) instead
        // of "Healthfirst" as one word — treat both as the same payer for
        // the Healthfirst-specific coding rules below.
        const isHealthfirst = !!insurance && /^health[\s-]*first\b/i.test(insurance.trim());
        const isMedicareInsurance = !!insurance && /^medicare(\s+part\s*[ab]|\s+[ab])?$/i.test(insurance.trim());

        const flags = extractClinicalFlags(text);
        const { hasDep, hasTob, hasAlc, hasSocialNeeds } = flags;

        // Raw CPT codes currently on the chart — read early so preventive
        // detection, the age-based correction-only codes, and the
        // 96686/90688→90656 swap can all see what's already there.
        const rawCPTCodesNow = getCPTRows()
            .map(r => (r.querySelector('td:nth-child(2)')?.textContent.trim() || '').toUpperCase())
            .filter(Boolean);
        const rawCPTCodeSet = new Set(rawCPTCodesNow);

        // Televisit is determined the same way isTelevisitNow(text) does
        // for the quick-action buttons (98012 CPT present, or "televisit"
        // mentioned in the HPI). Computed early because it also gates
        // whether any Preventive/Preventive-Counseling bundle (CPT +
        // linked ICDs) is allowed to remain on the chart below.
        const isTelevisitNote = /televisit/i.test(flags.hpiText) || rawCPTCodeSet.has('98012');

        // Single source of truth for whether each of the 4 quick-action
        // buttons (PV/PC/SM/OB) is currently allowed to fire — same
        // function that fades/enables them in the floating panel. Reusing
        // it here means "button faded" and "code gets cleaned off the
        // chart" can never drift apart: whatever reason disables a button
        // (already billed this year/30 days, wrong insurance, no chronic
        // dx, not a confirmed smoker, BMI doesn't qualify, new patient,
        // televisit, etc.) also disqualifies that bundle's codes from
        // staying on THIS chart.
        const gating = computeQuickActionGating(insurance, flags, text);

        // Whether a preventive visit code is on this chart — several
        // other rules below (G0444/G0442, BMI CPTs) are gated on this.
        const PREVENTIVE_VISIT_CODES = new Set([
            '99381', '99382', '99383', '99384', '99385', '99386', '99387',
            '99391', '99392', '99393', '99394', '99395', '99396', '99397',
            'G0438', 'G0439'
        ]);
        const hasPreventiveVisitRaw = rawCPTCodesNow.some(c => PREVENTIVE_VISIT_CODES.has(c));
        // If the PV button is faded (for ANY reason — already billed this
        // year, televisit, etc.) an already-present preventive code no
        // longer counts for downstream bundle logic; the code itself is
        // deleted below, right alongside its linked ICDs.
        const hasPreventiveVisit = hasPreventiveVisitRaw && !gating.pv.disabled;

        // ---- Quick-action gating cleanup ----
        // Whenever PV/PC/SM/OB is faded, delete that bundle's own CPT code
        // if it's already sitting on the chart. Linked ICDs (Z00.01/
        // Z00.121, Z71.3/Z71.82/Z71.89, BMI Z68.xx) are handled further
        // down by the existing hasPreventiveVisit/has99401ForZ71/
        // hasObesityCPTForBMI-driven logic, which now folds this gating in
        // too — so a faded button cascades into ICDs automatically without
        // duplicating the "still needed?" rules here.
        // Collected here (before `toDelete` exists yet below) and merged in
        // once `toDelete` is declared.
        const gatedBundleCPTDeletes = [];
        function deleteBundleCPTIfPresent(codes, reason) {
            getCPTRows().forEach(r => {
                const code = (r.querySelector('td:nth-child(2)')?.textContent.trim() || '').toUpperCase();
                if (codes.includes(code) && !gatedBundleCPTDeletes.some(d => d.code === code)) {
                    gatedBundleCPTDeletes.push({ code, row: r, kind: 'cpt', reason });
                }
            });
        }
        if (gating.pv.disabled) {
            deleteBundleCPTIfPresent([...PREVENTIVE_VISIT_CODES], `Preventive not applicable — ${gating.pv.title}`);
        }
        if (gating.pc.disabled) {
            deleteBundleCPTIfPresent(['99401'], `Preventive Counseling not applicable — ${gating.pc.title}`);
        }
        if (gating.sm.disabled) {
            deleteBundleCPTIfPresent(['99406'], `Smoking Counseling not applicable — ${gating.sm.title}`);
        }
        if (gating.ob.disabled) {
            deleteBundleCPTIfPresent(['G0447'], `Obesity Counseling not applicable — ${gating.ob.title}`);
        }

        const desired = new Map(); // code -> reason

        // Pap smear (Q0091/G0101), Advance Care (99497), TCM/Post-Hosp
        // (99495/99496) — no counseling code may coexist with these, and
        // (per the block below) none of the three block Weekend either.
        const HIGH_LEVEL_BLOCKING_CODES = ['Q0091', 'G0101', '99497', '99495', '99496'];
        const hasHighLevelCode = HIGH_LEVEL_BLOCKING_CODES.some(c => rawCPTCodesNow.includes(c));

        // ---- Weekend rule: CPT 99051 is desired only when the Weekend
        // toggle is on AND none of the blocking conditions below are met.
        // Blocked by: any 9-series CPT code already on the chart except
        // 99000 (blood draw) and the regular office-visit E&M codes
        // (OFFICE_VISIT_EM_CODES — every visit has one of these, so they
        // were wrongly blocking 99051 on every chart before this fix);
        // the Medicare AWV G-codes; G0447 (Obesity); a televisit (98012
        // present, or "televisit" in the HPI — same detection this file
        // already uses elsewhere, see the isTelevisitNote note near the
        // office-visit E&M rule); the insurance being part of the full
        // United Healthcare family (now via isUHCInsurance() — see its
        // v1.65 changelog entry; previously this rule used its own
        // narrower inline regex covering only UMR/Oxford, kept separate
        // by design, but isUHCInsurance() is now a strict superset of
        // that regex so reusing it here only adds coverage, never removes
        // any); or one of the high-level codes above being present.
        // Analyze/Apply decides this, not the toggle itself — flipping the
        // toggle just changes what the next Analyze run will propose. ----
        const isUHCFamilyForWeekend = isUHCInsurance(insurance);
        // v2.33: NYCE PPO can't get 99051 either (same as the UHC family).
        const isNyceForWeekend = isNycePPOIns(insurance);
        let weekendBlockReason = null; // why 99051 can't stay — used as its removal reason
        // v2.34: reasons that don't depend on which codes end up on the claim
        // (insurance, televisit, toggle). Code-based blockers are decided in
        // buildProposal against the FINAL procedure list.
        let weekendHardBlock = null;
        if (isWeekendEnabled()) {
            const isTelevisitForWeekend = rawCPTCodeSet.has('98012') || /televisit/i.test(flags.hpiText);
            const nineCode = rawCPTCodesNow.find(c =>
                /^9/.test(c) && c !== '99000' && c !== '99051' && !OFFICE_VISIT_EM_CODES.includes(c));
            const awvCode = MEDICARE_AWV_CODES.find(c => rawCPTCodeSet.has(c));
            const highCode = HIGH_LEVEL_BLOCKING_CODES.find(c => rawCPTCodeSet.has(c));
            // v2.32: G0447 (Obesity Counseling) CAN have 99051 — not a blocker
            if (isUHCFamilyForWeekend) weekendBlockReason = weekendHardBlock = `${insurance} is a United Healthcare plan — no weekend/holiday code (99051)`;
            else if (isNyceForWeekend) weekendBlockReason = weekendHardBlock = 'NYCE PPO — no weekend/holiday code (99051)';
            else if (isTelevisitForWeekend) weekendBlockReason = weekendHardBlock = 'Televisit — no weekend/holiday code (99051)';
            else if (highCode) weekendBlockReason = `Weekend (99051) can't be billed with ${highCode}`;
            else if (awvCode) weekendBlockReason = `Weekend (99051) can't be billed with ${awvCode}`;
            else if (rawCPTCodeSet.has('99406')) weekendBlockReason = "Weekend (99051) can't be billed with 99406";
            else if (nineCode) weekendBlockReason = `Weekend (99051) can't be billed with ${nineCode}`;
            if (!weekendBlockReason) desired.set('99051', 'Weekend/holiday visit, no blocking code or televisit present');
        } else {
            weekendBlockReason = weekendHardBlock = 'Weekend toggle is off — not a weekend/holiday visit';
        }

        // ---- BMI: CPTs only added when a preventive visit is present.
        // Adults (18+): G8417/G8418/G8420 from raw BMI thresholds.
        // Under 18: BMI-for-age percentile, not raw BMI. Preferred source
        // is a documented "BMI %:" percentile in the note; if that's not
        // there, falls back to an already-present Z68.51-Z68.54 ICD code. ----
        const PEDIATRIC_BMI_Z_TO_GCODE = { 'Z68.51': 'G8418', 'Z68.52': 'G8420', 'Z68.53': 'G8417', 'Z68.54': 'G8417' };
        function pediatricZ68FromPercentile(pct) {
            if (pct == null || isNaN(pct)) return null;
            if (pct < 5) return 'Z68.51';
            if (pct < 85) return 'Z68.52';
            if (pct < 95) return 'Z68.53';
            return 'Z68.54';
        }
        // Computed independently of hasPreventiveVisit — the ICD
        // correction below (delete a wrong Z68.xx) must fire regardless
        // of preventive status, same as the adult flow. Only the CPT
        // G-code add is gated on hasPreventiveVisit.
        let correctZ68Ped = null;
        if (bmi && age != null && age < 18) {
            correctZ68Ped = pediatricZ68FromPercentile(parseFloat(bmiPercentile));
            if (!correctZ68Ped) {
                const pedZ68Row = getICDRows().find(r => PEDIATRIC_BMI_Z_TO_GCODE[r.code.toUpperCase()]);
                if (pedZ68Row) correctZ68Ped = pedZ68Row.code.toUpperCase();
            }
        }
        if (bmi && hasPreventiveVisit && age != null) {
            if (age >= 18) {
                desired.set('3008F', 'BMI documented (preventive visit)');
                const bmiNum = parseFloat(bmi);
                const gCode = bmiNum < 18 ? 'G8418' : (bmiNum < 26 ? 'G8420' : 'G8417');
                desired.set(gCode, `BMI ${bmi} (preventive visit)`);
            } else if (correctZ68Ped) {
                desired.set('3008F', 'BMI documented (preventive visit)');
                desired.set(PEDIATRIC_BMI_Z_TO_GCODE[correctZ68Ped], `Pediatric BMI percentile ${bmiPercentile ? bmiPercentile + '%' : correctZ68Ped} (preventive visit)`);
            }
        }
        // If no preventive visit is present, 3008F/G8417/G8418/G8420 are
        // left out of `desired` entirely — MANAGED_CODES diff below will
        // flag any of them already on the chart for removal.

        // Deletion reasons override for specific MANAGED_CODES that need
        // more than the generic message (populated below, used in the
        // toDelete diff further down).
        const exclusionReasons = new Map();
        if (weekendBlockReason) exclusionReasons.set('99051', weekendBlockReason);

        // ---- BP: needs I10, both values under threshold. Yearly limit —
        // the BP qualifier set as a WHOLE can only be used once per
        // calendar year, not each code independently. The full BP code
        // family is 3074F/3075F/3077F (systolic tiers) and
        // 3078F/3079F/3080F (diastolic tiers); 3077F/3080F (the
        // "over threshold" tier) are never added for Hasan Sheikh, but
        // they still count as "the BP measure was billed" — if either was
        // used earlier this year (e.g. billed elsewhere, or left over from
        // before this rule existed), that still blocks billing any BP
        // qualifier again this year, same as a repeat of 3074F/3075F/
        // 3078F/3079F would. If ANY of the six was already billed earlier
        // this year, the entire addable set (3074F/3075F/3078F/3079F) is
        // excluded for this encounter and deleted from the chart if
        // present, regardless of which specific pair the current reading
        // would otherwise select. ----
        // v2.29: straight Medicare uses G8752 (systolic < 140) and G8754
        // (diastolic < 90) instead of 3074F/3075F/3078F/3079F. The at/over-
        // threshold codes (G8753, G8755 — like 3077F/3080F) are never added
        // and are removed if present. The other payer's set is removed too.
        const medicareBP = isStraightMedicareIns(insurance);
        const BP_ADDABLE_CODES = medicareBP ? ['G8752', 'G8754'] : ['3074F', '3075F', '3078F', '3079F'];
        const BP_ALL_CODES_FOR_YEAR_CHECK = ['3074F', '3075F', '3077F', '3078F', '3079F', '3080F', 'G8752', 'G8753', 'G8754', 'G8755'];
        (medicareBP ? ['3074F', '3075F', '3078F', '3079F'] : ['G8752', 'G8754']).forEach(c => exclusionReasons.set(c,
            medicareBP ? 'Medicare — BP is coded with G8752/G8754, not 3074F-3079F'
                       : 'G8752/G8754 are the Medicare BP codes — this insurance uses 3074F-3079F'));
        ['3077F', '3080F', 'G8753', 'G8755'].forEach(c => exclusionReasons.set(c, 'At/over-threshold BP codes are not used'));
        if (!bp) {
            BP_ADDABLE_CODES.forEach(c => exclusionReasons.set(c, 'No BP documented this encounter'));
        } else {
            const [sys, dia] = bp.split('/').map(n => parseInt(n));
            const hasI10 = getICDRows().some(r => r.code.toUpperCase() === 'I10');
            const sysOk = !isNaN(sys) && sys < 140;
            const diaOk = !isNaN(dia) && dia < 90;
            const bpDosYear = getCurrentDosYear();

            let bpReason = null;
            if (!hasI10) bpReason = 'No I10 (hypertension) on the ICD list';
            else if (!sysOk && !diaOk) bpReason = `Systolic ${sys} and diastolic ${dia} both at/over threshold (140/90)`;
            else if (!sysOk) bpReason = `Systolic ${sys} at/over 140`;
            else if (!diaOk) bpReason = `Diastolic ${dia} at/over 90`;

            if (bpReason) {
                BP_ADDABLE_CODES.forEach(c => exclusionReasons.set(c, bpReason));
            } else {
                const sysCode = medicareBP ? 'G8752' : (sys <= 129 ? '3074F' : '3075F');
                const diaCode = medicareBP ? 'G8754' : (dia <= 79 ? '3078F' : '3079F');
                const usedThisYear = BP_ALL_CODES_FOR_YEAR_CHECK.find(c => codeUsedInYear(c, bpDosYear));

                if (usedThisYear) {
                    const yearReason = `${usedThisYear} already billed earlier this year (once/year limit for the whole BP qualifier set)`;
                    BP_ADDABLE_CODES.forEach(c => exclusionReasons.set(c, yearReason));
                } else {
                    desired.set(sysCode, `Systolic ${sys}`);
                    desired.set(diaCode, `Diastolic ${dia}`);
                }
            }
        }

        // ---- Blood draw / EKG in CC — 36415/99000 no longer auto-added; EKG → 93000 ----
        const ccRaw = text.match(/Chief Complaint\(s\)\s*:?\s*([\s\S]+?)(?=\n\s*\n|\n\s*(?:Subjective|Objective|HPI|History|Assessment|Plan|Review|Physical|Vital|Social|Family|Medical|Surgical)\b|$)/i);
        const ccText = ccRaw ? ccRaw[1] : '';
        // CC entries sometimes render as tracked-change <li> elements
        // (e.g. <li section="Chief Complaint(s):" content="EKG done">)
        // rather than as plain visible text — those don't reliably show up
        // in document.body.innerText, so the regex above alone can miss
        // them. Read those elements directly as a second signal.
        const ccDomItems = document.querySelectorAll('[section="Chief Complaint(s):"]');
        const ccDomText = ccDomItems.length
            ? Array.from(ccDomItems).map(el => el.getAttribute('content') || el.textContent || '').join(' ')
            : '';
        if (/\bekg\b|\becg\b/i.test(ccText) || /\bekg\b|\becg\b/i.test(ccDomText)) {
            desired.set('93000', 'EKG mentioned in CC');
        }

        // ---- Age-based correction-only CPTs ----
        // 1170F/1157F/1158F/1125F(pain)/1126F(no pain): age 65+, never
        // added fresh, only corrected/deleted. No televisit rule here —
        // 1157F and 1158F are each just kept if present and age-eligible,
        // with no swap between them (that's a separate E&M rule elsewhere).
        const icdRows = getICDRows();
        const hasPainOrM = icdRows.some(r => isPainRelatedICDEntry(r.code, r.name));

        if (age >= 65) {
            ['1157F', '1158F', '1170F'].forEach(c => {
                if (rawCPTCodeSet.has(c)) desired.set(c, `Age ${age} — retained`);
            });
            const has1125or1126 = rawCPTCodeSet.has('1125F') || rawCPTCodeSet.has('1126F');
            if (has1125or1126) {
                const correctPain = hasPainOrM ? '1125F' : '1126F';
                const wrongPain = correctPain === '1125F' ? '1126F' : '1125F';
                desired.set(correctPain, `Pain-code correction based on ICD grid (age ${age})`);
                if (rawCPTCodeSet.has(wrongPain)) {
                    exclusionReasons.set(wrongPain, `Wrong pain-status code — should be ${correctPain} (${hasPainOrM ? 'pain ICD present' : 'no pain ICD'})`);
                }
            }
        } else {
            const reason = `Patient age ${age} — under 65, code not applicable`;
            ['1170F', '1157F', '1158F', '1125F', '1126F'].forEach(c => exclusionReasons.set(c, reason));
        }

        // 1159F/1160F: age 66+, no insurance-based rule. Never added fresh
        // by us; if one or both are already present on the chart, they're
        // left alone (no swap, no deletion) — only deleted outright if the
        // patient is under 66.
        if (age >= 66) {
            if (rawCPTCodeSet.has('1159F')) desired.set('1159F', `Age ${age} — retained`);
            if (rawCPTCodeSet.has('1160F')) desired.set('1160F', `Age ${age} — retained`);
        } else {
            const reason = `Patient age ${age} — under 66, code not applicable`;
            exclusionReasons.set('1159F', reason);
            exclusionReasons.set('1160F', reason);
        }

        // ---- Screenings: alcohol 18+, depression 12+ ----
        if (age >= 12) {
            if (hasDep === true) desired.set('G8510', 'Depression screening negative');
            else if (hasDep === false) desired.set('G8431', 'Depression screening positive');
        }

        if (age >= 18) {
            if (hasAlc === true) desired.set('G9622', 'Alcohol screening negative');
            else if (hasAlc === false) desired.set('3016F', 'Alcohol screening positive');
        }

        // Tobacco/smoking screening result codes share 99406's 18+ age
        // requirement — same pattern as the depression (12+) and alcohol
        // (18+) screening result codes above. Both are in MANAGED_CODES,
        // so wrapping the add in this age check also makes an
        // already-present one auto-delete for a now-too-young patient.
        if (age >= 18) {
            if (hasTob === true) {
                desired.set(isHealthfirst ? '1036F' : 'G9275', 'Tobacco screening negative');
            } else if (hasTob === false) {
                desired.set(isHealthfirst ? '1000F' : 'G9276', 'Tobacco screening positive');
            }
        }

        // G0136 (social needs screening) can only be used once every 6
        // months — skip it if already billed within the last 180 days.
        // G0136: only when a social needs / Social Determinants screening is
        // documented AND none was billed in the previous 6 calendar months.
        // While history is still loading nothing is proposed (the 6-month
        // check can't be answered yet); an existing G0136 is left alone
        // until it can.
        {
            const histApiG = window.__ecwPatientHistory;
            const historyLoadingG = !!(histApiG && histApiG.isLoading && histApiG.isLoading());
            if (!hasSocialNeeds) {
                exclusionReasons.set('G0136', 'No social needs / Social Determinants screening documented this visit');
            } else if (historyLoadingG) {
                if (rawCPTCodeSet.has('G0136')) desired.set('G0136', 'Kept while patient history loads');
            } else {
                const g0136Use = findG0136UseWithinSixMonths();
                if (g0136Use) exclusionReasons.set('G0136', `G0136 already billed ${g0136Use.date} — only once every 6 months`);
                else desired.set('G0136', 'Social needs screening documented, not billed in the last 6 months');
            }
        }

        // A1c control-CPT logic removed.

        // ---- Cancer screening CPTs from the screening Z code on the chart ----
        //   Z12.11 (colon)  -> 3017F
        //   Z12.4  (cervix) -> 3015F
        //   Z12.31 (breast) -> 3014F
        // Add-only: still not in MANAGED_CODES, so an existing 3014F/3015F/
        // 3017F is never deleted, even if its Z code isn't on the chart.
        {
            const icdNowForScreening = new Set(getICDRows().map(r => r.code.toUpperCase()));
            [
                ['Z12.11', '3017F', 'Colorectal cancer screening (Z12.11) on the chart'],
                ['Z12.4', '3015F', 'Cervical cancer screening (Z12.4) on the chart'],
                ['Z12.31', '3014F', 'Breast cancer screening (Z12.31) on the chart']
            ].forEach(([icd, cpt, why]) => {
                if (icdNowForScreening.has(icd)) desired.set(cpt, why);
            });
        }

        // ---- Annual screening G-codes: G0444 (depression), G0442 (alcohol) ----
        // Only when a preventive visit is present on this chart.
        // Still skipped for Medicaid/Medicare/UHC and gated to once/year.
        // Rule 19 age gates apply here too.
        if (hasPreventiveVisit && annualGCodesEligible(insurance)) {
            const dosYear = getCurrentDosYear();
            if (age >= 12 && hasDep !== null && !codeUsedInYear('G0444', dosYear)) {
                desired.set('G0444', 'Annual depression screening (once/year, preventive visit)');
            }
            // v1.1: G0442 only for a POSITIVE alcohol screen (hasAlc === false).
            if (age >= 18 && hasAlc === false && !codeUsedInYear('G0442', dosYear)) {
                desired.set('G0442', 'Annual alcohol screening — positive screen (once/year, preventive visit)');
            }
        }

        // ---- Diff against current chart ----
        const currentRows = getCPTRows().map(r => ({
            row: r,
            code: (r.querySelector('td:nth-child(2)')?.textContent.trim() || '').toUpperCase()
        })).filter(r => r.code);
        const currentCodes = new Set(currentRows.map(r => r.code));

        // United Health Care: no G-prefixed CPT codes at all, for any
        // reason — EXCEPT G0101/G0102/G0103, which UHC does use and which
        // must never be swept up by this rule.
        const isUHC = isUHCInsurance(insurance);
        const UHC_GCODE_EXCEPTIONS = new Set(['G0101', 'G0102', 'G0103']);
        if (isUHC) {
            Array.from(desired.keys()).forEach(code => {
                if (/^G\d/i.test(code) && !UHC_GCODE_EXCEPTIONS.has(code)) desired.delete(code);
            });
        }

        const toAdd = [];
        desired.forEach((reason, code) => {
            if (!currentCodes.has(code)) toAdd.push({ code, reason, kind: 'cpt' });
        });

        // ---- Screening ICDs: whenever depression or alcohol screening is
        // documented — positive OR negative, doesn't matter — propose the
        // corresponding screening ICD. These go through the same
        // Proposed-changes / Start-Action flow as everything else, not
        // added automatically.
        //
        // Z13.31/Z13.9 and their screening CPT are billed as a bundle —
        // the ICD is only proposed/kept when the matching CPT is actually
        // billable for this payer. "Matching CPT" means either already on
        // the chart OR about to be added this run (`desired`, post any
        // payer-specific filtering above — e.g. United Health Care's "no
        // G-prefixed CPT" sweep). For UHC, that sweep wipes G8510/G8431/
        // G0444/G0442/G9622, so when the actual screening result is the
        // G-coded one (e.g. a negative alcohol screen → G9622), NO CPT in
        // the bundle survives — Z13.31/Z13.9 are correctly never
        // suggested/kept for UHC in that case either, same as the G-code
        // itself. ICD and CPT move together, never one without the other.
        const DEPRESSION_SCREENING_CPTS = ['G8510', 'G8431', 'G0444', '3725F'];
        const ALCOHOL_SCREENING_CPTS = ['G9622', '3016F', 'G0442', 'H0049', '99408'];
        const hasDepressionScreeningCpt = DEPRESSION_SCREENING_CPTS.some(c => currentCodes.has(c) || desired.has(c));
        const hasAlcoholScreeningCpt = ALCOHOL_SCREENING_CPTS.some(c => currentCodes.has(c) || desired.has(c));
        const currentICDCodesForScreening = getICDGridEntriesFast().map(e => e.code.toUpperCase());
        if (age >= 12 && hasDep !== null && hasDepressionScreeningCpt && !currentICDCodesForScreening.includes('Z13.31')) {
            toAdd.push({ code: 'Z13.31', reason: 'Depression screening documented', kind: 'icd' });
        }
        if (age >= 18 && hasAlc !== null && hasAlcoholScreeningCpt && !currentICDCodesForScreening.includes('Z13.9')) {
            toAdd.push({ code: 'Z13.9', reason: 'Alcohol screening documented', kind: 'icd' });
        }

        const toDelete = [...gatedBundleCPTDeletes];

        // ---- Depression/alcohol screening ICD cleanup: Z13.31 or Z13.9
        // (or Z13.89) on the chart with no matching screening CPT means
        // the screening was never actually billed — someone added the
        // diagnosis code (or it carried over from a prior visit) but no
        // screening was documented/ordered this time, or (as above) the
        // only matching CPT is a G-code this payer never bills. Delete
        // the ICD in that case rather than leaving an orphaned screening
        // diagnosis sitting on the claim with nothing to justify it. Uses
        // the SAME hasDepressionScreeningCpt/hasAlcoholScreeningCpt as
        // the add rule above, so add and delete can never disagree.
        getICDGridEntriesFast().forEach(entry => {
            const code = entry.code.toUpperCase();
            if (code === 'Z13.6' && !toDelete.some(d => d.code === entry.code)) {
                toDelete.push({ code: entry.code, row: entry.row, kind: 'icd', reason: 'Z13.6 is no longer used for EKG (93000) linking or any other purpose — always deleted if present' });
            }
            if (code === 'Z13.31' && !hasDepressionScreeningCpt && !toDelete.some(d => d.code === entry.code)) {
                toDelete.push({ code: entry.code, row: entry.row, kind: 'icd', reason: 'Depression screening ICD present but no depression screening CPT on chart' });
            }
            if (code === 'Z13.89' && !toDelete.some(d => d.code === entry.code)) {
                // Z13.89 and Z13.9 are the same alcohol-screening ICD for
                // this practice's purposes — we standardize on Z13.9 only.
                // If alcohol screening applies, Z13.89 is replaced with
                // Z13.9 (the add rule above already adds Z13.9 whenever
                // hasAlcoholScreeningCpt is true and it's not already on
                // the chart). If alcohol screening does NOT apply, Z13.89
                // is deleted outright with no replacement, same as Z13.9
                // would be in that case.
                toDelete.push({
                    code: entry.code, row: entry.row, kind: 'icd',
                    reason: hasAlcoholScreeningCpt
                        ? 'Z13.89 replaced with Z13.9 — same alcohol screening ICD, this practice standardizes on Z13.9'
                        : 'Alcohol screening ICD present but no alcohol screening CPT on chart'
                });
            } else if (code === 'Z13.9' && !hasAlcoholScreeningCpt && !toDelete.some(d => d.code === entry.code)) {
                toDelete.push({ code: entry.code, row: entry.row, kind: 'icd', reason: 'Alcohol screening ICD present but no alcohol screening CPT on chart' });
            }
        });

        currentRows.forEach(r => {
            if (MANAGED_CODES.has(r.code) && !desired.has(r.code) && !toDelete.some(d => d.code === r.code)) {
                const reason = exclusionReasons.get(r.code) || 'Not applicable / wrong value for current chart';
                toDelete.push({ code: r.code, row: r.row, kind: 'cpt', reason });
            }
        });

        // United Health Care: also remove any G-code already on the chart,
        // even ones normally exempt from deletion elsewhere (e.g. G0444/
        // G0442) — this payer doesn't use G-codes at all, EXCEPT
        // G0101/G0102/G0103 (UHC_GCODE_EXCEPTIONS above), which stay.
        if (isUHC) {
            currentRows.forEach(r => {
                if (/^G\d/i.test(r.code) && !UHC_GCODE_EXCEPTIONS.has(r.code) && !toDelete.some(d => d.code === r.code)) {
                    toDelete.push({ code: r.code, row: r.row, kind: 'cpt', reason: 'United Health Care — G-codes not used for this payer' });
                }
            });
        }

        // High-level codes (Pap smear Q0091/G0101, Advance Care 99497, TCM/
        // Post-Hospitalization 99495/99496): no counseling code may coexist
        // with these. If any is present, any existing counseling code
        // (99401 Preventive Counseling, 99406 Smoking, G0447 Obesity) gets
        // proposed for deletion here. Preventive itself is unaffected —
        // this list intentionally excludes the preventive E&M/AWV codes.
        const triggeringHighLevelCode = HIGH_LEVEL_BLOCKING_CODES.find(c => rawCPTCodesNow.includes(c));
        if (triggeringHighLevelCode) {
            ['99401', '99406', 'G0447'].forEach(code => {
                if (rawCPTCodesNow.includes(code) && !toDelete.some(d => d.code === code)) {
                    const row = getCPTRowByCode(code);
                    if (row) toDelete.push({ code, row, kind: 'cpt', reason: `${triggeringHighLevelCode} present — counseling codes can't coexist with it` });
                }
            });
        }

        // ---- Preventive bundle ICDs (Z00.01/Z00.121): delete if Preventive
        // isn't on the chart. These two are the age-split "well visit"
        // diagnosis codes that only belong alongside a Preventive E&M/AWV
        // code (993xx or G0438/G0439) — same pairing the quick-action
        // buttons already enforce via clearOtherQuickActionBundles(), now
        // also enforced here so it's caught by the regular Analyze/Start
        // Action flow, not just when a quick-action button is clicked. ----
        if (!hasPreventiveVisit) {
            const preventiveBundleEntries = getICDRows().filter(e =>
                e.code.toUpperCase() === 'Z00.01' || e.code.toUpperCase() === 'Z00.121');
            preventiveBundleEntries.forEach(e => {
                toDelete.push({ code: e.code, row: e.row, kind: 'icd', reason: 'Preventive visit not present this encounter — preventive bundle ICD not applicable' });
            });
        }

        // ---- BMI Z68.xx ICD code: add if missing, fix if wrong, delete if
        // no longer needed ----
        // The correct Z68.xx code is added if it's not already on the ICD
        // list, and any OTHER Z68.xx code (wrong value, including an
        // adult-format code like Z68.28 wrongly used on a pediatric
        // chart) gets proposed for removal — same Analyze/Start Action
        // flow as everything else, not just the quick-action buttons.
        // BMI is only "needed" for this encounter if either a Preventive
        // visit is present OR Obesity Counseling (G0447) is on the chart
        // (Obesity's own gating already depends on BMI, per
        // computeQuickActionGating's BMI<30 fade rule) — if neither
        // applies, any existing Z68.xx is proposed for deletion instead of
        // being corrected/kept.
        const bmiNum = parseFloat(bmi) || null;
        const correctZ68 = age >= 18 ? mapBMIToZ68(bmiNum, age) : correctZ68Ped;
        const hasObesityCPTForBMI = rawCPTCodesNow.includes('G0447') && !gating.ob.disabled;
        const bmiZ68StillNeeded = hasPreventiveVisit || hasObesityCPTForBMI;
        const currentZ68Entries = getICDRows().filter(e => /^Z68\./i.test(e.code));
        if (!bmiZ68StillNeeded) {
            currentZ68Entries.forEach(e => {
                toDelete.push({ code: e.code, row: e.row, kind: 'icd', reason: 'Preventive visit not present and Obesity not billed — BMI code not needed' });
            });
        } else if (correctZ68) {
            const hasCorrectZ68 = currentZ68Entries.some(e => e.code.toUpperCase() === correctZ68.toUpperCase());
            // Rule 1: no Z68.xx present at all → don't add it, unless a
            // preventive visit is being applied this encounter. A WRONG
            // Z68.xx already present always gets corrected either way.
            if (!hasCorrectZ68 && (currentZ68Entries.length > 0 || hasPreventiveVisit)) {
                toAdd.push({ code: correctZ68, reason: `BMI ${age >= 18 ? bmiNum : (bmiPercentile ? bmiPercentile + '%' : correctZ68)} — correct Z68.xx code`, kind: 'icd' });
            }
            currentZ68Entries.forEach(e => {
                if (e.code.toUpperCase() !== correctZ68.toUpperCase()) {
                    toDelete.push({ code: e.code, row: e.row, kind: 'icd', reason: `Wrong BMI code (should be ${correctZ68})` });
                }
            });
        }

        // ---- Obesity ICD (E66.9/E66.01/E66.09): correction-only, by BMI ----
        // Never added from nothing here (the Obesity Counseling quick
        // action handles that) — but if one is already on the chart
        // (added by a provider, a prior visit, etc.), it gets corrected
        // or removed to match the current BMI. Adult BMI scale only.
        if (age >= 18 && bmi) {
            const OBESITY_ICD_CODES = ['E66.9', 'E66.01', 'E66.09'];
            const currentObesityEntries = getICDRows().filter(e => OBESITY_ICD_CODES.includes(e.code.toUpperCase()));
            if (currentObesityEntries.length) {
                const bmiNumObesity = parseFloat(bmi);
                let correctObesityCode = null;
                if (bmiNumObesity >= 30 && bmiNumObesity < 40) correctObesityCode = 'E66.9';
                else if (bmiNumObesity >= 40 && bmiNumObesity < 50) correctObesityCode = 'E66.01';
                else if (bmiNumObesity >= 50) correctObesityCode = 'E66.09';

                if (correctObesityCode) {
                    const hasCorrectObesity = currentObesityEntries.some(e => e.code.toUpperCase() === correctObesityCode);
                    if (!hasCorrectObesity) {
                        // E66.09 is a sensitive diagnosis: proposed UNTICKED so
                        // it's only added if the coder deliberately ticks it.
                        toAdd.push(correctObesityCode === 'E66.09'
                            ? { code: correctObesityCode, reason: `BMI ${bmiNumObesity} — severe obesity is a sensitive diagnosis, tick only if the provider documented it`, kind: 'icd', needsReview: true }
                            : { code: correctObesityCode, reason: `BMI ${bmiNumObesity} — correct obesity code`, kind: 'icd' });
                    }
                    currentObesityEntries.forEach(e => {
                        if (e.code.toUpperCase() !== correctObesityCode) {
                            toDelete.push({ code: e.code, row: e.row, kind: 'icd', reason: `Wrong obesity code for BMI ${bmiNumObesity} (should be ${correctObesityCode})` });
                        }
                    });
                } else {
                    // BMI under 30 — none of the obesity codes apply.
                    currentObesityEntries.forEach(e => {
                        toDelete.push({ code: e.code, row: e.row, kind: 'icd', reason: `BMI ${bmiNumObesity} — under 30, obesity code not applicable` });
                    });
                }
            }
        }

        // ---- Preventive/P-C counseling bundle (Z71.3, Z71.82/89): keep only
        // if Preventive OR Preventive Counseling (99401) is on the chart;
        // delete the whole bundle if NEITHER is present ----
        // These three ICDs are shared between the Preventive (PV) and
        // Preventive Counseling (P/C) bundles (see the quick-action
        // clearOtherQuickActionBundles() comment above) — they only belong
        // on the chart when one of those two is actually being billed.
        const has99401ForZ71 = rawCPTCodesNow.includes('99401') && !gating.pc.disabled;
        const z71BundleNeeded = hasPreventiveVisit || has99401ForZ71;
        if (!z71BundleNeeded) {
            const z71BundleEntries = getICDRows().filter(e =>
                ['Z71.3', 'Z71.82', 'Z71.89'].includes(e.code.toUpperCase()));
            z71BundleEntries.forEach(e => {
                toDelete.push({ code: e.code, row: e.row, kind: 'icd', reason: 'Neither Preventive nor Preventive Counseling present — counseling bundle ICD not applicable' });
            });
        } else {
            // ---- Z71.82 vs Z71.89 (exercise vs other counseling): fix if wrong ----
            // Only corrects this when one of the two is ALREADY on the chart
            // (added earlier by Preventive/Preventive Counsel) — this doesn't
            // introduce the code to charts that never had it, it just keeps an
            // existing one in sync as the ICD list changes (e.g. asthma gets
            // added later and Z71.82 should become Z71.89).
            const z71Entries = getICDRows().filter(e => e.code.toUpperCase() === 'Z71.82' || e.code.toUpperCase() === 'Z71.89');
            if (z71Entries.length) {
                const ccTextForZ71 = getChiefComplaintTextFast(text);
                const correctZ71 = determineZ71CodeFast(age, gender, ccTextForZ71, getICDRows());
                const hasCorrectZ71 = z71Entries.some(e => e.code.toUpperCase() === correctZ71.toUpperCase());
                if (!hasCorrectZ71) {
                    toAdd.push({ code: correctZ71, reason: 'Z71.82/89 correction based on current CC/ICD/age/gender criteria', kind: 'icd' });
                }
                z71Entries.forEach(e => {
                    if (e.code.toUpperCase() !== correctZ71.toUpperCase()) {
                        toDelete.push({ code: e.code, row: e.row, kind: 'icd', reason: `Wrong counseling code (should be ${correctZ71})` });
                    }
                });
            }
        }

        // ---- Office Visit E&M code ----
        // Only NP (new, always 99203) and ESTP (established, sub-rules
        // below) exist for this provider. Suggested code goes to the TOP
        // of Proposed Changes; any other office-visit code on the chart
        // gets flagged for removal if it doesn't match.

        // isTelevisitNote is computed earlier in this function (see above,
        // right before hasPreventiveVisit) so it can also gate the
        // Preventive/Preventive-Counseling bundle cleanup. Used for rule
        // 6.v below (televisit ESTPT visits always use 99213). No longer
        // used for 1157F/1158F — those have no televisit rule.

        // ---- v2.30: commercial insurance (Aetna, UHC, 1199, Cigna, Empire,
        // Anthem, BCBS, NYCE PPO) — no office-visit E/M code alongside a
        // Preventive visit (993xx or G0438/G0439): remove any on the chart,
        // don't suggest one. (Was NYCE PPO only.)
        let officeVisitNote = null; // shown in the Coding tab when no office-visit code is suggested
        const isNycePPOForOV = isCommercialInsurance(insurance); // name kept for the branch below
        if (isNycePPOForOV && hasPreventiveVisit) {
            officeVisitNote = `No office-visit code: ${insurance} is commercial insurance and a preventive visit code is on the chart.`;
            currentRows.forEach(r => {
                if (OFFICE_VISIT_EM_CODES.includes(r.code) && !toDelete.some(d => d.code === r.code)) {
                    toDelete.push({ code: r.code, row: r.row, kind: 'cpt', reason: 'Commercial insurance — office-visit E/M code not billed with a Preventive visit' });
                }
            });
            for (let i = toAdd.length - 1; i >= 0; i--) {
                if (OFFICE_VISIT_EM_CODES.includes(toAdd[i].code)) toAdd.splice(i, 1);
            }
        }

        // Hasan Sheikh only: if a TCM code (99495/99496) is on the chart,
        // NO office-visit E&M code is billed alongside it at all — not
        // even a downgraded one. (Every other client instead downgrades
        // 99214 -> 99213 when both are applicable; Bronx/Getwell allow
        // 99214 and TCM together with no change. See the shared
        // 99401/99406-vs-99214 rule right after this block for those.)
        let computedOvCodeForBilling = null;
        // (officeVisitNote is declared above, before the commercial-insurance block)
        const hasTCMOnChartForOV = rawCPTCodesNow.includes('99495') || rawCPTCodesNow.includes('99496');
        const visitType = getVisitType();
        let visitCategory = classifyVisitType(visitType);
        let visitTypeLabel = visitType;
        if (!visitCategory) {
            // Visit type missing or not NP/ESTPT: decide from history instead —
            // any earlier visit means established. Wait while history is still
            // loading so a real established patient is never billed as new.
            const histApi = window.__ecwPatientHistory;
            const histData = histApi && histApi.getData ? histApi.getData() : null;
            if (histApi && histApi.isLoading && histApi.isLoading()) {
                officeVisitNote = 'Office visit code: waiting for patient history to finish loading to tell new from established.';
            } else if (!histData) {
                officeVisitNote = `Office visit code not suggested: visit type ${visitType ? `"${visitType}" isn't NP or ESTPT` : "isn't on this page"} and patient history isn't loaded. Add it manually or open the chart from the dashboard.`;
            } else {
                visitCategory = isEstablishedPatient() ? 'established' : 'new';
                visitTypeLabel = `${visitType ? visitType + ', ' : ''}${visitCategory === 'new' ? 'no earlier visits' : 'earlier visits found'}`;
            }
        }
        // v2.19: a TCM code (99495/99496) CAN have an office visit, capped at
        // 99213 — 99214 is never billed with TCM (applied below).
        if (hasTCMOnChartForOV && !visitCategory && rawCPTCodeSet.has('99214')) {
            // Office visit type couldn't be decided, but 99214 sits next to TCM:
            // swap it for 99213 (an established visit, since TCM follows a stay).
            const row99214 = currentRows.find(r => r.code === '99214');
            if (row99214 && !toDelete.some(d => d.code === '99214')) {
                toDelete.unshift({ code: '99214', row: row99214.row, kind: 'cpt', reason: 'TCM (99495/99496) on the chart — office visit capped at 99213' });
            }
            if (!rawCPTCodeSet.has('99213')) {
                toAdd.unshift({ code: '99213', reason: 'TCM (99495/99496) on the chart — office visit capped at 99213', kind: 'em', emCategory: 'E/M SERVICES', emIsNewPatient: false });
            }
            computedOvCodeForBilling = '99213';
        } else if (visitCategory && !(isNycePPOForOV && hasPreventiveVisit)) {
            let ovCode;
            let ovIsNewPatient = false;
            let ovReason;

            if (visitCategory === 'new') {
                ovCode = '99203';
                ovIsNewPatient = true;
                ovReason = `New patient (${visitTypeLabel}) — 99203`;
            } else {
                // established patient — evaluate in priority order
                if (rawCPTCodeSet.has('99211')) {
                    // rule 6.i: 99211 is never used — force-correct to 99212
                    ovCode = '99212';
                    ovReason = '99211 is never used for this provider — corrected to 99212';
                } else if (isTelevisitNote) {
                    // rule 6.v: televisit (98012 present) always uses 99213
                    ovCode = '99213';
                    ovReason = 'Televisit (98012 present) — 99213';
                } else if (!isVitalsDocumented(text)) {
                    // rule 6.ii
                    ovCode = '99212';
                    ovReason = 'No vitals documented — 99212';
                } else {
                    const qualifying = getICDRows().filter(e => {
                        const c = e.code.toUpperCase();
                        if (/^F17/.test(c)) return false;
                        if (/^E5[3-6]/.test(c)) return false;
                        if (/^D51/.test(c)) return false;
                        if (/^E66/.test(c)) return false;
                        if (/^Z/.test(c)) return false;
                        return true;
                    });
                    const chronicCount = qualifying.filter(e => CHRONIC_DISEASE_ICD_CODES.has(e.code.toUpperCase())).length;
                    // rule 6.iii: eligible for 99214 via either path below,
                    // AND not used within the last 30 days —
                    // Normal path: 4+ qualifying dx, >=1 chronic.
                    // 3-chronic path: exactly 3 qualifying dx, all 3 chronic
                    // — fewer total codes, but all chronic is complex
                    // enough on its own (same as Getwell's rule).
                    const normalPathEligible = qualifying.length >= 4 && chronicCount >= 1;
                    const threeChronicPathEligible = qualifying.length === 3 && chronicCount === 3;
                    if ((normalPathEligible || threeChronicPathEligible) && !codeUsedInLastDays('99214', 30)) {
                        ovCode = '99214';
                        ovReason = normalPathEligible
                            ? `4+ dx with ${chronicCount} chronic — 99214 (not used in last 30 days)`
                            : `3 dx, all chronic — 99214 (not used in last 30 days)`;
                    } else {
                        ovCode = '99213'; // rule 6.iv: default
                        ovReason = 'Established visit — 99213 (default)';
                    }
                }
            }

            if (hasTCMOnChartForOV && ovCode === '99214') {
                ovCode = '99213';
                ovReason = 'TCM (99495/99496) on the chart — office visit capped at 99213 (99214 is not billed with TCM)';
            }

            if (ovCode) {
                if (!currentCodes.has(ovCode)) {
                    toAdd.unshift({
                        code: ovCode,
                        reason: ovReason,
                        kind: 'em',
                        emCategory: 'E/M SERVICES',
                        emIsNewPatient: ovIsNewPatient
                    });
                }
                currentRows.forEach(r => {
                    if (OFFICE_VISIT_EM_CODES.includes(r.code) && r.code !== ovCode) {
                        toDelete.unshift({ code: r.code, row: r.row, kind: 'cpt', reason: `Wrong office-visit code for this visit type (should be ${ovCode})` });
                    }
                });
            }
            computedOvCodeForBilling = ovCode || null;
        }

        // ---- Billing-exclusivity rule: 99401/99406 vs 99214 ----
        // Never billed together with 99214 — if both are applicable,
        // 99214 wins and 99401/99406 is removed. Applies to every client
        // (moot here whenever the TCM branch above already cleared the
        // office-visit code entirely, since computedOvCodeForBilling
        // stays null in that case).
        // v2.09: also applies when 99214 is already on the chart and no
        // other office-visit code was decided this run (visit type unknown,
        // history not loaded, etc.) — 99214 staying on the claim is what
        // matters, not which branch picked it.
        const officeVisitWillBe99214 = computedOvCodeForBilling === '99214' ||
            (computedOvCodeForBilling == null && !hasTCMOnChartForOV && rawCPTCodeSet.has('99214'));
        if (officeVisitWillBe99214) {
            ['99401', '99406'].forEach(code => {
                const row = currentRows.find(r => r.code === code);
                if (row && !toDelete.some(d => d.code === code)) {
                    toDelete.push({ code, row: row.row, kind: 'cpt', reason: '99214 applies this encounter — 99401/99406 is not billed together with 99214' });
                }
                for (let i = toAdd.length - 1; i >= 0; i--) {
                    if (toAdd[i].code === code) toAdd.splice(i, 1);
                }
            });
        }

        // ---- L21.0 vs L21.9 (seborrheic dermatitis): correction-only ----
        // <18 → L21.0 | >=18 → L21.9. Only corrects when ONE of the two is
        // ALREADY on the chart — never introduces either fresh if neither
        // is present.
        const l21Entries = getICDRows().filter(e => e.code.toUpperCase() === 'L21.0' || e.code.toUpperCase() === 'L21.9');
        if (l21Entries.length) {
            const correctL21 = (age != null && age < 18) ? 'L21.0' : 'L21.9';
            const hasCorrectL21 = l21Entries.some(e => e.code.toUpperCase() === correctL21);
            if (!hasCorrectL21) {
                toAdd.push({ code: correctL21, reason: `L21.0/L21.9 correction based on age (${age})`, kind: 'icd' });
            }
            l21Entries.forEach(e => {
                if (e.code.toUpperCase() !== correctL21) {
                    toDelete.push({ code: e.code, row: e.row, kind: 'icd', reason: `Wrong age-based L21 code (should be ${correctL21})` });
                }
            });
        }

        // (v1.4: the old "CPT starting with 8 → remove it and add Z13.88" rule
        // is gone — 8-series codes such as labs stay on the chart.)

        // ---- 99173 (visual acuity) ----
        // Preventive visit + no eye ICD -> delete 99173. Not preventive +
        // 99173 present + no eye ICD -> add H53.8.
        {
            const has99173Now = currentCodes.has('99173');
            if (has99173Now) {
                const hasEyeICDNow = getICDRows().some(r => isEyeICD(r.code));
                if (hasPreventiveVisit && !hasEyeICDNow) {
                    const row99173 = currentRows.find(r => r.code === '99173');
                    if (row99173 && !toDelete.some(d => d.code === '99173')) {
                        toDelete.push({ code: '99173', row: row99173.row, kind: 'cpt', reason: 'Preventive visit with no eye-related ICD — 99173 not applicable' });
                    }
                } else if (!hasPreventiveVisit && !hasEyeICDNow) {
                    const currentICDCodesFor99173 = getICDRows().map(e => e.code.toUpperCase());
                    if (!currentICDCodesFor99173.includes('H53.8')) {
                        toAdd.push({ code: 'H53.8', reason: '99173 present, no eye ICD — added', kind: 'icd' });
                    }
                }
            }
        }

        // ---- Age cleanup for G0442/G0444 ----
        // These two are deliberately excluded from MANAGED_CODES (so a
        // legitimately-billed prior one isn't stripped by an incomplete
        // eligibility recheck) — but an under-age one is unambiguously
        // wrong regardless of who/what added it, so it's still removed.
        if (age != null && age < 18) {
            const g0442Row = currentRows.find(r => r.code === 'G0442');
            if (g0442Row && !toDelete.some(d => d.code === 'G0442')) {
                toDelete.push({ code: 'G0442', row: g0442Row.row, kind: 'cpt', reason: `Patient age ${age} — under 18, alcohol screening G-code not applicable` });
            }
        }
        if (age != null && age < 12) {
            const g0444Row = currentRows.find(r => r.code === 'G0444');
            if (g0444Row && !toDelete.some(d => d.code === 'G0444')) {
                toDelete.push({ code: 'G0444', row: g0444Row.row, kind: 'cpt', reason: `Patient age ${age} — under 12, depression screening G-code not applicable` });
            }
        }

        // Medicaid/Medicare never use G0444/G0442 at all — same reasoning
        // as the age cleanup above (deliberately excluded from
        // MANAGED_CODES, so this is the only path that removes either one
        // if it's already on the chart, e.g. left from a prior insurance).
        if (isMedicaidOrMedicareIns(insurance)) {
            ['G0444', 'G0442'].forEach(code => {
                if (rawCPTCodesNow.includes(code) && !toDelete.some(d => d.code === code)) {
                    const row = getCPTRowByCode(code);
                    if (row) toDelete.push({ code, row, kind: 'cpt', reason: 'Medicaid/Medicare — G0444/G0442 not used for this payer' });
                }
            });
        }

        // ---- v1.1: G0442 only with a positive alcohol screen ----
        // A negative screen (G9622) never gets G0442 — remove one already on
        // the chart. Not documented (null) is left alone.
        if (hasAlc === true) {
            const g0442RowNeg = currentRows.find(r => r.code === 'G0442');
            if (g0442RowNeg && !toDelete.some(d => d.code === 'G0442')) {
                toDelete.push({ code: 'G0442', row: g0442RowNeg.row, kind: 'cpt', reason: 'Alcohol screening negative — G0442 is only billed for a positive screen' });
            }
        }

        // ---- G0444/G0442: already billed this calendar year -> delete ----
        // Mirrors the add rule above (only added when NOT already billed
        // this year, per codeUsedInYear). If one is already on THIS chart
        // but a PRIOR encounter this same calendar year already billed it,
        // it can't be billed again — deleted outright regardless of
        // whether a preventive visit is present this encounter. Excluded
        // from MANAGED_CODES on purpose (see the age-cleanup comment
        // above), so this is the only path that catches this specific
        // case.
        {
            const dosYearForAnnualGCodes = getCurrentDosYear();
            ['G0444', 'G0442'].forEach(code => {
                if (rawCPTCodesNow.includes(code) && !toDelete.some(d => d.code === code) &&
                    codeUsedInYear(code, dosYearForAnnualGCodes)) {
                    const row = getCPTRowByCode(code);
                    if (row) toDelete.push({ code, row, kind: 'cpt', reason: `${code} already billed this calendar year — can't bill again` });
                }
            });
        }

        // ---- 96686 / 90688 → 90656 replacement (rule 13) ----
        ['96686', '90688'].forEach(oldCode => {
            const row = currentRows.find(r => r.code === oldCode);
            if (row && !toDelete.some(d => d.code === oldCode)) {
                toDelete.push({ code: oldCode, row: row.row, kind: 'cpt', reason: 'Replaced with 90656' });
            }
        });
        if (!currentCodes.has('90656') && currentRows.some(r => r.code === '96686' || r.code === '90688')) {
            toAdd.push({ code: '90656', reason: 'Replaces 96686/90688', kind: 'cpt' });
        }

        // ---- Vaccine administration coding ----
        // Works out 90460/90461 (under 18, component-based), 90471/90472
        // (18+, per-vaccine), and the Medicare-only overrides (G0008 flu,
        // G0009 pneumococcal, G0010 HepB, 90480 COVID — no age limit) from
        // whatever vaccine PRODUCT codes are already on the chart. Uses
        // kind:'vaxadmin' so Start Action will fix the Units field even
        // when the admin code itself is already present.
        {
            const isMedicareForVax = isAnyMedicareIns(insurance) || isVNSChoiceIns(insurance);
            const vaccinePlan = computeVaccineAdminPlan(currentRows, age, isMedicareForVax);
            const plannedCodes = new Set(vaccinePlan.map(p => p.code));

            vaccinePlan.forEach(p => {
                const existingRow = currentRows.find(r => r.code === p.code);
                if (!existingRow) {
                    toAdd.push({ code: p.code, reason: p.reason, kind: 'vaxadmin', units: p.units });
                } else {
                    const currentUnits = getCPTRowUnits(existingRow.row);
                    if (currentUnits !== p.units) {
                        toAdd.push({ code: p.code, reason: `${p.reason} (units ${currentUnits ?? '?'} → ${p.units})`, kind: 'vaxadmin', units: p.units });
                    }
                }
            });

            // Any admin code from the managed universe that's present but
            // not part of the current plan is stale — remove it. BUT only
            // when at least one vaccine PRODUCT code is actually on the
            // chart (vaccinePlan is non-empty) — if there's no product
            // code at all, that doesn't necessarily mean no vaccine was
            // given: the patient may have brought their own vaccine and
            // the doctor only pushed the administration code, with no
            // product code ever entered. In that case there's nothing to
            // compare the admin code against, so it's left alone rather
            // than deleted.
            if (vaccinePlan.length) {
                currentRows.forEach(r => {
                    if (VACCINE_ADMIN_CODE_UNIVERSE.includes(r.code) && !plannedCodes.has(r.code) && !toDelete.some(d => d.code === r.code)) {
                        toDelete.push({ code: r.code, row: r.row, kind: 'cpt', reason: 'Vaccine admin code not applicable for the vaccines currently on this chart' });
                    }
                });
            }
        }

        // ---- v2.22: exactly one general-exam Z00 code, right for the age ----
        //   18+ : Z00.01 (with abnormal findings) / Z00.00 (without)
        //   <18 : Z00.121 (with abnormal findings) / Z00.129 (without)
        // Both of a pair on the chart -> keep the "with abnormal findings" one
        // (what PV adds). Wrong age group -> swap for the same kind in the
        // right group. A single, age-correct code is left alone. (The bundle check below still
        // removes all of them when there's no preventive visit.)
        {
            const EXAM = { 'Z00.00': ['adult', 'without'], 'Z00.01': ['adult', 'with'],
                           'Z00.129': ['child', 'without'], 'Z00.121': ['child', 'with'] };
            const CODE_FOR = { adult: { with: 'Z00.01', without: 'Z00.00' }, child: { with: 'Z00.121', without: 'Z00.129' } };
            const group = (age != null && age < 18) ? 'child' : 'adult';
            const present = getICDRows().filter(e => EXAM[e.code.toUpperCase()]);
            if (present.length) {
                const kinds = new Set(present.map(e => EXAM[e.code.toUpperCase()][1]));
                const keep = CODE_FOR[group][kinds.has('with') ? 'with' : 'without'];
                present.forEach(e => {
                    const c = e.code.toUpperCase();
                    if (c === keep || toDelete.some(d => d.code.toUpperCase() === c)) return;
                    const [g] = EXAM[c];
                    const why = g !== group
                        ? `${c} is for ${g === 'adult' ? 'adults (18+)' : 'patients under 18'} — patient is ${age}, replaced with ${keep}`
                        : `Only one general-exam code per visit — keeping ${keep}`;
                    toDelete.push({ code: e.code, row: e.row, kind: 'icd', reason: why });
                });
                if (!present.some(e => e.code.toUpperCase() === keep) && !toAdd.some(a => a.code.toUpperCase() === keep)) {
                    toAdd.push({ code: keep, kind: 'icd', reason: `General-exam code for a ${group === 'adult' ? 'patient 18+' : 'patient under 18'}` });
                }
            }
        }

        // ---- v2.20: bundle Z codes follow the FINAL procedure list ----
        // The Z-code cleanups above look at the chart as it is now; but a
        // bundle CPT can be removed later in this same run (99401/99406 vs
        // 99214, counseling vs Pap/TCM/Advance Care, gating...). Re-check
        // every bundle Z code against the procedure codes the chart will
        // have AFTER these changes: keep it only if its CPT stays or is
        // being added. Real diagnoses (F17.210, E66.x) are never touched.
        {
            const delCpt = new Set(toDelete.filter(d => d.kind !== 'icd').map(d => d.code.toUpperCase()));
            const finalCpt = new Set([
                ...currentRows.map(r => r.code).filter(c => !delCpt.has(c)),
                ...toAdd.filter(a => a.kind !== 'icd').map(a => a.code.toUpperCase())
            ]);
            const hasPrev = [...finalCpt].some(c => PREVENTIVE_VISIT_CODES.has(c) || c === 'G0402');
            const BUNDLE_Z = [
                { test: c => ['Z00.01', 'Z00.121', 'Z00.00', 'Z00.129'].includes(c), keep: hasPrev,
                  why: 'No preventive visit code on the final claim — well-visit Z code not needed' },
                { test: c => ['Z71.3', 'Z71.82', 'Z71.89'].includes(c), keep: hasPrev || finalCpt.has('99401'),
                  why: 'No preventive visit or Preventive Counseling (99401) on the final claim — counseling Z code not needed' },
                { test: c => /^Z68\./.test(c), keep: hasPrev || finalCpt.has('G0447'),
                  why: 'No preventive visit or Obesity Counseling (G0447) on the final claim — BMI Z code not needed' },
                { test: c => c === 'Z71.6', keep: finalCpt.has('99406'),
                  why: 'No Smoking Counseling (99406) on the final claim — tobacco counseling Z code not needed' }
            ];
            const groupOf = c => BUNDLE_Z.find(g => g.test(c));
            // drop proposed additions of bundle Z codes whose CPT won't be there
            for (let i = toAdd.length - 1; i >= 0; i--) {
                if (toAdd[i].kind !== 'icd') continue;
                const g = groupOf(toAdd[i].code.toUpperCase());
                if (g && !g.keep) toAdd.splice(i, 1);
            }
            // remove the ones already on the chart
            getICDRows().forEach(e => {
                const c = e.code.toUpperCase();
                const g = groupOf(c);
                if (!g || g.keep) return;
                const existing = toDelete.find(d => d.code.toUpperCase() === c);
                if (existing) existing.reason = g.why; // the real reason: its bundle is gone
                else toDelete.push({ code: e.code, row: e.row, kind: 'icd', reason: g.why });
            });
        }

        return { toAdd, toDelete, insurance, bp, bmi, isHealthfirst, isMedicareInsurance, officeVisitNote, officeVisitWillBe99214, weekendHardBlock };
    }

    // ====================== eCW BILLING API (scope-based add, v1.97) ======================
    // Adds ICD/CPT codes the same way eCW's own Billing screen does: looks
    // the code up through eCW's lookup endpoints (LookupDiagnosisCodes.jsp /
    // LookupCPTCodes.jsp, using eCW's own XMLWriter/startSoapPacket/
    // addElement/endSoapPacket helpers), picks the FIRST EXACT match, then
    // hands it to the Billing Angular scope:
    //   ICD -> scope.addToSelectedListFromGrid(selected)
    //   CPT -> scope.setBillingInsightsCpt({ action:'add', isEm, cpt })
    // No typing into search boxes, no autosuggest clicking, no E&M tree
    // picker. If the Billing scope or eCW's XML helpers aren't available
    // on the current page, the old DOM method is used as a fallback.
    const ecwApiSleep = ms => new Promise(r => setTimeout(r, ms));

    // ====================== PREFERRED eCW ENTRIES (edit here) ======================
    // Some codes have more than one entry in eCW's catalog. For the codes
    // below, the entry with this eCW item id is used; every other code (or
    // if the id isn't returned) uses the first exact match.
    //     'CODE': 'eCW itemId',
    const PREFERRED_ITEM_IDS = {
        'Z13.9': '470673', // "Encounter for screening, unspecified" (not 597524 SDoH)
        'G9622': '472173', // "PT NOT ID UNHLTHY ALC USR SCR ALC U" (not 485142 "Alcohol use Positive")
        'Z71.89': '484207', // "Other specified counseling" — the 2nd of two such entries (not 471212, nor the COVID/diabetes ones)
    };

    // Pick the eCW entry for `code` from `list` (exact matches only).
    // strict=true returns null when an item id is set but not in the list.
    function pickPreferredEntry(code, list, strict) {
        if (!list || !list.length) return null;
        const wantId = PREFERRED_ITEM_IDS[String(code || '').trim().toUpperCase()];
        if (!wantId) return strict ? null : list[0];
        const hit = list.find(x => String(x.itemId || '').trim() === wantId);
        return hit || (strict ? null : list[0]);
    }

    // v2.03: eCW's own globals (angular, XMLWriter, startSoapPacket,
    // addElement, endSoapPacket, makeURL) live on the PAGE window. When this
    // file runs through a loader (new Function("window", ...)) or a
    // userscript sandbox, bare names like XMLWriter may not reach them —
    // which silently disabled the API method (and with it, reliable
    // office-visit adds). Always look them up on the page window.
    const PAGE_WIN = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    function pageGlobal(name) {
        try { if (PAGE_WIN && PAGE_WIN[name] != null) return PAGE_WIN[name]; } catch (e) {}
        try { if (window[name] != null) return window[name]; } catch (e) {}
        try { if (typeof globalThis !== 'undefined' && globalThis[name] != null) return globalThis[name]; } catch (e) {}
        return undefined;
    }

    // Which pieces of the API method are reachable right now (also handy
    // from the console: smcDiagnose()).
    function ecwApiStatus() {
        const ng = pageGlobal('angular');
        const btn = document.querySelector('#billingBtn1');
        let scope = null;
        try { scope = btn && ng && ng.element ? ng.element(btn).scope() : null; } catch (e) { scope = null; }
        return {
            billingScreen: !!btn,
            angular: !!(ng && ng.element),
            billingScope: !!scope,
            XMLWriter: typeof pageGlobal('XMLWriter') === 'function',
            startSoapPacket: typeof pageGlobal('startSoapPacket') === 'function',
            addElement: typeof pageGlobal('addElement') === 'function',
            endSoapPacket: typeof pageGlobal('endSoapPacket') === 'function',
            setBillingInsightsCpt: !!scope && typeof scope.setBillingInsightsCpt === 'function',
            addToSelectedListFromGrid: !!scope && typeof scope.addToSelectedListFromGrid === 'function'
        };
    }
    function ecwApiMissing() {
        const st = ecwApiStatus();
        return Object.keys(st).filter(k => !st[k]);
    }

    function getBillingScope() {
        const btn = document.querySelector('#billingBtn1');
        const ng = pageGlobal('angular');
        if (!btn || !ng || !ng.element) return null;
        try { return ng.element(btn).scope() || null; } catch (e) { return null; }
    }

    function ecwApiAvailable() {
        const st = ecwApiStatus();
        return st.billingScope && st.XMLWriter && st.startSoapPacket && st.addElement && st.endSoapPacket;
    }

    // scope.$apply throws if a digest is already running — only wrap when idle.
    function ecwSafeApply(scope, fn) {
        const phase = scope.$root && scope.$root.$$phase;
        if (phase === '$apply' || phase === '$digest') fn();
        else scope.$apply(fn);
    }

    function ecwXmlText(node, tag) {
        return node.querySelector(tag)?.textContent?.trim() || '';
    }

    async function ecwPostLookup(path, xml) {
        let url = path;
        const mk = pageGlobal('makeURL');
        if (typeof mk === 'function') url = mk(url);
        const response = await fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ FormData: xml }).toString()
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`Lookup HTTP ${response.status}`);
        if (!text.includes('<')) throw new Error('Lookup returned non-XML response');
        const doc = new DOMParser().parseFromString(text, 'text/xml');
        if (doc.querySelector('parsererror')) throw new Error('Lookup returned invalid XML');
        return doc;
    }

    // ---- ICD ----
    function ecwCreateICDLookupXml(scope, code) {
        const XW = pageGlobal('XMLWriter'), sp = pageGlobal('startSoapPacket'),
              ae = pageGlobal('addElement'), ep = pageGlobal('endSoapPacket');
        const xw = new XW('ISO-8859-1', '1.0');
        sp(xw);
        xw.writeStartElement('lookup');
        xw.writeAttributeString('xsi:type', 'xsd:string');
        ae(xw, 'searchBy', 'code', 'xsi:type', 'xsd:string');
        ae(xw, 'code', String(code).trim().toLowerCase(), 'xsi:type', 'xsd:string');
        ae(xw, 'keyName', 'Assessments', 'xsi:type', 'xsd:string');
        ae(xw, 'ShowCodes', '1', 'xsi:type', 'xsd:string');
        ae(xw, 'ValidDate', scope.encounterDate || '', 'xsi:type', 'xsd:string');
        ae(xw, 'counter', '1', 'xsi:type', 'xsd:string');
        ae(xw, 'maxcount', '12', 'xsi:type', 'xsd:string');
        ae(xw, 'StartWith', 'Starts With', 'xsi:type', 'xsd:string');
        xw.writeEndElement();
        ep(xw);
        return xw.flush();
    }

    async function ecwFindICD(code) {
        const scope = getBillingScope();
        code = String(code).trim().toUpperCase();
        const doc = await ecwPostLookup(
            '/mobiledoc/jsp/catalog/xml/edi/LookupDiagnosisCodes.jsp?parentId=0',
            ecwCreateICDLookupXml(scope, code)
        );
        return [...doc.querySelectorAll('ICDCodes > icd')].map(icd => ({
            itemId: ecwXmlText(icd, 'itemId'),
            code: ecwXmlText(icd, 'code'),
            name: ecwXmlText(icd, 'name'),
            snowMedCode: ecwXmlText(icd, 'snowMedCode'),
            hasMultiple: ecwXmlText(icd, 'hasMultiple'),
            overdue: ecwXmlText(icd, 'overdue'),
            ecwstatus: ecwXmlText(icd, 'ecwstatus'),
            raf: ecwXmlText(icd, 'raf'),
            ValidFrom: ecwXmlText(icd, 'ValidFrom'),
            ValidTo: ecwXmlText(icd, 'ValidTo'),
            icdversion: ecwXmlText(icd, 'icdversion')
        }));
    }

    function ecwScopeHasICD(scope, code) {
        return (scope.icdData || []).some(x =>
            x && String(x.medicalcode || '').trim().toUpperCase() === code);
    }

    async function ecwAddICDViaApi(code) {
        const scope = getBillingScope();
        code = String(code).trim().toUpperCase();
        if (ecwScopeHasICD(scope, code)) return { ok: true, message: 'Already present' };

        // Remove only broken empty rows left behind by failed adds.
        if ((scope.icdData || []).some(x => !x || !x.medicalcode)) {
            ecwSafeApply(scope, () => {
                scope.icdData = (scope.icdData || []).filter(x => x && x.medicalcode);
            });
        }

        const results = await ecwFindICD(code);
        const exact = results.filter(x => String(x.code || '').trim().toUpperCase() === code);
        if (!exact.length) return { ok: false, message: `No exact eCW ICD match for ${code}` };
        if (typeof scope.addToSelectedListFromGrid !== 'function') {
            return { ok: false, message: 'addToSelectedListFromGrid() not found' };
        }

        const chosenIcd = pickPreferredEntry(code, exact) || exact[0];
        ecwSafeApply(scope, () => { scope.addToSelectedListFromGrid(chosenIcd); });

        const start = Date.now();
        while (Date.now() - start < 3000) {
            await ecwApiSleep(150);
            if (ecwScopeHasICD(scope, code) || findICDRowByCodeFast(code)) return { ok: true };
        }
        return { ok: false, message: 'Lookup succeeded but code not detected afterward' };
    }

    // ---- CPT ----
    function ecwCreateCPTLookupXml(code, catalog) {
        const XW = pageGlobal('XMLWriter'), sp = pageGlobal('startSoapPacket'),
              ae = pageGlobal('addElement'), ep = pageGlobal('endSoapPacket');
        const xw = new XW('ISO-8859-1', '1.0');
        sp(xw);
        xw.writeStartElement('lookup');
        xw.writeAttributeString('xsi:type', 'xsd:string');
        ae(xw, 'searchBy', 'code', 'xsi:type', 'xsd:string');
        ae(xw, 'code', String(code).trim(), 'xsi:type', 'xsd:string');
        ae(xw, 'counter', '1', 'xsi:type', 'xsd:string');
        if (catalog === 'visit') {
            ae(xw, 'keyName', 'VisitCodes', 'xsi:type', 'xsd:string');
        } else {
            ae(xw, 'keyName', 'CPTCodes', 'xsi:type', 'xsd:string');
            ae(xw, 'keyName', 'HCPCS', 'xsi:type', 'xsd:string');
        }
        ae(xw, 'maxcount', '12', 'xsi:type', 'xsd:string');
        ae(xw, 'bActive', 'Active', 'xsi:type', 'xsd:string');
        ae(xw, 'ShowInvalid', '0', 'xsi:type', 'xsd:string');
        ae(xw, 'Fee', '', 'xsi:type', 'xsd:string');
        ae(xw, 'Amount', '0.00', 'xsi:type', 'xsd:string');
        ae(xw, 'FeeSchId', '1', 'xsi:type', 'xsd:string');
        // eCW's own creatCPTXml() uses a BLANK ValidDate for inline lookup.
        ae(xw, 'ValidDate', '', 'xsi:type', 'xsd:string');
        ae(xw, 'inlinelookup', 'yes', 'xsi:type', 'xsd:string');
        xw.writeEndElement();
        ep(xw);
        return xw.flush();
    }

    // v2.04: read each <procedure>'s OWN child elements only. The old
    // querySelector('name') returned the first <name> anywhere inside the
    // result — a nested one (fee/modifier block) could win and give the
    // added code a bogus description such as "00".
    function ecwChildMap(node) {
        const out = {};
        for (const el of Array.from(node.children || [])) {
            if (!(el.tagName in out)) out[el.tagName] = (el.textContent || '').trim();
        }
        return out;
    }
    function ecwPickField(map, ...keys) {
        for (const k of keys) {
            const hit = Object.keys(map).find(x => x.toLowerCase() === k.toLowerCase());
            if (hit && map[hit] !== '') return map[hit];
        }
        return '';
    }
    // A real description has letters in it — "00", "0.00" or blank don't.
    function isUsableCptName(n) {
        const t = String(n || '').trim();
        return t.length >= 3 && /[A-Za-z]{3}/.test(t);
    }

    async function ecwLookupCPTCatalogRaw(code, catalog) {
        const scope = getBillingScope();
        const doc = await ecwPostLookup(
            '/mobiledoc/jsp/catalog/xml/edi/LookupCPTCodes.jsp?parentId=0&encId=' +
                encodeURIComponent(scope.encounterId),
            ecwCreateCPTLookupXml(code, catalog)
        );
        return [...doc.querySelectorAll('procedures > procedure')].map(ecwChildMap);
    }

    async function ecwLookupCPTCatalog(code, catalog) {
        const raw = await ecwLookupCPTCatalogRaw(code, catalog);
        return raw.map(m => {
            const name = [
                ecwPickField(m, 'name'), ecwPickField(m, 'description'), ecwPickField(m, 'desc'),
                ecwPickField(m, 'codedesc'), ecwPickField(m, 'longdesc'), ecwPickField(m, 'shortdesc'),
                ecwPickField(m, 'itemname')
            ].find(isUsableCptName) || ecwPickField(m, 'name');
            // Same object shape the standalone billing script passes to eCW.
            return {
                itemId: ecwPickField(m, 'itemId'),
                code: ecwPickField(m, 'code'),
                name,
                Mod1: ecwPickField(m, 'Mod1'),
                Mod2: ecwPickField(m, 'Mod2'),
                Mod3: ecwPickField(m, 'Mod3'),
                Mod4: ecwPickField(m, 'Mod4'),
                units: ecwPickField(m, 'units'),
                chargecode: ecwPickField(m, 'chargecode'),
                DocumentMinutes: ecwPickField(m, 'DocumentMinutes'),
                TimedCode: ecwPickField(m, 'TimedCode')
            };
        });
    }

    // General CPT+HCPCS catalog first (as the standalone script). An exact
    // match there is used only if it has a real description; for E&M codes
    // the VisitCodes catalog is tried whenever the general match is missing
    // OR nameless — that's where eCW keeps office-visit descriptions.
    async function ecwFindCPT(code, isEm) {
        code = String(code).trim().toUpperCase();
        const exactOf = list => list.filter(x => String(x.code || '').trim().toUpperCase() === code);
        const normal = exactOf(await ecwLookupCPTCatalog(code, 'normal'));
        let pool = normal.filter(x => isUsableCptName(x.name));
        const hasPref = !!PREFERRED_ITEM_IDS[code];
        let visit = [];
        if (isEm && (!pool.length || (hasPref && !pickPreferredEntry(code, pool, true)))) {
            visit = exactOf(await ecwLookupCPTCatalog(code, 'visit'));
            pool = pool.concat(visit.filter(x => isUsableCptName(x.name)));
        }
        if (pool.length) return [pickPreferredEntry(code, pool) || pool[0]];
        if (!normal.length && visit.length) return visit;
        return normal;
    }

    // Console helper: every field eCW returns for a code, from both
    // catalogs — e.g. smcLookupCPT('99213').
    async function smcLookupCPT(code) {
        const out = {};
        for (const cat of ['normal', 'visit']) {
            try { out[cat] = await ecwLookupCPTCatalogRaw(String(code).trim(), cat); }
            catch (e) { out[cat] = String(e.message || e); }
        }
        console.log(`smcLookupCPT(${code}) — normal = CPTCodes+HCPCS, visit = VisitCodes`);
        ['normal', 'visit'].forEach(cat => {
            console.log(cat + ':');
            if (Array.isArray(out[cat])) console.table(out[cat]); else console.log(out[cat]);
        });
        return out;
    }

    function ecwScopeHasCPT(scope, code) {
        return (scope.cptData || []).some(x =>
            x && String(x.code || '').trim().toUpperCase() === code);
    }

    // E&M = office visit codes + preventive medicine codes.
    function isEmCode(code) {
        const c = String(code || '').trim().toUpperCase();
        return OFFICE_VISIT_EM_CODES.includes(c) || ALL_PREVENTIVE_EM_CODES.includes(c) ||
            ['99201', '99202', '99204', '99205'].includes(c);
    }

    async function ecwAddCPTViaApi(code, isEm) {
        const scope = getBillingScope();
        code = String(code).trim().toUpperCase();
        if (ecwScopeHasCPT(scope, code)) return { ok: true, message: 'Already present' };

        const exact = await ecwFindCPT(code, isEm);
        if (!exact.length) return { ok: false, message: `No exact eCW CPT match for ${code}` };
        if (typeof scope.setBillingInsightsCpt !== 'function') {
            return { ok: false, message: 'setBillingInsightsCpt() not found' };
        }

        // Not wrapped in $apply — setBillingInsightsCpt/addCode already runs
        // through eCW/Angular internally.
        scope.setBillingInsightsCpt({ action: 'add', isEm: !!isEm, cpt: exact[0] });

        // Associated-CPT processing is async — poll instead of a flat wait.
        const start = Date.now();
        while (Date.now() - start < 4000) {
            await ecwApiSleep(200);
            if (ecwScopeHasCPT(scope, code) || getCPTRowByCode(code)) return { ok: true };
        }
        return { ok: false, message: 'Lookup succeeded but code not detected afterward' };
    }

    // Console helpers (same names as the standalone script).
    window.ecwFindICD = ecwFindICD;
    window.ecwAddICD = ecwAddICDViaApi;
    window.ecwFindCPT = ecwFindCPT;
    window.ecwAddCPT = ecwAddCPTViaApi;
    try { PAGE_WIN.smcDiagnose = () => { const st = ecwApiStatus(); console.table(st); return st; }; } catch (e) {}
    window.smcDiagnose = () => { const st = ecwApiStatus(); console.table(st); return st; };
    window.smcLookupCPT = smcLookupCPT;
    try { PAGE_WIN.smcLookupCPT = smcLookupCPT; } catch (e) {}

    // ====================== FAST ICD ADD (search box + selection only, ported from the Button_Disabled ICD linker script) ======================
    function getICDSearchInput() {
        const inputs = Array.from(document.querySelectorAll("#ICDCode"));
        // Multiple elements can share this id in ECW's markup; pick the visible one
        // whose placeholder says "ICD".
        return inputs.find(i => {
            if (i.offsetParent === null) return false;
            const ph = (i.getAttribute("placeholder") || "").toUpperCase();
            return ph === "ICD";
        });
    }

    function waitForICDSuggestion(code, timeoutMs = 2500) {
        return new Promise(resolve => {
            const start = Date.now();
            const check = () => {
                const links = document.querySelectorAll('#cptmaintable a[id^="CPT-ICDAutoSuggest-tplLink"]');
                const match = Array.from(links).find(a => {
                    const span = a.querySelector("span[ng-bind='item.code']") || a.querySelector("span");
                    return span && span.textContent.trim().toUpperCase() === code.toUpperCase();
                });
                if (match) return resolve(match);
                if (Date.now() - start > timeoutMs) return resolve(null);
                setTimeout(check, 60);
            };
            check();
        });
    }

    function findICDRowByCodeFast(code) {
        return Array.from(document.querySelectorAll('#billingTbl2 tbody tr')).find(row =>
            row.querySelector('td:nth-child(3)')?.textContent.trim().toUpperCase() === code.toUpperCase()
        );
    }

    function waitForICDRowAppear(code, timeoutMs = 2000) {
        return new Promise(resolve => {
            if (findICDRowByCodeFast(code)) return resolve(true);
            const start = Date.now();
            const timer = setInterval(() => {
                if (findICDRowByCodeFast(code)) { clearInterval(timer); resolve(true); return; }
                if (Date.now() - start > timeoutMs) { clearInterval(timer); resolve(false); }
            }, 60);
        });
    }

    // Skips codes already present, then types + autosuggest-clicks the rest.
    // Polls for the row to actually appear instead of a blind fixed sleep,
    // so it settles as soon as ECW finishes inserting (usually well under
    // the old flat delay).
    async function addSingleICDCodeFast(code) {
        if (findICDRowByCodeFast(code)) return true;

        // v1.97: eCW Billing API method first (lookup + scope add).
        if (ecwApiAvailable()) {
            try {
                const result = await ecwAddICDViaApi(code);
                if (!result.ok) console.warn(`ICD ${code}: ${result.message}`);
                return result.ok;
            } catch (e) {
                console.warn(`ICD ${code}: API add failed`, e);
                return false;
            }
        }
        // Fallback (Billing scope/XML helpers not on this page): old DOM method.

        // Same reasoning as addSingleCPT — clear any leftover confirm
        // dialog before it blocks this new action too.
        clickAnyYesButton();

        const input = getICDSearchInput();
        if (!input) { console.warn("ICD search box not found/visible"); return false; }

        input.focus();
        input.value = code;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        // autocompleteData is bound to ng-keyup, so a real keyup event is required
        input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: code.slice(-1) }));

        const suggestion = await waitForICDSuggestion(code);
        if (!suggestion) { console.warn(`No ICD autosuggest match found for "${code}"`); return false; }
        suggestion.click();
        return await waitForICDRowAppear(code);
    }

    async function addICDCodesFast(codes) {
        const results = [];
        for (const raw of codes) {
            const code = (raw || '').trim();
            if (!code) continue;
            const ok = await addSingleICDCodeFast(code);
            results.push({ code, ok });
        }
        const failed = results.filter(r => !r.ok).map(r => r.code);
        if (failed.length) {
            alert(`Could not add ICD: ${failed.join(", ")}\n(check the code is valid, or add it manually)`);
        }
        return results;
    }

    // ====================== PREVENTIVE / COUNSEL / SMOKING / OBESITY ACTIONS ======================
    // Adult BMI thresholds only (Z68.1-Z68.45, raw BMI number). Pediatric
    // BMI coding needs age/sex percentile charts (Z68.51-Z68.54) that this
    // script doesn't have data for — returns null under 18 rather than
    // misapplying adult thresholds to a child.
    function mapBMIToZ68(bmi, age) {
        if (age != null && age < 18) return null;
        if (bmi == null || isNaN(bmi)) return null;
        if (bmi < 20) return "Z68.1"; // v1.11: every adult BMI under 20 (incl. below 19) -> Z68.1
        if (bmi < 30) return `Z68.${Math.floor(bmi)}`;   // Z68.20 .. Z68.29
        if (bmi < 40) return `Z68.${Math.floor(bmi)}`;   // Z68.30 .. Z68.39
        if (bmi < 45) return "Z68.41";
        if (bmi < 50) return "Z68.42";
        if (bmi < 60) return "Z68.43";
        if (bmi < 70) return "Z68.44";
        return "Z68.45";
    }

    function getChiefComplaintTextFast(text) {
        const m = text.match(/Chief Complaint\(s\)\s*:?\s*([\s\S]+?)(?=\n\s*\n|\n\s*(?:Subjective|Objective|HPI|History|Assessment|Plan|Review|Physical|Vital|Social|Family|Medical|Surgical)\b|$)/i);
        return m ? m[1] : "";
    }

    function getICDGridEntriesFast() {
        return Array.from(document.querySelectorAll('#billingTbl2 tbody tr')).map(row => {
            const cells = row.querySelectorAll('td');
            const code = (cells[2]?.textContent || '').trim();
            const name = (cells[3]?.textContent || '').trim();
            return { code, name };
        }).filter(r => r.code);
    }

    // "pain" word in the Chief Complaint, or a pain-related ICD already on
    // the grid (pain-related ICD-10 codes normally start with "M", or the
    // diagnosis description itself contains the word "pain").
    // Only for the Z71.82-vs-Z71.89 decision (not 0521F/1125F/1126F, which
    // stays ICD-grid-only). Pain word in CC counts here too, plus ICD-grid
    // pain/injury codes.
    function hasPainIndicatorFast(ccText, icdEntries) {
        if (/\bpain\b/i.test(ccText || "")) return true;
        return icdEntries.some(e => isPainRelatedICDEntry(e.code, e.name) || isInjuryICDEntry(e.code));
    }

    // Checks each keyword is actually documented as present, not denied —
    // ROS entries like "Shortness of Breath denies." were matching as a
    // positive finding on a plain substring search.
    // CC and ICD list only — no ROS/whole-note scanning.
    function hasSpecialConditionKeywordsFast(ccText, icdEntries) {
        const combined = (ccText || "") + " " + icdEntries.map(e => e.name).join(" ");
        return /\basthma\b/i.test(combined) ||
               /shortness of (?:breath|breadth)/i.test(combined) ||
               /\bweakness\b/i.test(combined) ||
               /\bpregnan(?:t|cy)\b/i.test(combined);
    }

    // Z71.82 (exercise counseling) vs Z71.89 (other counseling). Z71.89 if:
    // pain (CC or ICD list), any fracture/injury ICD, age <18, female 50+,
    // male 55+, or asthma/SOB/weakness (CC or ICD list). Otherwise Z71.82.
    function determineZ71CodeFast(age, gender, ccText, icdEntries) {
        if (age != null && age < 18) return "Z71.89";
        if (hasPainIndicatorFast(ccText, icdEntries)) return "Z71.89";
        if (gender === "F" && age != null && age >= 50) return "Z71.89";
        if (gender === "M" && age != null && age >= 55) return "Z71.89";
        if (hasSpecialConditionKeywordsFast(ccText, icdEntries)) return "Z71.89";
        return "Z71.82";
    }

    // Lightweight, non-blocking toast for the "add appropriate E&M code" reminder.
    function showQuickNotice(message) {
        const el = document.createElement('div');
        el.textContent = message;
        Object.assign(el.style, {
            position: 'fixed',
            top: '80px',
            right: '20px',
            maxWidth: '360px',
            padding: '12px 16px',
            background: '#fff3cd',
            border: '1px solid #ffc107',
            borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            zIndex: '9999999',
            fontFamily: 'sans-serif',
            fontSize: '13px',
            color: '#333',
            transition: 'opacity 0.3s'
        });
        document.body.appendChild(el);
        setTimeout(() => {
            el.style.opacity = '0';
            setTimeout(() => el.remove(), 400);
        }, 5000);
    }

    // Pap smear (Q0091/G0101), Advance Care (99497), TCM/Post-Hosp (99495/
    // 99496): no counseling quick action (P/C, Smoking, Obesity) may run
    // while any of these is present. Preventive (PV) is unaffected.
    function getHighLevelBlockingCode() {
        const codes = ['Q0091', 'G0101', '99497', '99495', '99496'];
        for (const code of codes) {
            if (getCPTRowByCode(code)) return code;
        }
        return null;
    }

    let quickActionRunning = false;

    // ── Preventive: Z00.01/Z00.121, Z68.xx, Z71.3, Z71.82/89, then a reminder popup ──
    // All 14 Preventive Medicine E&M codes (7 age bands × New/Established),
    // used to detect and clean up a wrong one if age or patient status
    // changes between visits.
    const ALL_PREVENTIVE_EM_CODES = [
        '99381', '99382', '99383', '99384', '99385', '99386', '99387',
        '99391', '99392', '99393', '99394', '99395', '99396', '99397'
    ];

    // Medicare's "Welcome to Medicare" / Annual Wellness Visit codes. These
    // REPLACE the 993xx Preventive Medicine code for Medicare/VNS Choice —
    // never both. G0402 retired — only G0438/G0439 apply now, for VNS
    // Choice and any other Medicare alike.
    const MEDICARE_AWV_CODES = ['G0438', 'G0439'];

    function isVNSChoiceIns(insurance) {
        return !!insurance && /\bvns\b/i.test(insurance);
    }

    function isAnyMedicareIns(insurance) {
        return !!insurance && /medicare/i.test(insurance);
    }

    // Established = at least one PRIOR encounter exists in patient history
    // (i.e. more than just today's current visit). No history at all, or
    // only today's own encounter, means New Patient.
    function isEstablishedPatient() {
        const api = window.__ecwPatientHistory;
        const data = api && api.getData ? api.getData() : null;
        if (!data || !data.length) return false;
        const currentDos = document.querySelector("#encDropDownItem")?.title?.match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0] || "";
        return data.some(enc => enc.encounter_date && enc.encounter_date !== currentDos);
    }

    // Age-band mapping per eCW's Preventive Medicine E&M list.
    function mapAgeToPreventiveCPT(age, established) {
        if (age == null) return null;
        if (age < 1) return established ? '99391' : '99381';
        if (age <= 4) return established ? '99392' : '99382';
        if (age <= 11) return established ? '99393' : '99383';
        if (age <= 17) return established ? '99394' : '99384';
        if (age <= 39) return established ? '99395' : '99385';
        if (age <= 64) return established ? '99396' : '99386';
        return established ? '99397' : '99387';
    }

    // Generic poll-until-found helper for the E&M picker below.
    function waitForElement(finder, timeoutMs = 3000, intervalMs = 100) {
        return new Promise(resolve => {
            const start = Date.now();
            const timer = setInterval(() => {
                const el = finder();
                if (el) { clearInterval(timer); resolve(el); return; }
                if (Date.now() - start > timeoutMs) { clearInterval(timer); resolve(null); }
            }, intervalMs);
        });
    }

    function findEMTreeNode(labelText) {
        return Array.from(document.querySelectorAll('span[bo-bind="node.label"]'))
            .find(el => el.offsetParent !== null && el.textContent.trim().toLowerCase() === labelText.toLowerCase()) || null;
    }

    // "Est Patient"/"New Patient" exist under MULTIPLE categories (E/M
    // SERVICES, Eye Codes, Preventive Medicine, ...) — a plain document-wide
    // text search for "Est Patient" always finds the FIRST one (E/M
    // SERVICES', since it comes earlier in the tree), not the one actually
    // nested under the category we just expanded. Scoped to the handful of
    // tree nodes immediately following the category label instead, since a
    // category's own children render right after it in document order.
    function findEMChildNode(categoryLabel, childLabel) {
        const allNodes = Array.from(document.querySelectorAll('span[bo-bind="node.label"]'))
            .filter(el => el.offsetParent !== null);
        const catIndex = allNodes.findIndex(el => el.textContent.trim().toLowerCase() === categoryLabel.toLowerCase());
        if (catIndex === -1) return null;
        for (let i = catIndex + 1; i < allNodes.length && i - catIndex <= 6; i++) {
            if (allNodes[i].textContent.trim().toLowerCase() === childLabel.toLowerCase()) return allNodes[i];
        }
        return null;
    }

    function findEMCodeCell(code) {
        return Array.from(document.querySelectorAll('td[ng-bind="item.code"]'))
            .find(el => el.offsetParent !== null && el.textContent.trim() === code) || null;
    }

    // Preventive Medicine E&M codes go through the "Add E&M" picker
    // (billingBtn2 -> optional confirm popup -> Preventive Medicine tree ->
    // Est/New Patient -> click the code cell -> OK), NOT the normal CPT
    // search box, per the actual eCW markup.
    // Shared "Add E&M" picker mechanism — works for any category/subsection
    // in the tree (Preventive Medicine, E/M SERVICES, etc.). Only clicks the
    // category to expand it if its children aren't already visible (some
    // categories stay expanded by default; clicking one that's already open
    // toggles it CLOSED instead, which hides Est/New Patient).
    async function addEMTreeCode(code, categoryLabel, isNewPatient) {
        // Already there — no need to reopen the picker at all.
        if (getCPTRowByCode(code)) return { ok: true, message: 'Already present' };

        // v1.97: E&M codes go through the eCW Billing API as isEm:true
        // (general catalog first, VisitCodes fallback) — no picker needed.
        if (ecwApiAvailable()) {
            try {
                return await ecwAddCPTViaApi(code, true);
            } catch (e) {
                return { ok: false, message: `API add failed: ${e.message || e}` };
            }
        }
        // Fallback (Billing scope/XML helpers not on this page): E&M picker.

        // A leftover "Could not add ICD: ..." error from the ICD-add step
        // right before this would otherwise block every click below.
        dismissEcwErrorPopup();

        const addBtn = document.getElementById('billingBtn2');
        if (!addBtn) return { ok: false, message: 'Add E&M button not found' };
        addBtn.click();

        // eCW sometimes shows a confirmation popup before opening the
        // picker — click Yes if it appears (no-op otherwise).
        await new Promise(r => setTimeout(r, 300));
        clickAnyYesButton();
        dismissEcwErrorPopup();

        const categoryNode = await waitForElement(() => findEMTreeNode(categoryLabel));
        if (!categoryNode) return { ok: false, message: `${categoryLabel} category not found` };

        const subLabel = isNewPatient ? 'New Patient' : 'Est Patient';

        let subNode = findEMChildNode(categoryLabel, subLabel);
        if (!subNode) {
            categoryNode.click();
            subNode = await waitForElement(() => findEMChildNode(categoryLabel, subLabel));
        }
        if (!subNode) return { ok: false, message: `${subLabel} subsection not found under ${categoryLabel}` };
        subNode.click();

        const codeCell = await waitForElement(() => findEMCodeCell(code));
        if (!codeCell) return { ok: false, message: `CPT ${code} not found in the E&M list` };
        codeCell.click();

        await new Promise(r => setTimeout(r, 150));
        const okBtn = document.getElementById('billingBtn29');
        if (!okBtn) return { ok: false, message: 'OK button not found' };
        okBtn.click();

        const added = await waitForElement(() => getCPTRowByCode(code), 3000);
        return { ok: !!added };
    }

    // ====================== OFFICE VISIT E&M (visit-type driven) ======================
    const OFFICE_VISIT_EM_CODES = ['99211', '99212', '99213', '99214', '99215', '99203'];

    // Chronic disease ICD list used for the 99213-vs-99214 complexity check.
    const CHRONIC_DISEASE_ICD_CODES = new Set([
        "B18.8", "I10", "E03.8", "E03.9", "E07.89", "E07.9", "E11.21", "E11.22", "E11.40", "E11.42", "E11.49", "E11.59",
        "E11.610", "E11.618", "E11.65", "E11.69", "E11.8", "E11.9", "E44.0", "E78.1", "E78.2", "E78.5",
        "F01.50", "F01.51", "F03.90", "F03.91", "F06.30", "F06.31", "F06.32", "F06.4", "F20.1", "F20.3", "F20.9", "F31.10",
        "F31.61", "F31.9", "F32.9", "F32.A", "F33.0", "F33.1", "F34.9", "F39", "F41.1", "F41.9", "F51.01", "F51.12", "F52.21",
        "G47.00", "G47.09", "G89.29", "H25.013", "H34.8192", "I25.10", "I25.119", "I25.810", "I25.812", "I25.83", "I25.9",
        "I48.91", "I50.22", "I51.7", "I51.9", "I67.9", "I73.9", "I83.10", "I83.891", "I83.93",
        "J32.0", "J44.1", "J44.9", "J45.20", "J45.21", "J45.30", "J45.40", "J45.901", "J45.909", "J45.991",
        "K21.00", "K21.9", "K58.0", "K58.1", "K58.2", "K70.31", "K74.60", "K76.0", "K86.0", "K86.1", "K90.0",
        "L40.9", "L74.9", "L83", "M06.89", "M06.9", "M10.00", "M10.072", "M10.9", "M47.22", "M47.25", "M47.26", "M79.7", "M81.0",
        "N18.2", "N18.30", "N18.31", "N18.32", "N18.4", "N18.9", "N40.0", "N40.1", "N46.9", "N52.9",
        "R00.1", "R01.1", "R41.81", "R54", "R87.810", "R94.4", "R94.5", "R94.6", "T82.212D", "E78.00"
    ]);

    // Reads the visit type. First choice: the appointment caption, e.g.
    // 'Appt: (07/24/2026 10:30 am, ESTPT) ' -> "ESTPT". The caption isn't
    // always on the page (often missing on the Billing tab), so it also
    // looks for a visit-type word in the encounter drop-down.
    function getVisitType() {
        const span = document.querySelector('span.appt-caption-main[ng-bind="apptCaption"]');
        const raw = span ? (span.getAttribute('title') || span.textContent || '') : '';
        const m = raw.match(/,\s*([^,)]+)\)/);
        if (m && m[1].trim()) return m[1].trim();
        const sources = [
            document.querySelector('#encDropDownItem')?.getAttribute('title') || '',
            document.querySelector('#encDropDownList li.hlight-enc')?.textContent || ''
        ];
        for (const src of sources) {
            const t = src.match(/\b(NP|ESTPT|EST\.?\s*PT|NEW\s*PT|NEW\s*PATIENT|ESTABLISHED(?:\s*PATIENT)?)\b/i);
            if (t) return t[1].trim();
        }
        return '';
    }

    // 'new' / 'established' / null (unknown). Accepts the usual spellings
    // (NP, New Pt, New Patient, ESTPT, Est Pt, Established). Anything else
    // returns null and computeAnalysis falls back to patient history.
    function classifyVisitType(visitType) {
        const v = String(visitType || '').toLowerCase().replace(/[^a-z]/g, '');
        if (!v) return null;
        if (v === 'np' || v === 'newpt' || v.startsWith('newpatient') || v === 'new') return 'new';
        if (v === 'estpt' || v === 'est' || v.startsWith('established') || v.startsWith('estpatient')) return 'established';
        return null;
    }

    // Eye/adnexa ICD detection (H00-H59 minus unused ranges, plus C69/D31/
    // Q10-15/S05/T15/T26/P39.1) — used by the 99173 (visual acuity) rule
    // in computeAnalysis.
    const EYE_ICD_PATTERNS = [
        /^H(0[0-6]|1[0-9]|2[0-8]|3[0-6]|40|4[2-9]|5[0-9])/,
        /^C69/, /^D31/, /^Q1[0-5]/, /^S05/, /^T15/, /^T26/, /^P39\.1/
    ];
    function isEyeICD(code) {
        return !!code && EYE_ICD_PATTERNS.some(rx => rx.test(code.toUpperCase()));
    }

    // ================= WEEKEND RULE (CPT 99051) =================
    // 99051 = services provided on a weekend/holiday. Auto-detected from the
    // current encounter's DOS (Sat/Sun or a listed federal holiday, 2026-2029),
    // but always user-overridable via the toggle next to CURRENT ENCOUNTER.
    // Rule (v2.32): allowed alongside a plain visit and Obesity Counseling
    // (OB, G0447); NOT allowed alongside Preventive (PV), Preventive
    // Counseling (P/C, 99401) or Smoking Counseling (SM, 99406) — see the
    // Weekend rule in computeAnalysis and weekendBlockingCode().
    const WEEKEND_HOLIDAYS = new Set([
        // 2026
        "01/01/2026", "01/19/2026", "02/16/2026", "05/25/2026", "06/19/2026",
        "07/03/2026", "09/07/2026", "10/12/2026", "11/11/2026", "11/26/2026", "12/25/2026",
        // 2027
        "01/01/2027", "01/18/2027", "02/15/2027", "05/31/2027", "06/18/2027",
        "07/05/2027", "09/06/2027", "10/11/2027", "11/11/2027", "11/25/2027", "12/24/2027",
        // 2028 (New Year's Day observed 12/31/2027)
        "12/31/2027", "01/17/2028", "02/21/2028", "05/29/2028", "06/19/2028",
        "07/04/2028", "09/04/2028", "10/09/2028", "11/10/2028", "11/23/2028", "12/25/2028",
        // 2029
        "01/01/2029", "01/15/2029", "02/19/2029", "05/28/2029", "06/19/2029",
        "07/04/2029", "09/03/2029", "10/08/2029", "11/12/2029", "11/22/2029", "12/25/2029",
    ]);

    function getCurrentDOSStr() {
        return document.querySelector("#encDropDownItem")?.title?.match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0] || "";
    }

    function isWeekendOrHolidayDOS(dosStr) {
        const m = String(dosStr || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (!m) return false;
        if (WEEKEND_HOLIDAYS.has(dosStr)) return true;
        const day = new Date(+m[3], +m[1] - 1, +m[2]).getDay();
        return day === 0 || day === 6;
    }

    const weekendOverrides = {}; // `${patientKey}_${dos}` -> true/false, manual override only

    function getWeekendKey() {
        const pidKey = (window.__ecwPatientHistory && window.__ecwPatientHistory.getCurrentKey)
            ? (window.__ecwPatientHistory.getCurrentKey() || "")
            : "";
        return `${pidKey}_${getCurrentDOSStr()}`;
    }

    function isWeekendEnabled() {
        const key = getWeekendKey();
        return Object.prototype.hasOwnProperty.call(weekendOverrides, key)
            ? weekendOverrides[key]
            : isWeekendOrHolidayDOS(getCurrentDOSStr());
    }

    function setWeekendOverride(val) {
        weekendOverrides[getWeekendKey()] = val;
    }

    // Same 98012/"televisit" detection computeAnalysis uses (see
    // isTelevisitNote there) — re-derived here so the quick-action buttons
    // can be gated at render time, before any action actually runs.
    function isTelevisitNow(text) {
        const hasCode = getCPTRows().some(row => {
            const code = (row.querySelector('td:nth-child(2)')?.textContent || '').trim().toUpperCase();
            return code === '98012';
        });
        return hasCode || /televisit/i.test(text || '');
    }

    // ── Quick-action button gating (PV / P/C / SM / OB) ─────────────────
    // Computed fresh on every render so a faded/disabled button always
    // reflects the CURRENT chart, insurance, and visit type — same cadence
    // as renderSnapshotBlock() itself (2.5s poll + every action/grid
    // change). Each entry is { disabled, title } — title doubles as the
    // on-hover explanation for why a button is greyed out.
    function computeQuickActionGating(insurance, flags, text) {
        const isTelevisit = isTelevisitNow(text);
        const established = isEstablishedPatient();
        const dosYear = getCurrentDosYear();
        const PREVENTIVE_ALL_CODES = [...ALL_PREVENTIVE_EM_CODES, ...MEDICARE_AWV_CODES];

        // ---- PV: Preventive ----
        let pv = { disabled: false, title: 'Preventive' };
        if (PREVENTIVE_ALL_CODES.some(c => codeUsedInYear(c, dosYear))) {
            pv = { disabled: true, title: 'Preventive already billed this calendar year' };
        } else if (isTelevisit) {
            pv = { disabled: true, title: 'Preventive not applicable for a televisit' };
        }

        // ---- P/C: Preventive Counseling ----
        // P/C also requires at least one chronic disease ICD coded on the
        // CURRENT encounter (checked against the same CHRONIC_DISEASE_ICD_CODES
        // list used for the 99213-vs-99214 complexity rule) — without a
        // chronic condition to counsel on, Preventive Counseling doesn't apply.
        const hasChronicDiseaseThisEncounter = getICDRows().some(r => CHRONIC_DISEASE_ICD_CODES.has((r.code || '').toUpperCase()));
        let pc = { disabled: false, title: 'Preventive Counseling' };
        // Hasan Sheikh only: 99401 is never billed for a capitated plan
        // (Centerlight, Well Care, Ameri Group). Every other allowed payer,
        // Healthfirst included, uses the same 30-day gap below.
        if (isCapitatedInsurance(insurance)) {
            pc = { disabled: true, title: `Preventive Counseling (99401) not applicable for capitated insurance (${insurance})` };
        } else if ([...PREVENTIVE_ALL_CODES, '99401'].some(c => codeUsedInLastDays(c, 30))) {
            pc = { disabled: true, title: 'Preventive or Preventive Counseling billed in the last 30 days' };
        } else if (isPreventiveCounselBlockedIns(insurance)) {
            pc = { disabled: true, title: `Preventive Counseling not applicable for ${insurance || 'this insurance'}` };
        } else if (!hasChronicDiseaseThisEncounter) {
            pc = { disabled: true, title: 'Preventive Counseling requires at least one chronic disease diagnosis in this encounter' };
        } else if (isTelevisit) {
            pc = { disabled: true, title: 'Preventive Counseling not applicable for a televisit' };
        }

        // ---- SM: Smoking Counseling ----
        // 99406 requires the patient to be 18+ — same age-gate pattern as
        // the G0444 (12+) / G0442 (18+) screening G-codes below.
        const smAge = getAgeAtDOS(text);
        let sm = { disabled: false, title: 'Smoking Counseling' };
        if (smAge != null && smAge < 18) {
            sm = { disabled: true, title: `Smoking Counseling not applicable — patient age ${smAge} is under 18` };
        } else if (flags.hasSmoker !== false) {
            sm = { disabled: true, title: 'Smoking Counseling only applies to a confirmed smoker' };
        } else if (codeUsedInLastDays('99406', 30)) {
            sm = { disabled: true, title: 'Smoking counseling (99406) billed in the last 30 days' };
        } else if (isNycePPOIns(insurance)) {
            sm = { disabled: true, title: 'Smoking Counseling not applicable for NYCE PPO' };
        } else if (isTelevisit) {
            sm = { disabled: true, title: 'Smoking Counseling not applicable for a televisit' };
        }

        // ---- OB: Obesity Counseling ----
        // Pediatric (under 18) uses BMI-for-age PERCENTILE, not raw adult
        // BMI — a raw BMI number is meaningless on the adult 30-cutoff
        // scale for a child (e.g. a raw BMI of 22 can be the 95th
        // percentile — obese — for a young child, while reading as
        // "normal" if wrongly compared to the adult threshold). This was
        // wrongly blocking Obesity Counseling for pediatric patients who
        // ARE obese by pediatric standards. Applies at the 95th percentile
        // per CDC pediatric BMI-for-age classification. If a pediatric
        // patient has no BMI percentile documented, BMI doesn't block OB
        // here at all (falls through to the other conditions below)
        // rather than wrongly falling back to the adult scale. Adults keep
        // the existing raw-BMI<30 rule, unchanged.
        const obAge = getAgeAtDOS(text) ?? 0;
        const obBmi = parseFloat(snapshotExtract(text, /BMI:\s*(\d{1,3}(?:\.\d{1,2})?)/i)) || null;
        const obBmiPercentile = parseFloat(snapshotExtract(text, /BMI\s*%:\s*(\d{1,3}(?:\.\d{1,2})?)\s*%/i)) || null;
        const obBmiBlocked = obAge < 18
            ? (obBmiPercentile != null && obBmiPercentile < 95)
            : (obBmi != null && obBmi < 30);
        const obBmiBlockTitle = obAge < 18
            ? `Obesity Counseling not applicable — BMI percentile ${obBmiPercentile}% is under the 95th percentile`
            : `Obesity Counseling not applicable — BMI ${obBmi} is under 30`;
        // BUG FIX: if NO BMI value/percentile is documented at all, the
        // button used to stay enabled (obBmiBlocked short-circuits to
        // false when the value is null) and only failed after being
        // clicked, showing "BMI not found on this page — skipped."
        // instead of fading the button up front like every other missing-
        // prerequisite case. Now checked first so the button fades
        // immediately with a clear reason when BMI genuinely isn't there.
        const obBmiMissing = obAge < 18 ? (obBmiPercentile == null) : (obBmi == null);
        let ob = { disabled: false, title: 'Obesity Counseling' };
        if (obBmiMissing) {
            ob = { disabled: true, title: 'Obesity Counseling requires a documented BMI on this encounter' };
        } else if (obBmiBlocked) {
            ob = { disabled: true, title: obBmiBlockTitle };
        } else if (codeUsedInLastDays('G0447', 30)) {
            ob = { disabled: true, title: 'Obesity counseling (G0447) billed in the last 30 days' };
        } else if (insurance && /medicaid/i.test(insurance.trim())) {
            ob = { disabled: true, title: 'Obesity Counseling not applicable for Medicaid' };
        } else if (isNycePPOIns(insurance)) {
            ob = { disabled: true, title: 'Obesity Counseling not applicable for NYCE PPO' };
        } else if (isTelevisit) {
            ob = { disabled: true, title: 'Obesity Counseling not applicable for a televisit' };
        }

        // ---- New patient: only Preventive is relevant — force the other
        // three faded regardless of what their own rules would say. ----
        if (!established) {
            const reason = 'New patient — only Preventive applies';
            if (!pc.disabled) pc = { disabled: true, title: reason };
            if (!sm.disabled) sm = { disabled: true, title: reason };
            if (!ob.disabled) ob = { disabled: true, title: reason };
        }

        // ---- No vitals documented: none of the four bundles apply ----
        // Preventive/Preventive Counseling/Smoking Counseling/Obesity
        // Counseling all require at least one vital sign (BP, weight,
        // height, pulse, temp, resp rate, O2 sat) documented this
        // encounter. With no vitals at all, every one of the four is
        // faded regardless of what its own rule above would otherwise
        // allow — this check runs last so it always wins.
        if (!isVitalsDocumented(text)) {
            pv = { disabled: true, title: "No vitals documented — Preventive can't be applied" };
            pc = { disabled: true, title: "No vitals documented — Preventive Counseling can't be applied" };
            sm = { disabled: true, title: "No vitals documented — Smoking Counseling can't be applied" };
            ob = { disabled: true, title: "No vitals documented — Obesity Counseling can't be applied" };
        }

        // ---- TCM on chart (99495/99496): P/C, Smoking, and Obesity
        // Counseling never apply alongside a TCM code — only Preventive
        // (PV) can still be used, if its own rules above allow it. Runs
        // last so it always wins, same as the no-vitals check above. ----
        if (getCPTRows().some(r => { const c = (r.querySelector('td:nth-child(2)')?.textContent.trim() || '').toUpperCase(); return c === '99495' || c === '99496'; })) {
            const tcmReason = 'TCM code (99495/99496) is on the chart — only Preventive applies, not Preventive/Smoking/Obesity Counseling';
            pc = { disabled: true, title: tcmReason };
            sm = { disabled: true, title: tcmReason };
            ob = { disabled: true, title: tcmReason };
        }

        return { pv, pc, sm, ob };
    }

    // ====================== PAYER HELPERS (used by gating + plans) ======================
    // Preventive Counsel is never applicable for these payers. "Medicare"
    // means straight Medicare specifically — the insurance name must
    // START with "Medicare". A Medicare-branded plan administered by
    // another payer (e.g. "Healthfirst Medicare Plan") is NOT straight
    // Medicare and CAN have Preventive Counsel.
    function isPreventiveCounselBlockedIns(insurance) {
        if (!insurance) return false;
        const name = insurance.trim();
        if (/metro\s*plus/i.test(name)) return true;
        if (/medicaid/i.test(name)) return true;
        if (isUHCInsurance(name)) return true;
        if (isNycePPOIns(name)) return true;
        if (/^medicare\b/i.test(name)) return true; // straight Medicare = starts with "Medicare"
        return false;
    }

    // v2.30: commercial insurance — Aetna, UnitedHealthcare (all UHC
    // variants via isUHCInsurance), 1199, Cigna, Empire, Anthem,
    // BCBS / Blue Cross Blue Shield, NYCE PPO. With commercial insurance an
    // office-visit code can NOT go with a preventive visit.
    function isCommercialInsurance(insurance) {
        if (!insurance) return false;
        if (isUHCInsurance(insurance)) return true; // United Healthcare, UMR, Oxford...
        const name = insurance.trim().toLowerCase()
            .replace(/[.,]/g, '')
            .replace(/[\s-]+/g, ' ')
            .trim()
            // Strip a leading "the " so "The Empire Plan" is matched the
            // same as "Empire Plan" / "Empire BCBS" below.
            .replace(/^the\s+/, '');
        if (/^aetna\b/.test(name)) return true;
        if (/^cigna\b/.test(name)) return true;
        if (/^1199/.test(name)) return true;          // 1199, 1199SEIU, 1199 National Benefit Fund...
        if (/^anthem\b/.test(name)) return true;
        if (/^bcbs\b/.test(name)) return true;
        // "Blue Cross Blue Shield", "Blue Cross Blue Shield of NY",
        // "Blue Cross of California" — anything starting "Blue Cross".
        if (/^blue\s+cross\b/.test(name)) return true;
        if (/^empire\b/.test(name)) return true;     // Empire BCBS, Empire Plan, The Empire Plan...
        // "Other Blue Plans Empire BCBS - N" and similar.
        if (/\bempire\b/.test(name) && /\bbcbs\b/.test(name)) return true;
        if (isNycePPOIns(insurance)) return true;
        return false;
    }

    // NYCE PPO — its own payer, used by the P/C, SM and OB gating; for the
    // office-visit rule it's covered by isCommercialInsurance above.
    function isNycePPOIns(insurance) {
        return !!insurance && /nyce/i.test(insurance) && /ppo/i.test(insurance);
    }

    // Capitated plans (Hasan Sheikh only) — 99401 Preventive Counseling is
    // never billed for any of these, regardless of anything else.
    function isCapitatedInsurance(insurance) {
        if (!insurance) return false;
        const name = insurance.trim();
        if (/center\s*light/i.test(name)) return true;
        if (/well\s*care/i.test(name)) return true;
        if (/ameri\s*group/i.test(name)) return true;
        return false;
    }

    // ====================== CODE ORDERING (v1.98) ======================
    // ICD: disease codes first, Z codes always below them; chart order is
    // kept inside each group (so the primary disease stays on top).
    function icdRank(code) { return /^Z/i.test(String(code || '').trim()) ? 2 : 1; }

    // CPT: 1 office visit, 2 preventive/counseling, 3 9-series, 4 G0442,
    // 5 G0444, 6 8-series, 7 6-series, 8 4-series, 9 G0108, 10 G0136,
    // 11 3-series (e.g. 36415), 12 everything else. "N-series" = the code's
    // first character, so 3074F sorts with 36415 and 4010F with the 4s.
    const ORDER_OFFICE_VISIT = /^99(20[1-5]|21[1-5])$/;
    const ORDER_PREVENTIVE_COUNSEL = new Set([
        '99381', '99382', '99383', '99384', '99385', '99386', '99387',
        '99391', '99392', '99393', '99394', '99395', '99396', '99397',
        'G0402', 'G0438', 'G0439', '99401', '99402', '99403', '99404', '99406', '99407', 'G0447'
    ]);
    function cptRank(code) {
        const c = String(code || '').trim().toUpperCase();
        if (ORDER_OFFICE_VISIT.test(c)) return 1;
        if (ORDER_PREVENTIVE_COUNSEL.has(c)) return 2;
        if (/^9/.test(c)) return 3;
        if (c === 'G0442') return 4;
        if (c === 'G0444') return 5;
        if (/^8/.test(c)) return 6;
        if (/^6/.test(c)) return 7;
        if (/^4/.test(c)) return 8;
        if (c === 'G0108') return 9;
        if (c === 'G0136') return 10;
        if (/^3/.test(c)) return 11;
        return 12;
    }
    // Stable sort — ties keep their original order.
    function sortByRank(list, rank) {
        return list.map((x, i) => ({ x, i, r: rank(x.code) }))
            .sort((a, b) => a.r - b.r || a.i - b.i)
            .map(o => o.x);
    }
    function isOrdered(list, rank) {
        return list.every((x, i) => i === 0 || rank(list[i - 1].code) <= rank(x.code));
    }

    // Re-orders eCW's own Billing arrays (scope.icdData / scope.cptData) in
    // place so the grids — and what gets saved — follow the rules above.
    async function reorderBillingCodes() {
        const scope = getBillingScope();
        if (!scope) return { ok: false, message: 'Billing screen not found — codes were not re-ordered' };
        let changed = false;
        const reorder = (key, codeOf, rank) => {
            const arr = scope[key];
            if (!Array.isArray(arr)) return;
            const live = arr.filter(Boolean).map(item => ({ code: codeOf(item), item }));
            if (isOrdered(live, rank) && live.length === arr.length) return;
            const sorted = sortByRank(live, rank).map(o => o.item);
            ecwSafeApply(scope, () => { arr.splice(0, arr.length, ...sorted); });
            changed = true;
        };
        reorder('icdData', x => String(x.medicalcode || ''), icdRank);
        reorder('cptData', x => String(x.code || ''), cptRank);
        if (!changed) return { ok: true, message: 'Already in order' };
        await ecwApiSleep(600);
        const ok = isOrdered(readCurrentICD(), icdRank) && isOrdered(readCurrentCPT(), cptRank);
        return ok ? { ok: true } : { ok: false, message: 'eCW did not show the new order — drag the rows into place manually' };
    }

    // ====================== BILLING NAMES FROM eCW (v2.05) ======================
    // Current codes: the name eCW itself holds for the row (scope.icdData /
    // scope.cptData). Proposed codes: eCW's catalog lookup — the same
    // LookupDiagnosisCodes.jsp / LookupCPTCodes.jsp request used to add
    // them — fetched in the background and cached per code.
    function scopeBillingName(kind, code) {
        const sc = getBillingScope();
        if (!sc) return '';
        const arr = kind === 'icd' ? sc.icdData : sc.cptData;
        const hit = (arr || []).find(x => x &&
            String((kind === 'icd' ? x.medicalcode : x.code) || '').trim().toUpperCase() === code);
        const name = hit ? String(hit.name || hit.description || '').trim() : '';
        return kind === 'cpt' && !isUsableCptName(name) ? '' : name;
    }

    const ecwNameCache = new Map();   // 'icd:E11.9' -> name ('' = eCW had none)
    const ecwNamePending = new Set();
    const ecwNameQueue = [];
    let ecwNameWorkers = 0;

    function ecwCatalogName(kind, code, isEm) {
        const key = `${kind}:${String(code).trim().toUpperCase()}`;
        if (ecwNameCache.has(key)) return ecwNameCache.get(key);
        if (!ecwNamePending.has(key) && ecwApiAvailable()) {
            ecwNamePending.add(key);
            ecwNameQueue.push({ key, kind, code: String(code).trim().toUpperCase(), isEm: !!isEm });
            pumpEcwNameQueue();
        }
        return '';
    }

    function pumpEcwNameQueue() {
        while (ecwNameWorkers < 2 && ecwNameQueue.length) {
            const job = ecwNameQueue.shift();
            ecwNameWorkers++;
            (async () => {
                let name = '';
                try {
                    if (job.kind === 'icd') {
                        const results = await ecwFindICD(job.code);
                        const exactIcd = results.filter(x => String(x.code || '').trim().toUpperCase() === job.code);
                        const hit = pickPreferredEntry(job.code, exactIcd);
                        name = hit ? String(hit.name || '').trim() : '';
                    } else {
                        const exact = await ecwFindCPT(job.code, job.isEm);
                        name = exact[0] && isUsableCptName(exact[0].name) ? String(exact[0].name).trim() : '';
                    }
                } catch (e) { name = ''; }
                ecwNameCache.set(job.key, name);
                ecwNamePending.delete(job.key);
                ecwNameWorkers--;
                if (!actionRunning) renderPanel();
                pumpEcwNameQueue();
            })();
        }
    }

    // ====================== CHART READERS ======================
    function readCurrentICD() {
        return getICDRows().map(r => {
            const code = r.code.toUpperCase();
            return { code, name: scopeBillingName('icd', code) || r.name };
        });
    }
    function readCurrentCPT() {
        return getCPTRows().map(r => {
            const cells = r.querySelectorAll('td');
            const code = (cells[1]?.textContent || '').trim().toUpperCase();
            const nameCell = cells[2];
            const name = nameCell ? (nameCell.getAttribute('title') || nameCell.textContent || '').trim() : '';
            const gridName = name.toUpperCase() === code ? '' : name;
            return { code, name: scopeBillingName('cpt', code) || gridName, units: getCPTRowUnits(r) };
        }).filter(x => x.code);
    }
    function hasBillingGrids() {
        return !!document.getElementById('billingTbl2') || !!document.getElementById('billingTbl4');
    }
    function getPatientName() {
        const el = document.querySelector('span[ng-bind*="FULL_NAME"]');
        const raw = el ? (el.getAttribute('title') || el.textContent || '') : '';
        return raw.replace(/,\s*[MFOU]\s*$/i, '').trim();
    }
    function getEncounterKey() {
        const pid = (window.__ecwPatientHistory && window.__ecwPatientHistory.getCurrentKey)
            ? (window.__ecwPatientHistory.getCurrentKey() || '') : '';
        return `${pid}_${getCurrentDOSStr()}`;
    }

    // ====================== QUICK-ACTION PLANS (v1.98) ======================
    // PV / P-C / SM / OB no longer write to the chart on click. Each builds
    // a plan (codes to add + codes to remove) that is merged into the
    // Coding tab's proposed changes — reviewed, unticked if needed, then
    // applied with Add to EMR. Only one plan at a time (same mutual
    // exclusivity the old bundles had); clicking the active one again
    // removes it.
    let activeQuick = null;
    let activePlan = null;
    const QUICK_LABELS = { pv: 'Preventive', pc: 'Preventive Counseling', sm: 'Smoking Counseling', ob: 'Obesity Counseling' };

    function planDeletesPresent(icdCodes, cptCodes, reason) {
        const out = [];
        const icdSet = new Set(icdCodes.map(c => c.toUpperCase()));
        const cptSet = new Set(cptCodes.map(c => c.toUpperCase()));
        readCurrentICD().forEach(r => { if (icdSet.has(r.code)) out.push({ code: r.code, kind: 'icd', reason }); });
        readCurrentCPT().forEach(r => { if (cptSet.has(r.code)) out.push({ code: r.code, kind: 'cpt', reason }); });
        return out;
    }

    function planClearOtherBundles(current) {
        const reason = `Replaced by ${QUICK_LABELS[current]}`;
        let out = [];
        if (current !== 'pv') out = out.concat(planDeletesPresent(['Z00.01', 'Z00.121'], [...ALL_PREVENTIVE_EM_CODES, ...MEDICARE_AWV_CODES], reason));
        if (current !== 'pv' && current !== 'pc') out = out.concat(planDeletesPresent(['Z71.3', 'Z71.82', 'Z71.89'], [], reason));
        if (current !== 'pc') out = out.concat(planDeletesPresent([], ['99401'], reason));
        if (current !== 'sm') out = out.concat(planDeletesPresent([], ['99406'], reason));
        if (current !== 'ob') out = out.concat(planDeletesPresent([], ['G0447'], reason));
        if (current !== 'pv' && current !== 'ob') {
            readCurrentICD().filter(r => /^Z68\./.test(r.code)).forEach(r => out.push({ code: r.code, kind: 'icd', reason }));
        }
        return out;
    }

    const NOT_WITH_99214 = { pc: '99401', sm: '99406' };
    function blockedBy99214(kind) {
        return !!NOT_WITH_99214[kind] && !!(analysisState && analysisState.officeVisitWillBe99214);
    }

    function buildQuickPlan(kind) {
        if (blockedBy99214(kind)) {
            return { error: `Office visit is 99214 — ${NOT_WITH_99214[kind]} is not billed together with 99214` };
        }
        if (kind !== 'pv') {
            const blocking = getHighLevelBlockingCode();
            if (blocking) return { error: `${blocking} is on the chart — counseling codes can't be added alongside it` };
        }
        const text = getEncounterText();
        const insurance = parseInsuranceFromPage(text);
        const flags = extractClinicalFlags(text);
        const gating = computeQuickActionGating(insurance, flags, text);
        if (gating[kind].disabled) return { error: gating[kind].title };

        const age = getAgeAtDOS(text);
        const gender = getGenderFromDOM();
        const bmi = parseFloat(snapshotExtract(text, /BMI:\s*(\d{1,3}(?:\.\d{1,2})?)/i)) || null;
        const ccText = getChiefComplaintTextFast(text);
        const icdEntries = getICDGridEntriesFast();
        const toAdd = [];
        const toDelete = planClearOtherBundles(kind);
        let dropAdds = [];   // codes the analysis must NOT add while this plan is active
        const addIcd = (code, reason, extra) => toAdd.push(Object.assign({ code, kind: 'icd', reason }, extra || {}));
        const addCpt = (code, reason, extra) => toAdd.push(Object.assign({ code, kind: 'cpt', reason }, extra || {}));
        const addZ71Pair = label => {
            const z71 = determineZ71CodeFast(age, gender, ccText, icdEntries);
            addIcd('Z71.3', `${label} bundle`);
            addIcd(z71, z71 === 'Z71.89' ? `${label} bundle (other counseling)` : `${label} bundle (exercise counseling)`);
            toDelete.push(...planDeletesPresent([z71 === 'Z71.89' ? 'Z71.82' : 'Z71.89'], [], `Replaced by ${z71}`));
        };

        if (kind === 'pv') {
            const api = window.__ecwPatientHistory;
            if (api && api.isLoading && api.isLoading()) return { error: 'Patient history is still loading — try again in a moment' };
            if (age == null) return { error: 'Could not determine patient age' };
            const examCode = age >= 18 ? 'Z00.01' : 'Z00.121';
            addIcd(examCode, 'Preventive visit');
            toDelete.push(...planDeletesPresent(['Z00.00', 'Z00.01', 'Z00.121', 'Z00.129'].filter(c => c !== examCode), [],
                `Only one general-exam code per visit — ${examCode}`));
            const z68 = mapBMIToZ68(bmi, age);
            if (z68) addIcd(z68, `BMI ${bmi}`);
            addZ71Pair('Preventive');
            const established = isEstablishedPatient();
            if (isCommercialInsurance(insurance)) {
                toDelete.push(...planDeletesPresent([], OFFICE_VISIT_EM_CODES,
                    'Commercial insurance — office-visit E/M code not billed with a Preventive visit'));
                dropAdds = OFFICE_VISIT_EM_CODES.slice();
            }
            if (isVNSChoiceIns(insurance) || isAnyMedicareIns(insurance)) {
                const awv = established ? 'G0439' : 'G0438';
                addCpt(awv, `${isVNSChoiceIns(insurance) ? 'VNS Choice' : 'Medicare'} wellness visit, ${established ? 'established' : 'new'} patient`);
                toDelete.push(...planDeletesPresent([], [...ALL_PREVENTIVE_EM_CODES, ...MEDICARE_AWV_CODES.filter(c => c !== awv)], `Replaced by ${awv}`));
            } else {
                const em = mapAgeToPreventiveCPT(age, established);
                if (!em) return { error: 'Could not pick a preventive E&M code' };
                toAdd.push({ code: em, kind: 'em', emCategory: 'Preventive Medicine', emIsNewPatient: !established, reason: `Preventive, ${established ? 'established' : 'new'} patient, age ${age}` });
                toDelete.push(...planDeletesPresent([], [...MEDICARE_AWV_CODES, ...ALL_PREVENTIVE_EM_CODES.filter(c => c !== em)], `Replaced by ${em}`));
            }
        } else if (kind === 'pc') {
            if (isPreventiveCounselBlockedIns(insurance)) return { error: `Not applicable for ${insurance || 'this insurance'}` };
            if (age == null) return { error: 'Could not determine patient age' };
            addZ71Pair('Preventive Counseling');
            addCpt('99401', 'Preventive Counseling');
        } else if (kind === 'sm') {
            if (flags.hasSmoker !== false) return { error: 'Patient is not a confirmed smoker' };
            addIcd('F17.210', 'Confirmed smoker');
            addCpt('99406', 'Smoking counseling');
        } else if (kind === 'ob') {
            if (insurance && /medicaid/i.test(insurance.trim())) return { error: 'Not applicable for Medicaid' };
            if (age != null && age < 18) {
                const pct = parseFloat(snapshotExtract(text, /BMI\s*%:\s*(\d{1,3}(?:\.\d{1,2})?)\s*%/i)) || null;
                if (pct == null) return { error: 'BMI percentile not found on this note' };
                if (pct < 95) return { error: `BMI percentile ${pct}% is under the 95th percentile` };
            } else {
                if (bmi == null) return { error: 'BMI not found on this note' };
                if (bmi < 30) return { error: `BMI ${bmi} is under 30` };
            }
            let obesityCode = 'E66.9';
            if (bmi >= 50) obesityCode = 'E66.09';
            else if (bmi >= 40) obesityCode = 'E66.01';
            addIcd(obesityCode, obesityCode === 'E66.09'
                ? `BMI ${bmi} — severe obesity is a sensitive diagnosis, tick only if the provider documented it`
                : `BMI ${bmi}`, obesityCode === 'E66.09' ? { needsReview: true } : null);
            const z68 = mapBMIToZ68(bmi, age);
            if (z68) addIcd(z68, `BMI ${bmi}`);
            addCpt('G0447', 'Obesity counseling');
        }

        const addSet = new Set(toAdd.map(a => a.code.toUpperCase()));
        const seen = new Set();
        return {
            dropAdds,
            toAdd,
            toDelete: toDelete.filter(d => {
                const c = d.code.toUpperCase();
                if (addSet.has(c) || seen.has(c)) return false;
                seen.add(c);
                return true;
            })
        };
    }

    function toggleQuickAction(kind) {
        if (actionRunning) return;
        if (activeQuick === kind) {
            activeQuick = null; activePlan = null;
            renderPanel();
            showToast(`${QUICK_LABELS[kind]} removed from the proposal`);
            return;
        }
        const plan = buildQuickPlan(kind);
        if (plan.error) { showToast(`${QUICK_LABELS[kind]}: ${plan.error}`); return; }
        activeQuick = kind; activePlan = plan;
        renderPanel();
        showToast(`${QUICK_LABELS[kind]} codes added to the proposal — review, then Add to EMR`);
    }

    // ====================== PROPOSAL (analysis + quick plan) ======================
    let pick = {};              // 'a:CODE' / 'd:CODE' -> true (apply) / false (skip)
    let lastAnalysisSig = '';
    let lastEncounterKey = '';
    let resultNotice = null;    // { ok, lines[] } shown after Add to EMR
    // After Add to EMR the columns show Previous (chart before the click) vs
    // Current (chart now) — { icd, cpt, at, sig }. It ends by itself when
    // the chart changes again, the rules propose more changes, or the
    // patient/encounter changes. No extra click needed.
    let reviewState = null;
    // Which codes are on the chart, ignoring their order (v2.26: eCW
    // redrawing the grid in the new order after Add to EMR must not count
    // as a change).
    function chartCodeSig() {
        return readCurrentICD().map(x => x.code).sort().join(',') + '|' +
            readCurrentCPT().map(x => `${x.code}x${x.units}`).sort().join(',');
    }
    // Code set whose ordering Add to EMR already tried; a leftover order
    // difference on that same set never re-enables the button on its own.
    let reorderTriedSig = '';
    // ---- Smart Sort (shared/sort.js) and Link (link.js) hooks ----
    function smartSortOn() {
        return !!(PILOT && PILOT.isEnabled && PILOT.isEnabled('sort') && PILOT.smartSort);
    }
    function linkOn() {
        return !!(PILOT && PILOT.linkMode && PILOT.linkMode() !== 'off');
    }
    // Order a list of {code} items the way the chart will be ordered:
    // Smart Sort's lists when it's on, the basic ranks otherwise.
    function orderItems(list, kind) {
        if (smartSortOn()) {
            const fn = kind === 'icd' ? PILOT.smartSort.orderICDCodes : PILOT.smartSort.orderCPTCodes;
            const order = fn(list.map(x => x.code));
            const pool = list.slice();
            return order.map(c => { const i = pool.findIndex(x => x.code === c); return pool.splice(i, 1)[0]; });
        }
        return sortByRank(list, kind === 'icd' ? icdRank : cptRank);
    }
    function isInOrder(list, kind) {
        if (smartSortOn()) return orderItems(list, kind).every((x, i) => x === list[i]);
        return isOrdered(list, kind === 'icd' ? icdRank : cptRank);
    }

    // Smart Sort: primary diagnosis missing, or modifiers not as planned?
    function smartTidyNeeded() {
        if (!smartSortOn()) return false;
        const sc = getBillingScope();
        if (!sc) return false;
        const sig = chartCodeSig() + '|' + JSON.stringify([...currentModifiers()]) + '|' + livePrimaryCode();
        if (sig === smartTriedSig) return false;
        const icd = sc.icdData || [];
        const noPrimary = icd.length && !(PILOT.smartSort.hasPrimary ? PILOT.smartSort.hasPrimary() : icd.some(r => r && String(r.isPrimaryAsmt) === '1')) &&
            icd.some(r => r && PILOT.smartSort.isPrimaryAllowedICD(r.medicalcode));
        const mods = currentModifiers();
        const codes = [...mods.keys()];
        const plan = PILOT.smartSort.planModifiers(codes.map(c => ({ code: c, mod1: mods.get(c) })));
        const sl = new Set(PILOT.linkSLCodes && linkOn() ? PILOT.linkSLCodes(codes) : []);
        const modsOff = codes.some(c => (sl.has(c) ? 'SL' : (plan.get(c) || '')) !== (mods.get(c) || ''));
        return !!(noPrimary || modsOff);
    }
    let smartTriedSig = '';

    function reorderStillNeeded() {
        if (isInOrder(readCurrentICD(), 'icd') && isInOrder(readCurrentCPT(), 'cpt')) return false;
        return chartCodeSig() !== reorderTriedSig;
    }
    function pendingChangeCount() {
        const prop = buildProposal();
        return prop.toAdd.filter(a => isPicked('a', a)).length + prop.toDelete.filter(d => isPicked('d', d)).length;
    }
    function reviewActive() {
        if (!reviewState || !hasBillingGrids()) return false;
        if (chartCodeSig() !== reviewState.sig || pendingChangeCount() > 0 || smartTidyNeeded()) { reviewState = null; return false; }
        return true;
    }

    function keyOf(prefix, code) { return `${prefix}:${String(code).toUpperCase()}`; }
    function isPicked(prefix, item) {
        const k = keyOf(prefix, item.code);
        return Object.prototype.hasOwnProperty.call(pick, k) ? pick[k] : !item.needsReview;
    }

    // Same code-based blockers as the Weekend rule in computeAnalysis: any
    // 9-series code except 99000, 99051 and the office-visit codes; the
    // Medicare AWV codes; 99406; Pap / Advance Care / TCM (G0447 is allowed
    // since v2.32). Returns
    // the first blocking code in `codes`, or null.
    function weekendBlockingCode(codes) {
        const HIGH_LEVEL = ['Q0091', 'G0101', '99497', '99495', '99496'];
        for (const c of codes) {
            if (c === '99051' || c === '99000') continue;
            if (/^9/.test(c) && !OFFICE_VISIT_EM_CODES.includes(c)) return c;
            if (MEDICARE_AWV_CODES.includes(c) || c === '99406' || HIGH_LEVEL.includes(c)) return c; // G0447 allowed (v2.32)
        }
        return null;
    }

    function buildProposal() {
        const base = analysisState || { toAdd: [], toDelete: [] };
        let toAdd = base.toAdd.slice();
        let toDelete = base.toDelete.slice();
        if (activePlan) {
            const pAdd = new Set(activePlan.toAdd.map(a => a.code.toUpperCase()));
            const pDel = new Set(activePlan.toDelete.map(d => d.code.toUpperCase()));
            const pDrop = new Set((activePlan.dropAdds || []).map(c => c.toUpperCase()));
            toDelete = toDelete.filter(d => !pAdd.has(d.code.toUpperCase()));
            toAdd = toAdd.filter(a => !pDel.has(a.code.toUpperCase()) && !pAdd.has(a.code.toUpperCase()) && !pDrop.has(a.code.toUpperCase()));
            toAdd = toAdd.concat(activePlan.toAdd.map(a => Object.assign({}, a, { fromQuick: activeQuick })));
            activePlan.toDelete.forEach(d => {
                if (!toDelete.some(x => x.code.toUpperCase() === d.code.toUpperCase())) {
                    toDelete.push(Object.assign({}, d, { fromQuick: activeQuick }));
                }
            });
        }
        // 99401/99406 never go in with 99214, whatever added them.
        if (analysisState && analysisState.officeVisitWillBe99214) {
            toAdd = toAdd.filter(a => a.code.toUpperCase() !== '99401' && a.code.toUpperCase() !== '99406');
        }
        const icdNow = new Set(readCurrentICD().map(x => x.code));
        const cptNow = new Set(readCurrentCPT().map(x => x.code));
        const seenA = new Set(), seenD = new Set();
        toAdd = toAdd.filter(a => {
            const c = a.code.toUpperCase();
            if (seenA.has(c)) return false;
            seenA.add(c);
            if (a.kind === 'vaxadmin') return true; // may be a units update on an existing row
            return a.kind === 'icd' ? !icdNow.has(c) : !cptNow.has(c);
        });
        toDelete = toDelete.filter(d => {
            const c = d.code.toUpperCase();
            if (seenD.has(c)) return false;
            seenD.add(c);
            return d.kind === 'icd' ? icdNow.has(c) : cptNow.has(c);
        });

        // v2.34: Weekend (99051) decided against the FINAL procedure list —
        // the chart plus every ticked addition, minus every ticked removal.
        //  - a blocker being ADDED (99401, 99406, preventive, vaccine admin,
        //    Pap/TCM/Advance Care...) keeps 99051 out / removes it;
        //  - a blocker being REMOVED no longer counts, so 99051 stays (or is
        //    proposed) — e.g. 99401 removed + G0447 added keeps 99051.
        // Insurance (UHC family, NYCE PPO), televisit and the Weekend toggle
        // still decide on their own (weekendHardBlock from computeAnalysis).
        if (analysisState) {
            const delPicked = new Set(toDelete.filter(d => d.kind !== 'icd' && isPicked('d', d)).map(d => d.code.toUpperCase()));
            const finalCpt = new Set([
                ...[...cptNow].filter(c => !delPicked.has(c)),
                ...toAdd.filter(a => a.kind !== 'icd' && isPicked('a', a)).map(a => a.code.toUpperCase())
            ]);
            const hard = analysisState.weekendHardBlock;
            const blocker = hard ? null : weekendBlockingCode(finalCpt);
            const allowed = !hard && !blocker;
            if (allowed) {
                // keep it: drop any removal, propose it if it isn't on the chart
                toDelete = toDelete.filter(d => d.code.toUpperCase() !== '99051');
                if (!cptNow.has('99051') && !toAdd.some(a => a.code.toUpperCase() === '99051')) {
                    toAdd.push({ code: '99051', kind: 'cpt', reason: 'Weekend/holiday visit, no blocking code on the final claim' });
                }
            } else {
                toAdd = toAdd.filter(a => a.code.toUpperCase() !== '99051');
                const why = hard || `Weekend (99051) can't be billed with ${blocker}`;
                const existing = toDelete.find(d => d.code.toUpperCase() === '99051');
                if (existing) existing.reason = why;
                else if (cptNow.has('99051')) toDelete.push({ code: '99051', kind: 'cpt', reason: why });
            }
        }
        // Excluded codes are never added or removed.
        toAdd = toAdd.filter(a => !isExcludedCode(a));
        toDelete = toDelete.filter(d => !isExcludedCode(d));
        return { toAdd, toDelete };
    }

    function splitProposal(prop) {
        const isIcd = x => x.kind === 'icd';
        return {
            icdAdds: prop.toAdd.filter(isIcd), cptAdds: prop.toAdd.filter(x => !isIcd(x)),
            icdDels: prop.toDelete.filter(isIcd), cptDels: prop.toDelete.filter(x => !isIcd(x))
        };
    }

    // Re-run the rule engine only when the chart or its inputs changed.
    function refreshAnalysisIfNeeded() {
        if (actionRunning || !hasBillingGrids()) return;
        const api = window.__ecwPatientHistory;
        const sig = [
            getEncounterKey(),
            readCurrentICD().map(x => x.code).join(','),
            readCurrentCPT().map(x => `${x.code}x${x.units}`).join(','),
            isWeekendEnabled() ? 'W' : '',
            api && api.isLoading && api.isLoading() ? 'L' : (api && api.getEncounterCount ? api.getEncounterCount() : 0),
            (cachedEncounterText || '').length
        ].join('|');
        if (sig === lastAnalysisSig) return;
        lastAnalysisSig = sig;
        try { analysisState = computeAnalysis(); } catch (err) { console.error('ECW Pilot analysis failed', err); analysisState = { toAdd: [], toDelete: [] }; }
        if (activeQuick) {
            const plan = buildQuickPlan(activeQuick);
            if (plan.error) {
                showToast(`${QUICK_LABELS[activeQuick]} removed: ${plan.error}`);
                activeQuick = null; activePlan = null;
            } else {
                activePlan = plan;
            }
        }
    }

    // ====================== ADD TO EMR ======================
    function setBusyStatus(text, fraction) {
        const sum = document.getElementById('smcFootSum');
        if (sum) sum.innerHTML = text;
        const bar = document.querySelector('#smcPanel .smc-progress i');
        if (bar) bar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    }

    async function addToEMR() {
        if (actionRunning || !hasBillingGrids()) return;
        if (!historyReadyState().ready) { showToast('Add to EMR is available once patient history has finished loading'); return; }
        const prop = buildProposal();
        const beforeSnapshot = { icd: readCurrentICD(), cpt: readCurrentCPT() };
        const dels = prop.toDelete.filter(d => isPicked('d', d));
        const adds = prop.toAdd.filter(a => isPicked('a', a));
        const total = dels.length + adds.length + 1;
        let step = 0;
        const apiMissing = ecwApiAvailable() ? [] : ecwApiMissing();
        actionRunning = true;
        if (PILOT) PILOT.busy = true;   // auto-link waits until Add to EMR is done
        actionLog = [];
        resultNotice = null;
        panel.classList.add('busy');
        renderPanel(true);

        for (const item of dels) {
            step++;
            setBusyStatus(`Removing <b>${escapeHtml(item.code)}</b> (${step} of ${total})`, step / total);
            let result;
            result = await ecwRemoveCodeNoWarning(item.kind === 'icd' ? 'icd' : 'cpt', item.code);
            actionLog.push({
                code: item.code, action: 'delete', kind: item.kind === 'icd' ? 'icd' : 'cpt',
                status: result.ok ? 'success' : 'fail',
                message: result.blocked ? "eCW won't allow deleting this here (no delete permission, or mapped elsewhere such as Patient Tracking) — remove it manually"
                    : (result.unavailable ? "eCW's remove function isn't available on this page — open the Billing tab and try again" : undefined)
            });
        }

        for (const item of adds) {
            step++;
            setBusyStatus(`Adding <b>${escapeHtml(item.code)}</b> (${step} of ${total})`, step / total);
            let ok = false, message;
            if (item.kind === 'icd') {
                const results = await addICDCodesFast([item.code]);
                ok = !!results[0]?.ok;
            } else if (item.kind === 'em') {
                const r = await addEMTreeCode(item.code, item.emCategory, item.emIsNewPatient);
                ok = r.ok; message = r.message;
            } else if (item.kind === 'vaxadmin') {
                ok = true;
                if (!getCPTRowByCode(item.code)) { const r = await addSingleCPT(item.code); ok = r.ok; message = r.message; }
                if (ok && item.units) {
                    const u = await setCPTUnitsByCode(item.code, item.units);
                    if (!u.ok) message = 'Added, but Units could not be set — set it manually';
                }
            } else {
                const r = await addSingleCPT(item.code);
                ok = r.ok; message = r.message;
            }
            actionLog.push({ code: item.code, action: 'add', kind: item.kind === 'icd' ? 'icd' : 'cpt', status: ok ? 'success' : 'fail', message });
        }

        // eCW sometimes shows a row, then silently drops it a moment later
        // (duplicate/modifier/insurance rejection) — confirm each change stuck.
        if (actionLog.length) {
            setBusyStatus('Checking that every change stuck…', (total - 0.5) / total);
            const pollUntilStable = async (checkFn, totalMs, intervalMs) => {
                let last = checkFn(), stable = 1;
                const start = Date.now();
                while (Date.now() - start < totalMs) {
                    await new Promise(r => setTimeout(r, intervalMs));
                    const cur = checkFn();
                    if (cur === last) { if (++stable >= 2) return cur; } else { stable = 1; last = cur; }
                }
                return last;
            };
            await Promise.all(actionLog.filter(e => e.status === 'success').map(async entry => {
                const sc = getBillingScope();
                const checkFn = entry.kind === 'icd'
                    ? () => !!findICDRowByCodeFast(entry.code) || (!!sc && ecwScopeHasICD(sc, entry.code.toUpperCase()))
                    : () => !!getCPTRowByCode(entry.code) || (!!sc && ecwScopeHasCPT(sc, entry.code.toUpperCase()));
                const present = await pollUntilStable(checkFn, 4500, 400);
                if (entry.action === 'add' && !present) { entry.status = 'fail'; entry.message = 'Disappeared after a moment — eCW rejected it (duplicate, modifier or insurance rule)'; }
                if (entry.action === 'delete' && present) { entry.status = 'fail'; entry.message = 'Came back after a moment — the removal did not stick'; }
            }));
        }

        let order, smart = null;
        if (smartSortOn()) {
            setBusyStatus('Smart Sort: ordering, primary diagnosis, modifiers…', 1);
            try { smart = await PILOT.smartSort.run(); } catch (e) { console.error('ECW Pilot: Smart Sort failed', e); }
            await ecwApiSleep(600);
            order = smart && smart.ok ? { ok: true } : { ok: false, message: 'Smart Sort could not reach the Billing grids — codes were not re-ordered' };
        } else {
            setBusyStatus('Putting codes in order…', 1);
            order = await reorderBillingCodes();
        }
        reorderTriedSig = chartCodeSig();

        // Last step (Link = Auto): set every CPT's ICD pointers and modifiers
        // from the Link rules, on the final, ordered code list.
        let linked = null;
        if (PILOT && PILOT.linkNow && PILOT.linkMode && PILOT.linkMode() === 'auto') {
            setBusyStatus('Linking diagnosis pointers…', 1);
            await ecwApiSleep(300);
            try { linked = PILOT.linkNow(); } catch (e) { console.error('ECW Pilot: linking after Add to EMR failed', e); }
        }

        smartTriedSig = chartCodeSig() + '|' + JSON.stringify([...currentModifiers()]) + '|' + livePrimaryCode();
        const fails = actionLog.filter(e => e.status === 'fail');
        const done = actionLog.length - fails.length;
        const lines = fails.map(f => `${f.code} — could not ${f.action === 'add' ? 'add' : 'remove'}${f.message ? `: ${f.message}` : ''}`);
        if (!order.ok) lines.push(order.message);
        if (smart && smart.primary && !smart.primary.set && !smart.primary.already && smart.primary.reason) {
            lines.push(`Primary diagnosis not set: ${smart.primary.reason}`);
        }
        if (apiMissing.length) lines.push(`eCW Billing method unavailable (missing: ${apiMissing.join(', ')}) — codes were typed in the old way, and E&M codes went through the E&M picker. Run smcDiagnose() in the console for details.`);
        reviewState = { icd: beforeSnapshot.icd, cpt: beforeSnapshot.cpt, at: new Date(), sig: chartCodeSig() };
        const afterIcd = new Set(readCurrentICD().map(x => x.code)), afterCpt = new Set(readCurrentCPT().map(x => x.code));
        const beforeIcd = new Set(beforeSnapshot.icd.map(x => x.code)), beforeCpt = new Set(beforeSnapshot.cpt.map(x => x.code));
        const addedCodes = [...[...afterIcd].filter(c => !beforeIcd.has(c)), ...[...afterCpt].filter(c => !beforeCpt.has(c))];
        const removedCodes = [...[...beforeIcd].filter(c => !afterIcd.has(c)), ...[...beforeCpt].filter(c => !afterCpt.has(c))];
        const changeSummary = [addedCodes.length ? `Added: ${addedCodes.join(', ')}` : '', removedCodes.length ? `Removed: ${removedCodes.join(', ')}` : '',
            smart && smart.primary && smart.primary.set ? `Primary: ${smart.primary.code}` : '',
            smart && smart.modifiersChanged ? `Modifiers updated on ${smart.modifiersChanged} code${smart.modifiersChanged === 1 ? '' : 's'}` : '',
            linked && linked.rows ? `Linked ${linked.rows} procedure${linked.rows === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
        resultNotice = {
            ok: !lines.length,
            title: lines.length
                ? `${done} of ${actionLog.length} changes applied. Needs attention:`
                : `Added to EMR — ${done} change${done === 1 ? '' : 's'} applied${order.message === 'Already in order' ? '' : ', codes in order'}.`,
            lines,
            summary: changeSummary
        };

        actionRunning = false;
        if (PILOT) PILOT.busy = false;
        activeQuick = null; activePlan = null;
        pick = {};
        analysisState = null;
        lastAnalysisSig = '';
        panel.classList.remove('busy');
        setBusyStatus('', 0);
        renderPanel(true);
        showToast(resultNotice.ok ? 'Added to EMR' : 'Added to EMR with problems — see the Coding tab');
    }

    // ====================== RENDER: CODING ======================
    // ---- Primary diagnosis marker ----
    // Live primary = eCW's primaryArr (what the ★ shows); the saved
    // isPrimaryAsmt flag only if eCW has no primaryArr.
    function livePrimaryCode() {
        const ng = pageGlobal('angular');
        const el = document.querySelector('#billingTbl2');
        if (!el || !ng || !ng.element) return '';
        let sc = null;
        try { sc = ng.element(el).scope(); } catch (e) { return ''; }
        while (sc && !Array.isArray(sc.icdData)) sc = sc.$parent;
        if (!sc) return '';
        let p = sc;
        while (p && !Array.isArray(p.primaryArr)) p = p.$parent;
        const codes = sc.icdData.map(r => String(r && r.medicalcode || '').trim().toUpperCase());
        if (p) return p.primaryArr.map(c => String(c || '').trim().toUpperCase()).find(c => codes.includes(c)) || '';
        const f = sc.icdData.find(r => r && String(r.isPrimaryAsmt) === '1');
        return f ? String(f.medicalcode || '').trim().toUpperCase() : '';
    }
    // Which diagnosis will be primary after the ticked changes:
    //  - the current one, if it stays;
    //  - if it's removed, eCW moves primary to the next diagnosis after it;
    //  - none at all + Smart Sort on → the one Smart Sort will pick.
    function predictedPrimary(current, adds, dels) {
        const live = livePrimaryCode();
        const delSet = new Set(dels.filter(d => isPicked('d', d)).map(d => d.code.toUpperCase()));
        if (live && !delSet.has(live)) return { code: live, will: false };
        if (live) {
            const i = current.findIndex(x => x.code === live);
            const next = current.slice(i + 1).find(x => !delSet.has(x.code));
            if (next) return { code: next.code, will: true, why: `${live} is removed — eCW moves primary to the next diagnosis` };
        }
        if (smartSortOn()) {
            const finalList = orderItems([
                ...current.filter(x => !delSet.has(x.code)),
                ...adds.filter(a => isPicked('a', a)).map(a => ({ code: a.code.toUpperCase() }))
            ], 'icd');
            const pick = finalList.find(x => PILOT.smartSort.isPrimaryAllowedICD(x.code));
            if (pick) return { code: pick.code, will: true, why: 'No primary set — Smart Sort sets it at Add to EMR' };
        }
        return null;
    }
    const primaryTag = (will, why) => `<span class="smc-tag smc-prim" title="${escapeHtml(why || 'Primary diagnosis')}">PRIMARY${will ? ' · will be set' : ''}</span>`;

    function currentColumnHtml(current, dels, isIcd) {
        const prim = isIcd ? livePrimaryCode() : '';
        if (!current.length) return `<div class="smc-empty">None on the chart</div>`;
        const delMap = new Map(dels.map(d => [d.code.toUpperCase(), d]));
        return current.map((x, i) => {
            const d = delMap.get(x.code);
            const units = x.units && x.units !== 1 ? `<span class="smc-tag">× ${x.units}</span>` : '';
            const isPrim = !!prim && x.code === prim;
            const pTag = isPrim ? primaryTag(false) : '';
            if (!d) {
                return `<div class="smc-row ${isPrim ? 'primary' : ''}"><span class="mk"><span class="smc-num">${i + 1}</span></span>
                    <div><div class="smc-code"><b>${escapeHtml(x.code)}</b>${units}${pTag}</div><div class="smc-name" title="${escapeHtml(x.name)}">${escapeHtml(x.name)}</div></div></div>`;
            }
            const on = isPicked('d', d);
            return `<label class="smc-row del ${on ? '' : 'off'} ${isPrim ? 'primary' : ''}" title="${escapeHtml(d.reason)}">
                <span class="mk"><input type="checkbox" data-k="${escapeHtml(keyOf('d', x.code))}" ${on ? 'checked' : ''} aria-label="Remove ${escapeHtml(x.code)}"></span>
                <div><div class="smc-code"><b>${escapeHtml(x.code)}</b>${units}${pTag}</div><div class="smc-name">${escapeHtml(x.name)}</div>
                <div class="smc-why">${on ? 'Remove — ' : 'Keeping — '}${escapeHtml(d.reason)}</div></div></label>`;
        }).join('');
    }

    function afterColumnHtml(current, adds, dels, rank) {
        const delSet = new Set(dels.filter(d => isPicked('d', d)).map(d => d.code.toUpperCase()));
        const addCodes = new Set(adds.map(a => a.code.toUpperCase()));
        const items = orderItems([
            ...current.filter(x => !delSet.has(x.code) && !addCodes.has(x.code)).map(x => Object.assign({}, x, { t: 'kept' })),
            ...adds.map(a => Object.assign({}, a, { t: 'add', isUpdate: current.some(x => x.code === a.code.toUpperCase()) }))
        ], rank === icdRank ? 'icd' : 'cpt');
        if (!items.length) return `<div class="smc-empty">Nothing left</div>`;
        const pred = rank === icdRank ? predictedPrimary(current, adds, dels) : null;
        const pTagFor = code => (pred && pred.code === code ? primaryTag(pred.will, pred.why) : '');
        const pCls = code => (pred && pred.code === code ? 'primary' : '');
        let n = 0;
        return items.map(x => {
            if (x.t === 'kept') {
                n++;
                const units = x.units && x.units !== 1 ? `<span class="smc-tag">× ${x.units}</span>` : '';
                return `<div class="smc-row ${pCls(x.code)}"><span class="mk"><span class="smc-num">${n}</span></span>
                    <div><div class="smc-code"><b>${escapeHtml(x.code)}</b>${units}${pTagFor(x.code)}</div><div class="smc-name" title="${escapeHtml(x.name)}">${escapeHtml(x.name)}</div></div></div>`;
            }
            const on = isPicked('a', x);
            if (on) n++;
            const tags = [
                x.isUpdate ? `<span class="smc-tag">units → ${escapeHtml(x.units)}</span>` : (x.units && x.units !== 1 ? `<span class="smc-tag">× ${escapeHtml(x.units)}</span>` : ''),
                x.fromQuick ? `<span class="smc-tag">${escapeHtml(x.fromQuick.toUpperCase())}</span>` : '',
                on ? '' : `<span class="smc-tag">skipped</span>`
            ].join('');
            const code = x.code.toUpperCase();
            const billingName = x.kind === 'icd'
                ? ecwCatalogName('icd', code)
                : (current.find(c => c.code === code)?.name || ecwCatalogName('cpt', code, x.kind === 'em' || isEmCode(code)));
            const nameLine = billingName
                ? `<div class="smc-name" title="${escapeHtml(billingName)}">${escapeHtml(billingName)}</div>`
                : '';
            return `<label class="smc-row add ${on ? '' : 'off'} ${x.needsReview ? 'review' : ''} ${pCls(code)}" title="${escapeHtml(billingName ? billingName + ' — ' + x.reason : x.reason)}">
                <span class="mk"><input type="checkbox" data-k="${escapeHtml(keyOf('a', x.code))}" ${on ? 'checked' : ''} aria-label="Add ${escapeHtml(x.code)}"></span>
                <div><div class="smc-code"><b>${escapeHtml(x.code)}</b>${tags}${pTagFor(code)}</div>${nameLine}
                <div class="smc-why">${escapeHtml(x.reason)}</div></div></label>`;
        }).join('');
    }

    function afterCount(current, adds, dels) {
        const delSet = new Set(dels.filter(d => isPicked('d', d)).map(d => d.code.toUpperCase()));
        const addCodes = new Set(adds.map(a => a.code.toUpperCase()));
        return current.filter(x => !delSet.has(x.code) && !addCodes.has(x.code)).length + adds.filter(a => isPicked('a', a)).length;
    }

    function sumHtml(adds, dels, orderFix) {
        const a = adds.filter(x => isPicked('a', x)).length;
        const d = dels.filter(x => isPicked('d', x)).length;
        const parts = [];
        if (a) parts.push(`<span class="a">+${a}</span>`);
        if (d) parts.push(`<span class="d">−${d}</span>`);
        if (orderFix) parts.push(`<span class="o">order fixed</span>`);
        return parts.length ? parts.join(' ') : 'no changes';
    }

    function diffBlockHtml(title, current, adds, dels, rank, extra) {
        const orderFix = !isInOrder(current, rank === icdRank ? 'icd' : 'cpt');
        return `<div class="smc-block">
            <div class="smc-block-head"><h2>${title}</h2><span class="smc-sum">${sumHtml(adds, dels, orderFix)}</span></div>
            <div class="smc-diff">
                <div class="smc-col"><div class="smc-col-h">Current <span>${current.length}</span></div>${currentColumnHtml(current, dels, rank === icdRank)}</div>
                <div class="smc-col"><div class="smc-col-h">After changes <span>${afterCount(current, adds, dels)}</span></div>${afterColumnHtml(current, adds, dels, rank)}</div>
            </div>${extra || ''}
        </div>`;
    }

    function contextHtml() {
        const text = getEncounterText();
        const insurance = parseInsuranceFromPage(text);
        const flags = extractClinicalFlags(text);
        const { hasDep, hasSmoker, hasOtherTobacco, hasAlc, hasSocialNeeds } = flags;
        const gating = computeQuickActionGating(insurance, flags, text);
        const age = getAgeAtDOS(text);
        const isPediatric = age != null && age > 0 && age < 18;

        const ccRaw = text.match(/Chief Complaint\(s\)\s*:?\s*([\s\S]+?)(?=\n\s*\n|\n\s*(?:Subjective|Objective|HPI|History|Assessment|Plan|Review|Physical|Vital|Social|Family|Medical|Surgical)\b|$)/i);
        const ccLines = ccRaw ? ccRaw[1].split(/\r?\n/).map(l => l.replace(/^[\s•\-\*·]+/, '').trim()).filter(Boolean) : [];

        const chips = [];
        const bp = snapshotExtract(text, /BP:\s*(\d{2,3}\/\s*\d{2,3})/i);
        if (bp) {
            const [sys, dia] = bp.split('/').map(n => parseInt(n));
            const high = sys > 139 || dia > 89;
            // v1.6: reading only — no quality codes on the pill.
            chips.push(`<span class="smc-chip ${high ? 'bad' : ''}"><b>BP</b> ${escapeHtml(bp)}</span>`);
        }
        const bmi = snapshotExtract(text, /BMI:\s*(\d{1,3}(?:\.\d{1,2})?)/i);
        const bmiPct = snapshotExtract(text, /BMI\s*%:\s*(\d{1,3}(?:\.\d{1,2})?)\s*%/i);
        if (isPediatric && bmiPct) {
            const p = parseFloat(bmiPct);
            chips.push(`<span class="smc-chip ${p >= 95 ? 'bad' : (p >= 85 ? 'warn' : '')}"><b>BMI</b> ${escapeHtml(bmiPct)}%</span>`);
        } else if (bmi) {
            const b = parseFloat(bmi);
            chips.push(`<span class="smc-chip ${b >= 30 ? 'bad' : (b >= 26 ? 'warn' : '')}"><b>BMI</b> ${escapeHtml(bmi)}</span>`);
        }
        // Screening pills, from SCREENING_PILLS at the top of this file.
        const screenChips = [];
        const pill = (label, cls, tip) =>
            `<span class="smc-chip smc-scr ${cls}" title="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}">${escapeHtml(label)}</span>`;
        const SCREEN_VALUES = { alcohol: hasAlc, depression: hasDep, smoking: hasSmoker, otherTobacco: hasOtherTobacco };
        for (const p of SCREENING_PILLS) {
            if (p.source === 'socialNeeds') {
                if (!hasSocialNeeds) { screenChips.push(pill(p.label, 'dim', `${p.name}: not done`)); continue; }
                const histApiC = window.__ecwPatientHistory;
                const loadingC = !!(histApiC && histApiC.isLoading && histApiC.isLoading());
                const useC = loadingC ? null : findG0136UseWithinSixMonths();
                screenChips.push(loadingC
                    ? pill(p.label, 'dim', `${p.name}: done — checking G0136 history…`)
                    : (useC
                        ? pill(p.label, 'bad', `${p.name}: done — G0136 already billed ${useC.date} (once every 6 months)`)
                        : pill(p.label, 'good', `${p.name}: done — G0136 can be billed`)));
                continue;
            }
            const val = SCREEN_VALUES[p.source];
            if (val === undefined) continue; // unknown source
            screenChips.push(val === null
                ? pill(p.label, 'dim', `${p.name}: not screened`)
                : (val ? pill(p.label, 'good', `${p.name}: ${p.neg || 'negative'}`) : pill(p.label, 'bad', `${p.name}: ${p.pos || 'positive'}`)));
        }

        const qaBtn = (kind, label) => {
            const on = activeQuick === kind;
            const blocked99214 = blockedBy99214(kind);
            const disabled = !on && (gating[kind].disabled || blocked99214 || actionRunning);
            const title = on ? `${QUICK_LABELS[kind]} is in the proposal — click to remove it`
                : (blocked99214 ? `Office visit is 99214 — ${NOT_WITH_99214[kind]} is not billed together with 99214` : gating[kind].title);
            return `<button type="button" class="smc-qa-btn ${on ? 'on' : ''}" data-qa="${kind}" title="${escapeHtml(title)}" ${disabled ? 'disabled' : ''}>${label}</button>`;
        };

        const insWarn = renderHistoryIntegration(insurance)
            .replace(/class="hist-warn"/, 'class="smc-note"')
            .replace(/class="hist-integration hist-loading"/, 'class="smc-chip dim"');

        return `<div class="smc-ctx">
            <div class="smc-cc"><span class="smc-cc-label">Chief complaint</span>${ccLines.length
                ? `<ul>${ccLines.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`
                : '<span class="smc-cc-none">Not documented</span>'}</div>
            <div class="smc-chips">${chips.join('')}</div>
            <div class="smc-chips smc-scr-row" aria-label="Screenings">${screenChips.join('')}</div>
            ${insWarn}
        </div>
        <div class="smc-qa-bar" role="toolbar" aria-label="Counseling">
            <div class="smc-qa">
                ${qaBtn('pv', 'PV')}${qaBtn('pc', 'P/C')}${qaBtn('sm', 'SM')}${qaBtn('ob', 'OB')}
                <span class="smc-spacer"></span>
                <label class="smc-switch" title="Weekend/holiday visit (99051)"><input type="checkbox" id="smcWeekend" ${isWeekendEnabled() ? 'checked' : ''}><span class="track"></span>Weekend</label>
            </div>
        </div>`;
    }

    function resultHtml() {
        if (!resultNotice) return '';
        return `<div class="smc-result ${resultNotice.ok ? 'ok' : 'fail'}">
            <div>${escapeHtml(resultNotice.title)}${resultNotice.summary ? `<div class="smc-result-sum">${escapeHtml(resultNotice.summary)}</div>` : ''}${resultNotice.lines.length ? `<ul>${resultNotice.lines.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : ''}</div>
            <button type="button" class="smc-x" data-act="dismiss" aria-label="Dismiss">×</button>
        </div>`;
    }

    const SMART_SORT_RULES_HTML = `<details class="smc-rules">
        <summary>How codes are ordered (Smart Sort)</summary>
        <p>Smart Sort is on. Diagnoses: the Smart Sort list moves to the bottom in its order, then every other Z code A→Z.
        Procedures follow the Smart Sort procedure list. Add to EMR also sets a primary diagnosis if none is set, and applies the modifiers.</p>
    </details>`;

    // ---- Modifiers table: shown when Smart Sort and Link are both on ----
    // Which CPTs get which modifier once the ticked changes are applied
    // (Smart Sort's 25 / 59 rules + Link's SL for vaccines under 19).
    function currentModifiers() {
        const sc = getBillingScope();
        const out = new Map();
        ((sc && sc.cptData) || []).forEach(r => {
            const c = String(r && r.code || '').trim().toUpperCase();
            if (c && !out.has(c)) out.set(c, String(r.mod1 || '').trim());
        });
        return out;
    }
    function modifiersBlockHtml(current, adds, dels) {
        if (!smartSortOn() || !linkOn()) return '';
        const delSet = new Set(dels.filter(d => isPicked('d', d)).map(d => d.code.toUpperCase()));
        const finalCodes = orderItems([
            ...current.filter(x => !delSet.has(x.code)),
            ...adds.filter(a => isPicked('a', a) && !current.some(x => x.code === a.code.toUpperCase())).map(a => ({ code: a.code.toUpperCase() }))
        ], 'cpt').map(x => x.code);
        const mods = currentModifiers();
        const plan = PILOT.smartSort.planModifiers(finalCodes.map(c => ({ code: c, mod1: mods.get(c) || '' })));
        const sl = new Set(PILOT.linkSLCodes ? PILOT.linkSLCodes(finalCodes) : []);
        const byMod = new Map();
        finalCodes.forEach(c => {
            const m = sl.has(c) ? 'SL' : (plan.get(c) || '');
            if (!m) return;
            if (!byMod.has(m)) byMod.set(m, []);
            if (!byMod.get(m).includes(c)) byMod.get(m).push(c);
        });
        const rows = [...byMod.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
        const body = rows.length
            ? rows.map(([m, codes]) => `<tr><td class="smc-mod">${escapeHtml(m)}</td><td>${codes.map(escapeHtml).join(', ')}</td></tr>`).join('')
            : `<tr><td colspan="2" class="smc-empty">No modifiers on this claim</td></tr>`;
        return `<div class="smc-block">
            <div class="smc-block-head"><h2>Modifiers</h2><span class="smc-sum">after changes</span></div>
            <table class="smc-mods"><thead><tr><th>Modifiers</th><th>CPT</th></tr></thead><tbody>${body}</tbody></table>
        </div>`;
    }

    const ORDER_RULES_HTML = `<details class="smc-rules">
        <summary>How codes are ordered</summary>
        <p>Diagnoses: disease codes first, Z codes always below them. Procedures:</p>
        <ol>
            <li>Office visit</li><li>Preventive or counseling</li><li>9-series</li><li>G0442</li>
            <li>G0444</li><li>8-series</li><li>6-series</li><li>4-series</li>
            <li>G0108</li><li>G0136</li><li>3-series (e.g. 36415)</li><li>Others</li>
        </ol>
    </details>`;

    // ---- Previous vs Current (after Add to EMR) ----
    function reviewColumnHtml(list, otherCodes, kindClass, label) {
        if (!list.length) return `<div class="smc-empty">None</div>`;
        return list.map((x, i) => {
            const changed = !otherCodes.has(x.code);
            const units = x.units && x.units !== 1 ? `<span class="smc-tag">× ${x.units}</span>` : '';
            return `<div class="smc-row ${changed ? kindClass : ''}">
                <span class="mk">${changed ? `<span class="smc-mark">${kindClass === 'add' ? '+' : '−'}</span>` : `<span class="smc-num">${i + 1}</span>`}</span>
                <div><div class="smc-code"><b>${escapeHtml(x.code)}</b>${units}${changed ? `<span class="smc-tag">${label}</span>` : ''}</div>
                <div class="smc-name" title="${escapeHtml(x.name)}">${escapeHtml(x.name)}</div></div></div>`;
        }).join('');
    }

    function reviewBlockHtml(title, prev, cur, rank) {
        const prevCodes = new Set(prev.map(x => x.code));
        const curCodes = new Set(cur.map(x => x.code));
        const added = cur.filter(x => !prevCodes.has(x.code)).length;
        const removed = prev.filter(x => !curCodes.has(x.code)).length;
        const orderChanged = prev.filter(x => curCodes.has(x.code)).map(x => x.code).join() !==
            cur.filter(x => prevCodes.has(x.code)).map(x => x.code).join();
        const parts = [];
        if (added) parts.push(`<span class="a">+${added} added</span>`);
        if (removed) parts.push(`<span class="d">−${removed} removed</span>`);
        if (orderChanged) parts.push(`<span class="o">re-ordered</span>`);
        return `<div class="smc-block">
            <div class="smc-block-head"><h2>${title}</h2><span class="smc-sum">${parts.join(' ') || 'unchanged'}</span></div>
            <div class="smc-diff">
                <div class="smc-col"><div class="smc-col-h">Previous <span>${prev.length}</span></div>${reviewColumnHtml(prev, curCodes, 'del', 'removed')}</div>
                <div class="smc-col"><div class="smc-col-h">Current <span>${cur.length}</span></div>${reviewColumnHtml(cur, prevCodes, 'add', 'added')}</div>
            </div>
        </div>`;
    }

    function reviewViewHtml() {
        const t = reviewState.at;
        const time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
        // v2.21: the context strip (with PV / P-C / SM / OB) stays here, so a
        // forgotten counseling can still be added right after Add to EMR —
        // picking one creates a new proposal and switches back to
        // Current vs After changes.
        return updatedNoticeHtml() + contextHtml() + resultHtml() +
            `<div class="smc-review-head">Added to EMR at ${time}. Left: the chart before Add to EMR · right: the chart now.</div>` +
            reviewBlockHtml('Diagnoses (ICD)', reviewState.icd, readCurrentICD(), icdRank) +
            reviewBlockHtml('Procedures (CPT)', reviewState.cpt, readCurrentCPT(), cptRank) +
            `<div style="height:10px"></div>`;
    }

    function codingViewHtml() {
        if (reviewActive()) return reviewViewHtml();
        if (!hasBillingGrids()) {
            return contextHtml() + resultHtml() +
                `<div class="smc-blank"><b>Open the Billing tab</b> to see the diagnosis and procedure codes and the proposed changes.</div>`;
        }
        const icdCur = readCurrentICD();
        const cptCur = readCurrentCPT();
        const p = splitProposal(buildProposal());
        const legend = `<div class="smc-legend">
            <span><i style="background:var(--smc-add)"></i>Will be added</span>
            <span><i style="background:var(--smc-del)"></i>Will be removed</span>
            <span>Untick to skip a change</span></div>`;
        const ovNote = analysisState && analysisState.officeVisitNote
            ? `<div class="smc-note" style="margin:12px 18px 0">${escapeHtml(analysisState.officeVisitNote)}</div>` : '';
        return updatedNoticeHtml() + contextHtml() + resultHtml() + ovNote +
            diffBlockHtml('Diagnoses (ICD)', icdCur, p.icdAdds, p.icdDels, icdRank) +
            diffBlockHtml('Procedures (CPT)', cptCur, p.cptAdds, p.cptDels, cptRank, legend + (smartSortOn() ? SMART_SORT_RULES_HTML : ORDER_RULES_HTML)) +
            modifiersBlockHtml(cptCur, p.cptAdds, p.cptDels) +
            `<div style="height:10px"></div>`;
    }

    // v2.12: Add to EMR stays off until patient history has fully loaded —
    // the once-per-year / 30-day / 6-month checks and new-vs-established
    // all depend on it.
    function historyReadyState() {
        const api = window.__ecwPatientHistory;
        if (!api) return { ready: false, text: "Patient history isn't running — check that the ECW Pilot loader is installed" };
        if (api.isLoading && api.isLoading()) {
            const p = (api.getProgress && api.getProgress()) || {};
            const merging = /Carets/i.test(p.currentDos || '');
            return { ready: false, text: merging
                ? 'Waiting for patient history — merging visit codes…'
                : `Waiting for patient history — ${p.completed || 0} of ${p.total || '?'} visits loaded` };
        }
        if (!(api.getData && api.getData())) return { ready: false, text: 'Waiting for patient history to start loading…' };
        return { ready: true };
    }

    function footerHtml() {
        if (actionRunning) return null; // setBusyStatus owns the footer while applying
        if (!hasBillingGrids()) return { sum: 'Open the Billing tab to add codes', disabled: true };
        if (reviewActive()) return { sum: 'Added to EMR — no further changes needed. Forgot a counseling? Pick it above.', disabled: true, count: 0 };
        const hist = historyReadyState();
        if (!hist.ready) return { sum: escapeHtml(hist.text), disabled: true };
        const prop = buildProposal();
        const keys = [
            ...prop.toAdd.map(a => ({ k: keyOf('a', a.code), on: isPicked('a', a) })),
            ...prop.toDelete.map(d => ({ k: keyOf('d', d.code), on: isPicked('d', d) }))
        ];
        const n = keys.filter(x => x.on).length;
        const reorder = reorderStillNeeded() || smartTidyNeeded();
        const tidyText = smartSortOn() ? 'Smart Sort will order codes, set primary and modifiers' : 'codes will be put in order';
        let sum;
        if (!keys.length) sum = reorder ? `No code changes — ${tidyText}` : 'No changes needed';
        else sum = `<b>${n} of ${keys.length}</b> changes selected${reorder ? `, ${smartSortOn() ? 'then Smart Sort' : 'codes will be re-ordered'}` : ''}` +
            `<br><button type="button" class="smc-link" data-act="toggle-all">${n === keys.length ? 'Untick all' : 'Tick all'}</button>`;
        return { sum, disabled: n === 0 && !reorder, count: n };
    }

    // ====================== RENDER: HISTORY (original Patient History design) ======================
    // v2.08: same look as the standalone "Patient Visit History" panel —
    // white cards with a blue gradient header (date + insurance/provider
    // badges), ICD Codes / CPT Codes columns with Visit / Procedure groups,
    // amber ⚠ watch-list highlight on the latest visit, red search
    // highlight, spinner + progress while loading, burst on copy.
    let historyQuery = '';

    function dpHighlight(text, q) {
        const e = escapeHtml(text);
        if (!q) return e;
        const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        return e.replace(re, '<mark class="dp-hl">$1</mark>');
    }

    function dpCodeRows(list, color, q, isLatest) {
        if (!list || !list.length) return `<span class="dp-empty">—</span>`;
        return list.map(c => {
            const code = String(c.code || '').trim();
            const watched = isLatest && CHRONIC_DISEASE_ICD_CODES.has(code.toUpperCase());
            return `<div class="dp-code-row${watched ? ' dp-watched-row' : ''}">
                <span class="dp-code${watched ? ' dp-watched' : ''}" ${watched ? '' : `style="color:${color};"`} data-copy="${escapeHtml(code)}"
                    title="${watched ? '⚠ Watch-list code — ' : ''}Double-click to copy ${escapeHtml(code)}">${watched ? '<span class="dp-watched-icon">⚠</span>' : ''}${dpHighlight(code, q)}${c.modifiers ? `<sup class="dp-mod">${escapeHtml(c.modifiers)}</sup>` : ''}</span>
                <span class="dp-desc" title="${escapeHtml(c.details || '')}">${escapeHtml(c.details || '')}</span>
            </div>`;
        }).join('');
    }

    function dpHasCodes(v) {
        return [...(v.assessments || []), ...(v.visit_codes || []), ...(v.procedure_codes || [])].some(c => (c.code || '').trim());
    }

    function dpCards(visits, q) {
        if (!visits.length) return `<div class="dp-none">No matching encounters found.</div>`;
        return visits.map((v, idx) => {
            const isLatest = idx === 0;
            const header = `<div class="dp-card-header">
                <span class="dp-card-date">${escapeHtml(v.encounter_date || '')}</span>
                <div class="dp-card-meta">
                    ${v.insurance_name ? `<span class="dp-badge dp-badge-ins">🏥 ${escapeHtml(v.insurance_name)}</span>` : ''}
                    ${v.pcp_name ? `<span class="dp-badge dp-badge-pcp">👤 ${escapeHtml(v.pcp_name)}</span>` : ''}
                </div></div>`;
            if (!dpHasCodes(v)) return `<div class="dp-card">${header}</div>`;
            const groups = [
                (v.visit_codes || []).length ? `<div class="dp-cpt-group"><div class="dp-cpt-label">Visit</div>${dpCodeRows(v.visit_codes, '#2563eb', q, isLatest)}</div>` : '',
                (v.procedure_codes || []).length ? `<div class="dp-cpt-group"><div class="dp-cpt-label">Procedure</div>${dpCodeRows(v.procedure_codes, '#7c3aed', q, isLatest)}</div>` : ''
            ].filter(Boolean).join('') || `<span class="dp-empty">—</span>`;
            return `<div class="dp-card">${header}
                <div class="dp-card-body">
                    <div class="dp-section"><div class="dp-section-title" style="color:#0f766e;"><span>🔵</span> ICD Codes</div>${dpCodeRows(v.assessments, '#0f766e', q, isLatest)}</div>
                    <div class="dp-section"><div class="dp-section-title" style="color:#2563eb;"><span>🟣</span> CPT Codes</div>${groups}</div>
                </div></div>`;
        }).join('');
    }

    // Same rule as the standalone panel: nothing dated after the current DOS,
    // newest first.
    function dpVisibleVisits(list) {
        const dosTs = parseUSDateSnap(getCurrentDOSStr());
        return (list || [])
            .filter(v => v && !v.error && (!dosTs || parseUSDateSnap(v.encounter_date) <= dosTs))
            .sort((a, b) => parseUSDateSnap(b.encounter_date) - parseUSDateSnap(a.encounter_date));
    }

    function historyViewHtml() {
        const api = window.__ecwPatientHistory;
        if (!api) return `<div class="dp-none">Patient history isn't running — check that the ECW Pilot loader is installed.</div>`;
        if (api.isLoading && api.isLoading()) {
            const p = (api.getProgress && api.getProgress()) || {};
            const total = p.total || 0, done = p.completed || 0;
            const pct = total ? Math.round(done / total * 100) : 0;
            const partial = dpVisibleVisits(p.partial || []);
            return `<div class="dp-loading">
                <div class="dp-loading-top">
                    <div class="dp-spinner"></div>
                    <div><div class="dp-loading-title">Loading encounters…</div>
                        ${p.currentDos ? `<div class="dp-loading-sub">Fetching <b>${escapeHtml(p.currentDos)}</b></div>` : ''}</div>
                    <div class="dp-loading-pct">${pct}%</div>
                </div>
                <div class="dp-bar"><i style="width:${pct}%"></i></div>
                <div class="dp-loading-count">${done} / ${total} encounters${p.errors ? ` · <span class="dp-err">${p.errors} failed</span>` : ''}</div>
            </div>
            ${partial.length ? `<div class="dp-partial-label">Loaded so far</div>${dpCards(partial, '')}` : ''}`;
        }
        const data = api.getData ? api.getData() : null;
        if (!data || !data.length) return `<div class="dp-none">No patient history loaded.</div>`;
        const q = historyQuery.trim().toLowerCase();
        const all = dpVisibleVisits(data);
        const shown = q
            ? all.filter(v => [...(v.assessments || []), ...(v.visit_codes || []), ...(v.procedure_codes || [])]
                .some(c => (c.code || '').toLowerCase().includes(q)))
            : all;
        const errors = api.getErrors ? api.getErrors() : 0;
        return `<div class="dp-count">${shown.length} / ${all.length} encounters${errors ? ` · <span class="dp-err">${errors} errors</span>` : ''}</div>${dpCards(shown, q)}`;
    }

    // Double-click a code: copy it, with the original panel's burst / ripple / "✓ Copied".
    function dpCopyBurst(el, code) {
        const doCopy = text => {
            if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
            document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); } catch (e) {}
            ta.remove();
            return Promise.resolve();
        };
        doCopy(code).then(() => {
            const r = el.getBoundingClientRect();
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            const oldColor = el.style.color;
            el.classList.add('dp-copied');
            el.style.removeProperty('color');
            const ripple = document.createElement('div');
            ripple.className = 'smcdp-ripple';
            const size = 2.2 * Math.max(r.width, r.height);
            ripple.style.cssText = `width:${size}px;height:${size}px;left:${cx - size / 2}px;top:${cy - size / 2}px;`;
            document.body.appendChild(ripple);
            const colors = ['#22c55e', '#16a34a', '#4ade80', '#86efac', '#bbf7d0', '#34d399'];
            const particles = [];
            for (let i = 0; i < 8; i++) {
                const ang = i / 8 * Math.PI * 2, dist = 22 + 14 * Math.random();
                const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist;
                const pt = document.createElement('div');
                pt.className = 'smcdp-particle';
                const sz = 4 + 3 * Math.random();
                pt.style.cssText = `width:${sz}px;height:${sz}px;left:${cx}px;top:${cy}px;background:${colors[i % colors.length]};animation-duration:${0.45 + 0.15 * Math.random()}s;transform:translate(${dx}px,${dy}px) scale(0);`;
                document.body.appendChild(pt);
                particles.push(pt);
                requestAnimationFrame(() => requestAnimationFrame(() => { pt.style.transform = `translate(${dx}px,${dy}px) scale(1)`; }));
            }
            const check = document.createElement('div');
            check.className = 'smcdp-check';
            check.textContent = '✓ Copied';
            check.style.left = `${cx}px`;
            check.style.top = `${cy - r.height - 6}px`;
            document.body.appendChild(check);
            setTimeout(() => {
                el.classList.remove('dp-copied');
                el.style.color = oldColor;
                [ripple, check, ...particles].forEach(n => n.remove());
            }, 950);
        }).catch(() => {});
    }

    // ====================== PANEL SHELL ======================
    let launcher = null;
    let toastEl = null;
    let activeTab = 'coding';
    const PANEL_WIDTH_KEY = 'smc_panel_width';
    const LAUNCHER_TOP_KEY = 'smc_launcher_top';
    // v1.14: panel + launcher can dock on the left or right side (remembered).
    const PANEL_SIDE_KEY = 'smc_panel_side';
    let panelSide = 'right';
    try { if (localStorage.getItem(PANEL_SIDE_KEY) === 'left') panelSide = 'left'; } catch (e) {}
    // Lucide "settings" icon (ISC license).
    const SETTINGS_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
    const SIDE_ICON_LEFT = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"></path><path d="m11 18-6-6 6-6"></path></svg>';
    const SIDE_ICON_RIGHT = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="m13 6 6 6-6 6"></path></svg>';
    function applyPanelSide() {
        const left = panelSide === 'left';
        if (panel) panel.classList.toggle('side-left', left);
        if (launcher) launcher.classList.toggle('side-left', left);
        const btn = panel && panel.querySelector('[data-act="side"]');
        if (btn) btn.textContent = left ? 'Move panel to the right' : 'Move panel to the left';
    }
    function togglePanelSide() {
        panelSide = panelSide === 'left' ? 'right' : 'left';
        try { localStorage.setItem(PANEL_SIDE_KEY, panelSide); } catch (e) {}
        applyPanelSide();
    }
    const renderCache = {};

    // Only touch the DOM when the markup actually changed, so periodic
    // refreshes never reset scroll position, focus or an open <details>.
    function setHtmlIfChanged(id, html) {
        const el = document.getElementById(id);
        if (!el || renderCache[id] === html) return;
        const details = el.querySelector('details');
        const wasOpen = details ? details.open : false;
        renderCache[id] = html;
        el.innerHTML = html;
        if (wasOpen) { const d = el.querySelector('details'); if (d) d.open = true; }
    }

    function showToast(message) {
        if (!toastEl) {
            toastEl = document.createElement('div');
            toastEl.id = 'smcToast';
            toastEl.setAttribute('role', 'status');
            document.body.appendChild(toastEl);
        }
        toastEl.textContent = message;
        toastEl.classList.add('show');
        clearTimeout(showToast._t);
        showToast._t = setTimeout(() => toastEl.classList.remove('show'), 3000);
    }

    // New patient/encounter: forget every per-encounter choice.
    function syncEncounterState() {
        const encKey = getEncounterKey();
        if (encKey !== lastEncounterKey) {
            lastEncounterKey = encKey;
            pick = {}; activeQuick = null; activePlan = null;
            analysisState = null; lastAnalysisSig = ''; resultNotice = null; reviewState = null; reorderTriedSig = ''; smartTriedSig = '';
        }
    }

    // Badge on the collapsed launcher: spinner while history loads, green
    // count of selected proposed changes when there are any.
    function updateLauncherBadge() {
        if (!launcher || !launcher.classList.contains('show')) return;
        const badge = launcher.querySelector('.smc-l-badge');
        const api = window.__ecwPatientHistory;
        const loading = !!(api && api.isLoading && api.isLoading());
        let count = 0;
        if (!loading && hasBillingGrids() && !actionRunning) {
            syncEncounterState();
            refreshAnalysisIfNeeded();
            const prop = buildProposal();
            count = prop.toAdd.filter(a => isPicked('a', a)).length + prop.toDelete.filter(d => isPicked('d', d)).length;
        }
        launcher.classList.toggle('loading', loading);
        launcher.classList.toggle('has-count', !loading && count > 0);
        if (badge) badge.textContent = loading ? '' : (count > 99 ? '99+' : (count ? String(count) : ''));
        const tip = loading ? 'Loading patient history…'
            : (!hasBillingGrids() ? 'Open coding panel'
                : (count ? `${count} proposed change${count === 1 ? '' : 's'} — click to review` : 'No changes needed'));
        launcher.title = tip;
        launcher.setAttribute('aria-label', tip);
    }

    function createLauncher() {
        if (launcher) return;
        launcher = document.createElement('button');
        launcher.id = 'smcLauncher';
        launcher.type = 'button';
        launcher.title = 'Open coding panel';
        launcher.setAttribute('aria-label', 'Open coding panel');
        // Icon: Lucide "clipboard-check" (ISC license, lucide.dev).
        launcher.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"></rect><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><path d="m9 14 2 2 4-4"></path></svg><span class="smc-l-badge"></span>`;
        let top = 120;
        try { const v = parseInt(localStorage.getItem(LAUNCHER_TOP_KEY)); if (!isNaN(v)) top = v; } catch (e) {}
        launcher.style.top = Math.min(Math.max(top, 10), window.innerHeight - 60) + 'px';
        document.body.appendChild(launcher);
        applyPanelSide();

        let dragging = false, dragged = false, startY = 0, startTop = 0;
        launcher.addEventListener('mousedown', e => {
            dragging = true; dragged = false; startY = e.clientY; startTop = launcher.getBoundingClientRect().top;
            launcher.classList.add('dragging'); e.preventDefault();
        });
        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            const dy = e.clientY - startY;
            if (Math.abs(dy) > 4) dragged = true;
            launcher.style.top = Math.min(Math.max(startTop + dy, 6), window.innerHeight - 48) + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            launcher.classList.remove('dragging');
            if (dragged) { try { localStorage.setItem(LAUNCHER_TOP_KEY, Math.round(launcher.getBoundingClientRect().top)); } catch (e) {} }
            else openPanel();
        });
    }

    function createPanel() {
        if (panel) return;
        panel = document.createElement('aside');
        panel.id = 'smcPanel';
        panel.setAttribute('aria-label', 'ECW Pilot');
        let width = 480;
        try { const v = parseInt(localStorage.getItem(PANEL_WIDTH_KEY)); if (!isNaN(v)) width = v; } catch (e) {}
        panel.style.width = Math.min(Math.max(width, 380), window.innerWidth * 0.96) + 'px';
        panel.innerHTML = `
            <div class="smc-resize" title="Drag to resize"></div>
            <header class="smc-head">
                <div class="smc-top">
                    <div class="smc-pt" id="smcHeadInfo"></div>
                    <button type="button" class="smc-icon-btn" data-act="settings" title="Settings" aria-label="Settings" aria-haspopup="true" aria-expanded="false">${SETTINGS_ICON}</button>
                    <div class="smc-menu" id="smcMenu" role="menu" hidden>
                        <div class="smc-menu-h">Modules</div>
                        <label class="smc-menu-row"><span>Smart Sort</span><span class="smc-switch"><input type="checkbox" data-setting="sort"><span class="track"></span></span></label>
                        <div class="smc-menu-row smc-menu-link"><span>Link</span>
                            <span class="smc-seg" role="radiogroup" aria-label="Link mode">
                                <button type="button" data-linkmode="off" role="radio">Off</button><button type="button" data-linkmode="manual" role="radio">Manual</button><button type="button" data-linkmode="auto" role="radio">Auto</button>
                            </span></div>
                        <label class="smc-menu-row"><span>Claim Link</span><span class="smc-switch"><input type="checkbox" data-setting="claimLink"><span class="track"></span></span></label>
                        <div class="smc-menu-note" id="smcMenuNote"></div>
                        <div class="smc-menu-sep"></div>
                        <button type="button" class="smc-menu-btn" data-act="side">Move panel to the left</button>
                    </div>
                    <button type="button" class="smc-icon-btn" data-act="minimize" title="Minimize" aria-label="Minimize panel">−</button>
                </div>
                <nav class="smc-tabs" role="tablist">
                    <button type="button" class="smc-tab on" data-tab="coding" role="tab">Coding <span class="smc-badge" id="smcBadge"></span></button>
                    <button type="button" class="smc-tab" data-tab="history" role="tab">History <span class="smc-muted" id="smcHistCount"></span></button>
                </nav>
            </header>
            <div class="smc-update" id="smcUpdate" hidden>A new version of ECW Pilot is available — <button type="button" class="smc-link" data-act="reload">refresh to update</button></div>
            <div class="smc-progress"><i></i></div>
            <div class="smc-body" id="smcBody">
                <section class="smc-view on" data-view="coding"><div id="smcCoding"></div></section>
                <section class="smc-view" data-view="history">
                    <div class="smc-hsearch"><div class="smc-hsearch-box">
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                        <input type="search" id="smcHistQ" placeholder="Search by ICD or CPT code…" aria-label="Search history by code"></div></div>
                    <div class="smc-visits" id="smcVisits"></div>
                </section>
            </div>
            <footer class="smc-foot" id="smcFoot">
                <div class="smc-foot-sum" id="smcFootSum"></div>
                <span class="smc-version" title="ECW Pilot version loaded in this browser">ECW Pilot · ${escapeHtml(CLIENT_NAME)} · v${escapeHtml(SCRIPT_VERSION)}</span>
                <button type="button" class="smc-primary" id="smcApply">Add to EMR</button>
            </footer>`;
        document.body.appendChild(panel);
        applyPanelSide();

        // Resize from the left edge.
        const handle = panel.querySelector('.smc-resize');
        let resizing = false, startX = 0, startW = 0;
        handle.addEventListener('mousedown', e => {
            resizing = true; startX = e.clientX; startW = panel.offsetWidth;
            document.body.style.userSelect = 'none'; e.preventDefault();
        });
        document.addEventListener('mousemove', e => {
            if (!resizing) return;
            const dx = panelSide === 'left' ? (e.clientX - startX) : (startX - e.clientX);
            panel.style.width = Math.min(Math.max(startW + dx, 380), window.innerWidth * 0.96) + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (!resizing) return;
            resizing = false; document.body.style.userSelect = '';
            try { localStorage.setItem(PANEL_WIDTH_KEY, Math.round(panel.offsetWidth)); } catch (e) {}
        });

        panel.addEventListener('click', e => {
            const t = e.target;
            const tabBtn = t.closest('[data-tab]');
            if (tabBtn) { setTab(tabBtn.dataset.tab); return; }
            const qa = t.closest('[data-qa]');
            if (qa && !qa.disabled) { toggleQuickAction(qa.dataset.qa); return; }
            const seg = t.closest('[data-linkmode]');
            if (seg && !seg.disabled) { setLinkMode(seg.dataset.linkmode); return; }
            const act = t.closest('[data-act]');
            if (act) {
                if (act.dataset.act === 'minimize') closePanelToLauncher();
                else if (act.dataset.act === 'settings') toggleSettingsMenu();
                else if (act.dataset.act === 'side') { togglePanelSide(); toggleSettingsMenu(false); }
                else if (act.dataset.act === 'reload') location.reload();
                else if (act.dataset.act === 'dismiss') { resultNotice = null; renderPanel(); }
                else if (act.dataset.act === 'ack-update') { if (PILOT && PILOT.ackUpdate) PILOT.ackUpdate(); renderPanel(true); }
                else if (act.dataset.act === 'toggle-all') {
                    const prop = buildProposal();
                    const items = [...prop.toAdd.map(a => ['a', a]), ...prop.toDelete.map(d => ['d', d])];
                    const allOn = items.every(([p, x]) => isPicked(p, x));
                    items.forEach(([p, x]) => { pick[keyOf(p, x.code)] = !allOn; });
                    renderPanel();
                }
                return;
            }
            if (t.closest('#smcApply')) addToEMR();
        });
        panel.addEventListener('change', e => {
            const t = e.target;
            if (t.dataset && t.dataset.setting) { onModuleToggle(t.dataset.setting, t.checked).then(() => { lastAnalysisSig = ''; renderPanel(true); }); return; }
            if (t.dataset && t.dataset.k) { pick[t.dataset.k] = t.checked; renderPanel(); return; }
            if (t.id === 'smcWeekend') { setWeekendOverride(!!t.checked); lastAnalysisSig = ''; renderPanel(); }
        });
        panel.addEventListener('input', e => {
            if (e.target.id === 'smcHistQ') { historyQuery = e.target.value; renderPanel(); }
        });
        panel.addEventListener('dblclick', e => {
            const c = e.target.closest('[data-copy]');
            if (c) dpCopyBurst(c, c.dataset.copy);
        });
    }

    // ---- Settings menu: Sort / Link / Claim Link on-off, panel side ----
    const MODULE_LABELS = { sort: 'Smart Sort', link: 'Link', claimLink: 'Claim Link' };
    // Link: Off (button disabled) / Manual (button only) / Auto (button + auto-link).
    function currentLinkMode() {
        if (!PILOT || !PILOT.settings || !PILOT.settings.get('link')) return 'off';
        return PILOT.settings.get('linkAuto') ? 'auto' : 'manual';
    }
    async function setLinkMode(mode) {
        if (!PILOT || !PILOT.settings) return;
        PILOT.settings.set('link', mode !== 'off');
        PILOT.settings.set('linkAuto', mode === 'auto');
        if (PILOT.loadModule) await PILOT.loadModule('link');
        window.dispatchEvent(new Event('ecwpilot:settings-changed'));
        syncSettingsMenu();
        const msg = { off: 'Link is off — the button is disabled', manual: 'Link: manual — click Link to link', auto: 'Link: auto — links whenever the codes change' }[mode];
        const note = document.getElementById('smcMenuNote');
        if (note) note.textContent = msg;
        showToast(msg);
    }
    function syncSettingsMenu() {
        if (!panel) return;
        const linkAvailable = !!(PILOT && PILOT.hasModule && PILOT.hasModule('link'));
        const mode = currentLinkMode();
        panel.querySelectorAll('[data-linkmode]').forEach(b => {
            const on = b.dataset.linkmode === mode;
            b.classList.toggle('on', on);
            b.setAttribute('aria-checked', String(on));
            b.disabled = !linkAvailable;
        });
        panel.querySelectorAll('[data-setting]').forEach(box => {
            const key = box.dataset.setting;
            const available = !!(PILOT && PILOT.hasModule && PILOT.hasModule(key));
            box.checked = !!(PILOT && PILOT.isEnabled && PILOT.isEnabled(key));
            box.disabled = !available;
            box.closest('.smc-menu-row').title = available ? '' : `${MODULE_LABELS[key]} isn't set up for this practice yet`;
        });
        const note = document.getElementById('smcMenuNote');
        if (note && !PILOT) note.textContent = 'Modules need the ECW Pilot loader.';
    }
    function toggleSettingsMenu(force) {
        const menu = document.getElementById('smcMenu');
        const btn = panel && panel.querySelector('[data-act="settings"]');
        if (!menu) return;
        const open = force === undefined ? menu.hidden : force;
        menu.hidden = !open;
        if (btn) btn.setAttribute('aria-expanded', String(open));
        if (open) syncSettingsMenu();
    }
    async function onModuleToggle(key, on) {
        if (!PILOT || !PILOT.settings) return;
        PILOT.settings.set(key, on);
        const note = document.getElementById('smcMenuNote');
        if (on) {
            const ok = PILOT.loadModule ? await PILOT.loadModule(key) : false;
            const msg = ok ? `${MODULE_LABELS[key]} is on` : `${MODULE_LABELS[key]} couldn't be loaded — try again later`;
            if (note) note.textContent = msg;
            showToast(msg);
        } else {
            // Smart Sort checks the setting each time, so it's off at once.
            const msg = key !== 'sort' && PILOT.isLoaded && PILOT.isLoaded(key)
                ? `${MODULE_LABELS[key]} turns off after you refresh the page`
                : `${MODULE_LABELS[key]} is off`;
            if (note) note.textContent = msg;
            showToast(msg);
        }
    }
    document.addEventListener('click', e => {
        const menu = document.getElementById('smcMenu');
        if (menu && !menu.hidden && !e.target.closest('#smcMenu') && !e.target.closest('[data-act="settings"]')) toggleSettingsMenu(false);
    });

    // ---- Update notices from the loader ----
    function syncUpdateBar() {
        const bar = document.getElementById('smcUpdate');
        if (bar) bar.hidden = !(PILOT && PILOT.updateAvailable);
    }
    window.addEventListener('ecwpilot:update-available', () => { syncUpdateBar(); showToast('A new version of ECW Pilot is available — refresh to update'); });
    // The Link button is always there next to History — disabled when Link
    // is Off — so the Link file loads even when it's turned off.
    if (PILOT && PILOT.hasModule && PILOT.hasModule('link') && PILOT.loadModule) {
        try { PILOT.loadModule('link'); } catch (e) {}
    }
    function updatedNoticeHtml() {
        const list = PILOT && PILOT.justUpdated;
        if (!list || !list.length) return '';
        const items = list.map(u => `<li><b>${escapeHtml(u.label)}</b> v${escapeHtml(u.to)}${u.notes && u.notes.length ? ' — ' + u.notes.map(escapeHtml).join(' · ') : ''}</li>`).join('');
        return `<div class="smc-result ok smc-updated"><div>ECW Pilot was updated<ul>${items}</ul></div>
            <button type="button" class="smc-x" data-act="ack-update" aria-label="Dismiss">×</button></div>`;
    }

    function setTab(name) {
        activeTab = name;
        panel.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
        panel.querySelectorAll('[data-view]').forEach(v => v.classList.toggle('on', v.dataset.view === name));
        document.getElementById('smcFoot').style.display = name === 'coding' ? '' : 'none';
        renderPanel(true);
    }

    function renderPanel(force) {
        if (!panel || !isPanelOpen()) return;
        if (force) Object.keys(renderCache).forEach(k => delete renderCache[k]);

        syncEncounterState();

        const text = getEncounterText();
        const age = getAgeAtDOS(text);
        const gender = getGenderFromDOM();
        const insurance = parseInsuranceFromPage(text);
        const name = getPatientName();
        setHtmlIfChanged('smcHeadInfo', `
            <div class="smc-pt-name">${escapeHtml(name || 'Current patient')}</div>
            <div class="smc-pt-meta">
                <span><b>${age != null ? age + ' y' : '—'}</b> ${escapeHtml(genderLabel(gender).toLowerCase())}</span>
                ${getCurrentDOSStr() ? `<span>DOS <b>${escapeHtml(getCurrentDOSStr())}</b></span>` : ''}
                ${insurance ? `<span><b>${escapeHtml(insurance)}</b></span>` : ''}
            </div>`);

        const api = window.__ecwPatientHistory;
        const histCount = api && api.isLoading && api.isLoading() ? 'loading…'
            : (api && api.getEncounterCount && api.getEncounterCount() ? `${api.getEncounterCount()} visits` : '');
        setHtmlIfChanged('smcHistCount', escapeHtml(histCount));

        if (activeTab === 'coding') {
            refreshAnalysisIfNeeded();
            if (!actionRunning) setHtmlIfChanged('smcCoding', codingViewHtml());
        } else {
            setHtmlIfChanged('smcVisits', historyViewHtml());
        }

        syncUpdateBar();
        const foot = footerHtml();
        if (foot) {
            setHtmlIfChanged('smcFootSum', foot.sum);
            const applyBtn = document.getElementById('smcApply');
            applyBtn.disabled = foot.disabled;

            const badge = document.getElementById('smcBadge');
            if (badge) badge.textContent = foot.count ? String(foot.count) : '';
        } else {
            document.getElementById('smcApply').disabled = true;
        }
    }

    // v2.25: the Link and Claim Link buttons (made by their own scripts)
    // sit right after the History tab while the panel is open, and go back
    // to where they were — original style and all — when it closes. Their
    // clicks, colours and hover effects stay with their own scripts.
    const EXTERNAL_TAB_BUTTONS = [
        { id: 'ecwLinkBtnNoDelete', order: 1 },
        { id: 'ecwClaimLinkBtn', order: 2 }
    ];
    function syncExternalButtons() {
        const tabs = isPanelOpen() && panel ? panel.querySelector('.smc-tabs') : null;
        EXTERNAL_TAB_BUTTONS.forEach(({ id, order }) => {
            const btn = document.getElementById(id);
            if (!btn) return;
            // Link (ECW Pilot's own): lives only inside the panel and shows only
            // while the Billing grids are on screen — never floating on the page.
            if (id === 'ecwLinkBtnNoDelete' && PILOT) {
                const home = panel ? panel.querySelector('.smc-tabs') : null;
                if (home && btn.parentElement !== home) {
                    home.appendChild(btn);
                    Object.assign(btn.style, {
                        position: 'static', top: '', left: '', right: '', zIndex: '', order: String(order),
                        alignSelf: 'center', margin: '0 0 3px', padding: '4px 10px',
                        fontSize: '12px', fontWeight: '600', borderRadius: '6px', boxShadow: 'none'
                    });
                }
                btn.style.display = home && isPanelOpen() && hasBillingGrids() ? '' : 'none';
                return;
            }
            if (tabs) {
                if (btn.parentElement === tabs) return;
                if (btn.dataset.smcOrigStyle === undefined) btn.dataset.smcOrigStyle = btn.getAttribute('style') || '';
                tabs.appendChild(btn);
                Object.assign(btn.style, {
                    position: 'static', top: '', left: '', right: '', zIndex: '', order: String(order),
                    alignSelf: 'center', margin: '0 0 3px', padding: '4px 10px',
                    fontSize: '12px', fontWeight: '600', borderRadius: '6px', boxShadow: 'none'
                });
            } else if (btn.dataset.smcOrigStyle !== undefined) {
                const bg = btn.style.background;           // keep the owner's current colour
                btn.setAttribute('style', btn.dataset.smcOrigStyle);
                if (bg) btn.style.background = bg;
                delete btn.dataset.smcOrigStyle;
                document.body.appendChild(btn);
            }
        });
    }

    function openPanel() {
        if (!panel) createPanel();
        if (launcher) launcher.classList.remove('show');
        panel.classList.add('open');
        renderPanel(true);
        syncExternalButtons();
    }

    function closePanelToLauncher() {
        if (panel) panel.classList.remove('open');
        syncExternalButtons();
        showLauncher();
    }

    function showLauncher() {
        if (!launcher) createLauncher();
        launcher.classList.add('show');
    }

    function hideLauncher() {
        if (launcher) launcher.classList.remove('show');
    }

    function isPanelOpen() {
        return !!(panel && panel.classList.contains('open'));
    }

    function escapeHtml(str) {
        return String(str == null ? "" : str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // Visible page text with the ECW Pilot panel/launcher/toast left out.
    function getPageTextExcludingPanel() {
        const skip = new Set(['smcPanel', 'smcLauncher', 'smcToast']);
        const parts = [];
        for (const el of document.body.children) {
            if (skip.has(el.id) || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
            const t = el.innerText;
            if (t) parts.push(t);
        }
        return parts.join('\n');
    }

    function isPatientChart() {
        // Cheap pre-check first: if neither the encounter dropdown nor
        // either billing grid exists at all, we're definitely not in a
        // chart/coding context, so skip the expensive innerText scan.
        const hasEncDropdown = !!document.getElementById('encDropDownItem');
        const hasBillingGrid = hasBillingGrids();
        if (!hasEncDropdown && !hasBillingGrid) return false;

        const liveText = getPageTextExcludingPanel();
        const hasSoapText = /Chief Complaint\(s\)|HPI:|Assessment:|Plan:/i.test(liveText);

        // Drop the cached note text if we've moved to a different
        // patient/encounter, so the billing tab never shows stale data
        // left over from someone else's chart.
        const key = (window.__ecwPatientHistory && window.__ecwPatientHistory.getCurrentKey)
            ? (window.__ecwPatientHistory.getCurrentKey() || "")
            : "";
        if (key !== cachedEncounterKey) {
            cachedEncounterText = "";
            cachedEncounterKey = key;
        }
        if (hasSoapText) cachedEncounterText = liveText;

        return hasSoapText || hasBillingGrid;
    }

    // The stable "what does the note say" text: the cached copy from the
    // last time the SOAP note was actually visible, falling back to a live
    // read only if nothing has been cached yet.
    function getEncounterText() {
        return cachedEncounterText || getPageTextExcludingPanel();
    }

    // ====================== MAIN LOOP ======================
    function checkAndUpdate() {
        // Skip the (relatively expensive) innerText-based scan entirely
        // while the page itself is still loading — no point competing with
        // the page's own render work, and there's nothing meaningful to
        // detect yet anyway.
        if (document.readyState !== 'complete') return;

        const onChart = isPatientChart();

        if (onChart) {
            if (!isPanelOpen()) { showLauncher(); updateLauncherBadge(); }
            else renderPanel();
            syncExternalButtons();
        } else {
            hideLauncher();
            if (panel) panel.classList.remove('open');
            syncExternalButtons();
        }
    }

    // Auto-dismisses eCW's "Associated CPT Codes" popup (always click No —
    // our own logic decides what CPTs belong on the chart). Matched only by
    // the modal's title text, not by id — ids like billingLink29 get reused
    // elsewhere in eCW's markup and clicking the wrong match was spam-firing
    // clicks on an unrelated element every cycle.
    function dismissAssociatedCPTModalIfPresent() {
        // Only ever act while the extension itself is mid-action (a quick
        // action / Start Action) — this modal is a side effect of OUR OWN
        // ICD add/delete steps, so it must never fire while the user is
        // doing something manually.
        if (!quickActionRunning && !actionRunning && !extensionBusy) return false;

        const title = Array.from(document.querySelectorAll('.modal-title'))
            .find(el => el.offsetParent !== null && /Associated CPT Codes/i.test(el.textContent || ''));
        if (!title) return false;

        const modal = title.closest('.modal, .modal-content, [role="dialog"]') || document;
        const noLink = Array.from(modal.querySelectorAll('a, button')).find(
            b => b.offsetParent !== null && b.textContent.trim().toLowerCase() === 'no'
        );
        if (noLink) { noLink.click(); return true; }

        const closeBtn = modal.querySelector('.close, [data-dismiss="modal"]');
        if (closeBtn) { closeBtn.click(); return true; }
        return false;
    }

    setInterval(dismissAssociatedCPTModalIfPresent, 1800);

    // eCW also shows a plain "eClinicalWorks"-titled dialog with just an OK
    // button for errors like "Could not add ICD: ...". Left open, its
    // backdrop blocks every click after it (that's what "stuck" looked
    // like) — dismiss it whenever it appears, and surface the message so a
    // failed add isn't silently swallowed.
    let lastEcwErrorShown = "";
    function dismissEcwErrorPopup() {
        // Same reasoning as dismissAssociatedCPTModalIfPresent above — only
        // act while the extension itself is mid-action. A manual delete
        // confirmation (e.g. "Are you sure you want to remove this ICD?")
        // reuses this exact same generic "eClinicalWorks" modal title, so
        // without this guard a manual action could get its own confirm
        // popup silently closed out from under it every ~1.8s.
        if (!quickActionRunning && !actionRunning && !extensionBusy) return false;

        const title = Array.from(document.querySelectorAll('.modal-title'))
            .find(el => el.offsetParent !== null && el.textContent.trim() === 'eClinicalWorks');
        if (!title) return false;

        const modal = title.closest('.modal, .modal-content, [role="dialog"]') || document;

        // The E&M picker (opened via billingBtn2, confirmed via billingBtn29)
        // shares this same generic "eClinicalWorks" modal title — don't
        // treat it as an error dialog and auto-close it out from under an
        // in-progress code selection (this was closing the E&M tree every
        // ~1.8s before the user/script could finish picking a code).
        if (modal.querySelector('#billingBtn29')) return false;

        // SAFETY (belt-and-suspenders on top of the busy gate above): never
        // touch a real Yes/No confirmation dialog.
        const hasYesNoButtons = Array.from(modal.querySelectorAll('button, a')).some(
            b => b.offsetParent !== null && ['yes', 'no'].includes(b.textContent.trim().toLowerCase())
        );
        if (hasYesNoButtons) return false;

        const bodyText = (modal.textContent || '').replace(title.textContent, '').trim();

        if (bodyText && bodyText !== lastEcwErrorShown) {
            lastEcwErrorShown = bodyText;
            showQuickNotice(`eCW reported: ${bodyText.slice(0, 200)}`);
        }

        const okBtn = Array.from(modal.querySelectorAll('button')).find(
            b => b.offsetParent !== null && b.textContent.trim().toLowerCase() === 'ok'
        );
        if (okBtn) { okBtn.click(); return true; }

        const closeBtn = modal.querySelector('.close, [data-dismiss="modal"], .icon-cancel');
        if (closeBtn) { closeBtn.click(); return true; }
        return false;
    }
    setInterval(dismissEcwErrorPopup, 1800);

    // ─── Auto-dismiss "Associated CPT Codes" popup ───────────────────
    // eCW sometimes shows this modal mid-way through an ICD add/delete
    // (its close button has ng-click="assocCPTCancle()"). Separate from
    // dismissEcwErrorPopup above since its title isn't "eClinicalWorks".
    // It can appear in the middle of any of this script's ICD add/delete
    // sequences (quick actions, Analyze/Apply) and would otherwise sit
    // there blocking the rest of the sequence. Clicking the × only
    // cancels the associated-CPT prompt — it doesn't undo the ICD change
    // itself — so it's safe to auto-dismiss.
    function dismissAssocCPTModalIfPresent() {
        const closeBtn = document.querySelector('button[ng-click="assocCPTCancle()"]');
        if (closeBtn && closeBtn.offsetParent !== null) {
            closeBtn.click();
            return true;
        }
        return false;
    }
    setInterval(dismissAssocCPTModalIfPresent, 800);

    // Give the page more time to actually finish loading/rendering before
    // our own (heavier) checkAndUpdate starts scanning the DOM — running
    // it the instant the script loads was competing with the page's own
    // initial render, which is exactly when things already feel slow.
    setInterval(checkAndUpdate, 2500);
    setTimeout(checkAndUpdate, 3000);
})();
