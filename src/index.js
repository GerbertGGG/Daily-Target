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
// Extract actual Intervals.icu fields
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

  // ACWR (hier als ctl/avgTSS Näherung)
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
// Hilfsfunktion: eine Woche CTL/ATL mit gegebener Weekly-TSS simulieren
//----------------------------------------------------------
function simulateWeekLoads(ctlStart, atlStart, weeklyTss, dayWeights, tauCtl, tauAtl) {
  let ctl = ctlStart;
  let atl = atlStart;

  const sumW = dayWeights.reduce((a, b) => a + b, 0) || 1;

  for (let d = 0; d < 7; d++) {
    const load = weeklyTss * (dayWeights[d] / sumW);
    ctl = ctl + (load - ctl) / tauCtl;
    atl = atl + (load - atl) / tauAtl;
  }
  return { ctl, atl };
}

//----------------------------------------------------------
// SIMULATION (6 Wochen) mit CTL-Regler 0.8–1.3 / Woche
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
  if (sumW === 0) { dayWeights = [1, 0, 1, 0, 1, 0, 1]; sumW = 4; }

  let ctl = ctlStart;
  let atl = atlStart;
  let prev = weeklyTargetStart;

  const progression = [];

  for (let w = 1; w <= weeks; w++) {
    const ctlBefore = ctl;
    const atlBefore = atl;

    // 1) erste Schätzung des Weekly-TSS (leicht Richtung Historie / ACWR)
    let base = prev;

    // sanfte Annäherung an 4-Wochen-Schnitt
    if (last4WeekAvgTss && last4WeekAvgTss > 0) {
      base = (base * 0.4) + (last4WeekAvgTss * 0.6);
    }

    // leichte Steigerung, wenn nicht müde
    let fatigueGuess = w === 1 ? fatigueStart : "Normal";
    let rampFactor =
      fatigueGuess === "Müde" ? 0.95 :
      fatigueGuess === "Erholt" ? 1.05 :
      1.02;

    let weeklyTss = base * rampFactor;

    // 2) CTL-Regler: Ziel-Delta zwischen 0.8 und 1.3
    const TARGET_DELTA_CTL = 1.0;
    const MIN_DELTA_CTL = 0.8;
    const MAX_DELTA_CTL = 1.3;

    // 2–3 Iterationen, um Weekly-TSS so zu treffen,
    // dass DeltaCTL in [0.8, 1.3] landet
    for (let iter = 0; iter < 3; iter++) {
      const tmp = simulateWeekLoads(ctlBefore, atlBefore, weeklyTss, dayWeights, tauCtl, tauAtl);
      const deltaCtl = tmp.ctl - ctlBefore;

      if (deltaCtl >= MIN_DELTA_CTL && deltaCtl <= MAX_DELTA_CTL) {
        // passt, übernehmen
        ctl = tmp.ctl;
        atl = tmp.atl;
        break;
      }

      // Schutz gegen verrückte Werte
      if (!isFinite(deltaCtl) || Math.abs(deltaCtl) < 0.1) {
        // Falls Simulation degeneriert, Weekly-TSS minimal erhöhen
        weeklyTss *= 1.1;
        continue;
      }

      // gewünschte Ziel-Delta (auf Band geclipped)
      let targetDelta =
        deltaCtl < MIN_DELTA_CTL ? MIN_DELTA_CTL :
        deltaCtl > MAX_DELTA_CTL ? MAX_DELTA_CTL :
        TARGET_DELTA_CTL;

      const factor = targetDelta / deltaCtl;

      // Faktor begrenzen, damit es nicht explodiert
      const safeFactor = Math.max(0.5, Math.min(1.5, factor));
      weeklyTss = weeklyTss * safeFactor;

      // in letzter Iteration CTL/ATL fest übernehmen
      if (iter === 2) {
        const finalTmp = simulateWeekLoads(ctlBefore, atlBefore, weeklyTss, dayWeights, tauCtl, tauAtl);
        ctl = finalTmp.ctl;
        atl = finalTmp.atl;
      }
    }

    const ramp = ctl - ctlBefore;
    const fatigue = classifyWeek(ctl, atl, ramp).state;

    const markers = computeMarkers(units28, hrMax, ftp, ctl, atl);
    const scores = computeScores(markers);
    const phase = recommendPhase(scores, fatigue);

    const emoji = stateEmoji(fatigue);

    // Montag der zukünftigen Woche
    const future = new Date(mondayDate);
    future.setUTCDate(future.getUTCDate() + 7 * w);
    const id = future.toISOString().slice(0, 10);

    const payload = {
      id,
      [WEEKLY_TARGET_FIELD]: Math.round(weeklyTss / 5) * 5, // auf 5 TSS runden
      [PLAN_FIELD]: `Rest ${Math.round(weeklyTss)} | ${emoji} ${fatigue} | Phase: ${phase}`
    };

    // ins Wellnessfeld schreiben (non-dry-run; hier ggf. später umschalten)
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
      weeklyTarget: Math.round(weeklyTss / 5) * 5,
      weekState: fatigue,
      phase,
      markers,
      scores
    });

    prev = weeklyTss;
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

    // Wellness holen
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

    // aktueller Wochen-TSS-Start
    const startTarget = well[WEEKLY_TARGET_FIELD] ?? Math.round(daily * 7);

    // Aktivitäten der letzten 4 Wochen holen, um avgTSS zu berechnen
    const start28 = new Date(monday);
    start28.setUTCDate(start28.getUTCDate() - 28);
    const startStr = start28.toISOString().slice(0, 10);
    const endStr = new Date(monday.getTime() + 6 * 86400000)
      .toISOString()
      .slice(0, 10);

    const actRes = await fetch(
      `${BASE_URL}/athlete/${ATHLETE_ID}/activities?oldest=${startStr}&newest=${endStr}`,
      { headers: { Authorization: authHeader } }
    );
    const act = await actRes.json();
    const units28 = act ?? [];

    // TSS pro Woche aus den letzten 4 Wochen
    const tssByWeek = {};
    for (const u of units28) {
      if (!u.start_date) continue;
      const d = u.start_date.slice(0, 10);
      if (!tssByWeek[d]) tssByWeek[d] = 0;
    }

    // einfacher: wir nehmen die TSS aus icu_training_load (falls gesetzt)
    let weeklyBuckets = {};
    for (const u of units28) {
      if (!u.start_date) continue;
      const date = new Date(u.start_date);
      const dow = (date.getUTCDay() + 6) % 7;
      const mondayW = new Date(date);
      mondayW.setUTCDate(mondayW.getUTCDate() - dow);
      const mondayId = mondayW.toISOString().slice(0, 10);

      const load = u.icu_training_load ?? u.hr_load ?? u.pace_load ?? 0;
      weeklyBuckets[mondayId] = (weeklyBuckets[mondayId] ?? 0) + load;
    }

    const weekKeys = Object.keys(weeklyBuckets).sort();
    const last4 = weekKeys.slice(-4);
    let sum4 = 0;
    for (const k of last4) sum4 += weeklyBuckets[k];
    const last4WeekAvgTss = last4.length > 0 ? sum4 / last4.length : null;

    const thisWeekTss = weeklyBuckets[mondayStr] ?? 0;

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
