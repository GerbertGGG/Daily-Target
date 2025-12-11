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
// Hilfsfunktionen allgemein
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

//----------------------------------------------------------
// RUN-DECOUPLING (Pa:Hr) für Phasenlogik
//----------------------------------------------------------

/**
 * Prüft, ob eine Einheit ein GA-Run für Decoupling ist:
 * - type === "Run"
 * - Dauer >= 45 min
 * - HRavg ca. 70–78 % HFmax
 * - HRmax <= 85 % HFmax
 * - Name nicht offensichtlich HIT/Intervall
 */
function isGaRunForDecoupling(a, hrMaxGlobal) {
  const type = (a.type || "").toLowerCase();
  if (!type.includes("run")) return false;

  const hrAvg = a.average_heartrate ?? null;
  const hrMax = a.max_heartrate ?? null;
  if (!hrAvg || !hrMax) return false;

  const durationSec =
    a.moving_time ??
    a.elapsed_time ??
    a.icu_recording_time ??
    0;
  if (!durationSec || durationSec < 45 * 60) return false; // mind. 45 min

  const athleteMax = a.athlete_max_hr ?? hrMaxGlobal ?? null;
  if (!athleteMax || athleteMax <= 0) return false;

  const relAvg = hrAvg / athleteMax;
  const relMax = hrMax / athleteMax;

  // Ziel: knapp unter LT1 / Zone2 → ca. 70–78 % HFmax
  if (relAvg < 0.70 || relAvg > 0.78) return false;

  // Keine Peaks tief in den Schwellen-/VO2-Bereich
  if (relMax > 0.85) return false;

  const name = (a.name || "").toLowerCase();
  if (/hit|intervall|interval|schwelle|vo2|max|berg|30s|30\/15|15\/15/i.test(name)) {
    return false;
  }

  return true;
}

/**
 * Holt den Pa:Hr-Decoupling-Wert für Lauf:
 * - pahr_decoupling (Hauptfeld)
 * - evtl. pa_hr_decoupling als Fallback
 * Rückgabe als Bruchteil (0.05 = 5%).
 */
function findRunDecoupling(a) {
  const candidates = [
    "pahr_decoupling",
    "pa_hr_decoupling"
  ];

  for (const key of candidates) {
    const v = a[key];
    if (typeof v === "number" && isFinite(v)) {
      let abs = Math.abs(v);
      // Intervals kann 5.3 für 5.3% liefern → in Bruchteil umwandeln
      if (abs > 1) abs = abs / 100;
      return abs;
    }
  }

  return null;
}

/**
 * Run-Decoupling-Stats für die letzten 28 Tage:
 * - medianDrift: Median über alle GA-Run-Drifts
 * - count: Anzahl Runs mit Drift
 * - gaCount: Anzahl GA-Runs (nach Filter)
 * - gaWithDrift: Anzahl GA-Runs mit gültigem Drift
 */
function extractRunDecouplingStats(activities, hrMaxGlobal) {
  const drifts = [];
  let gaCount = 0;
  let gaWithDrift = 0;

  for (const a of activities) {
    if (!isGaRunForDecoupling(a, hrMaxGlobal)) continue;
    gaCount++;

    const drift = findRunDecoupling(a);
    if (drift == null) continue;

    gaWithDrift++;
    drifts.push(drift);
  }

  const med = median(drifts);

  return {
    medianDrift: med,
    count: drifts.length,
    gaCount,
    gaWithDrift
  };
}

/**
 * Phase aus Run-Decoupling ableiten:
 *
 * medianDrift > 7%   -> "Grundlage"
 * 4–7%               -> "Aufbau"
 * < 4%               -> "Spezifisch"
 *
 * Keine Daten -> konservativ "Grundlage".
 */
function decidePhaseFromRunDecoupling(medianDrift) {
  if (medianDrift == null) return "Grundlage";

  if (medianDrift > 0.07) {
    return "Grundlage";
  }
  if (medianDrift > 0.04) {
    return "Aufbau";
  }
  return "Spezifisch";
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
    const hrMaxGlobal = well.hrMax ?? well.max_hr ?? 173;

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

    // Run-Decoupling-Stats aus 28 Tagen
    const decStats = extractRunDecouplingStats(activities, hrMaxGlobal);
    const phase = decidePhaseFromRunDecoupling(decStats.medianDrift);

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
            runDecoupling: {
              ...decStats,
              // zur Kontrolle: Median als Prozent
              medianDriftPercent: decStats.medianDrift != null
                ? decStats.medianDrift * 100
                : null,
              totalActivities: activities.length
            }
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
