//----------------------------------------------------------
// CONFIG
//----------------------------------------------------------
const BASE_URL = "https://intervals.icu/api/v1";
const API_KEY = "API_KEY";     // später als Secret
const API_SECRET = "1xg1v04ym957jsqva8720oo01";  // später Secret
const ATHLETE_ID = "i105857";

const WEEKLY_TARGET_FIELD = "WochenzielTSS";
const PLAN_FIELD = "WochenPlan";
const DAILY_TYPE_FIELD = "TagesTyp";

const DEFAULT_PLAN_STRING = "Mo,Mi,Fr,So";

//----------------------------------------------------------
// HELFER
//----------------------------------------------------------
function getTss(a) {
  // bevorzugt icu_training_load, fallback auf hr/power/pace_load
  return (
    a.icu_training_load ??
    a.hr_load ??
    a.power_load ??
    a.pace_load ??
    0
  ) || 0;
}

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

    const num = parseInt(t);
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

  const highATL = ctl > 0 &&
    atl / ctl >= (ctl < 50 ? 1.2 : ctl < 80 ? 1.3 : 1.4);

  if (ramp <= -0.5 && tsb >= -5) return { state: "Erholt", tsb };
  if (ramp >= 1.0 || tsb <= tsbCritical || highATL) return { state: "Müde", tsb };

  return { state: "Normal", tsb };
}

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
// MARKER (Decoupling, PDC, Polarisation, ACWR etc.)
//----------------------------------------------------------
function computeMarkers(units, hrMax, ftp, ctl, atl) {
  if (!Array.isArray(units)) units = [];

  const cleaned = units.map(extractMetrics);

  // Strength ignorieren
  const filtered = cleaned.filter(u => u.sport !== "WeightTraining");

  // ACWR im Marker: atl/ctl ist hier mehr "akut vs chronisch"
  const acwr = ctl > 0 ? atl / ctl : null;

  // Polarisation (über HR)
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

  // Qualitätseinheiten
  const qualitySessions = filtered.filter(u => {
    if (u.hrAvg && hrMax && (u.hrAvg / hrMax) >= 0.90) return true;
    if (u.powerMax && ftp && u.powerMax >= ftp * 1.15) return true;
    return false;
  }).length;

  // GA-Decoupling
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

  // PDC (Peak zu FTP)
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
// PHASE SELECTOR
//----------------------------------------------------------
function recommendPhase(scores, fatigue) {
  if (fatigue === "Müde") return "Erholung";

  const reds = Object.values(scores).filter(s => s.includes("🔴")).length;
  if (reds >= 2) return "Grundlage (Reset)";
  if (scores.aerobic.includes("🔴") || scores.polarisation.includes("🔴"))
    return "Grundlage";
  if (scores.anaerobic.includes("🟡") || scores.anaerobic.includes("🔴"))
    return "Intensiv";

  return "Aufbau";
}

//----------------------------------------------------------
// CTL-basiertes Weekly Target (0.8–1.3 CTL-Steigerung + ACWR 0.8–1.3)
//----------------------------------------------------------
function findWeeklyTargetByCtl(ctl, atl, rolling4Avg, dayWeights) {
  const tauCtl = 42;
  const tauAtl = 7;

  let weights = Array.isArray(dayWeights) ? [...dayWeights] : [1, 0, 1, 0, 1, 0, 0];
  let sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW <= 0) {
    weights = [1, 0, 1, 0, 1, 0, 0];
    sumW = 3;
  }

  const base = rolling4Avg > 0 ? rolling4Avg : 100;
  const minWeekly = base * 0.9;
  const maxWeekly = base * 1.3;

  const step = 5; // in 5er-Schritten

  let best = null;

  // 1. Versuch: strenge Bedingungen: ramp 0.8–1.3 UND ACWR 0.8–1.3
  for (
    let tss = Math.round(minWeekly / step) * step;
    tss <= Math.round(maxWeekly / step) * step;
    tss += step
  ) {
    let ctlSim = ctl;
    let atlSim = atl;

    for (let d = 0; d < 7; d++) {
      const load = tss * (weights[d] / sumW);
      ctlSim = ctlSim + (load - ctlSim) / tauCtl;
      atlSim = atlSim + (load - atlSim) / tauAtl;
    }

    const ramp = ctlSim - ctl;
    const acwr = rolling4Avg > 0 ? tss / rolling4Avg : 1.0;

    if (
      ramp >= 0.8 && ramp <= 1.3 &&
      acwr >= 0.8 && acwr <= 1.3
    ) {
      best = { tss, ctl: ctlSim, atl: atlSim, ramp, acwr };
      break; // kleinste TSS, die alle Bedingungen erfüllt
    }
  }

  // 2. Falls nichts gefunden: Bedingungen etwas lockern
  if (!best) {
    for (
      let tss = Math.round(minWeekly / step) * step;
      tss <= Math.round(maxWeekly / step) * step;
      tss += step
    ) {
      let ctlSim = ctl;
      let atlSim = atl;

      for (let d = 0; d < 7; d++) {
        const load = tss * (weights[d] / sumW);
        ctlSim = ctlSim + (load - ctlSim) / tauCtl;
        atlSim = atlSim + (load - atlSim) / tauAtl;
      }

      const ramp = ctlSim - ctl;
      const acwr = rolling4Avg > 0 ? tss / rolling4Avg : 1.0;

      if (ramp > 0 && acwr <= 1.3) {
        best = { tss, ctl: ctlSim, atl: atlSim, ramp, acwr };
        break;
      }
    }
  }

  // 3. Fallback: einfach "base" nehmen, damit nix völlig ausrastet
  if (!best) {
    const tss = Math.round(base / step) * step;
    let ctlSim = ctl;
    let atlSim = atl;

    for (let d = 0; d < 7; d++) {
      const load = tss * (weights[d] / sumW);
      ctlSim = ctlSim + (load - ctlSim) / tauCtl;
      atlSim = atlSim + (load - atlSim) / tauAtl;
    }

    const ramp = ctlSim - ctl;
    const acwr = rolling4Avg > 0 ? tss / rolling4Avg : 1.0;
    best = { tss, ctl: ctlSim, atl: atlSim, ramp, acwr };
  }

  return best;
}

//----------------------------------------------------------
// SIMULATION (CTL-FORECAST, 6 Wochen)
// CTL soll pro Woche 0.8–1.3 steigen, solange ACWR ok.
//----------------------------------------------------------
function simulateForecast(
  ctlStart,
  atlStart,
  thisWeekTss,
  last4WeekAvgTss,
  mondayDate,
  plan,
  units28,
  hrMax,
  ftp,
  weeks = 6
) {
  const tauCtl = 42;
  const tauAtl = 7;

  let dayWeights = plan.map(x => (x ? 1 : 0));
  let sumW = dayWeights.reduce((a, b) => a + b, 0);
  if (sumW === 0) {
    dayWeights = [1, 0, 1, 0, 1, 0, 1];
    sumW = 4;
  }

  let ctl = ctlStart;
  let atl = atlStart;

  // Rolling 4-Wochen Summe approximieren
  let rollingSum = (last4WeekAvgTss || 0) * 4;
  if (thisWeekTss && last4WeekAvgTss) {
    // Schätze: älteste Woche raus, aktuelle Woche rein
    rollingSum = rollingSum - last4WeekAvgTss + thisWeekTss;
  }

  const progression = [];

  for (let w = 1; w <= weeks; w++) {
    const rollingAvg =
      rollingSum > 0
        ? rollingSum / 4
        : last4WeekAvgTss || thisWeekTss || 100;

    const target = findWeeklyTargetByCtl(ctl, atl, rollingAvg, dayWeights);

    // CTL/ATL auf Forecast-Werte setzen
    ctl = target.ctl;
    atl = target.atl;

    // RollingSum updaten (nächste ACWR-Schätzung)
    const newRollingAvg = rollingSum > 0 ? rollingSum / 4 : rollingAvg;
    rollingSum = newRollingAvg * 3 + target.tss;

    const ramp = target.ramp;
    const acwr = target.acwr;

    const fatigue = classifyWeek(ctl, atl, ramp);

    const markers = computeMarkers(units28, hrMax, ftp, ctl, atl);
    // überschreibe Marker-ACWR mit dem geplanten ACWR aus TSS-Sicht
    markers.acwr = acwr;

    const scores = computeScores(markers);
    const phase = recommendPhase(scores, fatigue.state);

    const future = new Date(mondayDate);
    future.setUTCDate(future.getUTCDate() + 7 * w);
    const mondayStr = future.toISOString().slice(0, 10);

    progression.push({
      weekOffset: w,
      monday: mondayStr,
      weeklyTarget: Math.round(target.tss),
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

    // Montag dieser Woche (UTC-basiert)
    const offset = (todayObj.getUTCDay() + 6) % 7;
    const monday = new Date(todayObj);
    monday.setUTCDate(monday.getUTCDate() - offset);
    const mondayStr = monday.toISOString().slice(0, 10);

    // Ende dieser Woche (Sonntag)
    const endOfWeek = new Date(monday);
    endOfWeek.setUTCDate(endOfWeek.getUTCDate() + 6);
    const endStr = endOfWeek.toISOString().slice(0, 10);

    // Wellness für heute holen
    const wRes = await fetch(
      `${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${today}`,
      { headers: { Authorization: authHeader } }
    );
    const well = await wRes.json();

    const ctl = well.ctl ?? 0;
    const atl = well.atl ?? 0;
    const ramp = well.rampRate ?? 0;

    const fatigueNow = classifyWeek(ctl, atl, ramp);

    const plan = parseTrainingDays(
      well[DAILY_TYPE_FIELD] ?? DEFAULT_PLAN_STRING
    );

    const hrMax = well.hrMax ?? 173;
    const ftp = well.ftp ?? 250;

    // Start-Weekly-Target: entweder aus Wellness oder aus Daily
    const dailyGuess = ctl > 0 ? ctl : 20;
    const startTarget =
      well[WEEKLY_TARGET_FIELD] ?? Math.round(dailyGuess * 7);

    // 28 Tage zurück
    const start28 = new Date(monday);
    start28.setUTCDate(start28.getUTCDate() - 28);
    const start28Str = start28.toISOString().slice(0, 10);

    // Activities holen
    const actRes = await fetch(
      `${BASE_URL}/athlete/${ATHLETE_ID}/activities?oldest=${start28Str}&newest=${endStr}`,
      { headers: { Authorization: authHeader } }
    );

    if (!actRes.ok) {
      console.error("Activities fetch failed", actRes.status, actRes.statusText);
      return new Response("Error loading activities", { status: 500 });
    }

    let activitiesRaw = await actRes.json();
    let activities = [];

    // Robust auf Array normalisieren
    if (Array.isArray(activitiesRaw)) {
      activities = activitiesRaw;
    } else if (
      activitiesRaw &&
      typeof activitiesRaw === "object" &&
      Array.isArray(activitiesRaw.activities)
    ) {
      activities = activitiesRaw.activities;
    } else if (
      activitiesRaw &&
      typeof activitiesRaw === "object"
    ) {
      activities = Object.values(activitiesRaw);
    } else {
      activities = [];
    }

    // TSS dieser Woche
    const thisWeekTss = activities.reduce((sum, a) => {
      const d = (a.start_date || "").slice(0, 10);
      if (d >= mondayStr && d <= endStr) {
        return sum + getTss(a);
      }
      return sum;
    }, 0);

    // 4-Wochen-Ø TSS (28 Tage vor Montag)
    const total28 = activities.reduce((sum, a) => {
      const d = (a.start_date || "").slice(0, 10);
      if (d >= start28Str && d < mondayStr) {
        return sum + getTss(a);
      }
      return sum;
    }, 0);

    const last4WeekAvgTss = total28 / 4;

    // Einheiten 28 Tage für Marker
    const units28 = activities.filter(a => {
      const d = (a.start_date || "").slice(0, 10);
      return d >= start28Str && d <= mondayStr;
    });

    // Marker / Scores für jetzt (optional)
    const markersNow = computeMarkers(units28, hrMax, ftp, ctl, atl);
    const scoresNow = computeScores(markersNow);
    const phaseNow = recommendPhase(scoresNow, fatigueNow.state);

    // Forecast (nur Simulation, kein PUT): CTL jede Woche ~0.8–1.3 rauf,
    // solange ACWR in 0.8–1.3 bleibt (sofern möglich).
    const progression = simulateForecast(
      ctl,
      atl,
      thisWeekTss,
      last4WeekAvgTss,
      monday,
      plan,
      units28,
      hrMax,
      ftp,
      6
    );

    return new Response(
      JSON.stringify(
        {
          dryRun: true,
          thisWeek: {
            monday: mondayStr,
            weeklyTarget: startTarget,
            weekState: fatigueNow.state,
            ctl,
            atl,
            ramp,
            thisWeekTss,
            last4WeekAvgTss,
            markers: markersNow,
            scores: scoresNow,
            phase: phaseNow
          },
          progression
        },
        null,
        2
      ),
      { status: 200 }
    );
  } catch (err) {
    console.error(err);
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
    // Kannst du später für nächtlichen Auto-Run nehmen
    ctx.waitUntil(handle());
  }
};
