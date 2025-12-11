const BASE_URL = "https://intervals.icu/api/v1";

// 🔥 Hardcoded – später besser als Secrets
const INTERVALS_API_KEY = "1xg1v04ym957jsqva8720oo01";
const INTERVALS_ATHLETE_ID = "i105857";

const INTERVALS_TARGET_FIELD = "TageszielTSS";
const INTERVALS_PLAN_FIELD = "WochenPlan";
const WEEKLY_TARGET_FIELD = "WochenzielTSS";
const DAILY_TYPE_FIELD = "TagesTyp";

const DEFAULT_PLAN_STRING = "Mo,Mi,Fr,So";

const DAY_NAMES = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

// Optional Helper, aktuell ungenutzt, aber korrekt
function dayIdxFromJsDay(jsDay) {
  return jsDay === 0 ? 6 : jsDay - 1;
}

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

    // 1–7 -> Mo–So
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

// ---------------------------------------------------------
// Trainings-Logik: Fitness / Müdigkeit
// ---------------------------------------------------------
function computeDailyTarget(ctl, atl) {
  const tsb = ctl - atl;
  const tsbClamped = Math.max(-20, Math.min(20, tsb));
  const base = 1.0;
  const k = 0.05;
  const daily = ctl * (base + k * tsbClamped);
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
  const atlRatioThreshold = ctl < 50 ? 1.2 : ctl < 80 ? 1.3 : 1.4;
  const isAtlHigh = atlCtlRatio >= atlRatioThreshold;

  const isRampHigh = rampRate >= 1.0;
  const isRampLowAndFresh = rampRate <= -0.5 && tsb >= -5;

  if (isRampLowAndFresh) return { state: "Erholt", tsb };
  if (isRampHigh || isTsbTired || isAtlHigh) return { state: "Müde", tsb };
  return { state: "Normal", tsb };
}

// ---------------------------------------------------------
// Marker: Decoupling & PDC (GA-Filter + Intensiv)
// ---------------------------------------------------------
function computeMarkers(units, hrMax, ftp) {
  if (!Array.isArray(units)) units = [];

  // --- GA-Einheiten für "Decoupling" / aerobe Effizienz ---
  const gaUnits = units.filter(u => {
    const durationOk = u.durationMinutes >= 30;
    const isEndurance = ["Endurance", "LongRide", "EasyRun"].includes(u.type);

    const hrOk =
      u.hrAvg != null &&
      hrMax != null &&
      hrMax > 0 &&
      u.hrAvg <= 0.85 * hrMax;

    const watts = u.wattsAvg ?? null;
    const powerOk =
      watts != null && watts > 0 && ftp != null && ftp > 0 && watts <= 1.0 * ftp;

    return durationOk && isEndurance && hrOk && powerOk;
  });

  let decoupling = null;
  if (gaUnits.length > 0) {
    // "Effizienz-Index": HF pro Watt, relativ zu 1.0
    // 0.03 = 3% "schlechter" als Referenz, niedriger = besser.
    const sum = gaUnits.reduce((acc, u) => {
      const watts = u.wattsAvg;
      if (!watts || watts <= 0) return acc;
      const hrPerW = u.hrAvg / watts;
      return acc + (hrPerW - 1); // relativer Index
    }, 0);

    decoupling = sum / gaUnits.length; // z.B. 0.03 = 3 %
  }

  // --- Intensiv-Einheiten für PDC (Peak vs FTP) ---
  const intenseUnits = units.filter(u =>
    ["Interval", "Sprint", "VO2Max"].includes(u.type)
  );

  let pdc = null;
  if (intenseUnits.length > 0) {
    const peakPowers = intenseUnits
      .map(u => u.wattsMax ?? u.wattsAvg ?? null)
      .filter(v => v != null && v > 0);

    if (peakPowers.length > 0 && ftp != null && ftp > 0) {
      const maxPeak = Math.max(...peakPowers);
      pdc = maxPeak / ftp; // z.B. 1.3 = 130 % von FTP
    }
  }

  return { decoupling, pdc };
}

// ---------------------------------------------------------
// Wochenphase Empfehlung
// ---------------------------------------------------------
function recommendWeekPhase(lastWeekMarkers, weekState) {
  const decoupling = lastWeekMarkers?.decoupling ?? null; // 0.03 = 3 %
  const pdc = lastWeekMarkers?.pdc ?? null;               // z.B. 1.2 = 120 % FTP

  let phase = "Aufbau";

  // Wenn Marker fehlen -> konservativ: Grundlagenphase
  if (decoupling === null || pdc === null) {
    phase = "Grundlage";
  } else {
    // Decoupling > 5 % = GA-Basis eher bröselig -> mehr Grundlage
    if (decoupling > 0.05) {
      phase = "Grundlage";
    }
    // Peak-Leistung < 90 % FTP = anaerob "unterbelichtet" -> Intensivphase
    else if (pdc < 0.9) {
      phase = "Intensiv";
    } else {
      phase = "Aufbau";
    }
  }

  // Müdigkeit sticht alles → lieber Erholung
  if (weekState === "Müde") phase = "Erholung";

  return phase;
}

// ---------------------------------------------------------
// 6-Wochen-Simulation inkl. Wochenphase & Marker
// ---------------------------------------------------------
async function simulatePlannedWeeks(
  ctlStart,
  atlStart,
  weekStateStart,
  weeklyTargetStart,
  mondayDate,
  planSelected,
  authHeader,
  athleteId,
  units,
  hrMax,
  ftp,
  weeksToSim
) {
  const tauCtl = 42;
  const tauAtl = 7;

  // Verteilung des Wochenziels auf die Wochentage
  let dayWeights = new Array(7).fill(0);
  let countSelected = 0;
  for (let i = 0; i < 7; i++) {
    if (planSelected[i]) {
      dayWeights[i] = 1;
      countSelected++;
    }
  }
  if (countSelected === 0) {
    // Fallback: Mo, Mi, Fr, So
    dayWeights = [1, 0, 1, 0, 1, 0, 1];
    countSelected = 4;
  }
  let sumWeights = dayWeights.reduce((a, b) => a + b, 0);

  let ctl = ctlStart;
  let atl = atlStart;
  let prevTarget = weeklyTargetStart;
  let prevState = weekStateStart;

  const weeklyProgression = [];

  for (let w = 1; w <= weeksToSim; w++) {
    const ctlAtWeekStart = ctl;

    // CTL/ATL-Update über 7 Tage mit geplanter Wochenlast
    for (let d = 0; d < 7; d++) {
      const share = dayWeights[d] / sumWeights;
      const load = prevTarget * share;
      ctl = ctl + (load - ctl) / tauCtl;
      atl = atl + (load - atl) / tauAtl;
    }

    const ctlEnd = ctl;
    const atlEnd = atl;
    const rampSim = ctlEnd - ctlAtWeekStart;

    const { state: simState } = classifyWeek(ctlEnd, atlEnd, rampSim);

    const lastWeekMarkers = computeMarkers(units, hrMax, ftp);
    const phase = recommendWeekPhase(lastWeekMarkers, simState);

    const emoji = stateEmoji(simState);

    // Progressions-Logik für Wochenziel
    let multiplier = 1.0;
    if (simState === "Müde") {
      multiplier = 0.8;
    } else if (rampSim < 0.5) {
      multiplier = simState === "Erholt" ? 1.12 : 1.08;
    } else if (rampSim < 1.0) {
      multiplier = simState === "Erholt" ? 1.08 : 1.05;
    } else if (rampSim <= 1.5) {
      multiplier = 1.02;
    } else {
      multiplier = 0.9;
    }

    let nextTarget = prevTarget * multiplier;
    // Clamp auf ±25 %
    nextTarget = Math.max(prevTarget * 0.75, Math.min(prevTarget * 1.25, nextTarget));
    // Auf 5er-Schritte runden
    nextTarget = Math.round(nextTarget / 5) * 5;

    const mondayFutureDate = new Date(mondayDate);
    mondayFutureDate.setUTCDate(mondayFutureDate.getUTCDate() + 7 * w);
    const mondayId = mondayFutureDate.toISOString().slice(0, 10);

    const planText = `Rest ${nextTarget} | ${emoji} ${simState} | Phase: ${phase}`;

    const decStr =
      lastWeekMarkers.decoupling != null
        ? `${(lastWeekMarkers.decoupling * 100).toFixed(1)}%`
        : "n/a";

    const pdcStr =
      lastWeekMarkers.pdc != null
        ? `${(lastWeekMarkers.pdc * 100).toFixed(0)}% von FTP`
        : "n/a";

    const payloadFuture = {
      id: mondayId,
      [WEEKLY_TARGET_FIELD]: nextTarget,
      [INTERVALS_PLAN_FIELD]: planText,
      comments: `Wochenphase automatisch:
- Phase: ${phase} (${simState})
- Aerobe Basis (Decoupling): ${decStr} (niedrig = gut, >5–6% = müde / unökonomisch)
- Anaerobe Kapazität (PDC): ${pdcStr}
- Empfehlung: Intensität & Volumen entsprechend Phase anpassen`
    };

    try {
      const resFuture = await fetch(
        `${BASE_URL}/athlete/${athleteId}/wellness/${mondayId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: authHeader },
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
        resFuture.body.cancel?.();
      }
    } catch (e) {
      console.error("Error updating future week:", e);
    }

    prevTarget = nextTarget;
    prevState = simState;

    weeklyProgression.push({
      weekOffset: w,
      monday: mondayId,
      weeklyTarget: nextTarget,
      state: simState,
      phase: phase,
      markers: lastWeekMarkers
    });
  }

  return weeklyProgression;
}

// ---------------------------------------------------------
// Hauptlogik
// ---------------------------------------------------------
async function handle(env) {
  try {
    const apiKey = INTERVALS_API_KEY;
    const athleteId = INTERVALS_ATHLETE_ID;
    if (!apiKey || !athleteId)
      return new Response("Missing config", { status: 500 });

    const authHeader = "Basic " + btoa(`API_KEY:${apiKey}`);

    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    const todayDate = new Date(today + "T00:00:00Z");
    const jsDay = todayDate.getUTCDay(); // 0=So..6=Sa
    const offset = jsDay === 0 ? 6 : jsDay - 1; // Montag=0
    const mondayDate = new Date(todayDate);
    mondayDate.setUTCDate(mondayDate.getUTCDate() - offset);
    const mondayStr = mondayDate.toISOString().slice(0, 10);

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

    if (ctl == null || atl == null)
      return new Response("No ctl/atl data", { status: 200 });

    const { state: weekState, tsb } = classifyWeek(ctl, atl, rampRate);

    const dailyTargetBase = computeDailyTarget(ctl, atl);

    // 2) Wochenmuster aus Custom Field (oder Default)
    const planSelected = parseTrainingDays(
      wellness[DAILY_TYPE_FIELD] ?? DEFAULT_PLAN_STRING
    );

    // 3) Einheiten der Woche (Mo–So)
    const sundayDate = new Date(mondayDate);
    sundayDate.setUTCDate(sundayDate.getUTCDate() + 6);
    const sundayStr = sundayDate.toISOString().slice(0, 10);

    const unitsRes = await fetch(
      `${BASE_URL}/athlete/${athleteId}/activities?from=${mondayStr}&to=${sundayStr}`,
      { headers: { Authorization: authHeader } }
    );
    const unitsJson = await unitsRes.json();
    const units = unitsJson.activities ?? unitsJson.data ?? [];

    const hrMax = wellness.hrMax || 173;
    const ftp = wellness.ftp || 250;

    const weeklyTargetStart =
      wellness[WEEKLY_TARGET_FIELD] ?? Math.round(dailyTargetBase * 7);

    const weeklyProgression = await simulatePlannedWeeks(
      ctl,
      atl,
      weekState,
      weeklyTargetStart,
      mondayDate,
      planSelected,
      authHeader,
      athleteId,
      units,
      hrMax,
      ftp,
      6
    );

    // Rückgabe nur als "Dry Run" JSON (keine Tagesplanung)
    return new Response(
      JSON.stringify(
        {
          dryRun: true,
          thisWeek: {
            monday: mondayStr,
            weeklyTarget: weeklyTargetStart,
            alreadyDone: 0,
            remaining: weeklyTargetStart
          },
          weeklyProgression
        },
        null,
        2
      ),
      { status: 200 }
    );
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(
      "Unexpected error: " + (err.stack ?? String(err)),
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------
// EXPORT (Cloudflare Worker)
// ---------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    return handle(env);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handle(env));
  }
};

