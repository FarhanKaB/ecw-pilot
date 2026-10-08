/* ============================================================
   ECW Pilot — shared/sort.js   (Smart Sort — every client)
   From the Sort extension (background.js + primary-icd-guard.js).

   While Smart Sort is ON (Settings menu), Add to EMR uses it instead of
   the basic ordering:
     1. sorts the diagnoses (ICD_HEAD list to the bottom in that order,
        then every other Z code A→Z),
     2. sorts the procedures (CPT_ORDER list),
     3. sets a primary diagnosis if none is set (first code allowed to be
        primary, by the same rules as the guard),
     4. applies the modifiers (25 / 59 rules below). A modifier SL that
        Link put on a vaccine is kept, as is 93/95 on 99213.
   The primary-diagnosis guard (blocks clicking a code that can't be
   primary, with "Allow Anyway") is also active while Smart Sort is on.
   The setting is read every time, so turning it off works immediately.

   To release a change: edit this file, then raise
   shared -> sort -> version in manifest.json.
   ============================================================ */
(function () {
  'use strict';
  if (window.__ecwPilotSortRunning) return;   // never start twice on one page
  window.__ecwPilotSortRunning = true;

  var PILOT = window.ECWPilot || null;
  function isOn() { return !PILOT || !PILOT.settings ? true : !!PILOT.settings.get('sort'); }

  // ═══ Shared helpers ═════════════════════════════════════════════════
  // Find the scope that owns `prop` (icdData / cptData) starting from a table.
  function findListScope(tableSel, prop) {
    var el = document.querySelector(tableSel);
    if (!el || !window.angular) return null;
    var s = angular.element(el).scope();
    while (s && !Array.isArray(s[prop])) s = s.$parent;
    return s || null;
  }

  // Replace array contents IN PLACE (never reassign: child scopes would shadow it).
  function replaceInPlace(arr, newOrder) {
    arr.length = 0;
    Array.prototype.push.apply(arr, newOrder);
  }

  // Same semantics as the old one-at-a-time moves: first match goes to the bottom.
  function moveToBottom(arr, getCode, code) {
    var i = arr.findIndex(function (x) { return getCode(x) === code; });
    if (i === -1) return;
    arr.push(arr.splice(i, 1)[0]);
  }

  function applyScope(scope, fn) {
    if (scope.$root.$$phase) fn(); else scope.$apply(fn);
  }

  // ═══ ICD sort ═══════════════════════════════════════════════════════
  // Moved to the bottom in this exact order.
var ICD_HEAD = [
      "F06.4","F32.0","F32.1","F32.2","F32.3","F32.4","F32.5","F32.81","F32.89","F32.9","F32.A",
      "F41.0","F41.1","F41.3","F41.8","F41.9",
      "D50.0","D50.1","D50.8","D50.9","D62","D64.9","E61.1",
      "F17.200","F17.201","F17.203","F17.208","F17.209","F17.210","F17.211","F17.213","F17.218","F17.219",
      "F17.220","F17.221","F17.223","F17.228","F17.229","F17.290","F17.291","F17.293","F17.298","F17.299",
      "E66.01","E66.09","E66.1","E66.2","E66.3","E66.811","E66.812","E66.813","E66.89","E66.9",
      "D51.0","D51.1","D51.2","D51.3","D51.8","D51.9","E56.9","E53.9","E53.8","E55.9",
      "Y93.79",
      "Z00.01","Z00.00","Z00.121","Z00.129",
      "Z68.51","Z68.52","Z68.53","Z68.54","Z68.55","Z68.56","Z68.1",
      "Z68.20","Z68.21","Z68.22","Z68.23","Z68.24","Z68.25","Z68.26","Z68.27","Z68.28","Z68.29",
      "Z68.30","Z68.31","Z68.32","Z68.33","Z68.34","Z68.35","Z68.36","Z68.37","Z68.38","Z68.39",
      "Z68.41","Z68.42","Z68.43","Z68.44","Z68.45",
      "Z71.3","Z71.82","Z71.89"
    ];
  // After the head list, every remaining Z code goes to the bottom in
  // ascending code order.

  // Pure: items in, sorted copy out (same algorithm as the extension).
  // getPrimary(item) -> true for a diagnosis already marked primary (optional).
  function orderICDItems(items, getCode, getPrimary) {
    var arr = items.slice();
    ICD_HEAD.forEach(function (c) { moveToBottom(arr, getCode, c); });
    var head = new Set(ICD_HEAD);
    var tail = arr.filter(function (r) { var c = getCode(r); return c.startsWith("Z") && !head.has(c); });
    var keep = arr.filter(function (r) { return tail.indexOf(r) === -1; });
    tail.sort(function (a, b) { return getCode(a) < getCode(b) ? -1 : getCode(a) > getCode(b) ? 1 : 0; });
    return floatPrimaryToTop(keep.concat(tail), getCode, getPrimary);
  }

  // The primary diagnosis belongs in row 1 (pointer 1 on the claim).
  // eCW moves it there itself when the Billing tab is saved, so if we leave
  // it further down, every code below shifts up afterwards and the CPT
  // diagnosis pointers Link just set end up on the wrong rows. Doing the
  // move here means the pointers are built against the final order.
  // The row chosen is the one already marked primary; if none is marked,
  // it's the one Smart Sort would set (the first that's allowed to be
  // primary) — the same code the panel tags "PRIMARY . will be set".
  function floatPrimaryToTop(arr, getCode, getPrimary) {
    var i = -1;
    if (typeof getPrimary === "function") {
      i = arr.findIndex(function (r) { return getPrimary(r); });
    }
    if (i === -1) {
      i = arr.findIndex(function (r) { return isPrimaryAllowedICD(getCode(r)); });
    }
    if (i <= 0) return arr;                       // none found, or already row 1
    var out = arr.slice();
    out.unshift(out.splice(i, 1)[0]);
    return out;
  }

  function sortICD() {
    var s = findListScope("#billingTbl2", "icdData");
    if (!s) return false;
    var getCode = function (r) { return (r && r.medicalcode || "").trim(); };
    // Row 1 = the diagnosis the ★ shows right now (live), not the saved flag.
    var live = currentPrimary(s);
    var getPrimary = function (r) { return !!live && getCode(r).toUpperCase() === String(live).toUpperCase(); };
    var sorted = orderICDItems(s.icdData, getCode, getPrimary);
    applyScope(s, function () { replaceInPlace(s.icdData, sorted); });

    // Same safety net as before, in case the row-number cell isn't bound to $index.
    setTimeout(function () {
      var tb = document.querySelector("#billingTbl2 tbody");
      if (!tb) return;
      Array.from(tb.children).forEach(function (x, j) {
        var c = x.querySelector("td center");
        if (c) c.textContent = j + 1;
      });
    }, 100);
    return true;
  }

  // ═══ CPT sort ═══════════════════════════════════════════════════════
var CPT_ORDER = [
      // Office Visits
      "99211","99212","99213","99214","99215","99202","99203","99204","99205","98005","99443","99442","99441",
      "99238","99234","99232","99223","99222","99221","98012",
      // TCM
      "99495","99496",
      // Preventive
      "99381","99382","99383","99384","99385","99386","99387","99391","99392","99393","99394","99395","99396","99397",
      "G0402","G0438","G0439",
      // Counselling
      "99401","99402","99403","99497","99406","99407","99408","G0447","Q2038","Q0091","G0101",
      // Procedures
      "92082","92228","92229","99173","99490","99484","99483","99457","99454","99453","99429","99412","99411","99177",
      "99172","99080","99072","99071","99024","99001","98967","98966","98960","98016","98013","98004","97803","97802",
      "97602","97597","97535","97530","97167","97166","97165","97140","97112","97110","95992","95251","95250","95249",
      "95165","95117","95115","95076","95024","95018","95004","94761","94760","94664","94640","94200","94060","94016",
      "94010","93978","93975","93971","93970","93923","93922","93880","93306","93268","93229","93228","93015","93010",
      "93005","93000","92611","92610","92607","92579","92558","92552","92551","92542","92524","92523","92522","92521",
      "92511","92507","92504","92310","92285","92250","92230","92134","92133","92100","92083","92081","92020","92015",
      "92014","92012","92004","92002","91320","91319","91313","91312","91305","91304","91300",
      // Vaccine
      "90471","90472","90460","90461","G0008","G0009","90862","90853","90849","90847","90846","90837","90836","90834",
      "90833","90832","90792","90791","90785","90756","90750","90748","90746","90744","90743","90736","90734","90733",
      "90732","90723","90718","90716","90715","90714","90713","90710","90707","90703","90700","90698","90697","90696",
      "90694","90691","90688","90687","90686","90685","90681","90680","90677","90674","90672","90670","90662","90661",
      "90658","90656","90653","90651","90650","90649","90648","90647","90636","90633","90632","90620","90619","90480",
      "90473","90396","90384",
      // 96 related
      "96401","96379","96373","96372","96367","96365","96361","96360","96161","96160","96156","96127","96110",
      // 2 related
      "29580","29550","29540","29130","28190","20612","20610","20605","20600","20551","20550",
      // J codes
      "J7610","J7307","J7301","J7300","J7298","J7296","J3520","J3490","J3420","J3301","J2930","J2920","J2790","J1885",
      "J1756","J1200","J1130","J1080","J1070","J1050","J1030","J1000","J0897","J0696","J0585",
      // Other
      "99000","99051","99050",
      "H0049","H0047","H0009","H0002","H0001",
      "G0442","G0444","G0108","G0136","G0246","G0403","G0404","G0405","G0436","G0470","G0469","G0468","G0467","G0466",
      "G0443","G0417","G0406","G0328","G0202","G0180","G0179","G0123","G0121","G0104","G0103","G0010",
      // 8 related
      "88150","88142","87999","87880","87811","87807","87804","87651","87637","87636","87635","87430","87428","87426",
      "87338","87177","87110","87088","87086","87076","87070","86735","86677","86580","86480","86403","86328","85597",
      "84479","84443","84436","84153","83525","83518","83036","83014","83013","83009","82962","82950","82947","82607",
      "82570","82306","82274","82270","82043","81528","81025","81015","81007","81005","81003","81002","81001","81000",
      "80305","80053","80050","80048",
      // Other character-specific
      "U0002","U0001","T1028","T1013","P3001","M1296","M1293","M1211","M1208",
      "D9974","D9951","D9940","D9920","D9911","D9910","D9430","D9310","D9230","D9215","D9210","D9110","D7971","D7510",
      "D7460","D7411","D7410","D7321","D7311","D7310","D7286","D7283","D7280","D7251","D7250","D7240","D7230","D7220",
      "D7210","D7140","D7111","D6930","D6792","D6740","D6252","D6240","D6210","D6065","D6058","D6057","D5986","D5899",
      "D5821","D5820","D5760","D5750","D5741","D5740","D5731","D5730","D5660","D5650","D5640","D5630","D5620","D5610",
      "D5600","D5520","D5510","D5422","D5421","D5411","D5410","D5281","D5226","D5225","D5214","D5213","D5212","D5211",
      "D5200","D5130","D5120","D5110","D4910","D4355","D4342","D4341","D4211","D3999","D3347","D3330","D3320","D3310",
      "D3300","D3221","D3220","D3120","D3110","D2999","D2960","D2954","D2950","D2940","D2931","D2930","D2920","D2910",
      "D2750","D2740","D2700","D2394","D2393","D2392","D2391","D2335","D2332","D2331","D2330","D2161","D2160","D2150",
      "D2140","D1555","D1510","d1354","D1351","D1330","D1310","D1208","D1206","D1201","D1120","D1110","D0470","D0350",
      "D0330","D0274","D0272","D0270","D0230","D0220","D0210","D0180","D0171","D0170","D0160","D0150","D0140","D0120",
      "A7003","A6260","A4561",
      // 7 related
      "78268","78267","77081","77080","77067","77057","76999","76942","76882","76857","76856","76831","76830","76819",
      "76818","76817","76816","76815","76811","76805","76802","76801","76705","76700","75571","73721","73718","71046",
      // 6 related
      "69210","69209","69200","67820","65205","64555","64455","64450",
      // 5 related
      "59820","59514","59510","59430","59426","59425","59414","59409","59400","59160","59025","58940","58670","58661",
      "58611","58571","58562","58558","58550","58301","58300","58150","58140","58120","58110","58100","57522","57520",
      "57510","57500","57460","57456","57455","57454","57420","57410","57200","57170","57160","56605","54150",
      "5200D","5200C","5200B","5200A","51798","5100D","5100C","5100B","5100A",
      // 4 related
      "49002","44389","44388","43235","41115","41010",
      // Other billable
      "36410","36415","36416","0521F","0518F","0513F","0503F","0502F","0501F","0500F","0403T","0173A","0144A","0134A",
      "0124A","0121A","0071A","0054A","0052A","0051A","0031A","0012A","0011A","0004A",
      // QM: Depression screening
      "3725F","G8510","G8431",
      // QM: BMI
      "3008F","G8420","G8417","G8418",
      // QM: BP
      "3074F","3075F","3077F","3078F","3079F","3080F",
      // QM: Tobacco
      "1000F","1032F","1036F","G9275","G9276",
      // Others
      "S9470","S9451","S9442","S9441","S4993","S4990","S2120","S0630","S0612","S0610","S0340","S0257","S0191","S0190",
      "4000F","4004F","43328","G9920","G9903","G9899","G9831","G9820","G9797","G9796","G9664","G9642","G9622","G9621",
      "G9420","G9277","G9273","G9272","G9254","G9228","G9141","G9016","G8952","G8911","G8864","G8783","G8754","G8753",
      "G8752","G8737","G8736","G8710","G8598","G8476","G8473","G8432","G8428","G8427","G8419","G8410","G8404","G8111",
      "G2252","G2211","G2160","G2075","G2023","G2012",
      "3014F","3015F","3016F","3017F","3044F","3046F","3048F","3049F","3051F","3052F","3210F","3288F",
      "2010F","2022F","2023F","10060","1101F","1111F","1123F","1124F","1125F","1126F","1157F","1158F","1159F","1160F",
      "1170F","17000","3515F","3514F","3513F","3512F","3511F","3510F","3350F","3344F","3342F","3341F","3340F","3330F",
      "3292F","3281F","3279F","31575","31238","31231","3120F","3117F","3090F","30901","3085F","3072F","3066F","3062F",
      "3061F","3060F","3050F","3045F","30300","30140","3011F","2028F","2020F","2016F","2014F","2000F","17110","17003",
      "16020","16000","15853","15852","15789","15788","1494F","1220F","12001","11983","11982","11981","11900","11755",
      "11750","11740","11732","11730","11721","11720","11719","1150F","11200","11104","11103","11102","11057","11056",
      "11055","11044","11042","1100F","1090F","1060F","1034F","1033F","1031F","10180","10121","10120","10061","1005F",
      "10040","10006","10005","LSM01","4013F","PD001","CP001","2026F","2033F","4010F","4086F","4293F","G8950","AST01",
      "G8432"
    ];

  function orderCPTItems(items, getCode) {
    var arr = items.slice();
    CPT_ORDER.forEach(function (c) { moveToBottom(arr, getCode, c); });
    return arr;
  }

  function sortCPT() {
    var s = findListScope("#billingTbl4", "cptData");
    if (!s) return false;
    var getCode = function (r) { return (r && r.code || "").trim(); };
    var sorted = orderCPTItems(s.cptData, getCode);
    applyScope(s, function () { replaceInPlace(s.cptData, sorted); });
    var tb = document.querySelector("#billingTbl4 tbody");
    if (tb) tb.dispatchEvent(new Event("mouseup"));
    return true;
  }

  // ═══ Modifiers ══════════════════════════════════════════════════════
  // Pure plan: rows [{ code, mod1 }] in claim order → Map(code → mod1).
  // Same rules as the extension's applyModifierLogic.
  function planModifiers(rows) {
    // First row per code, same as the old rows.find() behaviour.
    var byCode = new Map();
    rows.forEach(function (r) {
      var c = (r && r.code || "").trim();
      if (c && !byCode.has(c)) byCode.set(c, r);
    });
    var presentCPTs = Array.from(byCode.keys());

    var officeVisit = ["99211","99212","99213","99214","99215","99201","99202","99203","99204","99205"];
    var preventive = ["99381","99382","99383","99384","99385","99386","99387","99391","99392","99393","99394","99395","99396","99397","99401","99402","99403","99404","G0402","G0438","G0439"];
    var others = ["99495","99496","99406","99407","99408","Q0091","90471","90472","90460","90461","93000","96372","20610","99497","G0008","G0009","99484","99483","99409","99173","99172","97804","97803","97802","96374","96373","94762","94761","94760","94012","94011","93018","93017","93016","93015","93010","93005","92270","92265","92260","92250","92242","92240","92235","92230","92229","92228","92227","91322","91321","91320","91319","91318","91310","91304"];
    var noModifierPreventive = ["G0402","G0438","G0439"];
    // G0447 is deliberately NOT in `others`; it carries its own 59.
    var mod59Codes = ["G0442","G0444","Q0091","G0447"];

    var has = function (codes) { return codes.some(function (c) { return byCode.has(c); }); };

    var plan = new Map();
    var setMod = function (code, val) { if (byCode.has(code)) plan.set(code, val); };

    // 99213 keeps a telehealth modifier (93/95); nothing else is protected.
    var telehealthMods = ["93", "95"];
    var m213 = byCode.get("99213");
    var protectedOfficeCodes = new Set(
      m213 && telehealthMods.includes(String(m213.mod1 || "").trim()) ? ["99213"] : []
    );

    presentCPTs.forEach(function (c) { if (!protectedOfficeCodes.has(c)) setMod(c, ""); });

    var hasOffice = has(officeVisit);
    var hasPreventive = has(preventive);
    var hasOther = has(others);

    if (hasOffice && (hasPreventive || hasOther)) {
      officeVisit.forEach(function (c) { if (!protectedOfficeCodes.has(c)) setMod(c, "25"); });
    }
    if (hasPreventive && hasOther) {
      preventive.forEach(function (c) { if (!noModifierPreventive.includes(c)) setMod(c, "25"); });
    }

    mod59Codes.forEach(function (c) { setMod(c, "59"); });

    // Advance care planning: 25 only when another `others` code (not ACP itself) is present.
    var acpCodes = ["99497","99498"];
    var hasOtherForACP = has(others.filter(function (c) { return !acpCodes.includes(c); }));
    if (has(acpCodes) && hasOtherForACP) acpCodes.forEach(function (c) { setMod(c, "25"); });

    // 99211: 25 if any other CPT is on the claim.
    if (byCode.has("99211") && presentCPTs.some(function (c) { return c !== "99211"; })) {
      setMod("99211", "25");
    }

    // ECW Pilot: keep the SL modifier Link puts on vaccines for patients under 19.
    plan.forEach(function (val, code) {
      if (val === "" && String(byCode.get(code).mod1 || "").trim().toUpperCase() === "SL") plan.set(code, "SL");
    });
    return plan;
  }

  function applyModifiers() {
    var s = findListScope("#billingTbl4", "cptData");
    if (!s) return 0;
    var byCode = new Map();
    s.cptData.forEach(function (r) {
      var c = (r && r.code || "").trim();
      if (c && !byCode.has(c)) byCode.set(c, r);
    });
    var plan = planModifiers(s.cptData);
    var changed = 0;
    applyScope(s, function () {
      plan.forEach(function (val, code) {
        var row = byCode.get(code);
        if (String(row.mod1 || "") !== val) changed++;
        row.mod1 = val;
      });
    });
    var tb = document.querySelector("#billingTbl4 tbody");
    if (tb) tb.dispatchEvent(new Event("mouseup"));
    return changed;
  }

  // ═══ Primary diagnosis ══════════════════════════════════════════════
  function isPrimaryAllowedICD(code) {
    if (!code) return false;
    code = code.trim().toUpperCase();

    // No 7-character code (decimal point excluded) can ever be primary
    if (code.replace(".", "").length === 7) return false;

    // Explicit allowed exceptions
    if (code === "I10") return true;
    if (code.startsWith("K21.")) return true;
    if (code.startsWith("N39.")) return true;

    // Explicit blocked exceptions
    if (code === "R53.1") return false;
    var blockedObesityCodes = ["E66.01","E66.09","E66.1","E66.2","E66.3","E66.811","E66.812","E66.813","E66.89","E66.9"];
    if (blockedObesityCodes.includes(code)) return false;
    var blockedVitaminCodes = ["D51.9","E53.8","E53.9","E55.9","E56.9"];
    if (blockedVitaminCodes.includes(code)) return false;

    return ["E", "G", "J", "L", "M", "R"].includes(code[0]);
  }

  // ── Reading from the model (icdData / row item `code`) ──────────────────
  function rowScope(row) {
    try { return window.angular ? angular.element(row).scope() : null; } catch (e) { return null; }
  }

  function codeForRow(row) {
    var s = rowScope(row);
    var c = s && s.code && s.code.medicalcode;
    if (c) return c.trim();
    // Fallback: the non-blank title cell (old behaviour)
    var cell = Array.from(row.querySelectorAll("td[title]"))
      .find(function (td) { return (td.getAttribute("title") || "").trim() !== ""; });
    return cell ? cell.getAttribute("title").trim() : null;
  }

  function allClaimCodes(row) {
    var s = rowScope(row);
    var list = s && Array.isArray(s.icdData) ? s.icdData : null;
    if (list) return list.map(function (d) { return d && d.medicalcode; }).filter(Boolean);
    return Array.from(document.querySelectorAll("#billingTbl2 tbody tr[ng-repeat]"))
      .map(codeForRow).filter(Boolean);
  }

  // ── Dialog (unchanged look) ─────────────────────────────────────────────
  function ensurePrimaryDialogFallbackStyles() {
    if (document.getElementById("primaryICDDialogFallbackStyles")) return;
    var style = document.createElement("style");
    style.id = "primaryICDDialogFallbackStyles";
    style.textContent = `
      .bootstrap-dialog.fade { transition: opacity 0.15s linear; }
      .bootstrap-dialog .modal-dialog { margin: 60px auto; width: 380px; max-width: 90vw; }
      .bootstrap-dialog .modal-content { background: #fff; border-radius: 4px; box-shadow: 0 3px 12px rgba(0,0,0,0.3); overflow: hidden; }
      .bootstrap-dialog .bootstrap-dialog-title { font-weight: bold; }
      .bootstrap-dialog .bootstrap-dialog-close-button { float: right; }
      .bootstrap-dialog .bootstrap-dialog-close-button .close { border: none; background: none; font-size: 18px; cursor: pointer; }
      .bootstrap-dialog .bootstrap-dialog-message { font-size: 14px; line-height: 1.5; }
      .bootstrap-dialog .bootstrap-dialog-footer-buttons { display: flex; gap: 8px; justify-content: flex-end; }
    `;
    document.head.appendChild(style);
  }

  function ensureAllowBtnStyles() {
    if (document.getElementById("primaryICDAllowBtnStyles")) return;
    var style = document.createElement("style");
    style.id = "primaryICDAllowBtnStyles";
    style.textContent = `
      #primaryICDDialog .allowBtn { background: #f0ad4e; color: #fff; border: 1px solid #eb9316; border-radius: 3px; padding: 6px 14px; font-size: 12px; cursor: pointer; }
      #primaryICDDialog .allowBtn:hover { background: #ec971f; border-color: #d68210; }
    `;
    document.head.appendChild(style);
  }

  function showPrimaryBlockDialog(code, row) {
    var nativeStylesPresent = !!document.querySelector('link[href*="bootstrap-dialog"], style[data-bootstrap-dialog]');
    if (!nativeStylesPresent) ensurePrimaryDialogFallbackStyles();
    ensureAllowBtnStyles();

    var oldBackdrop = document.querySelector(".modal-backdrop.primaryICDBackdrop");
    if (oldBackdrop) oldBackdrop.remove();
    var old = document.getElementById("primaryICDDialog");
    if (old) old.remove();

    var backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop fade in primaryICDBackdrop";

    var overlay = document.createElement("div");
    overlay.className = "modal bootstrap-dialog size-normal type-primary fade in";
    overlay.id = "primaryICDDialog";
    overlay.setAttribute("tabindex", "-1");
    overlay.style.display = "block";
    overlay.innerHTML =
      '<div class="modal-dialog"><div class="modal-content">' +
        '<div class="modal-header"><div class="bootstrap-dialog-header">' +
          '<div class="bootstrap-dialog-close-button"><button class="close">&times;</button></div>' +
          '<div class="bootstrap-dialog-title">eClinicalWorks</div>' +
        '</div></div>' +
        '<div class="modal-body"><div class="bootstrap-dialog-body">' +
          '<div class="bootstrap-dialog-message"></div>' +
        '</div></div>' +
        '<div class="modal-footer"><div class="bootstrap-dialog-footer"><div class="bootstrap-dialog-footer-buttons">' +
          '<button class="btn btn-lgrey btn-xs dismissBtn">OK</button>' +
          '<button class="btn allowBtn btn-xs">Allow Anyway</button>' +
        '</div></div></div>' +
      '</div></div>';
    overlay.querySelector(".bootstrap-dialog-message").textContent =
      (code || "This code") + " cannot be set as primary diagnosis.";

    function closeDialog() { overlay.remove(); backdrop.remove(); }

    overlay.querySelector(".close").addEventListener("click", closeDialog);
    overlay.querySelector(".dismissBtn").addEventListener("click", closeDialog);
    overlay.querySelector(".allowBtn").addEventListener("click", function () {
      var s = rowScope(row);
      if (s && s.makeICDPrimary && s.code) {
        s.$apply(function () { s.makeICDPrimary(s.code); });
      }
      closeDialog();
    });

    document.body.appendChild(backdrop);
    document.body.appendChild(overlay);
  }


  // ── Primary: what eCW currently has ─────────────────────────────────
  // Checked on a live chart: eCW's ★ follows $scope.primaryArr (codes) /
  // primaryNameArr (names) — updated the moment a ★ is set or un-set.
  // isPrimaryAsmt on the row is only what was SAVED and never changes while
  // the tab is open, so it's used only if eCW has no primaryArr at all.
  function primaryScope(s) {
    var x = s;
    while (x && !Array.isArray(x.primaryArr)) x = x.$parent;
    return x || null;
  }
  function currentPrimary(s) {
    if (!s || !Array.isArray(s.icdData)) return null;
    var ps = primaryScope(s);
    if (ps) {
      var codes = s.icdData.map(function (r) { return String(r && r.medicalcode || "").trim().toUpperCase(); });
      var live = ps.primaryArr.map(function (c) { return String(c || "").trim().toUpperCase(); })
        .find(function (c) { return codes.indexOf(c) !== -1; });
      return live || null;
    }
    var flagged = s.icdData.find(function (r) { return r && String(r.isPrimaryAsmt) === "1"; });
    return flagged ? String(flagged.medicalcode || "").trim() : null;
  }
  function hasPrimary() {
    return !!currentPrimary(findListScope("#billingTbl2", "icdData"));
  }

  // If no diagnosis is primary yet, make the first one that's allowed primary
  // — the same way clicking its ★ does: run that row's own ng-click
  // expression on the row's scope (right arguments, e.g. $index, included).
  async function setPrimaryIfMissing() {
    var s = findListScope("#billingTbl2", "icdData");
    if (!s || !s.icdData.length) return { set: false };
    var existing = currentPrimary(s);
    if (existing) return { set: false, already: true, code: existing };
    var item = s.icdData.find(function (r) { return r && isPrimaryAllowedICD(r.medicalcode); });
    if (!item) return { set: false, reason: "no diagnosis on the claim can be primary" };

    // The grid row that shows this diagnosis (matched by its data, not position).
    var rows = Array.from(document.querySelectorAll("#billingTbl2 tbody tr[ng-repeat]"));
    var tr = rows.find(function (r) { var rs = rowScope(r); return rs && rs.code === item; }) ||
             rows.find(function (r) { return codeForRow(r) === String(item.medicalcode).trim(); });
    var rs = tr ? rowScope(tr) : null;
    var cell = tr ? tr.querySelector('[ng-click*="makeICDPrimary"]') : null;
    var expr = cell ? cell.getAttribute("ng-click") : "";
    try {
      if (rs && expr && typeof rs.$eval === "function") {
        applyScope(rs, function () { rs.$eval(expr); });
      } else {
        var owner = rs;
        while (owner && typeof owner.makeICDPrimary !== "function") owner = owner.$parent;
        if (!owner) { owner = s; while (owner && typeof owner.makeICDPrimary !== "function") owner = owner.$parent; }
        if (!owner) return { set: false, reason: "eCW's make-primary (★) function was not found" };
        applyScope(owner, function () { owner.makeICDPrimary(item); });   // eCW's ★: makeICDPrimary(code)
      }
    } catch (e) {
      console.error("[Smart Sort] setting the primary diagnosis failed", e);
      return { set: false, reason: "eCW refused: " + (e && e.message || e) };
    }
    // Confirm eCW now has a primary (it may finish a moment later).
    for (var i = 0; i < 15; i++) {
      var now = currentPrimary(s);
      if (now) return { set: true, code: now };
      await new Promise(function (r) { setTimeout(r, 150); });
    }
    return { set: false, reason: "eCW did not mark " + item.medicalcode + " as primary" };
  }

  // ═══ Guard (active while Smart Sort is on) ═══════════════════════════
  function blockRestrictedPrimaryICD() {
    if (window.__primaryICDGuardAttached) return;
    window.__primaryICDGuardAttached = true;

    document.addEventListener("click", function (e) {
      if (!isOn()) return;
      var cell = e.target.closest('#billingTbl2 tbody tr td[ng-click*="makeICDPrimary"]');
      if (!cell) return;

      var row = cell.closest("tr");
      var code = codeForRow(row);
      if (isPrimaryAllowedICD(code)) return;

      // If nothing on the claim is primary-eligible, let the click through.
      if (allClaimCodes(row).some(isPrimaryAllowedICD)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        showPrimaryBlockDialog(code, row);
      }
    }, true); // capture phase: runs before Angular's ng-click
  }
  blockRestrictedPrimaryICD();

  // ═══ For the coding panel ═══════════════════════════════════════════
  // run(): what Add to EMR calls instead of the basic ordering.
  async function run() {
    var t0 = performance.now();
    // Primary first: sortICD() floats whichever row is marked primary to the
    // top, so it has to be set before the list is ordered.
    var primary = await setPrimaryIfMissing();
    var icd = sortICD();
    var cpt = sortCPT();
    var mods = applyModifiers();
    var ms = Math.round(performance.now() - t0);
    console.log("[Smart Sort] done in " + ms + " ms", { primary: primary, modifiersChanged: mods });
    return { ok: icd || cpt, primary: primary, modifiersChanged: mods, ms: ms };
  }

  var api = {
    isOn: isOn,
    run: run,
    planModifiers: planModifiers,
    isPrimaryAllowedICD: isPrimaryAllowedICD,
    hasPrimary: hasPrimary,
    currentPrimary: function () { return currentPrimary(findListScope("#billingTbl2", "icdData")); },
    orderICDCodes: function (codes) {
      var norm = function (c) { return String(c || "").trim().toUpperCase(); };
      var live = currentPrimary(findListScope("#billingTbl2", "icdData"));
      return orderICDItems(codes, norm, live ? function (c) { return norm(c) === norm(live); } : null);
    },
    orderCPTCodes: function (codes) { return orderCPTItems(codes, function (c) { return String(c || "").trim(); }); }
  };
  if (PILOT) PILOT.smartSort = api;
  window.__ecwSmartSort = api;
})();
