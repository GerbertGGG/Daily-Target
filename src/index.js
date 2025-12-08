const BASE_URL = "https://intervals.icu/api/v1";

// 🔥 Hardcoded Variablen – später ideal als Secrets/KV hinterlegen
const INTERVALS_API_KEY = "1xg1v04ym957jsqva8720oo01";
const INTERVALS_ATHLETE_ID = "i105857";
const INTERVALS_TARGET_FIELD = "TageszielTSS";
const INTERVALS_PLAN_FIELD = "WochenPlan";
const WEEKLY_TARGET_FIELD = "WochenzielTSS";
const DAILY_TYPE_FIELD = "TagesTyp"; // bleibt ungenutzt, aber existiert

// Fallback: angenommene Anzahl Trainingstage pro Woche
const TRAINING_DAYS_PER_WEEK = 4.0;

// Taper-Konstanten
const TAPER_MIN_DAYS = 3;
const TAPER_MAX_DAYS = 21;
const TAPER_DAILY_START = 0.8;
const TAPER_DAILY_END = 0.3;

// KV-Key für das Muster
const WEEKDAY_PATTERN_KEY = "weekdayPatternRaw";

// Lernrate für das exponentielle Lernen (0.0–1.0)
// 0.9 = viel Gedächtnis, neue Daten haben 10% Gewicht
const PATTERN_ALPHA = 0.9;

// ---------------------------------------------------------
// Adaptive Ramp – Hilfsfunktionen
// ---------------------------------------------------------

function median(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

// CTL-Delta-Fenster aus der Historie ableiten
function deriveAdaptiveCtlRampWindow(weeklyCtlHistory) {
  if (!weeklyCtlHistory || weeklyCtlHistory.length < 2) {
    // Fallback ohne History
    return { minDelta: -2, maxDelta: 2, medianDelta: 0 };
  }
  const deltas = [];
  for (let i = 1; i < weeklyCtlHistory.length; i++) {
    deltas.push(weeklyCtlHistory[i] - weeklyCtlHistory[i - 1]);
  }
  if (!deltas.length) {
    return { minDelta: -2, maxDelta: 2, medianDelta: 0 };
  }
  const med = median(deltas);

  // Fenster um den Median herum (z.B. ±0.7 CTL/Woche)
  let minDelta = med - 0.7;
  let maxDelta = med + 0.7;

  // Sicherheitskappen: nie mehr als ±3 CTL/Woche
  minDelta = Math.max(minDelta, -3);
  maxDelta = Math.min(maxDelta, 3);

  return { minDelta, maxDelta, medianDelta: med };
}

// Verbindung Weekly-TSS ↔ CTL-Delta (vereinfacht)
function weeklyTssFromCtlDelta(ctlNow, ctlDelta) {
  const targetAvgDailyTss = ctlNow + ctlDelta;
  return 7 * targetAvgDailyTss;
}

function ctlDeltaFromWeeklyTss(ctlNow, weeklyTss) {
  const avgDailyTss = weeklyTss / 7;
  return avgDailyTss - ctlNow;
}

// Wunsch-Ramp in % (nur grob, wird später durch CTL-Fenster geclamped)
function computeBaseRampPercent(classification, achievedCat) {
  // classification: "Müde" | "Normal" | "Erholt"
  if (classification === "Müde") {
    return -0.20;
  }
  if (classification === "Normal") {
    if (achievedCat === "untererfuellt") return -0.05;
    if (achievedCat === "erfuellt")      return 0.05;
    return 0.07; // übererfüllt
  }
  if (classification === "Erholt") {
    if (achievedCat === "untererfuellt") return 0.0;
    if (achievedCat === "erfuellt")      return 0.08;
    return 0.10; // übererfüllt
  }
  return 0;
}

// Montags-CTL-Historie holen (CTL der letzten n Montagswerte)
async function fetchWeeklyCtlHistory(mondayDate, weeksBack, athleteId, authHeader) {
  const mondayStr = mondayDate.toISOString().slice(0, 10);
  const startDate = new Date(mondayDate);
  startDate.setUTCDate(startDate.getUTCDate() - weeksBack * 7);
  const oldest = startDate.toISOString().slice(0, 10);

  const res = await fetch(
    `${BASE_URL}/athlete/${athleteId}/wellness?oldest=${oldest}&newest=${mondayStr}&cols=id,ctl`,
    { headers: { Authorization: authHeader } }
  );
  if (!res.ok) {
    if (res.body) res.body.cancel?.();
    return [];
  }
  const arr = await res.json();
  const ctlById = new Map();
  for (const d of arr) {
    if (d.id && d.ctl != null) {
      ctlById.set(d.id, d.ctl);
    }
  }

  const history = [];
  // Älteste Woche zuerst
  for (let i = weeksBack; i >= 0; i--) {
    const d = new Date(mondayDate);
    d.setUTCDate(d.getUTCDate() - i * 7);
    const id = d.toISOString().slice(0, 10);
    const ctl = ctlById.get(id);
    if (ctl != null) {
      history.push(ctl);
    }
  }
  return history;
}

// Adaptive Wochenziel-Berechnung basierend auf:
// - letzter Woche (Target + Ist)
// - aktuellem CTL
// - historischer CTL-Rampe
function computeNextWeekTargetAdaptive({
  ctlNow,
  weeklyTargetLast,
  weeklyActualLast,
  classification,   // "Müde" | "Normal" | "Erholt"
  weeklyCtlHistory
}) {
  if (weeklyTargetLast == null || weeklyActualLast == null) {
    return null; // kein adaptives Ziel möglich
  }

  const achieved = weeklyActualLast / weeklyTargetLast;
  let achievedCat;
  if (achieved < 0.8) achievedCat = "untererfuellt";
  else if (achieved <= 1.05) achievedCat = "erfuellt";
  else achievedCat = "uebererfuellt";

  const baseRamp = computeBaseRampPercent(classification, achievedCat);

  // "Wunsch"-Wochenziel rein aus der Ramp-Logik
  let desiredWeeklyTarget = weeklyTargetLast * (1 + baseRamp);

  // harte Caps auf %-Änderung, bevor CTL-Fenster greift
  desiredWeeklyTarget = Math.max(
    weeklyTargetLast * 0.75,
    Math.min(weeklyTargetLast * 1.25, desiredWeeklyTarget)
  );

  // resultierende CTL-Änderung
  const desiredCtlDelta = ctlDeltaFromWeeklyTss(ctlNow, desiredWeeklyTarget);

  // adaptives CTL-Fenster aus Historie
  const { minDelta, maxDelta, medianDelta } =
    deriveAdaptiveCtlRampWindow(weeklyCtlHistory);

  let clampedCtlDelta = desiredCtlDelta;
  if (clampedCtlDelta < minDelta) clampedCtlDelta = minDelta;
  if (clampedCtlDelta > maxDelta) clampedCtlDelta = maxDelta;

  // daraus neues Wochen-TSS
  let nextWeekTarget = weeklyTssFromCtlDelta(ctlNow, clampedCtlDelta);

  // Regression verhindern, wenn Woche erfüllt und nicht müde
  if (achieved >= 0.9 && classification !== "Müde") {
    nextWeekTarget = Math.max(nextWeekTarget, weeklyTargetLast);
  }

  // auf 5er-TSS runden
  nextWeekTarget = Math.round(nextWeekTarget / 5) * 5;

  return {
    nextWeekTarget,
    desiredWeeklyTarget,
    desiredCtlDelta,
    clampedCtlDelta,
    rampPercentEffective: (nextWeekTarget / weeklyTargetLast) - 1,
    achieved,
    achievedCat,
    ctlRampWindow: { minDelta, maxDelta, medianDelta }
  };
}

// ---------------------------------------------------------
// Lernendes Wochentagsmuster (KV)
// ---------------------------------------------------------

function normalizePattern(rawPattern) {
  let sum = rawPattern.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    // Fallback-Muster: Di/Do/Sa/So Hauptlast
    rawPattern = [0.0, 1.0, 0.0, 1.0, 0.0, 1.3, 0.7];
    sum = rawPattern.reduce((a, b) => a + b, 0);
  }
  return rawPattern.map((v) => (sum > 0 ? v / sum : 0));
}

// Initialisierung des Musters aus der History (z.B. letzte 12 Wochen)
async function initWeekdayPatternFromHistory(env, athleteId, authHeader, todayDate) {
  const HISTORY_WEEKS_INIT = 12;
  const startDate = new Date(todayDate);
  startDate.setUTCDate(startDate.getUTCDate() - HISTORY_WEEKS_INIT * 7);
  const oldest = startDate.toISOString().slice(0, 10);
  const newest = todayDate.toISOString().slice(0, 10);

  let rawPattern = new Array(7).fill(0); // Mo..So

  try {
    const histRes = await fetch(
      `${BASE_URL}/athlete/${athleteId}/wellness?oldest=${oldest}&newest=${newest}&cols=id,ctlLoad`,
      { headers: { Authorization: authHeader } }
    );
    if (histRes.ok) {
      const histArr = await histRes.json();
      for (const d of histArr) {
        if (!d.id || d.ctlLoad == null) continue;
        const dateObj = new Date(d.id + "T00:00:00Z");
        if (isNaN(dateObj.getTime())) continue;
        const wd = dateObj.getUTCDay(); // 0=So,1=Mo...
        let idx;
        if (wd === 0) idx = 6; // So -> 6
        else idx = wd - 1;     // Mo->0, Di->1, ...
        if (idx >= 0 && idx < 7) {
          rawPattern[idx] += d.ctlLoad;
        }
      }
    } else if (histRes.body) {
      histRes.body.cancel();
    }
  } catch (e) {
    console.error("Error in initWeekdayPatternFromHistory:", e);
  }

  // Falls gar nichts drin ist → Fallback
  let sum = rawPattern.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    rawPattern = [0.0, 1.0, 0.0, 1.0, 0.0, 1.3, 0.7];
  }

  await env.WEEKDAY_PATTERN.put(WEEKDAY_PATTERN_KEY, JSON.stringify(rawPattern));
  return rawPattern;
}

// Muster aus KV holen oder initialisieren
async function loadRawPattern(env, athleteId, authHeader, todayDate) {
  let rawStr = await env.WEEKDAY_PATTERN.get(WEEKDAY_PATTERN_KEY);
  if (!rawStr) {
    // erstmalig: aus History initialisieren
    return await initWeekdayPatternFromHistory(env, athleteId, authHeader, todayDate);
  }
  try {
    const arr = JSON.parse(rawStr);
    if (Array.isArray(arr) && arr.length === 7) {
      return arr.map((v) => (typeof v === "number" && isFinite(v) ? v : 0));
    }
  } catch (e) {
    console.error("Error parsing weekdayPatternRaw from KV:", e);
  }
  // Fallback, wenn KV kaputt
  const rawPattern = [0.0, 1.0, 0.0, 1.0, 0.0, 1.3, 0.7];
  await env.WEEKDAY_PATTERN.put(WEEKDAY_PATTERN_KEY, JSON.stringify(rawPattern));
  return rawPattern;
}

// Muster mit gestrigem Load updaten (Exponentielles Lernen)
async function updatePatternWithYesterday(env, rawPattern, yesterdayDate, yesterdayLoad) {
  if (!yesterdayDate || yesterdayLoad == null) {
    return rawPattern;
  }
  const d = yesterdayDate;
  const wd = d.getUTCDay(); // 0=So,1=Mo...
  let idx;
  if (wd === 0) idx = 6; // So -> 6
  else idx = wd - 1;     // Mo->0, Di->1, ...

  if (idx >= 0 && idx < 7) {
    const old = rawPattern[idx] ?? 0;
    const load = Math.max(0, yesterdayLoad);
    const updated = PATTERN_ALPHA * old + (1 - PATTERN_ALPHA) * load;
    rawPattern[idx] = updated;
  }

  await env.WEEKDAY_PATTERN.put(WEEKDAY_PATTERN_KEY, JSON.stringify(rawPattern));
  return rawPattern;
}

// ---------------------------------------------------------
// Hilfsfunktionen Training / Müdigkeit / Taper
// ---------------------------------------------------------

function computeDailyTarget(ctl, atl) {
  const base = 1.0;
  const k = 0.05;
  const tsb = ctl - atl;
  const tsbClamped = Math.max(-20, Math.min(20, tsb));
  const dailyTss = ctl * (base + k * tsbClamped);
  return Math.round(Math.max(0, Math.min(dailyTss, ctl * 1.5)));
}

// Dynamische Müdigkeitslogik
function classifyWeek(ctl, atl, rampRate) {
  const tsb = ctl - atl;

  // 1) Dynamischer TSB-Schwellenwert abhängig vom CTL
  let tsbCritical;
  if (ctl < 50) {
    tsbCritical = -5;
  } else if (ctl < 80) {
    tsbCritical = -10;
  } else {
    tsbCritical = -15;
  }
  const isTsbTired = tsb <= tsbCritical;

  // 2) ATL/CTL-Ratio
  let atlCtlRatio = Infinity;
  if (ctl > 0) {
    atlCtlRatio = atl / ctl;
  }

  let atlRatioThreshold;
  if (ctl < 50) {
    atlRatioThreshold = 1.2;
  } else if (ctl < 80) {
    atlRatioThreshold = 1.3;
  } else {
    atlRatioThreshold = 1.4;
  }
  const isAtlHigh = atlCtlRatio >= atlRatioThreshold;

  // 3) Ramp-Rate
  const isRampHigh = rampRate >= 1.0;
  const isRampLowAndFresh = rampRate <= -0.5 && tsb >= -5;

  // 4) Entscheidung
  if (isRampLowAndFresh) {
    return { state: "Erholt", tsb };
  }

  if (isRampHigh || isTsbTired || isAtlHigh) {
    return { state: "Müde", tsb };
  }

  return { state: "Normal", tsb };
}

function stateEmoji(state) {
  if (state === "Erholt") return "🔥";
  if (state === "Müde") return "🧘";
  return "⚖️";
}

// Nächstes Event holen
async function getNextEventDate(athleteId, authHeader, todayStr) {
  const todayDate = new Date(todayStr + "T00:00:00Z");
  const futureDate = new Date(todayDate);
  futureDate.setUTCDate(futureDate.getUTCDate() + 90);
  const futureStr = futureDate.toISOString().slice(0, 10);

  const res = await fetch(
    `${BASE_URL}/athlete/${athleteId}/events?oldest=${todayStr}&newest=${futureStr}`,
    { headers: { Authorization: authHeader } }
  );
  if (!res.ok) return null;

  const events = await res.json();
  if (!Array.isArray(events) || events.length === 0) return null;

  let candidates = events.filter(
    (e) => e.category === "RACE" || e.category === "TARGET"
  );
  if (candidates.length === 0) candidates = events;

  let bestDate = null;
  for (const ev of candidates) {
    const startLocal = ev.start_date_local || ev.startDateLocal || null;
    if (!startLocal) continue;
    const d = new Date(startLocal);
    if (isNaN(d.getTime())) continue;

    const dDateOnly = new Date(d.toISOString().slice(0, 10) + "T00:00:00Z");
    if (dDateOnly < todayDate) continue;

    if (!bestDate || dDateOnly < bestDate) {
      bestDate = dDateOnly;
    }
  }

  if (!bestDate) return null;

  const msDiff = bestDate.getTime() - todayDate.getTime();
  const daysToEvent = Math.round(msDiff / (1000 * 60 * 60 * 24));

  return {
    eventDate: bestDate.toISOString().slice(0, 10),
    daysToEvent
  };
}

// Taperlänge so wählen, dass TSB am Event-Tag >= 0 ist
function computeTaperDays(ctl0, atl0, normalLoad, daysToEvent) {
  if (daysToEvent <= 0) return 0;

  const tauCtl = 42;
  const tauAtl = 7;
  const maxTaper = Math.min(TAPER_MAX_DAYS, daysToEvent);
  let chosen = 0;

  for (let taperDays = TAPER_MIN_DAYS; taperDays <= maxTaper; taperDays++) {
    let ctl = ctl0;
    let atl = atl0;
    const taperStartIndex = daysToEvent - taperDays;

    for (let day = 0; day < daysToEvent; day++) {
      let factor = 1.0;

      if (day >= taperStartIndex) {
        if (taperDays <= 1) {
          factor = TAPER_DAILY_END;
        } else {
          const pos = day - taperStartIndex;
          const progress = Math.max(0, Math.min(1, pos / (taperDays - 1)));
          factor =
            TAPER_DAILY_START +
            (TAPER_DAILY_END - TAPER_DAILY_START) * progress;
        }
      }

      const load = normalLoad * factor;
      ctl = ctl + (load - ctl) / tauCtl;
      atl = atl + (load - atl) / tauAtl;
    }

    const tsbEvent = ctl - atl;
    if (tsbEvent >= 0) {
      chosen = taperDays;
      break;
    }
  }

  if (chosen === 0) return maxTaper;
  return chosen;
}

// Zukunfts-Wochen simulieren – jetzt mit Wochenprofil (weekdayWeights)
async function simulatePlannedWeeks(
  ctlMon0,
  atlMon0,
  weekState0,
  weeklyTarget0,
  baseMondayDate,
  weeksToSim,
  authHeader,
  athleteId,
  planField,
  weeklyTargetField,
  weekdayWeights
) {
  const tauCtl = 42;
  const tauAtl = 7;

  let pattern = Array.isArray(weekdayWeights) && weekdayWeights.length === 7
    ? weekdayWeights.slice()
    : [0.0, 1.0, 0.0, 1.0, 0.0, 1.3, 0.7]; // Mo..So

  let patternSum = pattern.reduce((a, b) => a + b, 0);
  if (patternSum <= 0) {
    pattern = [1, 1, 1, 1, 1, 1, 1];
    patternSum = 7;
  }

  let ctlStart = ctlMon0;
  let atlStart = atlMon0;
  let prevTarget = weeklyTarget0;
  let prevState = weekState0;

  for (let w = 1; w < weeksToSim; w++) {
    let ctl = ctlStart;
    let atl = atlStart;

    // 7 Tage mit Verteilungsprofil simulieren
    for (let d = 0; d < 7; d++) {
      const share = pattern[d] ?? 0;
      const load = patternSum > 0 ? (prevTarget * (share / patternSum)) : (prevTarget / 7);

      ctl = ctl + (load - ctl) / tauCtl;
      atl = atl + (load - atl) / tauAtl;
    }

    const ctlEnd = ctl;
    const atlEnd = atl;
    const rampSim = ctlEnd - ctlStart;
    const { state: simState } = classifyWeek(ctlEnd, atlEnd, rampSim);

    let nextTarget;
    if (simState === "Müde") {
      nextTarget = Math.round(prevTarget * 0.8);
    } else {
      if (rampSim < 0.5) {
        const factor = prevState === "Müde" ? 1.10 : 1.15;
        nextTarget = Math.round(prevTarget * factor);
      } else if (rampSim < 0.8) {
        nextTarget = Math.round(prevTarget * 1.10);
      } else if (rampSim <= 1.3) {
        nextTarget = Math.round(prevTarget * 1.05);
      } else if (rampSim <= 1.6) {
        nextTarget = Math.round(prevTarget * 0.92);
      } else {
        nextTarget = Math.round(prevTarget * 0.85);
      }
    }

    const maxIncrease = prevTarget * 1.20;
    const minDecrease = prevTarget * 0.75;
    nextTarget = Math.max(minDecrease, Math.min(nextTarget, maxIncrease));

    const mondayFutureDate = new Date(baseMondayDate);
    mondayFutureDate.setUTCDate(mondayFutureDate.getUTCDate() + 7 * w);
    const mondayId = mondayFutureDate.toISOString().slice(0, 10);

    const emoji = stateEmoji(simState);
    const planText = `Rest ${nextTarget} | ${emoji} ${simState} (geplant)`;

    const payloadFuture = {
      id: mondayId,
      [weeklyTargetField]: nextTarget,
      [planField]: planText
    };

    const resFuture = await fetch(
      `${BASE_URL}/athlete/${athleteId}/wellness/${mondayId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader
        },
        body: JSON.stringify(payloadFuture)
      }
    );

    if (!resFuture.ok) {
      const txt = await resFuture.text();
      console.error(
        "Failed to update future wellness:",
        mondayId,
        resFuture.status,
        txt
      );
    } else if (resFuture.body) {
      resFuture.body.cancel();
    }

    ctlStart = ctlEnd;
    atlStart = atlEnd;
    prevTarget = nextTarget;
    prevState = simState;
  }
}

// ---------------------------------------------------------
// HAUPTLOGIK
// ---------------------------------------------------------

async function handle(env) {
  const apiKey = INTERVALS_API_KEY;
  const athleteId = INTERVALS_ATHLETE_ID;

  if (!apiKey || !athleteId) {
    return new Response("Missing config", { status: 500 });
  }

  const authHeader = "Basic " + btoa(`API_KEY:${apiKey}`);

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const todayDate = new Date(today + "T00:00:00Z");

  const weekday = todayDate.getUTCDay(); // 0=So,1=Mo,...
  const offset = weekday === 0 ? 6 : weekday - 1;
  const mondayDate = new Date(todayDate);
  mondayDate.setUTCDate(mondayDate.getUTCDate() - offset);
  const mondayStr = mondayDate.toISOString().slice(0, 10);

  // Letzte Woche (für Zielvergleich)
  const lastMondayDate = new Date(mondayDate);
  lastMondayDate.setUTCDate(lastMondayDate.getUTCDate() - 7);
  const lastSundayDate = new Date(mondayDate);
  lastSundayDate.setUTCDate(lastSundayDate.getUTCDate() - 1);
  const lastMondayStr = lastMondayDate.toISOString().slice(0, 10);
  const lastSundayStr = lastSundayDate.toISOString().slice(0, 10);

  try {
    // 1) Wellness heute
    const wellnessRes = await fetch(
      `${BASE_URL}/athlete/${athleteId}/wellness/${today}`,
      { headers: { Authorization: authHeader } }
    );
    if (!wellnessRes.ok) {
      const text = await wellnessRes.text();
      return new Response(
        `Failed to fetch wellness today: ${wellnessRes.status} ${text}`,
        { status: 500 }
      );
    }

    const wellness = await wellnessRes.json();
    const ctl = wellness.ctl;
    const atl = wellness.atl;
    const rampRate = wellness.rampRate ?? 0;

    if (ctl == null || atl == null) {
      return new Response("No ctl/atl data", { status: 200 });
    }

    const { state: weekState, tsb } = classifyWeek(ctl, atl, rampRate);
    const dailyTargetBase = computeDailyTarget(ctl, atl);

    // 2) Montag-Werte (ctl/atl am Wochenanfang + evtl. existierendes Wochenziel)
    const mondayWellnessRes = await fetch(
      `${BASE_URL}/athlete/${athleteId}/wellness/${mondayStr}`,
      { headers: { Authorization: authHeader } }
    );

    let ctlMon;
    let atlMon;
    let mondayWeeklyTarget = null;

    if (mondayWellnessRes.ok) {
      const mon = await mondayWellnessRes.json();
      ctlMon = mon.ctl ?? ctl;
      atlMon = mon.atl ?? atl;
      mondayWeeklyTarget = mon[WEEKLY_TARGET_FIELD] ?? null;
    } else {
      ctlMon = ctl;
      atlMon = atl;
    }

    // 2b) Vorwochen-Ziel und -Ergebnis für Steigerungs-/Anti-Rückschritt-Logik
    let lastWeekTarget = null;
    let lastWeekActual = null;

    // Wochenziel letzte Woche holen (aus Montag der Vorwoche)
    try {
      const lastMonWellRes = await fetch(
        `${BASE_URL}/athlete/${athleteId}/wellness/${lastMondayStr}`,
        { headers: { Authorization: authHeader } }
      );
      if (lastMonWellRes.ok) {
        const lastMonWell = await lastMonWellRes.json();
        lastWeekTarget = lastMonWell[WEEKLY_TARGET_FIELD] ?? null;
      } else if (lastMonWellRes.body) {
        lastMonWellRes.body.cancel();
      }
    } catch (e) {
      console.error("Error fetching last Monday wellness:", e);
    }

    // Tatsächliche TSS letzte Woche (Summe ctlLoad)
    try {
      const lastWeekRes = await fetch(
        `${BASE_URL}/athlete/${athleteId}/wellness?oldest=${lastMondayStr}&newest=${lastSundayStr}&cols=id,ctlLoad`,
        { headers: { Authorization: authHeader } }
      );
      if (lastWeekRes.ok) {
        const lastWeekArr = await lastWeekRes.json();
        let sum = 0;
        for (const d of lastWeekArr) {
          if (d.ctlLoad != null) sum += d.ctlLoad;
        }
        lastWeekActual = sum;
      } else if (lastWeekRes.body) {
        lastWeekRes.body.cancel();
      }
    } catch (e) {
      console.error("Error fetching last week load:", e);
    }

    // 3) Wochenzustand → Basis-Faktor (Fallback)
    let factor = 7;
    if (weekState === "Erholt") factor = 8;
    if (weekState === "Müde") factor = 5.5;

    // 3a) CTL-Historie der letzten x Wochen holen (für Adaptive Ramp)
    const WEEKS_BACK_FOR_CTL = 6;
    const weeklyCtlHistory = await fetchWeeklyCtlHistory(
      mondayDate,
      WEEKS_BACK_FOR_CTL,
      athleteId,
      authHeader
    );

    // 3b) Wochenziel – ggf. adaptiv setzen, falls noch keins existiert
    let weeklyTarget;
    let adaptiveInfo = null;

    if (mondayWeeklyTarget != null) {
      // Montag hat schon ein Wochenziel → dieses verwenden (z.B. manuell gesetzt)
      weeklyTarget = mondayWeeklyTarget;
    } else {
      // Versuche, ein adaptives Ziel basierend auf letzter Woche + CTL-Historie zu setzen
      if (
        lastWeekTarget != null &&
        lastWeekActual != null &&
        weeklyCtlHistory.length >= 2
      ) {
        adaptiveInfo = computeNextWeekTargetAdaptive({
          ctlNow: ctlMon,
          weeklyTargetLast: lastWeekTarget,
          weeklyActualLast: lastWeekActual,
          classification: weekState, // "Müde" | "Normal" | "Erholt"
          weeklyCtlHistory
        });

        if (adaptiveInfo && adaptiveInfo.nextWeekTarget != null) {
          weeklyTarget = adaptiveInfo.nextWeekTarget;
        }
      }

      // Fallback, falls adaptive Berechnung nicht möglich war
      if (weeklyTarget == null) {
        let weeklyTargetRaw = Math.round(computeDailyTarget(ctlMon, atlMon) * factor);

        // bisherige Steigerungs-/Anti-Rückschritt-Logik beibehalten:
        const hitLastWeek =
          lastWeekTarget != null &&
          lastWeekActual != null &&
          lastWeekActual >= 0.95 * lastWeekTarget; // ≥95% des Ziels

        if (hitLastWeek && weekState !== "Müde") {
          // niemals unter Vorwoche
          let minAllowed = lastWeekTarget;

          // Wenn du aktuell eher frisch bist (TSB >= 0), leicht steigern:
          if (tsb >= 0) {
            const progFactor = (weekState === "Erholt") ? 1.10 : 1.05;
            const progressive = lastWeekTarget * progFactor;
            minAllowed = Math.max(minAllowed, progressive);
          }

          weeklyTargetRaw = Math.max(weeklyTargetRaw, Math.round(minAllowed));
        }

        weeklyTarget = weeklyTargetRaw;
      }
    }

    // 4) Event & Taper – wirkt nur auf Tagesziel, NICHT aufs Wochenziel
    let taperDailyFactor = 1.0;
    let inTaper = false;

    try {
      const evt = await getNextEventDate(athleteId, authHeader, today);
      if (evt && evt.daysToEvent > 0) {
        const normalLoad = ctl;
        const taperDays = computeTaperDays(ctl, atl, normalLoad, evt.daysToEvent);

        if (taperDays > 0 && evt.daysToEvent <= taperDays) {
          const taperStartIndex = evt.daysToEvent - taperDays;
          const dayIndex = 0;

          let progress = 0;
          if (taperDays <= 1) {
            progress = 1;
          } else {
            const pos = dayIndex - taperStartIndex;
            const progressRaw = pos / (taperDays - 1);
            progress = Math.max(0, Math.min(1, progressRaw));
          }

          taperDailyFactor =
            TAPER_DAILY_START +
            (TAPER_DAILY_END - TAPER_DAILY_START) * progress;

          inTaper = true;
        }
      }
    } catch (e) {
      console.error("Error in event/taper logic:", e);
    }

    // weeklyTarget bleibt unverändert

    // 5) Wochenload summieren + Daten für Mikrozyklus
    let weekLoad = 0;
    let weekArr = [];

    if (today !== mondayStr) {
      const weekRes = await fetch(
        `${BASE_URL}/athlete/${athleteId}/wellness?oldest=${mondayStr}&newest=${today}&cols=id,ctlLoad`,
        { headers: { Authorization: authHeader } }
      );
      if (weekRes.ok) {
        weekArr = await weekRes.json();
        for (const day of weekArr) {
          if (day.ctlLoad != null) weekLoad += day.ctlLoad;
        }
      } else if (weekRes.body) {
        weekRes.body.cancel();
      }
    }

    const weeklyRemaining = Math.max(0, Math.round(weeklyTarget - weekLoad));
    const weekDone = Math.max(0, Math.min(weeklyTarget, weekLoad));

    let weekPercent = 0;
    if (weeklyTarget > 0) {
      weekPercent = Math.round((weekDone / weeklyTarget) * 100);
    }
    weekPercent = Math.max(0, Math.min(200, weekPercent));

    let weekBarFilled = 0;
    if (weeklyTarget > 0) {
      weekBarFilled = Math.round((weekDone / weeklyTarget) * 10);
    }
    weekBarFilled = Math.max(0, Math.min(10, weekBarFilled));
    const weekBar = "█".repeat(weekBarFilled) + "░".repeat(10 - weekBarFilled);

    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const daysSinceMonday = Math.round(
      (todayDate.getTime() - mondayDate.getTime()) / MS_PER_DAY
    );

    const ctlLoadByDate = new Map();
    for (const day of weekArr) {
      if (day.id && day.ctlLoad != null) {
        ctlLoadByDate.set(day.id, day.ctlLoad);
      }
    }

    // Wie lange her ist das letzte Training (inkl. heute)?
    let daysSinceLastTraining = daysSinceMonday + 1;
    for (let offset = 0; offset <= daysSinceMonday; offset++) {
      const d = new Date(todayDate);
      d.setUTCDate(d.getUTCDate() - offset);
      const id = d.toISOString().slice(0, 10);
      const load = ctlLoadByDate.get(id) ?? 0;
      if (load > 0) {
        daysSinceLastTraining = offset;
        break;
      }
    }

    // Wie viele Tage in Folge (bis gestern) wurde trainiert?
    let consecutiveTrainingDays = 0;
    for (let offset = 1; offset <= daysSinceMonday; offset++) {
      const d = new Date(todayDate);
      d.setUTCDate(d.getUTCDate() - offset);
      const id = d.toISOString().slice(0, 10);
      const load = ctlLoadByDate.get(id) ?? 0;
      if (load > 0) {
        consecutiveTrainingDays++;
      } else {
        break;
      }
    }

    // Load der letzten beiden Tage
    const yesterdayDate = new Date(todayDate);
    yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
    const yesterdayId = yesterdayDate.toISOString().slice(0, 10);
    const yesterdayLoad = ctlLoadByDate.get(yesterdayId) ?? 0;

    const twoDaysAgoDate = new Date(todayDate);
    twoDaysAgoDate.setUTCDate(twoDaysAgoDate.getUTCDate() - 2);
    const twoDaysAgoId = twoDaysAgoDate.toISOString().slice(0, 10);
    const twoDaysAgoLoad = ctlLoadByDate.get(twoDaysAgoId) ?? 0;

    const last2DaysLoad = yesterdayLoad + twoDaysAgoLoad;

    // 6) Lernendes Wochenmuster: loadRawPattern + Update mit gestern
    let rawPattern = await loadRawPattern(env, athleteId, authHeader, todayDate);
    rawPattern = await updatePatternWithYesterday(env, rawPattern, yesterdayDate, yesterdayLoad);
    const weekdayWeights = normalizePattern(rawPattern);

    // 7) Tagesziel – aus Woche, Fitness, Form, Taper, Mikrozyklus

    // a) Wochen-Sicht: TSS nach Wochentagsmuster
    let targetFromWeek;
    {
      const jsDay = weekday; // 0=So,1=Mo,...
      const dayIdx = jsDay === 0 ? 6 : jsDay - 1;
      const weightToday = weekdayWeights[dayIdx] ?? 0;
      const sumWeights = weekdayWeights.reduce((a, b) => a + b, 0);
      if (sumWeights > 0 && weightToday > 0) {
        const share = weightToday; // schon normiert
        targetFromWeek = weeklyTarget * share;
      } else {
        // Fallback: gleichmäßige Verteilung auf TRAINING_DAYS_PER_WEEK
        targetFromWeek = weeklyTarget / TRAINING_DAYS_PER_WEEK;
      }
    }

    // b) Fitness-Sicht (CTL/ATL/TSB + Taper)
    const baseFromFitness = dailyTargetBase * taperDailyFactor;

    // c) Kombination: eher Wochenziel-getrieben, aber Fitness stärker berücksichtigen als früher
    const combinedBase = 0.7 * targetFromWeek + 0.3 * baseFromFitness;

    // d) Form-Faktor (TSB)
    let tsbFactor = 1.0;
    if (tsb >= 10) tsbFactor = 1.4;
    else if (tsb >= 5) tsbFactor = 1.25;
    else if (tsb >= 0) tsbFactor = 1.10;
    else if (tsb <= -15) tsbFactor = 0.5;
    else if (tsb <= -10) tsbFactor = 0.6;
    else if (tsb <= -5) tsbFactor = 0.8;

    // e) Mikrozyklus-Faktor: Pausen, Serien & Load der letzten Tage
    let microFactor = 1.0;
    let suggestRestDay = false;

    // 1) Pausentage / Ruhetag gestern → leicht hochskalieren, wenn Form nicht schlecht
    if (yesterdayLoad === 0 && tsb >= 0) {
      microFactor *= 1.10; // +10% nach einem Ruhetag
    }
    if (daysSinceLastTraining >= 2 && tsb >= 0) {
      microFactor *= 1.25; // +25% nach ≥2 Tagen Pause
    }
    if (daysSinceLastTraining >= 3 && tsb >= 0) {
      microFactor *= 1.10; // zusätzlicher kleiner Boost
    }

    // 2) Serien: viele Tage am Stück → runter
    let fatigueFactor = 1.0;

    if (consecutiveTrainingDays >= 3) {
      fatigueFactor = Math.min(fatigueFactor, 0.8);
    }
    if (consecutiveTrainingDays >= 4) {
      fatigueFactor = Math.min(fatigueFactor, 0.7);
    }

    // 3) Load-basiert: sehr hoher TSS gestern → stärker runter
    const avgTrainingDay = weeklyTarget / TRAINING_DAYS_PER_WEEK;
    const heavyThreshold = Math.max(1.5 * avgTrainingDay, 60);
    const veryHeavyThreshold = Math.max(2.3 * avgTrainingDay, 90);

    if (yesterdayLoad >= veryHeavyThreshold && tsb <= -5) {
      fatigueFactor = Math.min(fatigueFactor, 0.4);
      suggestRestDay = true;
    } else if (yesterdayLoad >= heavyThreshold && tsb <= 0) {
      fatigueFactor = Math.min(fatigueFactor, 0.6);
    }

    // 4) Zwei-Tage-Kombi: wenn die letzten 2 Tage zusammen sehr hoch waren
    const highTwoDayThreshold = Math.max(3.0 * avgTrainingDay, 120);

    if (last2DaysLoad >= highTwoDayThreshold && tsb <= -5) {
      fatigueFactor = Math.min(fatigueFactor, 0.6);
    }

    microFactor *= fatigueFactor;

    // Rohes Tagesziel (TSS)
    let dailyTargetRaw = combinedBase * tsbFactor * microFactor;

    // f) Obergrenzen
    const maxDailyByCtl = ctl * 3.0;
    const maxDailyByWeek = avgTrainingDay * 2.5;
    const maxDaily = Math.max(
      baseFromFitness,
      Math.min(maxDailyByCtl, maxDailyByWeek)
    );

    dailyTargetRaw = Math.max(0, dailyTargetRaw);
    let dailyTarget = Math.round(Math.min(dailyTargetRaw, maxDaily));

    // Optionales Minimum, damit Trainingstage nicht zu mickrig werden
    const minDaily = Math.min(30, weeklyTarget); // bei CTL ~20: ~30 TSS Minimum
    dailyTarget = Math.max(minDaily, dailyTarget);

    const tssTarget = dailyTarget;

    // Range 80–120 %
    const tssLow = Math.round(tssTarget * 0.8);
    const tssHigh = Math.round(tssTarget * 1.2);

    // 8) WochenPlan OHNE Balken (clean)
    const emojiToday = stateEmoji(weekState);
    const planTextToday = `Rest ${weeklyRemaining} | ${emojiToday} ${weekState}`;

    const adaptiveRampLine = adaptiveInfo
      ? `Adaptive Ramp: Wunsch-ΔCTL=${adaptiveInfo.desiredCtlDelta.toFixed(2)}, erlaubt=${adaptiveInfo.ctlRampWindow.minDelta.toFixed(2)} bis ${adaptiveInfo.ctlRampWindow.maxDelta.toFixed(2)}, gesetzt=${adaptiveInfo.clampedCtlDelta.toFixed(2)} (eff. Ramp ${(adaptiveInfo.rampPercentEffective * 100).toFixed(1)}%)`
      : "Adaptive Ramp: Fallback (zu wenig Historie oder keine Vorwochen-Daten)";

    // 9) Kommentar mit Balken
    const commentText = `Erklärung zum heutigen Trainingsziel:

Wochenziel: ${weeklyTarget} TSS
Geplante Trainingstage pro Woche (Fallback): ${TRAINING_DAYS_PER_WEEK}

Lernendes Wochentagsmuster (Mo..So, normiert):
${weekdayWeights.map(v => v.toFixed(3)).join(" / ")}

Vorwoche:
Ziel letzte Woche: ${lastWeekTarget != null ? lastWeekTarget.toFixed(0) : "keine Daten"}
Ist letzte Woche: ${lastWeekActual != null ? lastWeekActual.toFixed(1) : "keine Daten"}

Wochenfortschritt:
[${weekBar}] ${weekPercent}% der Wochenlast erledigt (TSS: ${weekLoad.toFixed(1)}/${weeklyTarget})

Aktuelle Fitness und Form:
CTL: ${ctl.toFixed(1)}
ATL: ${atl.toFixed(1)}
TSB (Form): ${tsb.toFixed(1)}
Wochentyp: ${weekState}
Taperphase: ${inTaper ? "Ja" : "Nein"}

Adaptive Logik:
${adaptiveRampLine}

Mikrozyklus dieser Woche:
Tage seit letztem Training (inkl. heute): ${daysSinceLastTraining}
Zusammenhängende Trainingstage bis gestern: ${consecutiveTrainingDays}
Gestern geladene TSS (ctlLoad): ${yesterdayLoad.toFixed(1)}
Vorgestern geladene TSS (ctlLoad): ${twoDaysAgoLoad.toFixed(1)}
Letzte 2 Tage zusammen: ${last2DaysLoad.toFixed(1)} TSS
Ruhe-/Belastungs-Empfehlung: ${
      suggestRestDay
        ? "Empfehlung: Heute eher Ruhetag oder nur sehr lockere, kurze Einheit."
        : "Normale Belastung möglich – auf Körpergefühl achten."
    }

Rechenweg:
targetFromWeek (Muster-basiert) ≈ ${targetFromWeek.toFixed(1)} TSS
baseFromFitness = dailyTargetBase(${dailyTargetBase}) * taperDailyFactor(${taperDailyFactor.toFixed(2)}) = ${baseFromFitness.toFixed(1)}
combinedBase = 0.7 * ${targetFromWeek.toFixed(1)} + 0.3 * ${baseFromFitness.toFixed(1)} = ${combinedBase.toFixed(1)}
tsbFactor = ${tsbFactor}
microFactor = ${microFactor.toFixed(2)}
dailyTargetRaw = combinedBase(${combinedBase.toFixed(1)}) * tsbFactor(${tsbFactor}) * microFactor(${microFactor.toFixed(2)}) = ${dailyTargetRaw.toFixed(1)}
maxDaily = min(CTL*3=${(ctl * 3).toFixed(1)}, Week*2.5=${(avgTrainingDay * 2.5).toFixed(1)}) = ${maxDaily.toFixed(1)}
minDaily (Sicherheitsuntergrenze) = ${minDaily.toFixed(1)}

Tagesziel: ${tssTarget} TSS
Empfohlene Tagesrange: ${tssLow}–${tssHigh} TSS (80–120%)
`;

    // 10) Wellness heute updaten
    const payloadToday = {
      id: today,
      [INTERVALS_TARGET_FIELD]: tssTarget,
      [INTERVALS_PLAN_FIELD]: planTextToday,
      comments: commentText
      // DAILY_TYPE_FIELD wird absichtlich NICHT gesetzt
    };

    if (today === mondayStr && mondayWeeklyTarget == null) {
      payloadToday[WEEKLY_TARGET_FIELD] = weeklyTarget;
    }

    const updateRes = await fetch(
      `${BASE_URL}/athlete/${athleteId}/wellness/${today}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader
        },
        body: JSON.stringify(payloadToday)
      }
    );

    if (!updateRes.ok) {
      const text = await updateRes.text();
      return new Response(
        `Failed to update wellness: ${updateRes.status} ${text}`,
        { status: 500 }
      );
    } else if (updateRes.body) {
      updateRes.body.cancel();
    }

    // 11) Zukünftige Wochen planen (mit gleichem Muster)
    const WEEKS_TO_SIMULATE = 7;
    await simulatePlannedWeeks(
      ctlMon,
      atlMon,
      weekState,
      weeklyTarget,
      mondayDate,
      WEEKS_TO_SIMULATE,
      authHeader,
      athleteId,
      INTERVALS_PLAN_FIELD,
      WEEKLY_TARGET_FIELD,
      weekdayWeights
    );

    return new Response(
      `OK: Tagesziel=${tssTarget}, Wochenziel=${weeklyTarget}, Range=${tssLow}-${tssHigh}, suggestRestDay=${suggestRestDay}`,
      { status: 200 }
    );
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response("Unexpected error: " + err.toString(), {
      status: 500
    });
  }
}

// ---------------------------------------------------------
// EXPORT
// ---------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    return handle(env);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handle(env));
  }
};