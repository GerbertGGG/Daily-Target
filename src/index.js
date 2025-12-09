const BASE_URL = "https://intervals.icu/api/v1";

// 🔥 Hardcoded Variablen – später ideal als Secrets/KV hinterlegen
const INTERVALS_API_KEY = "1xg1v04ym957jsqva8720oo01";
const INTERVALS_ATHLETE_ID = "i105857";

const INTERVALS_TARGET_FIELD = "TageszielTSS";   // dynamisches Tagesziel
const INTERVALS_PLAN_FIELD = "WochenPlan";       // kurzer Plan-Text
const WEEKLY_TARGET_FIELD = "WochenzielTSS";     // Wochenziel
const DAILY_TYPE_FIELD = "TagesTyp";            // dein Plan-String (z.B. "Mo,Mi,Fr,So")
const INTERVALS_DAILY_PLAN_FIELD = "TageszielPlan"; // geplanter TSS für den Tag

// Fallback: angenommene Anzahl Trainingstage pro Woche (nur für Caps etc.)
const TRAINING_DAYS_PER_WEEK = 4.0;

// Taper-Konstanten (für Events)
const TAPER_MIN_DAYS = 3;
const TAPER_MAX_DAYS = 21;
const TAPER_DAILY_START = 0.8;
const TAPER_DAILY_END = 0.3;

// KV-Keys
const WEEKDAY_PATTERN_KEY = "weekdayStats_v1";         // lernendes Muster (Idee 1)
const WEEKPLAN_PREFIX = "weekPlan:";                   // Wochenplan: weekPlan:YYYY-MM-DD
const WEEKPLAN_STRING_PREFIX = "weekPlanString:";      // Klartext-Plan: "Mo,Mi,Do,Sa"

// Ab wann zählt ein Tag als „Trainingstag“ (TSS-Schwelle)
const TRAIN_THRESHOLD = 5;

// ---------------------------------------------------------
// Hilfsfunktionen Allgemein
// ---------------------------------------------------------

function dayIdxFromJsDay(jsDay) {
  // jsDay: 0=So,1=Mo,... → idx: 0=Mo..6=So
  return jsDay === 0 ? 6 : jsDay - 1;
}

const DAY_NAMES = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

// Trainingstage aus String wie "Mo,Mi,Sa" oder "2,4,6" parsen → bool[7] (Mo..So)
function parseTrainingDays(str) {
  if (!str || typeof str !== "string") return new Array(7).fill(false);

  const tokens = str
    .split(/[,\s;]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return new Array(7).fill(false);

  const selected = new Array(7).fill(false);

  for (const tokenRaw of tokens) {
    const t = tokenRaw.toLowerCase();

    // Zahlen-Variante: 1=Mo..7=So
    const num = parseInt(t, 10);
    if (!isNaN(num) && num >= 1 && num <= 7) {
      selected[num - 1] = true;
      continue;
    }

    // Kürzel-Variante (de)
    if (t.startsWith("mo")) selected[0] = true;
    else if (t.startsWith("di")) selected[1] = true;
    else if (t.startsWith("mi")) selected[2] = true;
    else if (t.startsWith("do")) selected[3] = true;
    else if (t.startsWith("fr")) selected[4] = true;
    else if (t.startsWith("sa")) selected[5] = true;
    else if (t.startsWith("so")) selected[6] = true;
  }

  return selected;
}

// ---------------------------------------------------------
// Lernendes Wochentagsmuster (Idee 1: P(Training) + Ø-Load)
// ---------------------------------------------------------

// stats-Objekt: { trainCount: number[7], sumLoad: number[7], weeks: number }

function normalizePattern(stats) {
  // Backwards-Kompatibilität: falls noch ein altes Array drin liegt
  if (Array.isArray(stats)) {
    const arr = stats.map((v) =>
      typeof v === "number" && isFinite(v) ? Math.max(0, v) : 0
    );
    let sum = arr.reduce((a, b) => a + b, 0);
    if (sum <= 0) return new Array(7).fill(1 / 7);
    return arr.map((v) => v / sum);
  }

  const trainCount = stats.trainCount ?? [];
  const sumLoad = stats.sumLoad ?? [];
  const weeks = stats.weeks ?? 1;

  const scores = new Array(7).fill(0);

  for (let i = 0; i < 7; i++) {
    const tc = trainCount[i] ?? 0;
    const sl = sumLoad[i] ?? 0;
    const w = weeks > 0 ? weeks : 1;

    let pTrain = tc / w;
    if (pTrain > 1) pTrain = 1;

    const avgIfTrain = tc > 0 ? sl / tc : 0;

    scores[i] = pTrain * avgIfTrain;
  }

  let sumScores = scores.reduce((a, b) => a + b, 0);
  if (sumScores <= 0) return new Array(7).fill(1 / 7);

  return scores.map((v) => v / sumScores);
}

// Initialisierung der Stats aus der History (z.B. letzte 12 Wochen)
async function initWeekdayPatternFromHistory(env, athleteId, authHeader, todayDate) {
  if (!env || !env.KV || !env.KV.put) {
    console.warn("KV binding missing in init – using fallback stats.");
    return {
      trainCount: new Array(7).fill(1),
      sumLoad: new Array(7).fill(1),
      weeks: 4
    };
  }

  const HISTORY_WEEKS_INIT = 12;
  const startDate = new Date(todayDate);
  startDate.setUTCDate(startDate.getUTCDate() - HISTORY_WEEKS_INIT * 7);
  const oldest = startDate.toISOString().slice(0, 10);
  const newest = todayDate.toISOString().slice(0, 10);

  const trainCount = new Array(7).fill(0);
  const sumLoad = new Array(7).fill(0);

  try {
    const histRes = await fetch(
      `${BASE_URL}/athlete/${athleteId}/wellness?oldest=${oldest}&newest=${newest}&cols=id,ctlLoad`,
      { headers: { Authorization: authHeader } }
    );
    if (histRes.ok) {
      const histArr = await histRes.json();
      for (const d of histArr) {
        if (!d.id || d.ctlLoad == null) continue;
        const load = d.ctlLoad;
        const dateObj = new Date(d.id + "T00:00:00Z");
        if (isNaN(dateObj.getTime())) continue;
        const jsDay = dateObj.getUTCDay();
        const idx = dayIdxFromJsDay(jsDay);
        if (idx >= 0 && idx < 7 && load >= TRAIN_THRESHOLD) {
          trainCount[idx] += 1;
          sumLoad[idx] += load;
        }
      }
    } else if (histRes.body) {
      histRes.body.cancel?.();
    }
  } catch (e) {
    console.error("Error in initWeekdayPatternFromHistory:", e);
  }

  const stats = {
    trainCount,
    sumLoad,
    weeks: HISTORY_WEEKS_INIT
  };

  await env.KV.put(WEEKDAY_PATTERN_KEY, JSON.stringify(stats));
  return stats;
}

// Stats aus KV holen (oder initialisieren)
async function loadRawPattern(env, athleteId, authHeader, todayDate) {
  if (!env || !env.KV || !env.KV.get) {
    console.warn("KV binding missing – using simple fallback stats.");
    return {
      trainCount: new Array(7).fill(1),
      sumLoad: new Array(7).fill(1),
      weeks: 4
    };
  }

  const rawStr = await env.KV.get(WEEKDAY_PATTERN_KEY);
  if (!rawStr) {
    return await initWeekdayPatternFromHistory(env, athleteId, authHeader, todayDate);
  }

  try {
    const parsed = JSON.parse(rawStr);

    if (
      parsed &&
      Array.isArray(parsed.trainCount) &&
      Array.isArray(parsed.sumLoad)
    ) {
      if (typeof parsed.weeks !== "number" || !isFinite(parsed.weeks)) {
        parsed.weeks = 4;
      }
      return parsed;
    }

    if (Array.isArray(parsed)) {
      const arr = parsed.map((v) =>
        typeof v === "number" && isFinite(v) ? Math.max(0, v) : 0
      );
      const trainCount = arr.map((v) => (v >= TRAIN_THRESHOLD ? 1 : 0));
      const sumLoad = arr.slice();
      const stats = {
        trainCount,
        sumLoad,
        weeks: 4
      };
      await env.KV.put(WEEKDAY_PATTERN_KEY, JSON.stringify(stats));
      return stats;
    }
  } catch (e) {
    console.error("Error parsing weekday stats from KV:", e);
  }

  const stats = {
    trainCount: new Array(7).fill(1),
    sumLoad: new Array(7).fill(1),
    weeks: 4
  };
  await env.KV.put(WEEKDAY_PATTERN_KEY, JSON.stringify(stats));
  return stats;
}

// Stats mit gestrigem Load updaten
async function updatePatternWithYesterday(env, stats, yesterdayDate, yesterdayLoad) {
  if (!yesterdayDate || yesterdayLoad == null) return stats;

  const d = yesterdayDate;
  const jsDay = d.getUTCDay();
  const idx = dayIdxFromJsDay(jsDay);

  if (!stats || typeof stats !== "object") {
    stats = {
      trainCount: new Array(7).fill(0),
      sumLoad: new Array(7).fill(0),
      weeks: 4
    };
  }

  if (!Array.isArray(stats.trainCount)) stats.trainCount = new Array(7).fill(0);
  if (!Array.isArray(stats.sumLoad)) stats.sumLoad = new Array(7).fill(0);
  if (typeof stats.weeks !== "number" || !isFinite(stats.weeks)) stats.weeks = 4;

  if (idx >= 0 && idx < 7) {
    const load = Math.max(0, yesterdayLoad);
    if (load >= TRAIN_THRESHOLD) {
      stats.trainCount[idx] = (stats.trainCount[idx] ?? 0) + 1;
      stats.sumLoad[idx] = (stats.sumLoad[idx] ?? 0) + load;
    }
  }

  if (env && env.KV && env.KV.put) {
    await env.KV.put(WEEKDAY_PATTERN_KEY, JSON.stringify(stats));
  }

  return stats;
}

// ---------------------------------------------------------
// Training / Müdigkeit / Taper
// ---------------------------------------------------------

function computeDailyTarget(ctl, atl) {
  const base = 1.0;
  const k = 0.05;
  const tsb = ctl - atl;
  const tsbClamped = Math.max(-20, Math.min(20, tsb));
  const dailyTss = ctl * (base + k * tsbClamped);
  return Math.round(Math.max(0, Math.min(dailyTss, ctl * 1.5)));
}

function classifyWeek(ctl, atl, rampRate) {
  const tsb = ctl - atl;

  let tsbCritical;
  if (ctl < 50) tsbCritical = -5;
  else if (ctl < 80) tsbCritical = -10;
  else tsbCritical = -15;

  const isTsbTired = tsb <= tsbCritical;

  let atlCtlRatio = Infinity;
  if (ctl > 0) atlCtlRatio = atl / ctl;

  let atlRatioThreshold;
  if (ctl < 50) atlRatioThreshold = 1.2;
  else if (ctl < 80) atlRatioThreshold = 1.3;
  else atlRatioThreshold = 1.4;

  const isAtlHigh = atlCtlRatio >= atlRatioThreshold;

  const isRampHigh = rampRate >= 1.0;
  const isRampLowAndFresh = rampRate <= -0.5 && tsb >= -5;

  if (isRampLowAndFresh) return { state: "Erholt", tsb };
  if (isRampHigh || isTsbTired || isAtlHigh) return { state: "Müde", tsb };
  return { state: "Normal", tsb };
}

function stateEmoji(state) {
  if (state === "Erholt") return "🔥";
  if (state === "Müde") return "🧘";
  return "⚖️";
}

async function getNextEventDate(athleteId, authHeader, todayStr) {
  const todayDate = new Date(todayStr + "T00:00:00Z");
  const futureDate = new Date(todayDate);
  futureDate.setUTCDate(todayDate.getUTCDate() + 90);
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
    if (!bestDate || dDateOnly < bestDate) bestDate = dDateOnly;
  }

  if (!bestDate) return null;

  const msDiff = bestDate.getTime() - todayDate.getTime();
  const daysToEvent = Math.round(msDiff / (1000 * 60 * 60 * 24));

  return {
    eventDate: bestDate.toISOString().slice(0, 10),
    daysToEvent
  };
}

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

// ---------------------------------------------------------
// Wochenplan + KV
// ---------------------------------------------------------

async function saveWeekPlan(env, mondayStr, weights, planString) {
  if (!env || !env.KV || !env.KV.put) return;
  const plan = {
    weekStart: mondayStr,
    weights
  };
  await env.KV.put(WEEKPLAN_PREFIX + mondayStr, JSON.stringify(plan));
  await env.KV.put(WEEKPLAN_STRING_PREFIX + mondayStr, planString);
}

async function loadWeekPlan(env, mondayStr) {
  if (!env || !env.KV || !env.KV.get) return null;

  let weights = null;
  let planString = null;

  const wpStr = await env.KV.get(WEEKPLAN_PREFIX + mondayStr);
  if (wpStr) {
    try {
      const plan = JSON.parse(wpStr);
      if (
        plan &&
        typeof plan.weekStart === "string" &&
        Array.isArray(plan.weights) &&
        plan.weights.length === 7
      ) {
        weights = plan.weights.map((v) =>
          typeof v === "number" && isFinite(v) ? Math.max(0, v) : 0
        );
      }
    } catch (e) {
      console.error("Error parsing week plan:", e);
    }
  }

  const psStr = await env.KV.get(WEEKPLAN_STRING_PREFIX + mondayStr);
  if (psStr && typeof psStr === "string") {
    const trimmed = psStr.trim();
    if (trimmed.length > 0) planString = trimmed;
  }

  if (!weights && planString) {
    const selected = parseTrainingDays(planString);
    const count = selected.filter(Boolean).length;
    if (count > 0) {
      const per = 1.0 / count;
      weights = new Array(7).fill(0);
      for (let i = 0; i < 7; i++) if (selected[i]) weights[i] = per;
      await saveWeekPlan(env, mondayStr, weights, planString);
    }
  }

  if (weights && !planString) {
    const names = [];
    for (let i = 0; i < 7; i++) if ((weights[i] ?? 0) > 0) names.push(DAY_NAMES[i]);
    planString = names.length > 0 ? names.join(",") : "Mo,Mi,Fr,So";
    await saveWeekPlan(env, mondayStr, weights, planString);
  }

  if (!weights || !planString) return null;
  return { weights, planString };
}

// Am Sonntag: dein `TagesTyp` ist der Plan für die NÄCHSTE Woche
async function storeNextWeekPlanFromSunday(env, todayDate, wellnessToday, authHeader) {
  if (!env || !env.KV || !env.KV.put) return null;

  const jsDay = todayDate.getUTCDay();
  if (jsDay !== 0) return null;

  const raw = wellnessToday[DAILY_TYPE_FIELD];
  if (!raw || typeof raw !== "string") return null;

  const planString = raw.trim();
  if (!planString) return null;

  const selected = parseTrainingDays(planString);
  const count = selected.filter(Boolean).length;
  if (count === 0) return null;

  const offset = jsDay === 0 ? 6 : jsDay - 1;
  const mondayThisWeek = new Date(todayDate);
  mondayThisWeek.setUTCDate(mondayThisWeek.getUTCDate() - offset);
  const nextMonday = new Date(mondayThisWeek);
  nextMonday.setUTCDate(nextMonday.getUTCDate() + 7);
  const nextMondayStr = nextMonday.toISOString().slice(0, 10);

  const weights = new Array(7).fill(0);
  const per = 1.0 / count;
  for (let i = 0; i < 7; i++) if (selected[i]) weights[i] = per;

  await saveWeekPlan(env, nextMondayStr, weights, planString);
  return { weekStart: nextMondayStr, weights, planString };
}

// Plan-String in alle Tage der Woche schreiben, wo DAILY_TYPE_FIELD leer ist
async function ensureDailyTypePlanForWeek(env, mondayStr, planString, authHeader) {
  const mondayDate = new Date(mondayStr + "T00:00:00Z");
  if (isNaN(mondayDate.getTime())) return;

  for (let i = 0; i < 7; i++) {
    const d = new Date(mondayDate);
    d.setUTCDate(d.getUTCDate() + i);
    const id = d.toISOString().slice(0, 10);

    try {
      const res = await fetch(
        `${BASE_URL}/athlete/${INTERVALS_ATHLETE_ID}/wellness/${id}`,
        { headers: { Authorization: authHeader } }
      );
      if (!res.ok) continue;
      const data = await res.json();
      const raw = data[DAILY_TYPE_FIELD];
      const existing =
        raw == null
          ? ""
          : typeof raw === "string"
          ? raw.trim()
          : String(raw).trim();

      if (!existing) {
        const payload = {
          id,
          [DAILY_TYPE_FIELD]: planString
        };
        const putRes = await fetch(
          `${BASE_URL}/athlete/${INTERVALS_ATHLETE_ID}/wellness/${id}`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: authHeader
            },
            body: JSON.stringify(payload)
          }
        );
        if (!putRes.ok && putRes.body) putRes.body.cancel?.();
      }
    } catch (e) {
      console.error("ensureDailyTypePlanForWeek error:", e);
    }
  }
}

// Wenn du den Plan unter der Woche änderst → Restwoche anpassen
async function propagatePlanStringForRestOfWeek(
  env,
  mondayStr,
  oldPlanString,
  newPlanString,
  todayDate,
  authHeader
) {
  const mondayDate = new Date(mondayStr + "T00:00:00Z");
  if (isNaN(mondayDate.getTime())) return;

  const todayTime = todayDate.getTime();
  const oldTrim = (oldPlanString || "").trim();
  const newTrim = (newPlanString || "").trim();

  for (let i = 0; i < 7; i++) {
    const d = new Date(mondayDate);
    d.setUTCDate(d.getUTCDate() + i);
    const id = d.toISOString().slice(0, 10);

    if (d.getTime() < todayTime) continue;

    try {
      const res = await fetch(
        `${BASE_URL}/athlete/${INTERVALS_ATHLETE_ID}/wellness/${id}`,
        { headers: { Authorization: authHeader } }
      );
      if (!res.ok) continue;
      const data = await res.json();
      const raw = data[DAILY_TYPE_FIELD];
      const existing =
        raw == null
          ? ""
          : typeof raw === "string"
          ? raw.trim()
          : String(raw).trim();

      if (!existing || existing === oldTrim) {
        const payload = {
          id,
          [DAILY_TYPE_FIELD]: newTrim
        };
        const putRes = await fetch(
          `${BASE_URL}/athlete/${INTERVALS_ATHLETE_ID}/wellness/${id}`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: authHeader
            },
            body: JSON.stringify(payload)
          }
        );
        if (!putRes.ok && putRes.body) putRes.body.cancel?.();
      }
    } catch (e) {
      console.error("propagatePlanStringForRestOfWeek error:", e);
    }
  }
}

// Plan-Tagesziele (TageszielPlan) für eine Woche / Restwoche schreiben
async function writePlannedDailyTargetsForWeekRange(
  athleteId,
  authHeader,
  mondayStr,
  weeklyTarget,
  planWeights,
  startDayIdx // 0=Mo..6=So, ab welchem Wochentag neu geschrieben wird
) {
  if (!weeklyTarget || !planWeights || planWeights.length !== 7) return;

  const mondayDate = new Date(mondayStr + "T00:00:00Z");
  if (isNaN(mondayDate.getTime())) return;

  const start = Math.max(0, Math.min(6, startDayIdx ?? 0));

  for (let i = start; i < 7; i++) {
    const d = new Date(mondayDate);
    d.setUTCDate(d.getUTCDate() + i);
    const id = d.toISOString().slice(0, 10);

    const w = planWeights[i] ?? 0;
    let tssPlan = Math.round(weeklyTarget * w);

    if (tssPlan < 5) tssPlan = 0;

    const payload = {
      id,
      [INTERVALS_DAILY_PLAN_FIELD]: tssPlan
    };

    try {
      const res = await fetch(
        `${BASE_URL}/athlete/${athleteId}/wellness/${id}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: authHeader
          },
          body: JSON.stringify(payload)
        }
      );
      if (!res.ok && res.body) {
        res.body.cancel?.();
      }
    } catch (e) {
      console.error(
        "writePlannedDailyTargetsForWeekRange error:",
        id,
        e
      );
    }
  }
}

// ---------------------------------------------------------
// HAUPTLOGIK
// ---------------------------------------------------------

async function handle(env) {
  try {
    const apiKey = INTERVALS_API_KEY;
    const athleteId = INTERVALS_ATHLETE_ID;
    if (!apiKey || !athleteId) {
      return new Response("Missing config", { status: 500 });
    }
    const authHeader = "Basic " + btoa(`API_KEY:${apiKey}`);

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const todayDate = new Date(today + "T00:00:00Z");

    const jsDay = todayDate.getUTCDay(); // 0=So..6=Sa
    const dayIdx = dayIdxFromJsDay(jsDay);

    const offset = jsDay === 0 ? 6 : jsDay - 1;
    const mondayDate = new Date(todayDate);
    mondayDate.setUTCDate(mondayDate.getUTCDate() - offset);
    const mondayStr = mondayDate.toISOString().slice(0, 10);

    const lastMondayDate = new Date(mondayDate);
    lastMondayDate.setUTCDate(lastMondayDate.getUTCDate() - 7);
    const lastSundayDate = new Date(mondayDate);
    lastSundayDate.setUTCDate(lastSundayDate.getUTCDate() - 1);
    const lastMondayStr = lastMondayDate.toISOString().slice(0, 10);
    const lastSundayStr = lastSundayDate.toISOString().slice(0, 10);

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

    const todaysDailyTypeRaw = wellness[DAILY_TYPE_FIELD];
    const todaysDailyType =
      todaysDailyTypeRaw == null
        ? ""
        : typeof todaysDailyTypeRaw === "string"
        ? todaysDailyTypeRaw.trim()
        : String(todaysDailyTypeRaw).trim();

    // Sonntag: Plan für nächste Woche aus TagesTyp
    if (jsDay === 0) {
      await storeNextWeekPlanFromSunday(env, todayDate, wellness, authHeader);
    }

    const weekClass = classifyWeek(ctl, atl, rampRate);
    const weekState = weekClass.state;
    const tsb = weekClass.tsb;
    const dailyTargetBase = computeDailyTarget(ctl, atl);

    // 2) Montag-Werte
    let ctlMon;
    let atlMon;
    let mondayWeeklyTarget = null;
    const mondayWellnessRes = await fetch(
      `${BASE_URL}/athlete/${athleteId}/wellness/${mondayStr}`,
      { headers: { Authorization: authHeader } }
    );
    if (mondayWellnessRes.ok) {
      const mon = await mondayWellnessRes.json();
      ctlMon = mon.ctl ?? ctl;
      atlMon = mon.atl ?? atl;
      mondayWeeklyTarget = mon[WEEKLY_TARGET_FIELD] ?? null;
    } else {
      ctlMon = ctl;
      atlMon = atl;
    }

    // Vorwoche Ziel + Ist
    let lastWeekTarget = null;
    let lastWeekActual = null;

    try {
      const lastMonWellRes = await fetch(
        `${BASE_URL}/athlete/${athleteId}/wellness/${lastMondayStr}`,
        { headers: { Authorization: authHeader } }
      );
      if (lastMonWellRes.ok) {
        const lastMonWell = await lastMonWellRes.json();
        lastWeekTarget = lastMonWell[WEEKLY_TARGET_FIELD] ?? null;
      } else if (lastMonWellRes.body) lastMonWellRes.body.cancel?.();
    } catch (e) {
      console.error("Error fetching last Monday wellness:", e);
    }

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
      } else if (lastWeekRes.body) lastWeekRes.body.cancel?.();
    } catch (e) {
      console.error("Error fetching last week load:", e);
    }

    // 3) Wochenziel
    let factor = 7;
    if (weekState === "Erholt") factor = 8;
    if (weekState === "Müde") factor = 5.5;

    let weeklyTarget;
    if (mondayWeeklyTarget != null) {
      weeklyTarget = mondayWeeklyTarget;
    } else {
      let weeklyTargetRaw = Math.round(computeDailyTarget(ctlMon, atlMon) * factor);

      const hitLastWeek =
        lastWeekTarget != null &&
        lastWeekActual != null &&
        lastWeekActual >= 0.95 * lastWeekTarget;

      if (hitLastWeek && weekState !== "Müde") {
        let minAllowed = lastWeekTarget;
        if (tsb >= 0) {
          const progFactor = weekState === "Erholt" ? 1.10 : 1.05;
          const progressive = lastWeekTarget * progFactor;
          minAllowed = Math.max(minAllowed, progressive);
        }
        weeklyTargetRaw = Math.max(weeklyTargetRaw, Math.round(minAllowed));
      }

      weeklyTarget = weeklyTargetRaw;
    }

    // 4) Event & Taper (optional)
    let taperDailyFactor = 1.0;
    let inTaper = false;

    try {
      const evt = await getNextEventDate(athleteId, authHeader, today);
      if (evt && evt.daysToEvent > 0) {
        const normalLoad = ctl;
        const taperDays = computeTaperDays(ctl, atl, normalLoad, evt.daysToEvent);
        if (taperDays > 0 && evt.daysToEvent <= taperDays) {
          const taperStartIndex = evt.daysToEvent - taperDays;
          const dayIndexSim = 0;
          let progress = 0;
          if (taperDays <= 1) {
            progress = 1;
          } else {
            const pos = dayIndexSim - taperStartIndex;
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

    // 5) Wochenload + Mikrozyklus
    let weekLoad = 0;
    let weekLoadUntilYesterday = 0;
    let weekArr = [];
    const todayTime = todayDate.getTime();

    const weekRes = await fetch(
      `${BASE_URL}/athlete/${athleteId}/wellness?oldest=${mondayStr}&newest=${today}&cols=id,ctlLoad`,
      { headers: { Authorization: authHeader } }
    );
    if (weekRes.ok) {
      weekArr = await weekRes.json();
      for (const d of weekArr) {
        if (!d.id || d.ctlLoad == null) continue;
        const dDate = new Date(d.id + "T00:00:00Z");
        const load = d.ctlLoad;
        if (!isNaN(dDate.getTime())) {
          weekLoad += load;
          if (dDate.getTime() < todayTime) weekLoadUntilYesterday += load;
        }
      }
    } else if (weekRes.body) weekRes.body.cancel?.();

    const weeklyRemaining = Math.max(0, Math.round(weeklyTarget - weekLoad));
    const weekDone = Math.max(0, Math.min(weeklyTarget, weekLoad));

    let weekPercent = 0;
    if (weeklyTarget > 0) weekPercent = Math.round((weekDone / weeklyTarget) * 100);
    weekPercent = Math.max(0, Math.min(200, weekPercent));

    let weekBarFilled = 0;
    if (weeklyTarget > 0) weekBarFilled = Math.round((weekDone / weeklyTarget) * 10);
    weekBarFilled = Math.max(0, Math.min(10, weekBarFilled));
    const weekBar = "█".repeat(weekBarFilled) + "░".repeat(10 - weekBarFilled);

    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const daysSinceMonday = Math.round(
      (todayDate.getTime() - mondayDate.getTime()) / MS_PER_DAY
    );

    const ctlLoadByDate = new Map();
    for (const d of weekArr) {
      if (d.id && d.ctlLoad != null) ctlLoadByDate.set(d.id, d.ctlLoad);
    }

    let daysSinceLastTraining = daysSinceMonday + 1;
    for (let o = 0; o <= daysSinceMonday; o++) {
      const d = new Date(todayDate);
      d.setUTCDate(d.getUTCDate() - o);
      const id = d.toISOString().slice(0, 10);
      const load = ctlLoadByDate.get(id) ?? 0;
      if (load > 0) {
        daysSinceLastTraining = o;
        break;
      }
    }

    let consecutiveTrainingDays = 0;
    for (let o = 1; o <= daysSinceMonday; o++) {
      const d = new Date(todayDate);
      d.setUTCDate(d.getUTCDate() - o);
      const id = d.toISOString().slice(0, 10);
      const load = ctlLoadByDate.get(id) ?? 0;
      if (load > 0) consecutiveTrainingDays++;
      else break;
    }

    const yesterdayDate = new Date(todayDate);
    yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
    const yesterdayId = yesterdayDate.toISOString().slice(0, 10);
    const yesterdayLoad = ctlLoadByDate.get(yesterdayId) ?? 0;

    const twoDaysAgoDate = new Date(todayDate);
    twoDaysAgoDate.setUTCDate(twoDaysAgoDate.getUTCDate() - 2);
    const twoDaysAgoId = twoDaysAgoDate.toISOString().slice(0, 10);
    const twoDaysAgoLoad = ctlLoadByDate.get(twoDaysAgoId) ?? 0;

    const last2DaysLoad = yesterdayLoad + twoDaysAgoLoad;

    // 6) Lernendes Wochentagsmuster
    let stats = await loadRawPattern(env, athleteId, authHeader, todayDate);
    stats = await updatePatternWithYesterday(env, stats, yesterdayDate, yesterdayLoad);
    const weekdayWeights = normalizePattern(stats);

    // 7) Wochenplan laden / Default / TagesTyp verteilen
    let loadedPlan = await loadWeekPlan(env, mondayStr);
    let planWeights;
    let planString;
    let planIsDefault = false;

    if (loadedPlan) {
      planWeights = loadedPlan.weights;
      planString = loadedPlan.planString;
    } else {
      planWeights = [0.25, 0.0, 0.25, 0.0, 0.25, 0.0, 0.25];
      planString = "Mo,Mi,Fr,So";
      planIsDefault = true;
      await saveWeekPlan(env, mondayStr, planWeights, planString);
    }

    // Plan-String in leere TagesTyp-Felder schreiben
    await ensureDailyTypePlanForWeek(env, mondayStr, planString, authHeader);

    // Mid-Week-Override: wenn du TagesTyp geändert hast
    const oldPlanString = planString;
    if (todaysDailyType && todaysDailyType !== oldPlanString) {
      const selected = parseTrainingDays(todaysDailyType);
      const count = selected.filter(Boolean).length;
      if (count > 0) {
        const per = 1.0 / count;
        const newWeights = new Array(7).fill(0);
        for (let i = 0; i < 7; i++) if (selected[i]) newWeights[i] = per;

        await saveWeekPlan(env, mondayStr, newWeights, todaysDailyType);
        await propagatePlanStringForRestOfWeek(
          env,
          mondayStr,
          oldPlanString,
          todaysDailyType,
          todayDate,
          authHeader
        );

        planWeights = newWeights;
        planString = todaysDailyType;
        planIsDefault = false;

        // Plan-Tagesziele ab heute für den Rest der Woche neu schreiben
        await writePlannedDailyTargetsForWeekRange(
          athleteId,
          authHeader,
          mondayStr,
          weeklyTarget,
          planWeights,
          dayIdx
        );
      }
    }

    // Montag: falls Woche zum ersten Mal ein Wochenziel bekommt → Plan für ganze Woche schreiben
    if (today === mondayStr && mondayWeeklyTarget == null && planWeights) {
      await writePlannedDailyTargetsForWeekRange(
        athleteId,
        authHeader,
        mondayStr,
        weeklyTarget,
        planWeights,
        0
      );
    }

    // 8) Tagesziel – aus Wochenplan mit Umverteilung
    let targetFromWeek;
    let plannedTodayBase = 0;
    let scaleFactor = 1.0;

    if (planWeights) {
      const weightToday = planWeights[dayIdx] ?? 0;
      if (weightToday > 0) {
        plannedTodayBase = weeklyTarget * weightToday;

        let plannedRemainingBase = 0;
        for (let i = dayIdx; i < 7; i++) {
          const w = planWeights[i] ?? 0;
          plannedRemainingBase += weeklyTarget * w;
        }

        const trueRemaining = Math.max(0, weeklyTarget - weekLoadUntilYesterday);
        if (plannedRemainingBase > 0) {
          scaleFactor = trueRemaining / plannedRemainingBase;
          if (scaleFactor < 0.5) scaleFactor = 0.5;
          if (scaleFactor > 1.5) scaleFactor = 1.5;
        } else {
          scaleFactor = 1.0;
        }

        targetFromWeek = plannedTodayBase * scaleFactor;
      } else {
        targetFromWeek = weeklyTarget * 0.02;
      }
    } else {
      targetFromWeek = weeklyTarget / TRAINING_DAYS_PER_WEEK;
    }

    const baseFromFitness = dailyTargetBase * taperDailyFactor;
    const combinedBase = 0.8 * targetFromWeek + 0.2 * baseFromFitness;

    let tsbFactor = 1.0;
    if (tsb >= 10) tsbFactor = 1.4;
    else if (tsb >= 5) tsbFactor = 1.25;
    else if (tsb >= 0) tsbFactor = 1.10;
    else if (tsb <= -15) tsbFactor = 0.5;
    else if (tsb <= -10) tsbFactor = 0.6;
    else if (tsb <= -5) tsbFactor = 0.8;

    let microFactor = 1.0;
    let suggestRestDay = false;

    if (yesterdayLoad === 0 && tsb >= 0) microFactor *= 1.10;
    if (daysSinceLastTraining >= 2 && tsb >= 0) microFactor *= 1.25;
    if (daysSinceLastTraining >= 3 && tsb >= 0) microFactor *= 1.10;

    let fatigueFactor = 1.0;
    if (consecutiveTrainingDays >= 3) fatigueFactor = Math.min(fatigueFactor, 0.8);
    if (consecutiveTrainingDays >= 4) fatigueFactor = Math.min(fatigueFactor, 0.7);

    const avgTrainingDay = weeklyTarget / TRAINING_DAYS_PER_WEEK;
    const heavyThreshold = Math.max(1.5 * avgTrainingDay, 60);
    const veryHeavyThreshold = Math.max(2.3 * avgTrainingDay, 90);

    if (yesterdayLoad >= veryHeavyThreshold && tsb <= -5) {
      fatigueFactor = Math.min(fatigueFactor, 0.4);
      suggestRestDay = true;
    } else if (yesterdayLoad >= heavyThreshold && tsb <= 0) {
      fatigueFactor = Math.min(fatigueFactor, 0.6);
    }

    const highTwoDayThreshold = Math.max(3.0 * avgTrainingDay, 120);
    if (last2DaysLoad >= highTwoDayThreshold && tsb <= -5) {
      fatigueFactor = Math.min(fatigueFactor, 0.6);
    }

    microFactor *= fatigueFactor;

    let dailyTargetRaw = combinedBase * tsbFactor * microFactor;

    const maxDailyByCtl = ctl * 3.0;
    const maxDailyByWeek = avgTrainingDay * 2.5;
    const maxDaily = Math.max(
      baseFromFitness,
      Math.min(maxDailyByCtl, maxDailyByWeek)
    );

    dailyTargetRaw = Math.max(0, dailyTargetRaw);
    const tssTarget = Math.round(Math.min(dailyTargetRaw, maxDaily));

    const tssLow = Math.round(tssTarget * 0.8);
    const tssHigh = Math.round(tssTarget * 1.2);

    const emojiToday = stateEmoji(weekState);
    const plannedNames = [];
    for (let i = 0; i < 7; i++) {
      if ((planWeights?.[i] ?? 0) > 0) plannedNames.push(DAY_NAMES[i]);
    }
    let plannedDaysText = plannedNames.join(",");
    if (planIsDefault) plannedDaysText += " (Default)";

    const patternLine = weekdayWeights.map((v) => v.toFixed(2)).join(" ");
    const shareTodayPct = (weekdayWeights[dayIdx] * 100).toFixed(1);
    const trainCountToday = stats.trainCount?.[dayIdx] ?? 0;
    const weeksStats = stats.weeks ?? 1;
    const pTrainToday = Math.min(
      1,
      weeksStats > 0 ? trainCountToday / weeksStats : 0
    );
    const sumLoadTodayStat = stats.sumLoad?.[dayIdx] ?? 0;
    const avgIfTrainToday =
      trainCountToday > 0 ? sumLoadTodayStat / trainCountToday : 0;

    const commentText = `Tagesziel-Erklärung

Woche:
Ziel ${weeklyTarget} TSS
Fortschritt [${weekBar}] ${weekPercent}% (${weekLoad.toFixed(1)}/${weeklyTarget})
Geplante Trainingstage (diese Woche): ${plannedDaysText}

Status:
CTL ${ctl.toFixed(1)} | ATL ${atl.toFixed(1)} | TSB ${tsb.toFixed(1)}
Wochentyp ${weekState} | Taper ${inTaper ? "Ja" : "Nein"}

Mikro:
Tage seit letztem Training ${daysSinceLastTraining}, Serie ${consecutiveTrainingDays}
Gestern ${yesterdayLoad.toFixed(1)} TSS, Vorgestern ${twoDaysAgoLoad.toFixed(1)} TSS
2-Tage-Load ${last2DaysLoad.toFixed(1)} TSS
Empfehlung: ${suggestRestDay ? "eher Ruhetag/locker" : "normale Belastung ok"}

Lernendes Muster (Auto-Statistik):
Gewichte Mo–So: ${patternLine}
Anteil heute (Auto-Muster): ${shareTodayPct}% der Wochenlast
Train-Wahrsch. heute ~ ${(pTrainToday * 100).toFixed(0)}%
Ø-Load, wenn Training: ${avgIfTrainToday.toFixed(1)} TSS

Rechenweg:
targetFromWeek (Plan) ≈ ${targetFromWeek.toFixed(1)} TSS
baseFromFitness = ${baseFromFitness.toFixed(1)}
combinedBase = ${combinedBase.toFixed(1)}
tsbFactor = ${tsbFactor}, microFactor = ${microFactor.toFixed(2)}
dailyTargetRaw = ${dailyTargetRaw.toFixed(1)}, maxDaily = ${maxDaily.toFixed(1)}

Tagesziel = ${tssTarget} TSS
Range: ${tssLow}–${tssHigh} TSS (80–120%)`;

    const planTextToday = `Rest ${weeklyRemaining} | ${emojiToday} ${weekState}`;

    const payloadToday = {
      id: today,
      [INTERVALS_TARGET_FIELD]: tssTarget,
      [INTERVALS_PLAN_FIELD]: planTextToday,
      comments: commentText
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
      updateRes.body.cancel?.();
    }

    return new Response(
      `OK: Tagesziel=${tssTarget}, Wochenziel=${weeklyTarget}, Range=${tssLow}-${tssHigh}, suggestRestDay=${suggestRestDay}`,
      { status: 200 }
    );
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(
      "Unexpected error: " + (err && err.stack ? err.stack : String(err)),
      { status: 500 }
    );
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
