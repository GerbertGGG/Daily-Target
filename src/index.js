//----------------------------------------------------------
// CONFIG
//----------------------------------------------------------
const BASE_URL = "https://intervals.icu/api/v1";
const API_KEY = "API_KEY";     // später als Secret
const API_SECRET = "1xg1v04ym957jsqva8720oo01";  // später Secret
const ATHLETE_ID = "i105857";

const WEEKLY_TARGET_FIELD = "WochenzielTSS";

//----------------------------------------------------------
// CTL-/ATL-Logik (0.8–1.3 CTL/Woche + Deload)
//----------------------------------------------------------

// Ziel-Steigerungen pro Woche
const CTL_DELTA_MIN = 0.8;
const CTL_DELTA_MAX = 1.3;

// ACWR-Bereiche
// 0.8–1.3  = ideal
// 1.3–1.5  = erhöhtes Risiko
// >1.5     = hochriskant, Deload
const ACWR_SOFT_MAX = 1.3;
const ACWR_HARD_MAX = 1.5;

// Deload-Faktor: 90 % der Erhaltungsbelastung (~CTL)
const DELOAD_FACTOR = 0.9;

/**
 * Liefert ATL-Grenzen in Abhängigkeit von CTL.
 * abgeleitet aus deiner Tabelle.
 */
function getAtlThresholds(ctl) {
  let softMaxAtl;
  let hardMaxAtl;

  if (ctl < 30) {
    // Einsteiger / Wiedereinsteiger
    softMaxAtl = Math.min(35, ctl + 10); // sicherer Deckel
    hardMaxAtl = Math.min(40, ctl + 15); // kurzzeitige Peaks
  } else if (ctl < 60) {
    // Fortgeschrittene
    softMaxAtl = Math.min(70, ctl + 15);
    hardMaxAtl = Math.min(80, ctl + 20);
  } else if (ctl < 90) {
    // Ambitioniert
    softMaxAtl = Math.min(95, ctl + 20);
    hardMaxAtl = Math.min(110, ctl + 25);
  } else {
    // Sehr fit
    softMaxAtl = Math.min(140, ctl + 25);
    hardMaxAtl = 140;
  }

  return { softMaxAtl, hardMaxAtl };
}

/**
 * Prüft, ob eine Entlastungswoche sinnvoll ist.
 *
 * Kriterien:
 *  1) ACWR >= 1.5  → immer Deload
 *  2) ATL > hardMaxAtl → Deload
 *  3) ACWR > 1.3 UND ATL > softMaxAtl → Deload
 */
function shouldDeload(ctl, atl) {
  if (ctl <= 0) return false;

  const acwr = atl / ctl;
  const { softMaxAtl, hardMaxAtl } = getAtlThresholds(ctl);

  if (acwr >= ACWR_HARD_MAX) return true;
  if (atl >= hardMaxAtl) return true;
  if (acwr > ACWR_SOFT_MAX && atl > softMaxAtl) return true;

  return false;
}

/**
 * Max. CTL-Delta, damit ACWR nach der Woche im "grünen" Bereich bleibt.
 *
 *   ACWR_next = (CTL + 6d) / (CTL + d) <= ACWR_SOFT_MAX
 *   => d_max = ((ACWR_SOFT_MAX - 1) / (6 - ACWR_SOFT_MAX)) * CTL
 */
function maxSafeCtlDelta(ctl) {
  if (ctl <= 0) return CTL_DELTA_MIN;
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
 * Berechnet NUR die nächste Woche auf Basis des aktuellen CTL/ATL.
 */
function calcNextWeekTarget(ctl, atl) {
  if (shouldDeload(ctl, atl)) {
    return computeDeloadWeek(ctl, atl);
  }

  const dMaxSafe = maxSafeCtlDelta(ctl);

  let targetDelta = Math.min(CTL_DELTA_MAX, dMaxSafe);

  if (dMaxSafe < CTL_DELTA_MIN) {
    targetDelta = dMaxSafe;
  } else if (targetDelta < CTL_DELTA_MIN) {
    targetDelta = CTL_DELTA_MIN;
  }

  if (!isFinite(targetDelta) || targetDelta <= 0) {
    targetDelta = 0; // Erhaltungswoche
  }

  return computeWeekFromCtlDelta(ctl, atl, targetDelta);
}

/**
 * Simuliert die folgenden Wochen NACH dieser Woche.
 * week0 = Ergebnis von calcNextWeekTarget() für die aktuelle Woche.
 *
 * progression[0] = nächste Woche (Montag + 7 Tage)
 */
function simulateFutureWeeks(ctlStart, atlStart, mondayDate, weeks, week0) {
  const progression = [];

  // Erst diese Woche "einschmelzen"
  let ctl = week0.nextCtl;
  let atl = week0.nextAtl;

  for (let w = 1; w <= weeks; w++) {
    const weekResult = calcNextWeekTarget(ctl, atl);

    // Montag dieser Zukunftswoche (ab nächster Woche)
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
// MAIN HANDLER
//----------------------------------------------------------
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

    // Wellness für heute holen (aktuelles CTL/ATL)
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

    // Diese Woche berechnen (BUILD / MAINTAIN / DELOAD)
    const thisWeekPlan = calcNextWeekTarget(ctl, atl);
    const weeklyTargetTss = Math.round(thisWeekPlan.weekTss);

    // Folgewochen simulieren (z.B. 6 Wochen)
    const progression = simulateFutureWeeks(
      ctl,
      atl,
      monday,
      6,
      thisWeekPlan
    );

    // In WochenzielTSS für Montag dieser Woche schreiben
    if (!dryRun) {
      const putRes = await fetch(
        `${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${mondayStr}`,
        {
          method: "PUT",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            [WEEKLY_TARGET_FIELD]: weeklyTargetTss
          })
        }
      );

      if (!putRes.ok) {
        console.error(
          "Failed to update wellness",
          putRes.status,
          putRes.statusText
        );
        return new Response("Error updating WochenzielTSS", { status: 500 });
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
            weekType: thisWeekPlan.weekType,  // BUILD / MAINTAIN / DELOAD
            weeklyTargetTss,
            ctlDelta: thisWeekPlan.ctlDelta,
            acwr: thisWeekPlan.acwr
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
    return handle(true);  // nur berechnen, nichts schreiben
  },
  async scheduled(event, env, ctx) {
    // in Cloudflare Cron z.B. "Montag 06:00"
    ctx.waitUntil(handle(false)); // berechnen + WochenzielTSS setzen
  }
};
