//----------------------------------------------------------
// CONFIG
//----------------------------------------------------------
const BASE_URL = "https://intervals.icu/api/v1";
const API_KEY = "API_KEY";     // später als Secret
const API_SECRET = "1xg1v04ym957jsqva8720oo01";  // später Secret
const ATHLETE_ID = "i105857";

const WEEKLY_TARGET_FIELD = "WochenzielTSS";

//----------------------------------------------------------
// CTL-/ATL-Forecast & Weekly Target (0.8–1.3 CTL/Woche + Deload)
//----------------------------------------------------------

// Ziel-Steigerungen pro Woche
const CTL_DELTA_MIN = 0.8;
const CTL_DELTA_MAX = 1.3;

// ACWR-Limit-Interpretation
// 0.8–1.3  = ideal
// 1.3–1.5  = erhöhtes Risiko
// >1.5     = hochriskant, Deload
const ACWR_SOFT_MAX = 1.3;
const ACWR_HARD_MAX = 1.5;

// Deload-Faktor: 90 % der Erhaltungsbelastung (~CTL)
const DELOAD_FACTOR = 0.9;

/**
 * Liefert ATL-Grenzen in Abhängigkeit von CTL.
 * Nutzt deine Tabelle:
 *
 * CTL < 30:  ATL 25–45   | Obergrenze grob CTL+10, bei dir konkret ~35–40
 * 30–60:     ATL 40–70   | Obergrenze CTL+15
 * 60–90:     ATL 60–95   | Obergrenze CTL+20
 * 90–130:    ATL 80–140  | Obergrenze CTL+25
 *
 * Wir unterscheiden:
 *  - softMaxAtl: darüber wird es "heiß" in Kombi mit hohem ACWR
 *  - hardMaxAtl: absolute Obergrenze = klare Deload-Indikation
 */
function getAtlThresholds(ctl) {
  let softMaxAtl;
  let hardMaxAtl;

  if (ctl < 30) {
    // Einsteiger / Wiedereinsteiger
    // für dich: CTL ~21 → safe 20–35, Peak ~40
    softMaxAtl = Math.min(35, ctl + 10); // "sicherer" Deckel
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
 *  1) ACWR > 1.5  → immer Deload
 *  2) ATL > hardMaxAtl → Deload
 *  3) ACWR > 1.3 UND ATL > softMaxAtl → Deload
 *
 * Damit mapst du exakt auf deine Beschreibung:
 *  - ACWR 0.8–1.3 = ok
 *  - >1.4–1.5 plus hohe ATL = hohes Risiko
 *  - >1.6 oder ATL weit über Obergrenze = klar Deload
 */
function shouldDeload(ctl, atl) {
  if (ctl <= 0) return false;

  const acwr = atl / ctl;
  const { softMaxAtl, hardMaxAtl } = getAtlThresholds(ctl);

  // 1) Extremfall: ACWR sehr hoch
  if (acwr >= ACWR_HARD_MAX) {
    return true;
  }

  // 2) ATL deutlich über absoluter Obergrenze
  if (atl >= hardMaxAtl) {
    return true;
  }

  // 3) Kombination aus leicht erhöhtem ACWR + zu hoher ATL
  if (acwr > ACWR_SOFT_MAX && atl > softMaxAtl) {
    return true;
  }

  return false;
}

/**
 * Max. CTL-Delta, damit ACWR (ATL/CTL) nach der Woche im "grünen" Bereich bleibt.
 *
 * Modell:
 *   ΔCTL ≈ (TSS_mean - CTL) / 6
 *   TSS_mean = CTL + 6d
 *   ATL_next ≈ TSS_mean
 *   CTL_next = CTL + d
 *   ACWR_next = ATL_next / CTL_next = (CTL + 6d) / (CTL + d)
 *
 *   (CTL + 6d) / (CTL + d) <= ACWR_SOFT_MAX
 *   => d_max = ((ACWR_SOFT_MAX - 1) / (6 - ACWR_SOFT_MAX)) * CTL
 */
function maxSafeCtlDelta(ctl) {
  if (ctl <= 0) return CTL_DELTA_MIN;
  const numerator = (ACWR_SOFT_MAX - 1) * ctl; // z.B. 0.3 * CTL
  const denominator = 6 - ACWR_SOFT_MAX;       // z.B. 4.7
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
 * Berechnet NUR die nächste Woche auf Basis des aktuellen CTL/ATL.
 * - Entweder Deload oder Aufbau mit 0.8–1.3 CTL (+ ACWR-Limit).
 * - Deload wird über deine ACWR-/ATL-Regeln entschieden.
 */
function calcNextWeekTarget(ctl, atl) {
  if (shouldDeload(ctl, atl)) {
    return computeDeloadWeek(ctl, atl);
  }

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

  return computeWeekFromCtlDelta(ctl, atl, targetDelta);
}

//----------------------------------------------------------
// MAIN HANDLER
//----------------------------------------------------------
// dryRun = true   => nur berechnen, NICHT schreiben
// dryRun = false  => berechnen und in WochenzielTSS schreiben
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

    // Nächste Woche berechnen (BUILD / MAINTAIN / DELOAD)
    const week = calcNextWeekTarget(ctl, atl);
    const weeklyTargetTss = Math.round(week.weekTss);

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

    // Antwort nur zur Kontrolle
    return new Response(
      JSON.stringify(
        {
          dryRun,
          monday: mondayStr,
          ctl,
          atl,
          result: {
            weekType: week.weekType,       // BUILD / MAINTAIN / DELOAD
            weeklyTargetTss,
            ctlDelta: week.ctlDelta,
            acwr: week.acwr
          }
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
// GET-Aufruf: nur anschauen (dryRun = true)
// Scheduled-Cron (z.B. jeden Montag): schreibt WochenzielTSS (dryRun = false)
export default {
  async fetch(request, env, ctx) {
    return handle(true);  // nur berechnen, nichts schreiben
  },
  async scheduled(event, env, ctx) {
    // hier stellst du in Cloudflare Cron auf "jeden Montag" ein
    ctx.waitUntil(handle(false)); // berechnen + WochenzielTSS setzen
  }
};
