//----------------------------------------------------------
// CONFIG
//----------------------------------------------------------
const BASE_URL = "https://intervals.icu/api/v1";
const API_KEY = "API_KEY";     // später als Secret
const API_SECRET = "1xg1v04ym957jsqva8720oo01";  // später Secret
const ATHLETE_ID = "i105857";

const WEEKLY_TARGET_FIELD = "WochenzielTSS";

//----------------------------------------------------------
// CTL-/ATL-Logik (0.8 CTL/Woche + intelligente Deloads)
//----------------------------------------------------------

// Ziel-Steigerung pro Woche: fixe Rampe +0.8 CTL/Woche
const CTL_DELTA_TARGET = 0.8;

// ACWR-Bereiche
// 0.8–1.3  = ideal (für maxSafeCtlDelta)
// 1.3–1.5  = erhöhtes Risiko
// >1.5     = hochriskant, Deload
const ACWR_SOFT_MAX = 1.3;
const ACWR_HARD_MAX = 1.5;

/**
 * Absolute ATL-Obergrenze in Abhängigkeit vom CTL.
 *
 * Einsteiger / Wiedereinsteiger / CTL < 30   -> ATL max 30
 * Fortgeschritten / CTL 30–60               -> ATL max 45
 * Ambitioniert / CTL 60–90                  -> ATL max 60
 * Sehr fit / CTL 90–130                     -> ATL max 80
 */
function getAtlMax(ctl) {
  if (ctl < 30) {
    return 30;
  } else if (ctl < 60) {
    return 45;
  } else if (ctl < 90) {
    return 60;
  } else if (ctl < 130) {
    return 80;
  } else {
    return 80;
  }
}

/**
 * Prüft, ob eine Deload-Woche nötig ist für ein gegebenes CTL/ATL-Paar.
 *
 * Kann sowohl für die aktuelle Woche (Ist-Zustand) als auch
 * für die geplante nächste Woche (Simulationszustand) verwendet werden.
 *
 * Kriterien:
 *  1) ACWR >= 1.5  → immer Deload
 *  2) ATL > ATL-Max (aus Tabelle) → Deload
 */
function shouldDeloadByFatigue(ctl, atl) {
  if (ctl <= 0) return false;

  const acwr = atl / ctl;
  const maxAtl = getAtlMax(ctl);

  if (acwr >= ACWR_HARD_MAX) {
    return true;
  }

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
 * Entlastungswoche (Deload):
 * - 20 % weniger TSS als eine "normale" Aufbauwoche (refWeekTss)
 */
function computeDeloadWeek(ctl, atl, refWeekTss) {
  const weekTss = refWeekTss * 0.8;      // 20% weniger TSS
  const tssMean = weekTss / 7;

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
 * Plant EINE Woche:
 * - Ziel: +0.8 CTL/Woche, begrenzt durch ACWR
 * - Intelligente Deload-Entscheidung:
 *   - Wenn aktuelles CTL/ATL "rot" ist → Deload
 *   - ODER wenn die geplante Build-Woche zu einem "roten" CTL/ATL führen würde
 *     (also ATL oder ACWR über Grenze) → Deload
 * - Sonst Build-/Maintain-Woche mit Zielrampe.
 */
function planWeek(ctl, atl) {
  // 1) Referenz-Aufbauwoche berechnen (ohne Deload-Check)
  const dMaxSafe = maxSafeCtlDelta(ctl);
  let targetDelta = CTL_DELTA_TARGET;

  if (!isFinite(dMaxSafe) || dMaxSafe <= 0) {
    targetDelta = 0; // ACWR erlaubt keine Steigerung → Erhaltungswoche
  } else if (dMaxSafe < targetDelta) {
    targetDelta = dMaxSafe; // durch ACWR limitiert
  }

  const refBuildWeek = computeWeekFromCtlDelta(ctl, atl, targetDelta);

  // 2) Deload-Check:
  //    a) auf Basis des IST-Zustands
  const fatigueDeloadNow = shouldDeloadByFatigue(ctl, atl);
  //    b) auf Basis der geplanten Woche (Ziel-Zustand)
  const fatigueDeloadFuture = shouldDeloadByFatigue(
    refBuildWeek.nextCtl,
    refBuildWeek.nextAtl
  );

  if (fatigueDeloadNow || fatigueDeloadFuture) {
    const deloadWeek = computeDeloadWeek(ctl, atl, refBuildWeek.weekTss);
    return deloadWeek;
  }

  // 3) Sonst normale Build-/Maintain-Woche
  return refBuildWeek;
}

/**
 * Simuliert die folgenden Wochen NACH dieser Woche.
 * thisWeekPlan = Ergebnis von planWeek() für die aktuelle Woche.
 */
function simulateFutureWeeks(
  ctlStart,
  atlStart,
  mondayDate,
  weeks,
  thisWeekPlan
) {
  const progression = [];

  // Erst diese Woche "einschmelzen"
  let ctl = thisWeekPlan.nextCtl;
  let atl = thisWeekPlan.nextAtl;

  for (let w = 1; w <= weeks; w++) {
    const weekResult = planWeek(ctl, atl);

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

    // Diese Woche planen (intelligent: BUILD / DELOAD / MAINTAIN)
    const thisWeekPlan = planWeek(ctl, atl);
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
            weekType: thisWeekPlan.weekType,  // BUILD / DELOAD / MAINTAIN
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