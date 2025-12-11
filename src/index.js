//----------------------------------------------------------
// CONFIG
//----------------------------------------------------------
const BASE_URL = "https://intervals.icu/api/v1";
const API_KEY = "API_KEY";     // später Secret
const API_SECRET = "1xg1v04ym957jsqva8720oo01";  // später Secret
const ATHLETE_ID = "i105857";

const WEEKLY_TARGET_FIELD = "WochenzielTSS";
const PLAN_FIELD = "WochenPlan";
const DAILY_TYPE_FIELD = "TagesTyp";

const DEFAULT_PLAN_STRING = "Mo,Mi,Fr,So";

// ---- NEU: CTL-basierte Ziel-Parameter ----
const CTL_FACTOR = 6.5;   // wie viel TSS pro CTL-Punkt
const MAX_TSS = 180;      // obere Kappe für Aufbau-Wochen
const MIN_DELOAD_TSS = 120; // Ziel in Deload-Wochen
const MAX_ACWR = 1.25;    // max. Verhältnis geplanter Woche / Ø letzte 4 Wochen

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

  const highATL = atl / ctl >= (ctl < 50 ? 1.2 : ctl < 80 ? 1.3 : 1.4);

  if (ramp <= -0.5 && tsb >= -5) return { state: "Erholt", tsb };
  if (ramp >= 1.0 || tsb <= tsbCritical || highATL) return { state: "Müde", tsb };

  return { state: "Normal", tsb };
}

function computeDailyTarget(ctl, atl) {
  const tsb = ctl - atl;
  const adj = Math.max(-20, Math.min(20, tsb));
  const val = ctl * (1 + 0.05 * adj);
  return Math.round(Math.max(0, Math.min(val, ctl * 1.5)));
}

//----------------------------------------------------------
// NEW: Extract actual Intervals.icu fields
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
// EXTENDED MARKERS (physiological, Option A)
//----------------------------------------------------------
function computeMarkers(units, hrMax, ftp, ctl, atl) {
  if (!Array.isArray(units)) units = [];

  const cleaned = units.map(extractMetrics);

  // Ignore Strength training
  const filtered = cleaned.filter(u => u.sport !== "WeightTraining");

  // ACWR (physiologisch hier: ATL/CTL)
  const acwr = ctl > 0 ? atl / ctl : null;

  // Polarisation
  let z1z2 = 0, z3z5 = 0, total = 0;

  for (const u of filtered) {
    if (!u.hrAvg) continue;

    const dur = u.durationMin;
    if (dur <= 0) continue;

    const rel = u.hrAvg / hrMax;

    total += dur;
    if (rel <= 0.80) z1z2 += dur;
    else z3z5 += dur;
  }

  const polarisationIndex = total > 0 ? z1z2 / total : null;

  // Quality sessions
  const qualitySessions = filtered.filter(u => {
    if (u.hrAvg && u.hrAvg / hrMax >= 0.90) return true;
    if (u.powerMax && ftp && u.powerMax >= ftp * 1.15) return true;
    return false;
  }).length;

  // Decoupling (GA)
  const ga = filtered.filter(u => {
    if (u.durationMin < 30) return false;
    if (!u.hrAvg) return false;
    if (u.hrAvg > 0.85 * hrMax) return false;
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
// NEU: Wochen-TSS Map & CTL-basiertes Weekly Target
//----------------------------------------------------------
function getActivityLoad(a) {
  return (
    (typeof a.icu_training_load === "number" ? a.icu_training_load : null) ??
    (typeof a.hr_load === "number" ? a.hr_load : null) ??
    (typeof a.power_load === "number" ? a.power_load : null) ??
    (typeof a.pace_load === "number" ? a.pace_load : null) ??
    0
  );
}

function buildWeeklyTssMap(activities) {
  const map = new Map();

  for (const a of activities || []) {
    const start = a.start_date || a.start_date_local;
    if (!start) continue;
    const d = new Date(start);
    const day = d.getUTCDay();
    const diff = (day + 6) % 7; // Montag = 0
    d.setUTCDate(d.getUTCDate() - diff);
    d.setUTCHours(0, 0, 0, 0);
    const mondayIso = d.toISOString().slice(0, 10);

    const load = getActivityLoad(a);
    map.set(mondayIso, (map.get(mondayIso) || 0) + load);
  }

  return map;
}

function getLastNWeekAvgTss(weekTssMap, thisWeekMondayIso, n) {
  const keys = Array.from(weekTssMap.keys()).sort();
  const candidates = keys.filter(k => k < thisWeekMondayIso);
  if (!candidates.length) return null;
  const last = candidates.slice(-n);
  const sum = last.reduce((acc, k) => acc + (weekTssMap.get(k) || 0), 0);
  return sum / last.length;
}

function getWeekTss(weekTssMap, mondayIso) {
  return weekTssMap.get(mondayIso) || 0;
}

function computeWeeklyTargetFromCtl({ ctl, weekState, last4WeekAvgTss }) {
  if (ctl == null) return null;

  // Basis: CTL * Faktor
  let target = Math.round(ctl * CTL_FACTOR);

  // Deload berücksichtigen
  if (weekState === "Müde") {
    target = Math.min(target, MIN_DELOAD_TSS);
  } else {
    target = Math.min(target, MAX_TSS);
  }

  // ACWR-Deckel
  if (last4WeekAvgTss && last4WeekAvgTss > 0) {
    const maxByAcwr = last4WeekAvgTss * MAX_ACWR;
    if (target > maxByAcwr) {
      target = Math.round(maxByAcwr);
    }
  }

  // Untergrenze
  if (target < 60) target = 60;

  // auf 5er TSS runden
  target = Math.round(target / 5) * 5;

  return target;
}

//----------------------------------------------------------
// SIMULATION (6 Wochen) - mit CTL-basiertem Weekly Target
//----------------------------------------------------------
async function simulate(
  ctlStart, atlStart, fatigueStart, weeklyTargetStart,
  mondayDate, plan, authHeader, athleteId,
  units28, hrMax, ftp,
  last4WeekAvgTss,
  weeks = 6
) {
  const tauCtl = 42, tauAtl = 7;

  let dayWeights = plan.map(x => x ? 1 : 0);
  let sumW = dayWeights.reduce((a, b) => a + b, 0);
  if (sumW === 0) { dayWeights = [1,0,1,0,1,0,1]; sumW = 4; }

  let ctl = ctlStart;
  let atl = atlStart;
  let prev = weeklyTargetStart;

  const progression = [];

  for (let w = 1; w <= weeks; w++) {
    const ctlBefore = ctl;

    // Woche mit aktuellem Ziel (prev) simulieren
    for (let d = 0; d < 7; d++) {
      const load = prev * (dayWeights[d] / sumW);
      ctl = ctl + (load - ctl) / tauCtl;
      atl = atl + (load - atl) / tauAtl;
    }

    const ramp = ctl - ctlBefore;
    const { state } = classifyWeek(ctl, atl, ramp);

    const markers = computeMarkers(units28, hrMax, ftp, ctl, atl);
    const scores = computeScores(markers);
    const phase = recommendPhase(scores, state);

    const emoji = stateEmoji(state);

    // ---- NEU: CTL-basierte Ziel-TSS für NÄCHSTE Woche ----
    let next = computeWeeklyTargetFromCtl({
      ctl,
      weekState: state,
      last4WeekAvgTss
    });

    // Falls irgendwas schief geht, fallback auf alte Logik:
    if (!next || !isFinite(next)) {
      let mult = state === "Müde" ? 0.8 :
        ramp < 0.5 ? (state === "Erholt" ? 1.12 : 1.08) :
        ramp < 1.0 ? (state === "Erholt" ? 1.08 : 1.05) :
        ramp <= 1.5 ? 1.02 : 0.9;

      next = Math.round(
        Math.min(prev * 1.25, Math.max(prev * 0.75, prev * mult)
        ) / 5
      ) * 5;
    }

    // Save future Monday (Montag dieser simulierten Woche + 7 Tage)
    const future = new Date(mondayDate);
    future.setUTCDate(future.getUTCDate() + 7 * w);
    const id = future.toISOString().slice(0, 10);

    const payload = {
      id,
      [WEEKLY_TARGET_FIELD]: next,
      [PLAN_FIELD]: `Rest ${next} | ${emoji} ${state} | Phase: ${phase}`
    };

    // write to Intervals (non-dry-run)
    try {
      await fetch(`${BASE_URL}/athlete/${athleteId}/wellness/${id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader
        },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      console.error(e);
    }

    progression.push({
      weekOffset: w,
      monday: id,
      weeklyTarget: next,
      weekState: state,
      phase,
      markers,
      scores
    });

    prev = next;
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

    const offset = (todayObj.getUTCDay() + 6) % 7;
    const monday = new Date(todayObj);
    monday.setUTCDate(monday.getUTCDate() - offset);
    const mondayStr = monday.toISOString().slice(0, 10);

    // wellness fetch (für ctl, atl, ramp etc.)
    const wRes = await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${today}`, {
      headers: { Authorization: authHeader }
    });
    const well = await wRes.json();

    const ctl = well.ctl;
    const atl = well.atl;
    const ramp = well.rampRate ?? 0;

    const { state } = classifyWeek(ctl, atl, ramp);
    const daily = computeDailyTarget(ctl, atl);

    const plan = parseTrainingDays(well[DAILY_TYPE_FIELD] ?? DEFAULT_PLAN_STRING);

    const hrMax = well.hrMax ?? 173;
    const ftp = well.ftp ?? 250;

    // Load 28 Tage Historie (inkl. aktueller Woche)
    const start = new Date(monday);
    start.setUTCDate(start.getUTCDate() - 28);

    const startStr = start.toISOString().slice(0, 10);
    const endStr = new Date(monday.getTime() + 6 * 86400000)
      .toISOString()
      .slice(0, 10);

    const actRes = await fetch(
      `${BASE_URL}/athlete/${ATHLETE_ID}/activities?oldest=${startStr}&newest=${endStr}`,
      { headers: { Authorization: authHeader } }
    );
    const act = await actRes.json();
    const units28 = act ?? [];

    // ---- NEU: Wochen-TSS-Historie + CTL-basiertes Start-Target ----
    const weekTssMap = buildWeeklyTssMap(units28);
    const last4WeekAvgTss = getLastNWeekAvgTss(weekTssMap, mondayStr, 4);
    const thisWeekTss = getWeekTss(weekTssMap, mondayStr);

    let startTarget = well[WEEKLY_TARGET_FIELD];
    if (typeof startTarget !== "number" || !isFinite(startTarget)) {
      // Wenn noch kein Wochenziel gesetzt ist → CTL-basiert bestimmen
      startTarget = computeWeeklyTargetFromCtl({
        ctl,
        weekState: state,
        last4WeekAvgTss
      }) ?? Math.round(daily * 7);
    }

    const progression = await simulate(
      ctl, atl, state, startTarget,
      monday, plan,
      authHeader, ATHLETE_ID,
      units28, hrMax, ftp,
      last4WeekAvgTss,
      6
    );

    return new Response(
      JSON.stringify(
        {
          dryRun: true,
          thisWeek: {
            monday: mondayStr,
            weeklyTarget: startTarget,
            weekState: state,
            ctl,
            atl,
            ramp,
            thisWeekTss,
            last4WeekAvgTss
          },
          progression
        },
        null,
        2
      ),
      { status: 200 }
    );
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
