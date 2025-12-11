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

  // ACWR im Marker: atl/ctl = akut vs. chronisch
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
// CTL-/ATL-Forecast & Weekly Target (0.8–1.3 CTL/Woche + Deload)
//----------------------------------------------------------

// Ziel-Steigerungen pro Woche
const CTL_DELTA_MIN = 0.8;
const CTL_DELTA_MAX = 1.3;

// ACWR-Limit (ATL / CTL)
const ACWR_SAFE_MAX = 1.3;

// Ermüdungs-Limit: ATL - CTL > 10 => Kandidat für Deload
const FATIGUE_GAP_THRESHOLD = 10;

// Deload-Faktor: 90 % der Erhaltungsbelastung (~CTL)
const DELOAD_FACTOR = 0.9;

/**
 * Prüft, ob eine Entlastungswoche im Forecast sinnvoll ist.
 * Regeln:
 *  - ACWR > 1.3 (ATL / CTL)
 *  - ATL - CTL > 10
 */
function shouldDeload(ctl, atl) {
  if (ctl <= 0) return false;
  const acwr = atl / ctl;
  const fatigueGap = atl - ctl;
  return acwr > ACWR_SAFE_MAX || fatigueGap > FATIGUE_GAP_THRESHOLD;
}

/**
 * Max. CTL-Delta, damit ACWR (ATL/CTL) nach der Woche <= ACWR_SAFE_MAX bleibt.
 *
 * Modell:
 *   ΔCTL ≈ (TSS_mean - CTL) / 6
 *   TSS_mean = CTL + 6d
 *   ATL_next ≈ TSS_mean
 *   CTL_next = CTL + d
 *   ACWR_next = ATL_next / CTL_next = (CTL + 6d) / (CTL + d)
 *
 *   (CTL + 6d) / (CTL + d) <= ACWR_SAFE_MAX
 *   => d_max = ((ACWR_SAFE_MAX - 1) / (6 - ACWR_SAFE_MAX)) * CTL
 */
function maxSafeCtlDelta(ctl) {
  if (ctl <= 0) return CTL_DELTA_MIN;
  const numerator = (ACWR_SAFE_MAX - 1) * ctl; // z.B. 0.3 * CTL
  const denominator = 6 - ACWR_SAFE_MAX;       // z.B. 4.7
  return numerator / denominator;
}

/**
 * Berechnet eine Woche mit gegebener CTL-Steigerung.
 */
function computeWeekFromCtlDelta(ctl, atl, ctlDelta) {
  // durchschnittlicher TSS pro Tag
  const tssMean = ctl + 6 * ctlDelta;
  const weekTss = tssMean * 7;

  const nextCtl = ctl + ctlDelta;
  const nextAtl = tssMean; // ATL-Zeitkonstante 7 => nähert sich TSS_mean an
  const acwr = nextCtl > 0 ? nextAtl / nextCtl : null;
  const ramp = ctlDelta;

  return {
    weekType: ctlDelta > 0 ? "BUILD" : "MAINTAIN",
    ctlDelta,
    weekTss,
    tssMean,
    nextCtl,
    nextAtl,
    acwr,
    ramp
  };
}

/**
 * Berechnet eine Entlastungswoche (Deload):
 *  - ca. 90 % des Erhaltungsniveaus (CTL)
 */
function computeDeloadWeek(ctl, atl) {
  const tssMean = DELOAD_FACTOR * ctl; // leicht unter Erhaltungslevel
  const weekTss = tssMean * 7;

  const ctlDelta = (tssMean - ctl) / 6;
  const nextCtl = ctl + ctlDelta;
  const nextAtl = tssMean;
  const acwr = nextCtl > 0 ? nextAtl / nextCtl : null;
  const ramp = ctlDelta;

  return {
    weekType: "DELOAD",
    ctlDelta,
    weekTss,
    tssMean,
    nextCtl,
    nextAtl,
    acwr,
    ramp
  };
}

/**
 * CTL-FORECAST, 6 Wochen (oder custom):
 * - start: ctlStart, atlStart (heutiger Montag)
 * - Ziel: CTL +0.8–1.3/Woche, begrenzt durch ACWR <= 1.3
 * - automatische Deload-Wochen, wenn Ermüdung zu hoch
 *
 * Hinweis:
 *  - thisWeekTss, last4WeekAvgTss, plan werden aktuell nicht zur
 *    Verteilung der Last verwendet, sind aber für spätere Erweiterungen
 *    noch im Funktions-Signatur drin.
 */
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
  let ctl = ctlStart;
  let atl = atlStart;

  const progression = [];

  for (let w = 1; w <= weeks; w++) {
    let weekResult;

    // 1) Prüfen, ob für diese Woche eine Deload sinnvoll ist
    if (shouldDeload(ctl, atl)) {
      weekResult = computeDeloadWeek(ctl, atl);
    } else {
      // 2) Aufbauwoche: Ziel-CTL-Delta innerhalb 0.8–1.3,
      //    zusätzlich durch ACWR-Limit begrenzt.
      const dMaxSafe = maxSafeCtlDelta(ctl);

      let targetDelta = Math.min(CTL_DELTA_MAX, dMaxSafe);

      // Wenn dMaxSafe < 0.8, dann so hoch wie sicher möglich,
      // auch wenn wir unter der Wunsch-Steigerung bleiben.
      if (dMaxSafe < CTL_DELTA_MIN) {
        targetDelta = dMaxSafe;
      } else if (targetDelta < CTL_DELTA_MIN) {
        targetDelta = CTL_DELTA_MIN;
      }

      // Edge Case: falls irgendwas schief geht (NaN, negativ etc.)
      if (!isFinite(targetDelta) || targetDelta <= 0) {
        // Erhaltungswoche
        targetDelta = 0;
      }

      weekResult = computeWeekFromCtlDelta(ctl, atl, targetDelta);
    }

    // CTL/ATL updaten
    ctl = weekResult.nextCtl;
    atl = weekResult.nextAtl;

    // Montag dieser zukünftigen Woche
    const future = new Date(mondayDate);
    future.setUTCDate(future.getUTCDate() + 7 * w);
    const mondayStr = future.toISOString().slice(0, 10);

    // Ermüdungszustand und Marker auf Basis des neuen CTL/ATL
    const fatigue = classifyWeek(ctl, atl, weekResult.ramp);

    const markers = computeMarkers(units28, hrMax, ftp, ctl, atl);
    // ACWR aus Forecast überschreiben
    markers.acwr = weekResult.acwr;

    const scores = computeScores(markers);
    const phase = recommendPhase(scores, fatigue.state);

    const weeklyTarget = Math.round(weekResult.weekTss);

    progression.push({
      weekOffset: w,
      monday: mondayStr,
      weeklyTarget,
      weekState: fatigue.state,
      phase,
      weekType: weekResult.weekType, // BUILD / MAINTAIN / DELOAD
      ctl: ctl,
      atl: atl,
      ramp: weekResult.ramp,
      acwr: weekResult.acwr,
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

    // Start-Weekly-Target: entweder aus Wellness oder grob CTL*7
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

    // Marker / Scores für jetzt
    const markersNow = computeMarkers(units28, hrMax, ftp, ctl, atl);
    const scoresNow = computeScores(markersNow);
    const phaseNow = recommendPhase(scoresNow, fatigueNow.state);

    // Forecast (nur Simulation, kein PUT)
    // Nutzt jetzt die neue CTL-/ATL-Logik mit Deload-Wochen.
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
    // Auto-Run (z.B. 1x pro Woche per Cron)
    ctx.waitUntil(handle());
  }
};

