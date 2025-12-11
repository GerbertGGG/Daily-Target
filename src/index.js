//----------------------------------------------------------
// CONFIG
//----------------------------------------------------------
const BASE_URL = "https://intervals.icu/api/v1";
const API_KEY = "API_KEY";     // später als Secret
const API_SECRET = "1xg1v04ym957jsqva8720oo01";  // später Secret
const ATHLETE_ID = "i105857";

const WEEKLY_TARGET_FIELD = "WochenzielTSS";

//----------------------------------------------------------
// CTL-/ATL-Logik (0.8 CTL/Woche + Deload)
//----------------------------------------------------------

// Ziel-Steigerung pro Woche: fixe Rampe +0.8 CTL/Woche
const CTL_DELTA_TARGET = 0.8;

// ACWR-Bereiche
// 0.8–1.3  = ideal
// 1.3–1.5  = erhöhtes Risiko
// >1.5     = hochriskant, Deload
const ACWR_SOFT_MAX = 1.3;
const ACWR_HARD_MAX = 1.5;

// Deload-Faktor: 90 % der Erhaltungsbelastung (~CTL)
const DELOAD_FACTOR = 0.9;

/**
 * ATL-Bänder in Abhängigkeit vom CTL (deine Tabelle)
 *
 * Einsteiger / Wiedereinsteiger / CTL < 30   -> ATL 25–45
 * Fortgeschritten / CTL 30–60               -> ATL 40–70
 * Ambitioniert / CTL 60–90                  -> ATL 60–95
 * Sehr fit / CTL 90–130                     -> ATL 80–140
 */
function getAtlBand(ctl) {
  if (ctl < 30) {
    return { minAtl: 25, maxAtl: 45 };
  } else if (ctl < 60) {
    return { minAtl: 40, maxAtl: 70 };
  } else if (ctl < 90) {
    return { minAtl: 60, maxAtl: 95 };
  } else {
    return { minAtl: 80, maxAtl: 140 };
  }
}

/**
 * Prüft, ob eine Entlastungswoche sinnvoll ist.
 *
 * Kriterien:
 *  1) ACWR >= 1.5  → immer Deload
 *  2) ATL > maxAtl (aus Band-Tabelle) → Deload
 */
function shouldDeload(ctl, atl) {
  if (ctl <= 0) return false;

  const acwr = atl / ctl;
  const { maxAtl } = getAtlBand(ctl);

  // 1) Extremfall: ACWR sehr hoch
  if (acwr >= ACWR_HARD_MAX) {
    return true;
  }

  // 2) ATL über oberem Band → absolut zu hoch
  if (atl > maxAtl) {
    return true;
  }

  return false;
}

/**
 * Max. CTL-Delta, damit ACWR nach der Woche im "grünen" Bereich bleibt.
 *
 *   ACWR_next = (CTL + 6d) / (CTL + d) <= ACWR_SOFT_MAX
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
 * Berechnet NUR die nächste Woche auf Basis des aktuellen CTL/ATL.
 * - Standardziel: +0.8 CTL/Woche
 * - begrenzt durch ACWR-Safety
 * - bei zu hohem ACWR oder ATL (absolut) → Deload
 */
function calcNextWeekTarget(ctl, atl) {
  // 1) Deload-Check
  if (shouldDeload(ctl, atl)) {
    return computeDeloadWeek(ctl, atl);
  }

  // 2) Aufbauwoche mit Zielrampe 0.8, begrenzt durch ACWR
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
 * Simuliert die folgenden Wochen NACH dieser Woche.
 * week0 = Ergebnis von calcNextWeekTarget() für die aktuelle Woche.
 */
function simulateFutureWeeks(ctlStart, atlStart, mondayDate, weeks, week0) {
  const progression = [];

  // Erst diese Woche "einschmelzen"
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

    // Diese Woche berechnen
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
    // Nur anschauen (dryRun = true)
    return handle(true);
  },
  async scheduled(event, env, ctx) {
    // Cron z.B. jeden Montag → berechnet + schreibt WochenzielTSS
    ctx.waitUntil(handle(false));
  }
};