//----------------------------------------------------------
// CONFIG
//----------------------------------------------------------
const BASE_URL = "https://intervals.icu/api/v1";

// ⚠️ später als Secret speichern
const INTERVALS_API_KEY = "1xg1v04ym957jsqva8720oo01";
const INTERVALS_ATHLETE_ID = "i105857";

const INTERVALS_PLAN_FIELD = "WochenPlan";
const WEEKLY_TARGET_FIELD = "WochenzielTSS";
const DAILY_TYPE_FIELD = "TagesTyp";

const DEFAULT_PLAN_STRING = "Mo,Mi,Fr,So";

//----------------------------------------------------------
// HELPERS
//----------------------------------------------------------
function parseTrainingDays(str) {
  if (!str || typeof str !== "string") return new Array(7).fill(false);

  const tokens = str
    .split(/[,\s;]+/)
    .map(t => t.trim())
    .filter(t => t.length > 0);

  const selected = new Array(7).fill(false);

  for (const raw of tokens) {
    const t = raw.toLowerCase();
    const num = parseInt(t, 10);

    if (!isNaN(num) && num >= 1 && num <= 7) {
      selected[num - 1] = true;
      continue;
    }

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

function stateEmoji(state) {
  if (state === "Erholt") return "🔥";
  if (state === "Müde") return "🧘";
  return "⚖️";
}

//----------------------------------------------------------
// CTL / ATL / FATIGUE
//----------------------------------------------------------
function computeDailyTarget(ctl, atl) {
  const tsb = ctl - atl;
  const tsbClamped = Math.max(-20, Math.min(20, tsb));
  const daily = ctl * (1 + 0.05 * tsbClamped);
  return Math.round(Math.max(0, Math.min(daily, ctl * 1.5)));
}

function classifyWeek(ctl, atl, rampRate) {
  const tsb = ctl - atl;

  let tsbCritical;
  if (ctl < 50) tsbCritical = -5;
  else if (ctl < 80) tsbCritical = -10;
  else tsbCritical = -15;

  const isTiredTSB = tsb <= tsbCritical;
  const isAtlHigh = atl / ctl >= (ctl < 50 ? 1.2 : ctl < 80 ? 1.3 : 1.4);
  const isRampHigh = rampRate >= 1.0;
  const isRampLowFresh = rampRate <= -0.5 && tsb >= -5;

  if (isRampLowFresh) return { state: "Erholt", tsb };
  if (isRampHigh || isTiredTSB || isAtlHigh) return { state: "Müde", tsb };
  return { state: "Normal", tsb };
}

//----------------------------------------------------------
// MARKER — Physiological Classification (Option A)
//----------------------------------------------------------
function computeExtendedMarkers(units, hrMax, ftp, ctl, atl) {
  if (!Array.isArray(units)) units = [];

  // -------------------------
  // ACWR
  // -------------------------
  const acwr = ctl > 0 ? atl / ctl : null;

  // -------------------------
  // Polarisation (HF-basiert)
  // -------------------------
  let z1z2 = 0, z3z5 = 0, total = 0;

  for (const u of units) {
    const dur = (u.duration ?? u.moving_time ?? 0) / 60; 
    if (dur <= 0) continue;

    const hr = u.hrAvg;
    if (hr == null || hrMax <= 0) continue;

    total += dur;
    const hrRel = hr / hrMax;

    if (hrRel <= 0.80) z1z2 += dur;
    else z3z5 += dur;
  }

  const polarisationIndex = total > 0 ? z1z2 / total : null;

  // -------------------------
  // Quality Sessions (HF ≥ 90% oder Power ≥ FTP*1.15)
  // -------------------------
  const qualitySessions = units.filter(u => {
    const hr = u.hrAvg;
    const power = u.wattsMax ?? u.wattsAvg ?? null;

    if (hr != null && hr / hrMax >= 0.90) return true;
    if (power != null && ftp > 0 && power >= ftp * 1.15) return true;
    return false;
  }).length;

  // -------------------------
  // GA-Decoupling
  // -------------------------
  const gaUnits = units.filter(u => {
    const dur = (u.duration ?? u.moving_time ?? 0) / 60;
    const hr = u.hrAvg;
    const p = u.wattsAvg ?? null;

    if (dur < 30) return false;
    if (hr == null) return false;
    if (hr > 0.85 * hrMax) return false;

    if (p != null && ftp > 0 && p > ftp * 0.90) return false;

    return true;
  });

  let decoupling = null;
  if (gaUnits.length > 0) {
    const sum = gaUnits.reduce((acc, u) => {
      const hr = u.hrAvg;
      const p = u.wattsAvg;
      if (!p || p <= 0) return acc; 
      return acc + ((hr / p) - 1);
    }, 0);

    decoupling = sum / gaUnits.length;
  }

  // -------------------------
  // PDC
  // -------------------------
  let pdc = null;
  const peaks = units
    .map(u => u.wattsMax ?? u.wattsAvg)
    .filter(v => v != null && v > 0);

  if (peaks.length > 0 && ftp > 0)
    pdc = Math.max(...peaks) / ftp;

  return {
    decoupling,
    pdc,
    polarisationIndex,
    qualitySessions,
    acwr
  };
}

//----------------------------------------------------------
// FITNESS SCORES
//----------------------------------------------------------
function computeFitnessScores(m) {
  const score = {};

  score.aerobic =
    m.decoupling == null ? "🟡 (zu wenig GA)"
    : m.decoupling <= 0.05 ? "🟢"
    : m.decoupling <= 0.08 ? "🟡"
    : "🔴";

  score.polarisation =
    m.polarisationIndex == null ? "🟡 (keine HR)"
    : m.polarisationIndex >= 0.80 ? "🟢"
    : m.polarisationIndex >= 0.70 ? "🟡"
    : "🔴";

  score.anaerobic =
    m.pdc == null ? "🟡 (zu wenig Daten)"
    : m.pdc >= 0.95 && m.qualitySessions >= 2 ? "🟢"
    : m.pdc >= 0.85 && m.qualitySessions >= 1 ? "🟡"
    : "🔴";

  score.workload =
    m.acwr == null ? "🟡"
    : (m.acwr >= 0.8 && m.acwr <= 1.3) ? "🟢"
    : (m.acwr >= 0.7 && m.acwr <= 1.4) ? "🟡"
    : "🔴";

  return score;
}

//----------------------------------------------------------
// WEEK PHASE LOGIC
//----------------------------------------------------------
function recommendWeekPhaseV2(scores, fatigue) {
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
// SIMULATION (6 Wochen)
//----------------------------------------------------------
async function simulateWeeks(
  ctlStart, atlStart, fatigueStart, weeklyTargetStart,
  mondayDate, planSelected, authHeader, athleteId,
  units28, hrMax, ftp, weeksToSim
) {
  const tauCtl = 42;
  const tauAtl = 7;

  let dayWeights = new Array(7).fill(0);
  for (let i = 0; i < 7; i++) if (planSelected[i]) dayWeights[i] = 1;

  let sumW = dayWeights.reduce((a, b) => a + b, 0);
  if (sumW === 0) { dayWeights = [1,0,1,0,1,0,1]; sumW = 4; }

  let ctl = ctlStart;
  let atl = atlStart;
  let prevTarget = weeklyTargetStart;

  const progression = [];

  for (let w = 1; w <= weeksToSim; w++) {
    const ctlStartW = ctl;

    for (let d = 0; d < 7; d++) {
      const load = prevTarget * (dayWeights[d] / sumW);
      ctl = ctl + (load - ctl) / tauCtl;
      atl = atl + (load - atl) / tauAtl;
    }

    const ramp = ctl - ctlStartW;
    const { state: weekState } = classifyWeek(ctl, atl, ramp);

    const markers = computeExtendedMarkers(units28, hrMax, ftp, ctl, atl);
    const scores = computeFitnessScores(markers);
    const phase = recommendWeekPhaseV2(scores, weekState);
    const emoji = stateEmoji(weekState);

    let mult = 1.0;
    if (weekState === "Müde") mult = 0.8;
    else if (ramp < 0.5) mult = weekState === "Erholt" ? 1.12 : 1.08;
    else if (ramp < 1.0) mult = weekState === "Erholt" ? 1.08 : 1.05;
    else if (ramp <= 1.5) mult = 1.02;
    else mult = 0.9;

    let nextTarget = prevTarget * mult;
    nextTarget = Math.max(prevTarget * 0.75, Math.min(prevTarget * 1.25, nextTarget));
    nextTarget = Math.round(nextTarget / 5) * 5;

    const mondayFuture = new Date(mondayDate);
    mondayFuture.setUTCDate(mondayFuture.getUTCDate() + 7 * w);
    const mondayId = mondayFuture.toISOString().slice(0, 10);

    const payload = {
      id: mondayId,
      [WEEKLY_TARGET_FIELD]: nextTarget,
      [INTERVALS_PLAN_FIELD]: `Rest ${nextTarget} | ${emoji} ${weekState} | Phase: ${phase}`,
      comments:
`Fitness-Analyse (28 Tage):
Aerob: ${scores.aerobic} (Decoupling ${markers.decoupling != null ? (markers.decoupling*100).toFixed(1)+"%" : "n/a"})
Anaerob: ${scores.anaerobic} (PDC ${(markers.pdc*100).toFixed(0)}%)
Polarisation: ${scores.polarisation} (${(markers.polarisationIndex*100).toFixed(0)}% Z1/Z2)
Workload (ACWR): ${scores.workload} (${markers.acwr?.toFixed(2)})

Empfohlene Phase: ${phase}
`
    };

    try {
      const res = await fetch(`${BASE_URL}/athlete/${athleteId}/wellness/${mondayId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify(payload)
      });

      if (!res.ok) console.error("Update error:", await res.text());
    } catch (e) {
      console.error("Exception updating week:", e);
    }

    progression.push({
      weekOffset: w,
      monday: mondayId,
      weeklyTarget: nextTarget,
      weekState,
      phase,
      markers,
      scores
    });

    prevTarget = nextTarget;
  }

  return progression;
}

//----------------------------------------------------------
// MAIN HANDLER
//----------------------------------------------------------
async function handle(env) {
  try {
    const apiKey = INTERVALS_API_KEY;
    const athleteId = INTERVALS_ATHLETE_ID;
    const authHeader = "Basic " + btoa(`API_KEY:${apiKey}`);

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const todayDate = new Date(today + "T00:00:00Z");

    const jsDay = todayDate.getUTCDay();
    const offset = jsDay === 0 ? 6 : jsDay - 1;

    const mondayDate = new Date(todayDate);
    mondayDate.setUTCDate(mondayDate.getUTCDate() - offset);

    const mondayStr = mondayDate.toISOString().slice(0, 10);

    // Wellness
    const wRes = await fetch(`${BASE_URL}/athlete/${athleteId}/wellness/${today}`, {
      headers: { Authorization: authHeader }
    });
    const wellness = await wRes.json();

    const ctl = wellness.ctl;
    const atl = wellness.atl;
    const ramp = wellness.rampRate ?? 0;

    const { state: weekState } = classifyWeek(ctl, atl, ramp);

    const dailyTarget = computeDailyTarget(ctl, atl);
    const planSelected = parseTrainingDays(wellness[DAILY_TYPE_FIELD] ?? DEFAULT_PLAN_STRING);

    const hrMax = wellness.hrMax ?? 173;
    const ftp = wellness.ftp ?? 250;

    const weeklyTargetStart =
      wellness[WEEKLY_TARGET_FIELD] ?? Math.round(dailyTarget * 7);

    // ------------------------------
    // 28-Tage Aktivitäten laden
    // ------------------------------
    const start28 = new Date(mondayDate);
    start28.setUTCDate(start28.getUTCDate() - 28);
    const startStr = start28.toISOString().slice(0, 10);

    const end28 = new Date(mondayDate);
    end28.setUTCDate(end28.getUTCDate() + 6);
    const endStr = end28.toISOString().slice(0, 10);

    const actRes = await fetch(
      `${BASE_URL}/athlete/${athleteId}/activities?from=${startStr}&to=${endStr}`,
      { headers: { Authorization: authHeader } }
    );

    const actJson = await actRes.json();
    const units28 = actJson.activities ?? actJson.data ?? [];

    // ------------------------------
    // Simulation
    // ------------------------------
    const progression = await simulateWeeks(
      ctl, atl, weekState, weeklyTargetStart,
      mondayDate, planSelected,
      authHeader, athleteId,
      units28, hrMax, ftp,
      6
    );

    return new Response(JSON.stringify({
      dryRun: true,
      thisWeek: {
        monday: mondayStr,
        weeklyTarget: weeklyTargetStart
      },
      progression
    }, null, 2));

  } catch (err) {
    return new Response("Error: " + err.toString(), { status: 500 });
  }
}

//----------------------------------------------------------
// EXPORT (ESSENTIELL!)
//----------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    return handle(env);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handle(env));
  }
};
