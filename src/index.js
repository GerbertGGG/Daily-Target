//----------------------------------------------------------
// CONFIG
//----------------------------------------------------------
const BASE_URL = "https://intervals.icu/api/v1";
const API_KEY = "API_KEY";           // später Secret in CF-Env
const API_SECRET = "YOUR_API_KEY";   // später Secret in CF-Env
const ATHLETE_ID = "i105857";

const WEEKLY_TARGET_FIELD = "WochenzielTSS";
const PLAN_FIELD = "WochenPlan";
const DAILY_TYPE_FIELD = "TagesTyp";

const DEFAULT_PLAN_STRING = "Mo,Mi,Fr,So";

// PMC-Konstanten
const TAU_CTL = 42;
const TAU_ATL = 7;

// CTL-Target pro Woche
const MIN_DELTA_CTL = 0.8;
const MAX_DELTA_CTL = 1.3;
const TARGET_DELTA_CTL = 1.0;

// ACWR-Bereich "ok"
const ACWR_MIN = 0.8;
const ACWR_MAX = 1.3;

//----------------------------------------------------------
// TRAINING DAY PARSER
//----------------------------------------------------------
function parseTrainingDays(str) {
  if (!str || typeof str !== "string") return Array(7).fill(false);

  const out = Array(7).fill(false);
  const tokens = str.split(/[,\s;]+/);

  const map = {
    mo: 0, di: 1, mi: 2, do: 3,
    fr: 4, sa: 5, so: 6
  };

  for (let t of tokens) {
    t = t.trim().toLowerCase();
    if (!t) continue;

    const num = parseInt(t, 10);
    if (!isNaN(num) && num >= 1 && num <= 7) {
      out[num - 1] = true;
      continue;
    }

    const key = t.slice(0, 2);
    if (map[key] !== undefined) out[map[key]] = true;
  }

  return out;
}

function stateEmoji(state) {
  if (state === "Erholt") return "🔥";
  if (state === "Müde") return "🧘";
  return "⚖️";
}

//----------------------------------------------------------
// FATIGUE CLASSIFICATION
//----------------------------------------------------------
function classifyWeek(ctl, atl, ramp) {
  const tsb = ctl - atl;

  let tsbCritical =
    ctl < 50 ? -5 :
    ctl < 80 ? -10 : -15;

  const highATL = ctl > 0
    ? (atl / ctl) >= (ctl < 50 ? 1.2 : ctl < 80 ? 1.3 : 1.4)
    : false;

  if (ramp <= -0.5 && tsb >= -5) return { state: "Erholt", tsb };
  if (ramp >= 1.0 || tsb <= tsbCritical || highATL) return { state: "Müde", tsb };

  return { state: "Normal", tsb };
}

//----------------------------------------------------------
// METRIC EXTRACTION
//----------------------------------------------------------
function extractMetrics(u) {
  const durationSec =
    u.moving_time ??
    u.elapsed_time ??
    u.icu_recording_time ??
    0;

  const hrAvg = u.average_heartrate ?? null;
  const hrMax = u.max_heartrate ?? null;

  const powerAvg =
    u.icu_average_watts ??
    u.icu_weighted_avg_watts ??
    u.power ??
    null;

  const powerMax =
    u.icu_pm_p_max ??
    u.icu_rolling_p_max ??
    null;

  const sport = u.type ?? "Unknown";

  return {
    durationMin: durationSec / 60,
    hrAvg,
    hrMax,
    powerAvg,
    powerMax,
    sport
  };
}

//----------------------------------------------------------
// EXTENDED MARKERS
//----------------------------------------------------------
function computeMarkers(units, hrMax, ftp, ctl, atl) {
  if (!Array.isArray(units)) units = [];

  const cleaned = units.map(extractMetrics);
  const filtered = cleaned.filter(u => u.sport !== "WeightTraining");

  // ACWR
  const acwr = ctl > 0 ? atl / ctl : null;

  // Polarisation
  let z1z2 = 0, z3z5 = 0, total = 0;

  for (const u of filtered) {
    if (!u.hrAvg) continue;
    const dur = u.durationMin;
    if (dur <= 0) continue;

    const rel = hrMax ? (u.hrAvg / hrMax) : null;
    if (!rel) continue;

    total += dur;
    if (rel <= 0.80) z1z2 += dur;
    else z3z5 += dur;
  }

  const polarisationIndex = total > 0 ? z1z2 / total : null;

  // Quality sessions
  const qualitySessions = filtered.filter(u => {
    if (u.hrAvg && hrMax && (u.hrAvg / hrMax) >= 0.90) return true;
    if (u.powerMax && ftp && u.powerMax >= ftp * 1.15) return true;
    return false;
  }).length;

  // Decoupling
  const ga = filtered.filter(u => {
    if (u.durationMin < 30) return false;
    if (!u.hrAvg) return false;
    if (hrMax && u.hrAvg > 0.85 * hrMax) return false;
    if (u.powerAvg && ftp && u.powerAvg > ftp * 0.90) return false;
    return true;
  });

  let decoupling = null;
  if (ga.length > 0) {
    const sum = ga.reduce((acc, u) => {
      if (!u.powerAvg || u.powerAvg <= 0) return acc;
      return acc + ((u.hrAvg / u.powerAvg) - 1);
    }, 0);
    decoupling = sum / ga.length;
  }

  // PDC
  const peaks = filtered
    .map(u => u.powerMax ?? u.powerAvg)
    .filter(v => v && v > 0);

  const pdc = peaks.length > 0 && ftp ? Math.max(...peaks) / ftp : null;

  return {
    decoupling,
    pdc,
    polarisationIndex,
    qualitySessions,
    acwr
  };
}

//----------------------------------------------------------
// SCORE SYSTEM
//----------------------------------------------------------
function computeScores(m) {
  const out = {};

  out.aerobic =
    m.decoupling == null ? "🟡 (zu wenig GA)" :
    m.decoupling <= 0.05 ? "🟢" :
    m.decoupling <= 0.08 ? "🟡" : "🔴";

  out.polarisation =
    m.polarisationIndex == null ? "🟡 (keine HR)" :
    m.polarisationIndex >= 0.80 ? "🟢" :
    m.polarisationIndex >= 0.70 ? "🟡" : "🔴";

  out.anaerobic =
    m.pdc == null ? "🟡 (keine Daten)" :
    m.pdc >= 0.95 && m.qualitySessions >= 2 ? "🟢" :
    m.pdc >= 0.85 && m.qualitySessions >= 1 ? "🟡" : "🔴";

  out.workload =
    m.acwr == null ? "🟡" :
    (m.acwr >= 0.8 && m.acwr <= 1.3) ? "🟢" :
    (m.acwr >= 0.7 && m.acwr <= 1.4) ? "🟡" : "🔴";

  return out;
}

//----------------------------------------------------------
// HELFER: Wochen-Load simulieren
//----------------------------------------------------------
function buildDayWeights(plan) {
  let dayWeights = plan.map(x => (x ? 1 : 0));
  let sumW = dayWeights.reduce((a, b) => a + b, 0);
  if (sumW === 0) {
    dayWeights = [1, 0, 1, 0, 1, 0, 0]; // fallback: 3 Tage
    sumW = 3;
  }
  return dayWeights.map(x => x / sumW);
}

function simulateWeekLoads(ctlStart, atlStart, weeklyTss, dayWeights) {
  let ctl = ctlStart;
  let atl = atlStart;

  for (let d = 0; d < 7; d++) {
    const load = weeklyTss * dayWeights[d];
    ctl = ctl + (load - ctl) / TAU_CTL;
    atl = atl + (load - atl) / TAU_ATL;
  }

  return { ctl, atl };
}

//----------------------------------------------------------
// HELFER: Weekly TSS so finden, dass ΔCTL in [0.8,1.3] liegt
//----------------------------------------------------------
function findWeeklyTssForCtlDelta(
  ctlStart,
  atlStart,
  baseWeeklyTss,
  dayWeights,
  minDelta = MIN_DELTA_CTL,
  maxDelta = MAX_DELTA_CTL,
  targetDelta = TARGET_DELTA_CTL
) {
  let base = Math.max(20, baseWeeklyTss || 80); // Minimalbasis

  let low = base * 0.3;
  let high = base * 1.7;

  let best = {
    weeklyTss: base,
    ctl: ctlStart,
    atl: atlStart,
    delta: 0
  };

  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2;
    const { ctl, atl } = simulateWeekLoads(ctlStart, atlStart, mid, dayWeights);
    const delta = ctl - ctlStart;

    // Bester Wert so nah wie möglich an targetDelta, aber positiv
    if (delta > 0 && Math.abs(delta - targetDelta) < Math.abs(best.delta - targetDelta)) {
      best = { weeklyTss: mid, ctl, atl, delta };
    }

    if (delta < minDelta) {
      low = mid; // zu wenig Wachstum → mehr TSS
    } else if (delta > maxDelta) {
      high = mid; // zu viel Wachstum → weniger TSS
    } else {
      // liegt im Zielband → hier können wir abbrechen
      best = { weeklyTss: mid, ctl, atl, delta };
      break;
    }
  }

  // etwas runden
  best.weeklyTss = Math.round(best.weeklyTss / 5) * 5;
  return best;
}

//----------------------------------------------------------
// CTL-FORECAST: Wochen iterativ simulieren
//----------------------------------------------------------
function simulateCtlForecast(
  ctlStart,
  atlStart,
  weeklyTssStart,
  mondayDate,
  plan,
  units28,
  hrMax,
  ftp,
  weeks = 6
) {
  const dayWeights = buildDayWeights(plan);

  let ctl = ctlStart;
  let atl = atlStart;
  let weeklyTss = weeklyTssStart;
  let acwrOk = true;

  const progression = [];

  for (let w = 1; w <= weeks; w++) {
    const ctlBefore = ctl;
    const atlBefore = atl;

    let weekResult;

    if (acwrOk) {
      // Versuche ΔCTL in [0.8,1.3] zu halten
      weekResult = findWeeklyTssForCtlDelta(
        ctlBefore,
        atlBefore,
        weeklyTss,
        dayWeights
      );
    } else {
      // ACWR schon "nicht ok": halte TSS konstant (oder leicht reduziert)
      const reducedTss = weeklyTss * 0.95;
      const sim = simulateWeekLoads(ctlBefore, atlBefore, reducedTss, dayWeights);
      weekResult = {
        weeklyTss: Math.round(reducedTss / 5) * 5,
        ctl: sim.ctl,
        atl: sim.atl,
        delta: sim.ctl - ctlBefore
      };
    }

    ctl = weekResult.ctl;
    atl = weekResult.atl;
    weeklyTss = weekResult.weeklyTss;

    const ramp = ctl - ctlBefore;
    const acwr = ctl > 0 ? atl / ctl : null;

    // ACWR-Check: solange ok, lassen wir weiter wachsen
    if (acwr != null && (acwr < ACWR_MIN || acwr > ACWR_MAX)) {
      acwrOk = false;
    }

    const fatigue = classifyWeek(ctl, atl, ramp);
    const markers = computeMarkers(units28, hrMax, ftp, ctl, atl);
    markers.acwr = acwr;

    const scores = computeScores(markers);
    const phase = fatigue.state === "Müde"
      ? "Erholung"
      : "Aufbau";

    const future = new Date(mondayDate);
    future.setUTCDate(future.getUTCDate() + 7 * w);
    const mondayStr = future.toISOString().slice(0, 10);

    progression.push({
      weekOffset: w,
      monday: mondayStr,
      weeklyTarget: weeklyTss,
      weekState: fatigue.state,
      phase,
      markers,
      scores
    });
  }

  return progression;
}

//----------------------------------------------------------
// MAIN HANDLER
//----------------------------------------------------------
async function handle() {
  try {
    const authHeader = "Basic " + btoa(`${API_KEY}:${API_SECRET}`);

    const today = new Date().toISOString().slice(0, 10);
    const todayObj = new Date(today + "T00:00:00Z");

    const offset = (todayObj.getUTCDay() + 6) % 7; // Montag=0
    const monday = new Date(todayObj);
    monday.setUTCDate(monday.getUTCDate() - offset);
    const mondayStr = monday.toISOString().slice(0, 10);

    // Wellness (aktueller CTL/ATL etc.)
    const wRes = await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${today}`, {
      headers: { Authorization: authHeader }
    });
    const well = await wRes.json();

    const ctl = well.ctl ?? 0;
    const atl = well.atl ?? 0;
    const ramp = well.rampRate ?? 0;

    const hrMax = well.hrMax ?? 173;
    const ftp = well.ftp ?? 250;

    const weekState = classifyWeek(ctl, atl, ramp).state;

    // Trainingsplan-Pattern
    const plan = parseTrainingDays(well[DAILY_TYPE_FIELD] ?? DEFAULT_PLAN_STRING);

    // Aktivitäten der letzten 28 Tage + diese Woche für Marker / TSS
    const start28 = new Date(monday);
    start28.setUTCDate(start28.getUTCDate() - 28);
    const start28Str = start28.toISOString().slice(0, 10);

    const endThisWeek = new Date(monday);
    endThisWeek.setUTCDate(endThisWeek.getUTCDate() + 6);
    const endStr = endThisWeek.toISOString().slice(0, 10);

    const actRes = await fetch(
      `${BASE_URL}/athlete/${ATHLETE_ID}/activities?oldest=${start28Str}&newest=${endStr}`,
      { headers: { Authorization: authHeader } }
    );
    const activities = await actRes.json() ?? [];

    // Diese Woche: TSS-Summe
    const thisWeekTss = activities.reduce((sum, a) => {
      const d = (a.start_date || "").slice(0, 10);
      if (d >= mondayStr && d <= endStr) {
        const tss = a.icu_training_load ?? a.hr_load ?? a.power_load ?? 0;
        return sum + (tss || 0);
      }
      return sum;
    }, 0);

    // Letzte 28 Tage: Summe und 4-Wochen-Schnitt
    const total28 = activities.reduce((sum, a) => {
      const d = (a.start_date || "").slice(0, 10);
      if (d >= start28Str && d < mondayStr) {
        const tss = a.icu_training_load ?? a.hr_load ?? a.power_load ?? 0;
        return sum + (tss || 0);
      }
      return sum;
    }, 0);

    const last4WeekAvgTss = total28 / 4; // grob 4 Wochen à 7 Tage

    const units28 = activities.filter(a => {
      const d = (a.start_date || "").slice(0, 10);
      return d >= start28Str && d <= mondayStr;
    });

    // Start-Wochenziel:
    let startTarget =
      well[WEEKLY_TARGET_FIELD] ??
      Math.round(last4WeekAvgTss || 100);

    // CTL-Forecast & TSS-Berechnung
    const progression = simulateCtlForecast(
      ctl,
      atl,
      startTarget,
      monday,
      plan,
      units28,
      hrMax,
      ftp,
      6
    );

    const responseBody = {
      dryRun: true,
      thisWeek: {
        monday: mondayStr,
        weeklyTarget: startTarget,
        weekState,
        ctl,
        atl,
        ramp,
        thisWeekTss,
        last4WeekAvgTss
      },
      progression
    };

    return new Response(JSON.stringify(responseBody, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response("Error: " + err, { status: 500 });
  }
}

//----------------------------------------------------------
// EXPORT (Cloudflare Worker entrypoints)
//----------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    return handle();
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handle());
  }
};
