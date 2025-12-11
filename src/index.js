//----------------------------------------------------------
// CONFIG
//----------------------------------------------------------
const BASE_URL = "https://intervals.icu/api/v1";
const API_KEY = "API_KEY";     // später als Secret
const API_SECRET = "1xg1v04ym957jsqva8720oo01";  // später Secret
const ATHLETE_ID = "i105857";

const WEEKLY_TARGET_FIELD = "WochenzielTSS";
const PLAN_FIELD = "WochenPlan"; // hier schreiben wir die Phase rein

//----------------------------------------------------------
// CTL-/ATL-Logik (0.8 CTL/Woche + Deload über ACWR/ATL)
//----------------------------------------------------------

// fixe Ziel-Steigerung pro Woche
const CTL_DELTA_TARGET = 0.8;

// ACWR-Bereiche
// 0.8–1.3  = ideal (Soft-Limit)
// >= 1.5   = hochriskant, Deload
const ACWR_SOFT_MAX = 1.3;
const ACWR_HARD_MAX = 1.5;

// Deload-Faktor: 90 % der Erhaltungsbelastung (~CTL)
const DELOAD_FACTOR = 0.9;

/**
 * Feste ATL-Deckel in Abhängigkeit vom CTL:
 *
 * CTL < 30    -> ATL-Max = 30
 * CTL 30–60   -> ATL-Max = 45
 * CTL 60–90   -> ATL-Max = 65
 * CTL >= 90   -> ATL-Max = 85
 */
function getAtlMax(ctl) {
  if (ctl < 30) return 30;
  if (ctl < 60) return 45;
  if (ctl < 90) return 65;
  return 85;
}

/**
 * Prüft, ob eine Entlastungswoche nötig ist.
 *
 * Deload, wenn:
 *  - ACWR >= 1.5
 *  - ODER ATL > ATL-Max (harte, fixe Grenze)
 */
function shouldDeload(ctl, atl) {
  const atlMax = getAtlMax(ctl);
  let acwr = null;

  if (ctl > 0) {
    acwr = atl / ctl;
  }

  if (acwr != null && acwr >= ACWR_HARD_MAX) {
    return true;
  }

  if (atl > atlMax) {
    return true;
  }

  return false;
}

/**
 * Max. CTL-Delta, damit ACWR nach der Woche im "grünen" Bereich bleibt.
 *
 * Modell:
 *   ΔCTL ≈ (TSS_mean - CTL) / 6
 *   TSS_mean = CTL + 6d
 *   ATL_next ≈ TSS_mean
 *   CTL_next = CTL + d
 *   ACWR_next = (CTL + 6d) / (CTL + d) <= ACWR_SOFT_MAX
 *
 *   => d_max = ((ACWR_SOFT_MAX - 1) / (6 - ACWR_SOFT_MAX)) * CTL
 */
function maxSafeCtlDelta(ctl) {
  if (ctl <= 0) return CTL_DELTA_TARGET;
  const numerator = (ACWR_SOFT_MAX - 1) * ctl;
  const denominator = 6 - ACWR_SOFT_MAX;
  return numerator / denominator;
}

/**
 * Berechnet eine Woche mit gegebener CTL-Steigerung.
 */
function computeWeekFromCtlDelta(ctl, atl, ctlDelta) {
  const tssMean = ctl + 6 * ctlDelta;   // ØTSS pro Tag
  const weekTss = tssMean * 7;          // Wochen-TSS

  const nextCtl = ctl + ctlDelta;
  const nextAtl = tssMean;              // ATL-Zeitkonstante 7 => ~TSS_mean
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
 * Entlastungswoche (Deload): ca. 90 % des Erhaltungsniveaus.
 */
function computeDeloadWeek(ctl, atl) {
  const tssMean = DELOAD_FACTOR * ctl;
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
 * NUR nächste Woche aus CTL/ATL berechnen:
 * - Standardziel: +0.8 CTL/Woche
 * - begrenzt durch ACWR (Soft-Limit 1.3)
 * - Deload bei ACWR >= 1.5 ODER ATL > ATL-Max
 */
function calcNextWeekTarget(ctl, atl) {
  if (shouldDeload(ctl, atl)) {
    return computeDeloadWeek(ctl, atl);
  }

  const dMaxSafe = maxSafeCtlDelta(ctl);
  let targetDelta = CTL_DELTA_TARGET;

  if (!isFinite(dMaxSafe) || dMaxSafe <= 0) {
    // ACWR lässt keine Steigerung zu → Erhaltungswoche
    targetDelta = 0;
  } else if (dMaxSafe < targetDelta) {
    // ACWR würde bei 0.8 zu hoch → auf sicheres Maximum begrenzen
    targetDelta = dMaxSafe;
  }

  return computeWeekFromCtlDelta(ctl, atl, targetDelta);
}

/**
 * Folgewochen simulieren (reine Orientierung, nichts wird geschrieben).
 */
function simulateFutureWeeks(ctlStart, atlStart, mondayDate, weeks, week0) {
  const progression = [];

  let ctl = week0.nextCtl;
  let atl = week0.nextAtl;

  for (let w = 1; w <= weeks; w++) {
    const weekResult = calcNextWeekTarget(ctl, atl);

    const future = new Date(mondayDate);
    future.setUTCDate(future.getUTCDate() + 7 * w);
    const mondayStr = future.toISOString().slice(0, 10);

    const weeklyTargetTss = Math.round(weekResult.weekTss);

    progression.push({
      weekOffset: w,
      monday: mondayStr,
      weekType: weekResult.weekType,   // BUILD / MAINTAIN / DELOAD
      weeklyTargetTss,
      ctl: weekResult.nextCtl,
      atl: weekResult.nextAtl,
      ctlDelta: weekResult.ctlDelta,
      acwr: weekResult.acwr
    });

    ctl = weekResult.nextCtl;
    atl = weekResult.nextAtl;
  }

  return progression;
}

//----------------------------------------------------------
// DECOUPLING / GRUNDLAGE-ANALYSE über 28 Tage
//----------------------------------------------------------

function median(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * GA-Filter:
 * - HF-Daten vorhanden
 * - HFmax der Einheit ≤ 85 % der globalen HFmax
 * - Dauer:
 *    - Run ≥ 45 min
 *    - Ride ≥ 60 min
 *    - sonst ≥ 45 min
 */
function isGaSession(a, hrMaxGlobal) {
  if (!hrMaxGlobal || hrMaxGlobal <= 0) return false;

  const type = (a.type || "").toLowerCase();
  const hrAvg = a.average_heartrate ?? null;
  const hrMax = a.max_heartrate ?? null;

  if (!hrAvg || !hrMax) return false;

  const durationSec =
    a.moving_time ??
    a.elapsed_time ??
    a.icu_recording_time ??
    0;

  if (!durationSec || durationSec <= 0) return false;

  let minDuration = 45 * 60; // default 45 min
  if (type.includes("ride")) minDuration = 60 * 60; // Rad eher 60 min

  if (durationSec < minDuration) return false;

  const hfMaxLimit = 0.85 * hrMaxGlobal;
  if (hrMax > hfMaxLimit) return false;

  return true;
}

/**
 * Holt aus 28 Tagen die GA-Einheiten und ihre Decoupling-Werte (icu_cardiac_drift).
 */
function extractGaDecouplingStats(activities, hrMaxGlobal) {
  const decouplings = [];

  for (const a of activities) {
    if (!isGaSession(a, hrMaxGlobal)) continue;

    const driftRaw =
      typeof a.icu_cardiac_drift === "number"
        ? a.icu_cardiac_drift
        : (typeof a.cardiac_drift === "number"
            ? a.cardiac_drift
            : null);

    if (driftRaw == null || !isFinite(driftRaw)) continue;

    const drift = Math.abs(driftRaw);
    decouplings.push(drift);
  }

  const med = median(decouplings);
  return {
    medianDecoupling: med,
    count: decouplings.length
  };
}

/**
 * Phase aus Decoupling ableiten:
 *
 * < 5 %   -> "Spezifisch"
 * 5–8 %   -> "Aufbau"
 * >= 8 %  -> "Grundlage"
 *
 * Keine Daten -> konservativ "Grundlage".
 */
function decidePhaseFromDecoupling(medianDecoupling) {
  if (medianDecoupling == null) {
    return "Grundlage";
  }

  if (medianDecoupling < 0.05) {
    return "Spezifisch";
  }
  if (medianDecoupling < 0.08) {
    return "Aufbau";
  }
  return "Grundlage";
}

//----------------------------------------------------------
// MAIN HANDLER
//----------------------------------------------------------
// dryRun = true   => nur berechnen, NICHT schreiben
// dryRun = false  => berechnen und in Wellness schreiben
async function handle(dryRun = true) {
  try {
    const authHeader = "Basic " + btoa(`${API_KEY}:${API_SECRET}`);

    const today = new Date().toISOString().slice(0, 10);
    const todayObj = new Date(today + "T00:00:00Z");

    // Montag dieser Woche (UTC-basiert)
    const offset = (todayObj.getUTCDay() + 6) % 7;
    const monday = new Date(todayObj);
    monday.setUTCDate(monday.getUTCDate() - offset);
    const mondayStr = monday.toISOString().slice(0, 10);

    // Wellness für heute holen (aktuelles CTL/ATL/HRmax)
    const wRes = await fetch(
      `${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${today}`,
      { headers: { Authorization: authHeader } }
    );

    if (!wRes.ok) {
      console.error("Wellness fetch failed", wRes.status, wRes.statusText);
      return new Response("Error loading wellness", { status: 500 });
    }

    const well = await wRes.json();

    const ctl = well.ctl ?? 0;
    const atl = well.atl ?? 0;
    const hrMaxGlobal = well.hrMax ?? 173;

    // Activities der letzten 28 Tage holen (für Decoupling)
    const start28 = new Date(monday);
    start28.setUTCDate(start28.getUTCDate() - 28);
    const start28Str = start28.toISOString().slice(0, 10);

    const actRes = await fetch(
      `${BASE_URL}/athlete/${ATHLETE_ID}/activities?oldest=${start28Str}&newest=${today}`,
      { headers: { Authorization: authHeader } }
    );

    let activities = [];
    if (actRes.ok) {
      const raw = await actRes.json();
      if (Array.isArray(raw)) {
        activities = raw;
      } else if (raw && typeof raw === "object" && Array.isArray(raw.activities)) {
        activities = raw.activities;
      } else if (raw && typeof raw === "object") {
        activities = Object.values(raw);
      }
    } else {
      console.error("Activities fetch failed", actRes.status, actRes.statusText);
    }

    // Decoupling über GA-Sessions auswerten
    const decStats = extractGaDecouplingStats(activities, hrMaxGlobal);
    const phase = decidePhaseFromDecoupling(decStats.medianDecoupling);

    // Diese Woche berechnen (TSS-Ziel)
    const thisWeekPlan = calcNextWeekTarget(ctl, atl);
    const weeklyTargetTss = Math.round(thisWeekPlan.weekTss);

    // Folgewochen simulieren (Orientierung)
    const progression = simulateFutureWeeks(
      ctl,
      atl,
      monday,
      6,
      thisWeekPlan
    );

    // Am Montag: WochenzielTSS + Phase in Wellness schreiben
    if (!dryRun) {
      const body = {
        [WEEKLY_TARGET_FIELD]: weeklyTargetTss,
        [PLAN_FIELD]: phase
      };

      const putRes = await fetch(
        `${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${mondayStr}`,
        {
          method: "PUT",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        }
      );

      if (!putRes.ok) {
        console.error(
          "Failed to update wellness",
          putRes.status,
          putRes.statusText
        );
        return new Response("Error updating WochenzielTSS/Phase", { status: 500 });
      }
    }

    return new Response(
      JSON.stringify(
        {
          dryRun,
          thisWeek: {
            monday: mondayStr,
            ctl,
            atl,
            atlMax: getAtlMax(ctl),
            hrMaxGlobal,
            weekType: thisWeekPlan.weekType,  // BUILD / MAINTAIN / DELOAD
            weeklyTargetTss,
            ctlDelta: thisWeekPlan.ctlDelta,
            acwr: thisWeekPlan.acwr,
            phase,                             // Grundlage | Aufbau | Spezifisch
            decoupling: decStats
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
    // nur anschauen, nichts schreiben
    return handle(true);
  },
  async scheduled(event, env, ctx) {
    // z.B. Cron jeden Montag
    ctx.waitUntil(handle(false)); // berechnet & schreibt WochenzielTSS + Phase
  }
};

