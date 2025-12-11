//----------------------------------------------------------
// CONFIG
//----------------------------------------------------------
const BASE_URL = "https://intervals.icu/api/v1";

// ⚠️ Später als Secret hinterlegen
const INTERVALS_API_KEY = "1xg1v04ym957jsqva8720oo01";
const INTERVALS_ATHLETE_ID = "i105857";

const INTERVALS_TARGET_FIELD = "TageszielTSS";
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
// CTL / ATL / MÜDIGKEIT
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

  const isTsbTired = tsb <= tsbCritical;
  const atlCtlRatio = ctl > 0 ? atl / ctl : Infinity;
  const isAtlHigh = atlCtlRatio >= (ctl < 50 ? 1.2 : ctl < 80 ? 1.3 : 1.4);

  const isRampHigh = rampRate >= 1.0;
  const isRampLowAndFresh = rampRate <= -0.5 && tsb >= -5;

  if (isRampLowAndFresh) return { state: "Erholt", tsb };
  if (isRampHigh || isTsbTired || isAtlHigh) return { state: "Müde", tsb };

  return { state: "Normal", tsb };
}


//----------------------------------------------------------
// MARKER: Aerob, Anaerob, Polarisation, ACWR
//----------------------------------------------------------
function computeExtendedMarkers(units, hrMax, ftp, ctl, atl) {
  if (!Array.isArray(units)) units = [];

  // --- ACWR ---
  const acwr = ctl > 0 ? atl / ctl : null;

  // --- Intensitätsverteilung ---
  let z1z2 = 0, z3z5 = 0, total = 0;

  for (const u of units) {
    if (!u.durationMinutes || u.hrAvg == null || hrMax <= 0) continue;

    const hrRel = u.hrAvg / hrMax;
    total += u.durationMinutes;

    if (hrRel <= 0.80) z1z2 += u.durationMinutes;
    else z3z5 += u.durationMinutes;
  }

  const polarisationIndex = total > 0 ? z1z2 / total : null;

  // --- Quality Sessions ---
  const qualitySessions = units.filter(u =>
    ["Interval", "VO2Max", "Sprint"].includes(u.type)
  ).length;

  // --- Decoupling / Durability ---
  const gaUnits = units.filter(u =>
    u.durationMinutes >= 30 &&
    ["Endurance", "LongRide", "EasyRun"].includes(u.type) &&
    u.hrAvg != null &&
    u.wattsAvg != null &&
    u.wattsAvg > 0 &&
    u.hrAvg <= 0.85 * hrMax
  );

  let decoupling = null;
  if (gaUnits.length > 0) {
    const sum = gaUnits.reduce((acc, u) =>
      acc + ((u.hrAvg / u.wattsAvg) - 1)
    , 0);
    decoupling = sum / gaUnits.length; // 0.03 = 3 %
  }

  // --- PDC ---
  let pdc = null;
  const peaks = units
    .filter(u => ["Interval", "VO2Max", "Sprint"].includes(u.type))
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
// FITNESS SCORES (🟢🟡🔴)
//----------------------------------------------------------
function computeFitnessScores(m) {
  const score = {};

  // Aerob
  if (m.decoupling == null) score.aerobic = "🟡 (zu wenig GA)";
  else if (m.decoupling <= 0.05) score.aerobic = "🟢";
  else if (m.decoupling <= 0.08) score.aerobic = "🟡";
  else score.aerobic = "🔴";

  // Polarisation
  if (m.polarisationIndex == null) score.polarisation = "🟡 (keine HR)";
  else if (m.polarisationIndex >= 0.80) score.polarisation = "🟢";
  else if (m.polarisationIndex >= 0.70) score.polarisation = "🟡";
  else score.polarisation = "🔴";

  // Anaerob
  if (m.pdc == null) score.anaerobic = "🟡 (zu wenig Daten)";
  else if (m.pdc >= 0.95 && m.qualitySessions >= 2) score.anaerobic = "🟢";
  else if (m.pdc >= 0.85 && m.qualitySessions >= 1) score.anaerobic = "🟡";
  else score.anaerobic = "🔴";

  // Workload (ACWR)
  if (m.acwr == null) score.workload = "🟡";
  else if (m.acwr >= 0.8 && m.acwr <= 1.3) score.workload = "🟢";
  else if (m.acwr >= 0.7 && m.acwr <= 1.4) score.workload = "🟡";
  else score.workload = "🔴";

  return score;
}


//----------------------------------------------------------
// NEUE WOCHENPHASEN LOGIK
//----------------------------------------------------------
function recommendWeekPhaseV2(scores, fatigueState) {

  if (fatigueState === "Müde") return "Erholung";

  const { aerobic, anaerobic, polarisation, workload } = scores;

  const reds = [aerobic, anaerobic, polarisation, workload]
    .filter(s => s.includes("🔴")).length;

  if (reds >= 2) return "Grundlage (Reset)";
  if (aerobic.includes("🔴") || polarisation.includes("🔴")) return "Grundlage";
  if (anaerobic.includes("🟡") || anaerobic.includes("🔴")) return "Intensiv";

  return "Aufbau";
}


//----------------------------------------------------------
// 6-WOCHEN-SIMULATION
//----------------------------------------------------------
async function simulateWeeks(
  ctlStart, atlStart, fatigueStateStart, weeklyTargetStart,
  mondayDate, planSelected, authHeader, athleteId,
  units, hrMax, ftp, weeksToSim
) {
  const tauCtl = 42;
  const tauAtl = 7;

  let dayWeights = new Array(7).fill(0);
  for (let i = 0; i < 7; i++) if (planSelected[i]) dayWeights[i] = 1;

  let sumWeights = dayWeights.reduce((a, b) => a + b, 0);
  if (sumWeights === 0) { dayWeights = [1,0,1,0,1,0,1]; sumWeights = 4; }

  let ctl = ctlStart;
  let atl = atlStart;
  let prevTarget = weeklyTargetStart;

  const progression = [];

  for (let w = 1; w <= weeksToSim; w++) {

    const ctlStartW = ctl;

    for (let d = 0; d < 7; d++) {
      const load = prevTarget * (dayWeights[d] / sumWeights);
      ctl = ctl + (load - ctl) / tauCtl;
      atl = atl + (load - atl) / tauAtl;
    }

    const ramp = ctl - ctlStartW;
    const { state: weekState } = classifyWeek(ctl, atl, ramp);

    const markers = computeExtendedMarkers(units, hrMax, ftp, ctl, atl);
    const scores = computeFitnessScores(markers);
    const phase = recommendWeekPhaseV2(scores, weekState);

    const emoji = stateEmoji(weekState);

    // Progression
    let multiplier = 1.0;
    if (weekState === "Müde") multiplier = 0.8;
    else if (ramp < 0.5) multiplier = weekState === "Erholt" ? 1.12 : 1.08;
    else if (ramp < 1.0) multiplier = weekState === "Erholt" ? 1.08 : 1.05;
    else if (ramp <= 1.5) multiplier = 1.02;
    else multiplier = 0.9;

    let nextTarget = prevTarget * multiplier;
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
`Fitness-Analyse:
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

      if (!res.ok) console.error("Update error", await res.text());
    } catch (e) {
      console.error("Exception updating future week:", e);
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
// MAIN
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

    // → Wellness
    const wRes = await fetch(`${BASE_URL}/athlete/${athleteId}/wellness/${today}`, {
      headers: { Authorization: authHeader }
    });
    const wellness = await wRes.json();

    const ctl = wellness.ctl;
    const atl = wellness.atl;
    const ramp = wellness.rampRate ?? 0;

    const { state: weekState } = classifyWeek(ctl, atl, ramp);

    const dailyTarget = computeDailyTarget(ctl, atl);

    const planSelected = parseTrainingDays(
      wellness[DAILY_TYPE_FIELD] ?? DEFAULT_PLAN_STRING
    );

    // → Activities der Woche
    const sunday = new Date(mondayDate);
    sunday.setUTCDate(sunday.getUTCDate() + 6);

    const aRes = await fetch(
      `${BASE_URL}/athlete/${athleteId}/activities?from=${mondayStr}&to=${sunday.toISOString().slice(0,10)}`,
      { headers: { Authorization: authHeader } }
    );
    const aJson = await aRes.json();
    const units = aJson.activities ?? aJson.data ?? [];

    const hrMax = wellness.hrMax ?? 173;
    const ftp = wellness.ftp ?? 250;

    const weeklyStart = wellness[WEEKLY_TARGET_FIELD] ?? Math.round(dailyTarget * 7);

    // → Simulation
    const progression = await simulateWeeks(
      ctl, atl, weekState, weeklyStart,
      mondayDate, planSelected,
      authHeader, athleteId,
      units, hrMax, ftp,
      6
    );

    return new Response(JSON.stringify({
      dryRun: true,
      thisWeek: {
        monday: mondayStr,
        weeklyTarget: weeklyStart,
      },
      progression
    }, null, 2));

  } catch (err) {
    return new Response("Error: " + err.toString(), { status: 500 });
  }
}


//----------------------------------------------------------
// EXPORT → WICHTIG!!!
//----------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    return handle(env);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handle(env));
  }
};
