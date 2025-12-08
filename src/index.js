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
// 0.7 = reagiert recht schnell auf neue Gewohnheiten
const PATTERN_ALPHA = 0.7;

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
    // absoluter Fallback: gleichmäßig
    rawPattern = [1, 1, 1, 1, 1, 1, 1];
    sum = 7;
  }
  return rawPattern.map((v) => (sum > 0 ? v / sum : 0));
}

// Initialisierung des Musters aus der History (z.B. letzte 12 Wochen)
async function initWeekdayPatternFromHistory(env, athleteId, authHeader, todayDate) {
  if (!env || !env.KV || !env.KV.put) {
    console.warn("KV binding missing in init – using simple equal fallback pattern.");
    return [1, 1, 1, 1, 1, 1, 1];
  }

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

  let sum = rawPattern.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    rawPattern = [1, 1, 1, 1, 1, 1, 1];
  }

  await env.KV.put(WEEKDAY_PATTERN_KEY, JSON.stringify(rawPattern));
  return rawPattern;
}

// Muster aus KV holen oder initialisieren
async function loadRawPattern(env, athleteId, authHeader, todayDate) {
  if (!env || !env.KV || !env.KV.get) {
    console.warn("KV binding missing – using simple equal fallback pattern.");
    return [1, 1, 1, 1, 1, 1, 1];
  }

  let rawStr = await env.KV.get(WEEKDAY_PATTERN_KEY);
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
  const rawPattern = [1, 1, 1, 1, 1, 1, 1];
  await env.KV.put(WEEKDAY_PATTERN_KEY, JSON.stringify(rawPattern));
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

  if (env && env.KV && env.KV.put) {
    await env.KV.put(WEEKDAY_PATTERN_KEY, JSON.stringify(rawPattern));
  }

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