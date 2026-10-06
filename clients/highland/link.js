/* ============================================================
   ECW Pilot — clients/highland/link.js   (HighLand only)
   Fast Link: plans every CPT's ICD pointers (and the SL modifier) from
   HighLand's rules, then writes them straight into eCW's billing data
   (cptData) in one update. Falls back to typing into the boxes only for a
   row that has no data behind it.

   Settings menu -> Link:
     Off    — Link button disabled. Nothing links.
     Manual — Link button works. Nothing links on its own.
     Auto   — Link button works, linking runs by itself when the codes
              change, and Add to EMR links everything as its last step.
   The mode is read every time, so a switch takes effect immediately.

   To release a change: edit this file, then raise
   clients -> highland -> files -> link -> version in manifest.json.
   ============================================================ */
(function () {
    'use strict';
    if (window.__ecwPilotLinkRunning) return;   // never start twice on one page
    window.__ecwPilotLinkRunning = true;

    // ═══ Config ═════════════════════════════════════════════════════════
    // true  = write directly to the Angular model (fast, one digest)
    // false = old DOM path (focus/blur + txtIcdBlur per slot), for fallback
    const USE_MODEL_WRITE = true;

    // ═══ Link mode (Off / Manual / Auto) from ECW Pilot settings ════════
    const PILOT = window.ECWPilot || null;
    function linkMode() {
        if (!PILOT || !PILOT.settings) return 'manual';   // run standalone: plain button
        if (!PILOT.settings.get('link')) return 'off';
        return PILOT.settings.get('linkAuto') ? 'auto' : 'manual';
    }

    // Automatic runs show each warning once per encounter; a click on the
    // Link button shows them all again.
    let quietRun = false;
    const shownKeys = new Set();

    // ═══ Notifications ══════════════════════════════════════════════════
    const NOTIFICATION_GAP = 12;
    const activeNotifications = [];

    if (!document.getElementById('ecw-notify-style')) {
        const style = document.createElement('style');
        style.id = 'ecw-notify-style';
        style.textContent = `
            @keyframes ecwNotifySlideIn { from { transform: translateX(120%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
            @keyframes ecwNotifySlideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(120%); opacity: 0; } }`;
        document.head.appendChild(style);
    }

    function repositionNotifications() {
        let top = 80;
        activeNotifications.forEach(c => {
            if (!document.body.contains(c)) return;
            c.style.top = top + 'px';
            top += c.offsetHeight + NOTIFICATION_GAP;
        });
    }

    function dismissNotification(c) {
        c.style.animation = 'ecwNotifySlideOut 0.25s ease forwards';
        setTimeout(() => {
            c.remove();
            const i = activeNotifications.indexOf(c);
            if (i !== -1) activeNotifications.splice(i, 1);
            repositionNotifications();
        }, 250);
    }

    function showNotification(messages, isWarning = true) {
        if (typeof messages === 'string') messages = [messages];
        if (!messages.length) return;
        const key = messages.join('||');
        if (activeNotifications.some(c => c.dataset.msgKey === key)) return;
        if (quietRun && shownKeys.has(key)) return;
        shownKeys.add(key);

        const accent = isWarning ? '#f59e0b' : '#3b82f6';
        const container = document.createElement('div');
        container.dataset.msgKey = key;
        Object.assign(container.style, {
            position: 'fixed', top: '80px', right: '20px', display: 'flex', alignItems: 'flex-start',
            gap: '12px', width: '360px', maxWidth: '90vw', padding: '14px 16px',
            background: 'rgba(255,255,255,0.97)', backdropFilter: 'blur(8px)',
            border: '1px solid rgba(0,0,0,0.06)', borderLeft: '4px solid ' + accent, borderRadius: '12px',
            boxShadow: '0 10px 30px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)', zIndex: '9999999',
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            fontSize: '13.5px', color: '#1f2937', animation: 'ecwNotifySlideIn 0.3s ease', transition: 'top 0.25s ease'
        });

        const icon = document.createElement('div');
        Object.assign(icon.style, {
            flexShrink: '0', width: '22px', height: '22px', borderRadius: '50%', background: accent,
            color: '#fff', fontWeight: '700', fontSize: '13px', display: 'flex',
            alignItems: 'center', justifyContent: 'center', marginTop: '1px'
        });
        icon.textContent = isWarning ? '!' : 'i';
        container.appendChild(icon);

        const content = document.createElement('div');
        content.style.flex = '1'; content.style.minWidth = '0';
        if (messages.length === 1) {
            const p = document.createElement('div');
            p.style.lineHeight = '1.4'; p.style.fontWeight = '500';
            p.textContent = messages[0];
            content.appendChild(p);
        } else {
            const ul = document.createElement('ul');
            ul.style.margin = '0'; ul.style.paddingLeft = '18px'; ul.style.lineHeight = '1.5';
            messages.forEach(m => { const li = document.createElement('li'); li.textContent = m; ul.appendChild(li); });
            content.appendChild(ul);
        }
        container.appendChild(content);

        const close = document.createElement('button');
        close.textContent = '\u00d7';
        Object.assign(close.style, {
            flexShrink: '0', border: 'none', background: 'transparent', color: '#9ca3af',
            fontSize: '18px', lineHeight: '1', cursor: 'pointer', padding: '0', marginLeft: '4px'
        });
        close.onmouseenter = () => close.style.color = '#4b5563';
        close.onmouseleave = () => close.style.color = '#9ca3af';
        close.onclick = () => dismissNotification(container);
        container.appendChild(close);

        document.body.appendChild(container);
        activeNotifications.push(container);
        repositionNotifications();
        setTimeout(() => dismissNotification(container), 5000);
    }

    // ═══ Reading (one pass, plain data) ═════════════════════════════════
    function getICDRows() { return Array.from(document.querySelectorAll('#billingTbl2 tbody tr[ng-repeat]')); }
    function getCPTRows() { return Array.from(document.querySelectorAll('#billingTbl4 tbody tr[ng-repeat]')); }

    function extractICDCode(raw) {
        if (!raw) return null;
        const m = raw.trim().match(/^([A-Z][0-9A-Z]{1,3}(?:\.[0-9A-Z]{1,4})?)\b/i);
        return m ? m[1].toUpperCase() : null;
    }

    // [{ code, rawText, rowNum }] in grid order
    function readICDs() {
        return getICDRows().map(tr => {
            const rawText = tr.querySelector('td:nth-child(3)')?.textContent || '';
            return {
                code: rawText.trim().toUpperCase(),
                rawText,
                rowNum: tr.querySelector('td:first-child center')?.textContent.trim() || ''
            };
        }).filter(i => i.code);
    }

    // [{ tr, code, model }]: model is the row's live `cpt` object
    function readCPTs() {
        return getCPTRows().map(tr => {
            let model = null;
            try { model = angular.element(tr).scope()?.cpt || null; } catch (e) {}
            return {
                tr,
                code: (model?.code || tr.querySelector('td:nth-child(2)')?.textContent || '').trim(),
                model
            };
        }).filter(c => c.code);
    }

    function getPatientAge() {
        const span = document.querySelector('.patient-identifier-span');
        if (!span) return null;
        const dobMatch = span.textContent.match(/(\w+ \d{1,2},\s*\d{4})/);
        if (!dobMatch) return null;
        const dob = new Date(dobMatch[1]);
        if (isNaN(dob)) return null;

        let serviceDate = null;
        const apptMatch = document.body.textContent.match(/Appt[:\s(]+(\d{2}\/\d{2}\/\d{4})/i);
        if (apptMatch) {
            const [mm, dd, yyyy] = apptMatch[1].split('/');
            serviceDate = new Date(+yyyy, +mm - 1, +dd);
        }
        if (!serviceDate || isNaN(serviceDate)) serviceDate = new Date();

        let age = serviceDate.getFullYear() - dob.getFullYear();
        const md = serviceDate.getMonth() - dob.getMonth();
        if (md < 0 || (md === 0 && serviceDate.getDate() < dob.getDate())) age--;
        return age;
    }

    // ═══ Reference data ═════════════════════════════════════════════════
    const PREVENTIVE_RULES = {
        "99391": { min: 0, max: 0 }, "99392": { min: 1, max: 4 }, "99393": { min: 5, max: 11 },
        "99394": { min: 12, max: 17 }, "99395": { min: 18, max: 39 }, "99396": { min: 40, max: 64 },
        "99397": { min: 65, max: 999 }, "99381": { min: 0, max: 0 }, "99382": { min: 1, max: 4 },
        "99383": { min: 5, max: 11 }, "99384": { min: 12, max: 17 }, "99385": { min: 18, max: 39 },
        "99386": { min: 40, max: 64 }, "99387": { min: 65, max: 999 }
    };

    const EYE_ICD_PATTERNS = [/^H(0[0-6]|1[0-9]|2[0-8]|3[0-6]|40|4[2-9]|5[0-9])/, /^C69/, /^D31/, /^Q1[0-5]/, /^S05/, /^T15/, /^T26/, /^P39\.1/];
    const isEyeICD = c => !!c && EYE_ICD_PATTERNS.some(rx => rx.test(c.toUpperCase()));

    const PAIN_RELATED_ICD_CODES = new Set([
        "R52","R52.0","R52.1","R52.2","R52.9","R51","G44.1","G44.209","G44.401","G44.501",
        "R07.0","R07.1","R07.2","R07.9","M54.2","M54.5","M54.4","M54.8","M54.9","M54.59","M54.50","M54.12",
        "M25.5","M25.51","M25.52","M25.53","M25.54","M25.55","M25.56","M25.57","M25.58","M25.59",
        "M25.511","M25.512","M25.519","M25.521","M25.522","M25.529","M25.531","M25.532","M25.539","M25.541","M25.542","M25.549",
        "M25.551","M25.552","M25.559","M25.561","M25.562","M25.569","M25.571","M25.572","M25.579",
        "M79.6","M79.1","M79.2","M79.7","G89.0","G89.2","G89.3","G89.4","G89.21","G89.22","G89.29",
        "G50.1","G56.0","G57.0","R10.0","R10.2","R10.30","R10.4","M17.0","N94.4","N94.5","N94.6","M72.2",
        "R52.81","R52.82","R52.89","M54.16","M10.9","M17.12","M79.10","M85.80","R25.2","M43.16","K59.4",
        "T14.0","T79.8XXA","K52.9","R11.2"
    ]);
    const NON_PAIN_M_EXACT_CODES = new Set(["M67.4","M72.0","M79.3","M81.0","M81.6","M81.8","M22.0","M22.1","M24.4","M24.5","M24.6","M25.6","M62.4","M62.81","M89.7"]);
    const NON_PAIN_M_PREFIXES = ["M20.","M21.","M40.","M41.","M43.0","M43.1","M85.","M95.","M96.","M88"];
    function isPainRelatedICD(code) {
        if (!code) return false;
        if (PAIN_RELATED_ICD_CODES.has(code)) return true;
        if (code.startsWith('M')) {
            if (NON_PAIN_M_EXACT_CODES.has(code)) return false;
            if (NON_PAIN_M_PREFIXES.some(p => code.startsWith(p))) return false;
            return true;
        }
        return false;
    }

    const CHRONIC_CODES = new Set([
        "B18.8","I10","E03.8","E03.9","E07.89","E07.9","E11.21","E11.22","E11.40","E11.42","E11.49","E11.59",
        "E11.610","E11.618","E11.65","E11.69","E11.8","E11.9","E44.0","E78.1","E78.2","E78.5",
        "F01.50","F01.51","F03.90","F03.91","F06.30","F06.31","F06.32","F06.4","F20.1","F20.3","F20.9","F31.10",
        "F31.61","F31.9","F32.9","F32.A","F33.0","F33.1","F34.9","F39","F41.1","F41.9","F51.01","F51.12","F52.21",
        "G47.00","G47.09","G89.29","H25.013","H34.8192","I25.10","I25.119","I25.810","I25.812","I25.83","I25.9",
        "I48.91","I50.22","I51.7","I51.9","I67.9","I73.9","I83.10","I83.891","I83.93",
        "J32.0","J44.1","J44.9","J45.20","J45.21","J45.30","J45.40","J45.901","J45.909","J45.991",
        "K21.00","K21.9","K58.0","K58.1","K58.2","K70.31","K74.60","K76.0","K86.0","K86.1","K90.0",
        "L40.9","L74.9","L83","M06.89","M06.9","M10.00","M10.072","M10.9","M47.22","M47.25","M47.26","M79.7","M81.0",
        "N18.2","N18.30","N18.31","N18.32","N18.4","N18.9","N40.0","N40.1","N46.9","N52.9",
        "R00.1","R01.1","R41.81","R54","R87.810","R94.4","R94.5","R94.6","T82.212D"
    ]);

    const SL_MODIFIER_CPTS = new Set([
        "90380","90381","90382","90480","90589","90611","90619","90620","90621","90622","90623","90624","90633",
        "90647","90648","90651","90656","90657","90658","90660","90661","90671","90674","90677","90680","90681",
        "90686","90688","90696","90697","90698","90700","90702","90707","90710","90713","90714","90715","90716",
        "90723","90732","90734","90740","90743","90744","90746","90747","90749","91304","91319","91320","91321",
        "91322","91323","96380","96381"
    ]);

    // ═══ CPT rules ══════════════════════════════════════════════════════
    function buildCPTRules() {
        const rules = {};
        const prevICDs = ["Z00.01","Z00.121","Z00.00","Z00.129","Z68","Z71.3","Z71.82","Z71.89"];
        ["99391","99392","99393","99394","99395","99396","99397","99381","99382","99383","99384","99385","99386","99387","G0438","G0439","G0402"]
            .forEach(c => { rules[c] = { type: "customICDCollector", icdList: prevICDs }; });

        const ecgICDs = ["E78","I10","R00.0","R00.1","R00.2","R03.0","R06.02","R07.9","Z13.6"];
        const labDrawICDs = ["E08","E09","E10","E11","E13","R73.03","E78","E00","E01","E02","E03","I10"];
        const b12ICDs = ["D51.9","E53.9"];
        const ov = { fallback: "officeVisit" };
        const ex = icds => ({ type: "exact", icds, ...ov });
        const sw = icds => ({ type: "startsWith", icds, ...ov });

        Object.assign(rules, {
            "3008F": { type: "customICDCollector", icdList: ["Z00.01","Z00.121","Z00.00","Z00.129","E66.3","E66.9","E66.01","E66.09","R63.6","Z68"] },
            "2010F": { type: "bmiLink" }, "G8418": { type: "bmiLink" }, "G8417": { type: "bmiLink" }, "G8420": { type: "bmiLink" },
            "0503F": ex(["Z39.2"]),
            "99401": { type: "multiICD", icds: [["Z71.3"], ["Z71.82","Z71.89"]] },
            "99402": { type: "multiICD", icds: [["Z71.3"], ["Z71.82","Z71.89"]] },
            "99406": { type: "multiICD", icds: [["F17"], ["Z71.6"]] },
            "G0447": { type: "multiICD", icds: [["E66.9","E66.01","E66.09"], ["Z68"]] },
            "LSM01": { type: "customICDCollector", icdList: ["Z71.3","Z71.82","Z71.89"], ...ov },
            "PD001": { type: "customICDCollector", icdList: ["Z71.3","Z71.82","Z71.89"], ...ov },
            "4013F": sw(["E78"]), "G9664": sw(["E78"]),
            "2026F": sw(["E11"]), "2033F": sw(["E11"]), "3072F": sw(["E11"]),
            "4010F": sw(["I10"]), "CP001": ex(["Z09","Z71.89","Z76.89"]),
            "3074F": sw(["I10"]), "3075F": sw(["I10"]), "3077F": sw(["I10"]), "3078F": sw(["I10"]),
            "3079F": sw(["I10"]), "3080F": sw(["I10"]),
            "G8752": sw(["I10"]), "G8753": sw(["I10"]), "G8754": sw(["I10"]), "G8755": sw(["I10"]),
            "3725F": ex(["Z13.31"]), "G8510": ex(["Z13.31"]), "G0444": ex(["Z13.31"]), "G8431": ex(["Z13.31"]),
            "1000F": sw(["F17"]), "1036F": sw(["F17"]), "G9275": sw(["F17"]), "G9276": sw(["F17"]),
            "G9622": ex(["Z13.89","Z13.9"]), "G0442": ex(["Z13.89","Z13.9"]),
            "3016F": ex(["Z13.89","Z13.9"]), "H0049": ex(["Z13.89","Z13.9"]),
            "G0136": { type: "officeVisit" }, "1100F": { type: "officeVisit" }, "3288F": { type: "officeVisit" },
            "1101F": { type: "officeVisit" },
            "1125F": { type: "painLink", ...ov }, "0521F": { type: "painLink", ...ov },
            "99497": { type: "chronicLink", ...ov }, "1157F": { type: "chronicLink", ...ov },
            "1126F": { type: "officeVisit" }, "1160F": { type: "officeVisit" }, "1170F": { type: "officeVisit" },
            "3048F": sw(["E78","Z71.2"]), "3049F": sw(["E78","Z71.2"]), "3050F": sw(["E78","Z71.2"]),
            "3044F": sw(["E11","R73.03","Z71.2"]), "3051F": sw(["E11","R73.03","Z71.2"]),
            "3052F": sw(["E11","R73.03","Z71.2"]), "3046F": sw(["E11","R73.03","Z71.2"]),
            "3060F": ex(["Z71.2"]), "3061F": ex(["Z71.2"]),
            "Q0091": ex(["Z12.4"]), "G0101": ex(["Z12.4"]), "88150": ex(["Z12.4"]), "88142": ex(["Z12.4"]),
            "86480": ex(["Z11.1"]),
            "S0612": { type: "multiICD", icds: [["Z11.51","Z12.4"]], ...ov },
            "93000": { type: "customICDCollector", icdList: ecgICDs, useRowOrder: true, ...ov },
            "93005": { type: "customICDCollector", icdList: ecgICDs, useRowOrder: true, ...ov },
            "93010": { type: "customICDCollector", icdList: ecgICDs, useRowOrder: true, ...ov },
            "81025": ex(["Z32.00","Z32.01","Z32.02"]), "83014": ex(["B96.81"]), "86580": ex(["Z11.1"]),
            "87811": ex(["Z11.52"]),
            "92228": sw(["E11"]), "92229": sw(["E11"]), "92250": sw(["E11"]), "82962": sw(["E11"]),
            "94060": ex(["R06.2"]), "96160": ex(["Z71.89"]), "G9820": ex(["Z11.3"]),
            "96372": { type: "customICDCollector", icdList: b12ICDs, ...ov },
            "97802": { type: "customICDCollector", icdList: ["Y93.79","Y93.81"], ...ov },
            "J3420": { type: "customICDCollector", icdList: b12ICDs, ...ov },
            "99408": ex(["Z13.9"]),
            "99173": ex(["Z01.00","Z00.01","Z00.121"]),
            "82270": ex(["Z12.11"]),
            "G0108": sw(["E11"]), "2028F": sw(["E11"]), "2023F": sw(["E11"]), "4008F": sw(["I10"]),
            "69209": sw(["H61"]), "96210": sw(["H61"]),
            "G0445": ex(["Z11.3"]), "G0328": ex(["Z12.11"]), "G0123": ex(["Z12.4"]), "G2023": ex(["Z11.52"]),
            "87110": ex(["Z11.8"]), "82950": ex(["Z13.1"]), "95251": ex(["E11.9"]), "95249": ex(["Z46.89"]),
            // Z12.31 (screening mammogram) takes priority, Z71.2 as fallback
            "3014F": ex(["Z12.31","Z71.2"]), "3015F": ex(["Z12.4","Z71.2"]),
            "3017F": { type: "multiICD", icds: [["Z12.11","Z71.2"]], ...ov },
            "36415": { type: "labDrawThenZ13", icdList: labDrawICDs },
            "1111F": { type: "officeVisit" }, "99051": { type: "officeVisit" },
            "82274": { type: "officeVisit" }, "99000": { type: "officeVisit" }
        });
        ["99211","99212","99213","99214","99215","99201","99202","99203","99204","99205"]
            .forEach(c => { rules[c] = { type: "officeVisit" }; });
        // Vaccines / admin → Z23
        ["90460","90461","90471","90472","G0008","G0009","90674","90686","90688","90715","90746","90589","90700",
         "90702","90696","90697","90723","90698","90633","90740","90743","90744","90747","90647","90648","90651",
         "90707","90710","90619","90620","90621","90624","90734","90623","90732","90671","90677","90713","90680",
         "90681","90714","90622","90611","90716","90749","90656","90657","90658","90660","90661","91319","91320",
         "91321","91322","91323","91304","90480","90380","90381","90382","96380","90694","96381"]
            .forEach(c => { rules[c] = ex(["Z23"]); });
        return rules;
    }
    const cptRules = buildCPTRules();

    // ═══ Planning (pure: ICD list in → picks out, no DOM) ═══════════════
    const matchesCode = (val, code) =>
        code.includes('.') ? val === code.toUpperCase() : val.startsWith(code.toUpperCase());

    function officeVisitPicks(icds) {
        return icds.filter(i => !i.code.startsWith('Z') && i.code[0] >= 'A' && i.code[0] <= 'Y' && i.rowNum).slice(0, 4);
    }

    function planCPT(cpt, icds) {
        const rule = cptRules[cpt];
        if (!rule || rule.type === 'officeVisit') return officeVisitPicks(icds);
        const fallback = picks => (picks.length || rule.fallback !== 'officeVisit') ? picks : officeVisitPicks(icds);

        // 3008F is checked first, as in the original
        if (cpt === '3008F' || rule.type === 'bmiLink') {
            const picks = [];
            const priority = ["Z00.01","Z00.121","Z00.00","Z00.129","E66.3","E66.9","E66.01","E66.09","R63.6"];
            let first = null;
            for (const code of priority) { first = icds.find(i => i.code === code); if (first) break; }
            if (!first) first = icds.find(i => !i.code.startsWith('Z'));
            if (first) picks.push(first);
            const z68 = icds.find(i => i.code.startsWith('Z68'));
            if (z68) picks.push(z68);
            return picks;
        }

        if (rule.type === 'labDrawThenZ13') {
            const matched = icds.filter(i => rule.icdList.some(c => matchesCode(i.code, c)));
            if (matched.length) return matched.slice(0, 4);
            if (icds.some(i => !i.code.startsWith('Z'))) return officeVisitPicks(icds);
            const z13 = icds.find(i => i.code === 'Z13.0');
            return z13 ? [z13] : [];
        }

        if (rule.type === 'painLink') return fallback(icds.filter(i => isPainRelatedICD(i.code)).slice(0, 4));
        if (rule.type === 'chronicLink') return fallback(icds.filter(i => CHRONIC_CODES.has(i.code)).slice(0, 4));

        if (cpt === '99173') {
            const eye = icds.filter(i => isEyeICD(i.code));
            if (eye.length) return eye.slice(0, 4);
            const prev = icds.find(i => ["Z01.00","Z00.01","Z00.121"].includes(i.code));
            if (prev) return [prev];
            return officeVisitPicks(icds);
        }

        if (rule.type === 'customICDCollector') {
            let picks;
            if (rule.useRowOrder) {
                picks = icds.filter(i => rule.icdList.some(c => matchesCode(i.code, c)));
            } else {
                // list order, de-duplicated
                const seen = new Set(); picks = [];
                rule.icdList.forEach(c => icds.forEach(i => {
                    if (matchesCode(i.code, c) && !seen.has(i.code)) { seen.add(i.code); picks.push(i); }
                }));
            }
            return fallback(picks.slice(0, 4));
        }

        // exact / startsWith / multiICD: one pick per group, slot = group index
        const groups = Array.isArray(rule.icds[0]) ? rule.icds : [rule.icds];
        const picks = [];
        groups.forEach((options, idx) => {
            for (const code of options) {
                const hit = icds.find(i => code.length <= 3 ? i.code.startsWith(code) : i.code === code);
                if (hit && hit.rowNum) { picks[idx] = hit; break; }
            }
        });
        return picks.some(Boolean) ? picks : fallback([]);
    }

    // ═══ Writing ═════════════════════════════════════════════════════════
    // Model path: every row in one digest.
    function applyPlansToModel(plans) {
        const scope = angular.element(document.querySelector('#billingTbl4')).scope();
        const write = () => {
            plans.forEach(({ model, picks, sl }) => {
                for (let s = 1; s <= 4; s++) {
                    const p = picks[s - 1];
                    model['icd' + s] = p ? p.rowNum : '';
                    model['icdcode' + s] = p ? p.code : '';
                }
                if (sl) model.mod1 = 'SL';
            });
        };
        if (scope.$root.$$phase) write(); else scope.$apply(write);
    }

    // DOM path (original behaviour): used when a row has no model or USE_MODEL_WRITE is off.
    function getICDInput(row, slot) {
        const inputs = row.querySelectorAll(`input[data-fieldname="icd${slot}"]`);
        if (!inputs.length) return null;
        if (inputs.length === 1) return inputs[0];
        for (const inp of inputs) { const td = inp.closest('td'); if (td && !td.classList.contains('ng-hide') && td.offsetParent !== null) return inp; }
        for (const inp of inputs) { const td = inp.closest('td'); if (td && !td.classList.contains('ng-hide')) return inp; }
        return inputs[inputs.length - 1];
    }

    function setInputValue(el, value) {
        if (!el) return;
        el.focus(); el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
        if (typeof window.txtIcdBlur === 'function' && /^icd\d$/.test(el.getAttribute('data-fieldname') || '')) {
            try {
                const idx = el.closest('tr').querySelector('input[data-fieldindex]')?.getAttribute('data-fieldindex') || 0;
                window.txtIcdBlur(el.getAttribute('data-fieldname'), el.value, 'GET_CODE', parseInt(idx, 10), 'yes');
            } catch (e) {}
        }
    }

    function applyPlanToDOM({ tr, picks, sl }) {
        for (let s = 1; s <= 4; s++) setInputValue(getICDInput(tr, s), picks[s - 1]?.rowNum || '');
        if (sl) {
            const mod = tr.querySelector('input[data-fieldname="mod1"], input[name="mod1"], input[id*="mod1"]');
            setInputValue(mod, 'SL');
        }
        tr.querySelectorAll('td.ng-binding[title]').forEach(td => td.dispatchEvent(new Event('mouseover')));
    }

    // ═══ Checks ═════════════════════════════════════════════════════════
    function alertDuplicateICDStart(icds) {
        const map = {};
        icds.forEach(({ code }) => {
            if (code.length < 3 || code.startsWith('Z')) return;
            (map[code.slice(0, 3)] ||= []).push(code);
        });
        const dups = Object.values(map).filter(a => a.length > 1);
        if (dups.length) showNotification([`Duplicate ICD prefix conflict: ${dups.map(a => a.join(', ')).join(' | ')}`]);
    }

    function checkDiabetesPrediabetesConflict(icds) {
        const codes = icds.map(i => i.code);
        if (codes.some(c => /^E0[89]|^E1[0-3]|^O24/.test(c)) && codes.some(c => c === 'R73.03' || c.startsWith('R7303')))
            showNotification(['Diabetes and Prediabetes (R73.03) both present — remove one']);
    }

    function alertDuplicateCPT(cpts) {
        const counts = {};
        cpts.forEach(({ code }) => { counts[code] = (counts[code] || 0) + 1; });
        const dups = Object.keys(counts).filter(c => counts[c] > 1);
        if (dups.length) showNotification([`Duplicate CPT(s) detected: ${dups.join(', ')}`]);
    }

    function validatePreventiveCPT(cpts, age) {
        if (age === null) return;
        const warnings = [];
        cpts.forEach(({ code }) => {
            const r = PREVENTIVE_RULES[code];
            if (!r || (age >= r.min && age <= r.max)) return;
            const correct = Object.entries(PREVENTIVE_RULES).filter(([, x]) => age >= x.min && age <= x.max).map(([k]) => k).join(', ');
            warnings.push(`CPT ${code} unsuitable for age ${age}. Suggested: ${correct}`);
        });
        if (warnings.length) showNotification(warnings);
    }

    let lastL21NotifyTime = 0;
    function checkForL21(icds, age) {
        if (age === null) return;
        const l21 = [...new Set(icds.map(i => extractICDCode(i.rawText)).filter(c => c && c.startsWith('L21')))];
        if (!l21.length) return;
        const bad = age < 18 ? l21.filter(c => c !== 'L21.0') : l21.filter(c => c === 'L21.0');
        if (!bad.length || Date.now() - lastL21NotifyTime < 2000) return;
        lastL21NotifyTime = Date.now();
        showNotification([age < 18
            ? `Patient is ${age} (under 18) — use L21.0 instead of ${bad.join(', ')}`
            : `Patient is ${age} (18+) — use L21.9/L21.8 instead of L21.0`]);
    }

    function checkForCancerICD(icds) {
        const c = [...new Set(icds.map(i => i.code).filter(x => x.startsWith('C')))];
        if (c.length) showNotification([`ICD code(s) ${c.join(', ')} start with "C" (malignant neoplasm) — please verify`]);
    }

    function checkForFluVaccineCPTs(cpts) {
        const p = [...new Set(cpts.map(c => c.code).filter(c => c === '90686' || c === '90688'))];
        if (p.length) showNotification([`CPT ${p.join(', ')} present on this claim`]);
    }

    function checkMedicarePreventiveCPT(cpts) {
        let primary = null;
        document.querySelectorAll('.insurance-name, [data-fieldname*="Insurance"]').forEach(el => {
            const t = (el.value || el.textContent || '').trim();
            if (t && !primary) primary = t;
        });
        if (!primary || !primary.toUpperCase().includes('MEDICARE')) return;
        const bad = [...new Set(cpts.map(c => c.code).filter(c => /^993[89]\d$/.test(c)))];
        if (bad.length) showNotification([`Add G0438/G0439 — ${bad.join(', ')} is invalid for Medicare`]);
    }

    // ═══ Main ═══════════════════════════════════════════════════════════
    // Returns { rows, model, dom, ms } so Add to EMR can report it.
    function mainFlow() {
        const t0 = performance.now();
        const icds = readICDs();
        const cpts = readCPTs();
        const age = getPatientAge();

        const plans = cpts.map(c => ({
            ...c,
            picks: planCPT(c.code, icds),
            sl: age !== null && age < 19 && SL_MODIFIER_CPTS.has(c.code)
        }));

        const modelPlans = USE_MODEL_WRITE ? plans.filter(p => p.model) : [];
        const domPlans = plans.filter(p => !modelPlans.includes(p));
        let modelOk = modelPlans.length;
        try {
            if (modelPlans.length) applyPlansToModel(modelPlans);
        } catch (e) {
            console.error('[Link] model write failed, falling back to DOM:', e);
            modelPlans.forEach(applyPlanToDOM);
            modelOk = 0;
        }
        domPlans.forEach(applyPlanToDOM);

        alertDuplicateICDStart(icds);
        // (removed: "Diagnosis code(s) … found below a Z code" — Add to EMR orders Z codes last)
        alertDuplicateCPT(cpts);
        validatePreventiveCPT(cpts, age);
        // (removed: "99214 can be added" — the coding panel decides the office visit itself)
        checkForL21(icds, age);
        checkForCancerICD(icds);
        checkDiabetesPrediabetesConflict(icds);
        checkForFluVaccineCPTs(cpts);
        checkMedicarePreventiveCPT(cpts);

        const ms = Math.round(performance.now() - t0);
        console.log(`[Link] ${plans.length} CPT rows (${modelOk} model, ${plans.length - modelOk} DOM) in ${ms} ms`);
        return { rows: plans.length, model: modelOk, dom: plans.length - modelOk, ms };
    }

    // ═══ Running it ═════════════════════════════════════════════════════
    let lastLinkedSig = '';
    let pendingSig = '';
    let lastEncounter = '';

    // Which codes are on the grids, in order — not the pointers, so linking
    // never triggers itself.
    function codesSignature() {
        if (!document.querySelector('#billingTbl4') || !document.querySelector('#billingTbl2')) return '';
        const cpt = getCPTRows().map(r => r.querySelector('td:nth-child(2)')?.textContent.trim() || '');
        if (!cpt.length) return '';
        return readICDs().map(i => i.code).join(',') + '|' + cpt.join(',');
    }

    function runLink(quiet) {
        flashLinking();
        quietRun = !!quiet;
        let result = null;
        try { result = mainFlow(); }
        catch (e) { console.error('ECW Pilot Link failed', e); }
        finally { quietRun = false; }
        lastLinkedSig = codesSignature();
        pendingSig = '';
        return result;
    }

    // Add to EMR's last step (Auto only) — the coding panel calls this after
    // codes are added, removed and put in order.
    if (PILOT) {
        PILOT.linkMode = linkMode;
        PILOT.linkNow = () => (linkMode() === 'auto' ? runLink(true) : null);
        // For the panel's Modifiers table: which of these codes Link gives SL.
        PILOT.linkSLCodes = codes => {
            const age = getPatientAge();
            if (age === null || age >= 19) return [];
            return (codes || []).filter(c => SL_MODIFIER_CPTS.has(String(c).trim()));
        };
    }

    // ═══ Link button (Off = disabled, Manual/Auto = active) ═════════════
    // Manual = solid red "Link" (a task) · Auto = soft green "Linked ✓"
    // (done — click to link again) · Off = grey, disabled.
    const BTN_ON = '#FF0000', BTN_HOVER = '#8c8c8c', BTN_OFF = '#c9ced1';
    const AUTO_BG = '#e4f3e9', AUTO_BG_HOVER = '#d3ecdb', AUTO_INK = '#2f7d4f', AUTO_LINE = '#b9dfc6';
    let busyLabelUntil = 0;

    function syncButton() {
        const btn = document.getElementById('ecwLinkBtnNoDelete');
        if (!btn) return;
        const mode = linkMode();
        const off = mode === 'off';
        const auto = mode === 'auto';
        btn.disabled = off;
        btn.style.background = off ? BTN_OFF : (auto ? AUTO_BG : BTN_ON);
        btn.style.color = off ? '#6b7478' : (auto ? AUTO_INK : '#fff');
        btn.style.border = auto ? `1px solid ${AUTO_LINE}` : 'none';
        btn.style.cursor = off ? 'not-allowed' : 'pointer';
        if (Date.now() < busyLabelUntil) return;          // "Linking…" is showing
        const label = auto ? 'Linked ✓' : 'Link';
        if (btn.textContent !== label) btn.textContent = label;
        btn.title = off ? 'Link is off — turn it on in ECW Pilot settings'
            : (auto ? 'Auto-link is on — links whenever the codes change and after Add to EMR. Click to link again.' : 'Link the diagnosis pointers now');
    }

    // Brief "Linking…" on the button while a run happens.
    function flashLinking() {
        const btn = document.getElementById('ecwLinkBtnNoDelete');
        if (!btn) return;
        btn.textContent = 'Linking…';
        busyLabelUntil = Date.now() + 700;
        setTimeout(syncButton, 750);
    }

    function createButton() {
        if (document.getElementById('ecwLinkBtnNoDelete')) { syncButton(); return; }
        const btn = document.createElement('button');
        btn.id = 'ecwLinkBtnNoDelete';
        btn.type = 'button';
        btn.textContent = 'Link';
        Object.assign(btn.style, {
            position: 'fixed', top: '60px', left: 'calc(100% - 280px)', padding: '9px 14px', zIndex: '999999',
            background: BTN_ON, color: '#fff', fontSize: '13px', border: 'none', borderRadius: '8px',
            cursor: 'pointer', boxShadow: '0 3px 8px rgba(0,0,0,0.25)', transition: 'background 0.3s'
        });
        btn.addEventListener('mouseenter', () => { if (!btn.disabled) btn.style.background = linkMode() === 'auto' ? AUTO_BG_HOVER : BTN_HOVER; });
        btn.addEventListener('mouseleave', () => syncButton());
        btn.addEventListener('click', () => {
            if (linkMode() === 'off') return;
            shownKeys.clear();          // a click shows every warning again
            runLink(false);
        });
        // With ECW Pilot the panel decides where/when it shows (inside the
        // panel, Billing only); on its own it floats as before.
        if (PILOT) btn.style.display = 'none';
        document.body.appendChild(btn);
        syncButton();
    }

    // ═══ Auto-link: codes changed and settled → link once ═══════════════
    function userIsTyping() {
        const el = document.activeElement;
        if (!el || el === document.body) return false;
        return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
    }

    function autoTick() {
        syncButton();
        const enc = document.querySelector('#encDropDownItem')?.getAttribute('title') || '';
        if (enc !== lastEncounter) {            // new patient/encounter
            lastEncounter = enc;
            shownKeys.clear();
            lastLinkedSig = '';
            pendingSig = '';
        }
        if (linkMode() !== 'auto') { pendingSig = ''; return; }
        if (PILOT && PILOT.busy) return;        // Add to EMR links at its own end
        const sig = codesSignature();
        if (!sig || sig === lastLinkedSig) { pendingSig = ''; return; }
        if (sig !== pendingSig) { pendingSig = sig; return; }   // wait until it settles
        if (userIsTyping()) return;             // try again once they leave the field
        runLink(true);
    }

    // ═══ Boot ═══════════════════════════════════════════════════════════
    (function waitForTables() {
        if (!document.querySelector('#billingTbl4') || !document.querySelector('#billingTbl2')) return setTimeout(waitForTables, 500);
        createButton();
    })();
    setInterval(autoTick, 800);
    window.addEventListener('ecwpilot:settings-changed', syncButton);
})();
