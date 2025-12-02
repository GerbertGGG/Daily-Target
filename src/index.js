const BASE_URL = "https://intervals.icu/api/v1";

// 🔥 Hardcoded Variablen – HIER deine Werte eintragen!
const INTERVALS_API_KEY = "1xg1v04ym957jsqva8720oo01";     // z.B. 1xg1v0...
const INTERVALS_ATHLETE_ID = "i105857";        // z.B. i104975
const INTERVALS_TARGET_FIELD = "TageszielTSS";               // numerisches Feld in Wellness
const INTERVALS_PLAN_FIELD = "WochenPlan";                   // Textfeld in Wellness
const WEEKLY_TARGET_FIELD = "WochenzielTSS";                 // numerisches Feld für Wochenziel

function computeDailyTarget(ctl, atl) {
  const base = 1.0;
  const k = 0.05;
  const tsb = ctl - atl;
  const tsbClamped = Math.max(-20, Math.min(20, tsb));

  let dailyTss = ctl * (base + k * tsbClamped);
  dailyTss = Math.max(0, Math.min(dailyTss, ctl * 1.5));

  return Math.round(dailyTss);
}

// Wochenzustand klassifizieren: Erholt / Normal / Müde
function classifyWeek(ctl, atl, rampRate) {
  const tsb = ctl - atl;
  let state = "Normal"; // Standard

  // Erholt: RampRate eher < 0, TSB nicht zu negativ
  if (rampRate <= -0.5 && tsb >= -5) {
    state = "Erholt";
  }
  // Müde: RampRate > 0 oder sehr negative TSB oder ATL deutlich über CTL
  else if (rampRate >= 1.0 || tsb <= -10 || atl > ctl + 5) {
    state = "Müde";
  }

  return { state, tsb };
}

// Emoji zu Zustand
function stateEmoji(state) {
  if (state === "Erholt") return "🔥";
  if (state === "Müde") return "🧘";
  return "⚖️"; // Normal
}

/**
 * Zukunftswochen simulieren:
 * - Startet bei CTL/ATL am Montag dieser Woche
 * - Woche 0 = aktuelle Woche (weeklyTarget0, weekState0)
 * - Für jede weitere Woche:
 *    - CTL/ATL der Vorwoche simulieren (mit weeklyTargetPrev)
 *    - Zustand klassifizieren
 *    - falls nicht Müde -> +5% Wochenziel
 *    - falls Müde       -> -20% Wochenziel
 *    - geplantes Wochenziel + WochenPlan in Wellness schreiben
 */
async function simulatePlannedWeeks(
  ctlMon0,
  atlMon0,
  weekState0,
  weeklyTarget0,
  baseMondayDate,      // Date-Objekt, Montag dieser Woche (Start)
  weeksToSim,          // z.B. 4 -> aktuelle Woche + 3 Zukunft
  authHeader,
  athleteId,
  planField,
  weeklyTargetField
) {
  const tauCtl = 42;
  const tauAtl = 7;

  // Startwerte am Montag dieser Woche
  let ctlStart = ctlMon0;
  let atlStart = atlMon0;

  let prevTarget = weeklyTarget0;
  let prevState = weekState0;

  // Wir simulieren ab Woche 1 (Woche 0 = aktuelle Woche)
  for (let w = 1; w < weeksToSim; w++) {
    // 1) CTL/ATL der Vorwoche simulieren, wenn man prevTarget trifft
    const dailyLoad = prevTarget / 7;
    let ctl = ctlStart;
    let atl = atlStart;

    for (let d = 0; d < 7; d++) {
      ctl = ctl + (dailyLoad - ctl) / tauCtl;
      atl = atl + (dailyLoad - atl) / tauAtl;
    }

    const ctlEnd = ctl;
    const atlEnd = atl;
    const rampRateSim = ctlEnd - ctlStart;

    // 2) Zustand aus Simulation bestimmen
    const { state: simState } = classifyWeek(ctlEnd, atlEnd, rampRateSim);

    // 3) Neues Wochenziel: je nach Zustand hoch oder runter
    let nextState = simState;
    let nextTarget;

    if (simState === "Müde") {
      // Müde -> Erholungswoche: -20 %
      nextTarget = Math.max(0, Math.round(prevTarget * 0.8));
    } else {
      // Nicht müde (Erholt oder Normal) -> +5 % Progression
      nextTarget = Math.max(0, Math.round(prevTarget * 1.05));
    }

    // 4) Datum des zukünftigen Montags
    const mondayFutureDate = new Date(baseMondayDate);
    mondayFutureDate.setUTCDate(mondayFutureDate.getUTCDate() + 7 * w);
    const mondayId = mondayFutureDate.toISOString().slice(0, 10);

    // 5) In Wellness als „geplant“ eintragen
    const emoji = stateEmoji(nextState);
    const planText = `Rest ${nextTarget} | ${emoji} ${nextState} (geplant)`;

    const payloadFuture = {
      id: mondayId,
      [weeklyTargetField]: nextTarget,
      [planField]: planText
    };

    await fetch(
      `${BASE_URL}/athlete/${athleteId}/wellness/${mondayId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader
        },
        body: JSON.stringify(payloadFuture)
      }
    );

    // 6) Werte für nächste Schleife vorbereiten
    ctlStart = ctlEnd;
    atlStart = atlEnd;
    prevTarget = nextTarget;
    prevState = nextState;
  }
}

// ---- Worker-Handler ------------------------------------------------

export default {
  async fetch(request) {
    const apiKey = INTERVALS_API_KEY;
    const athleteId = INTERVALS_ATHLETE_ID;
    const dailyField = INTERVALS_TARGET_FIELD;
    const planField = INTERVALS_PLAN_FIELD;
    const weeklyTargetField = WEEKLY_TARGET_FIELD;

    if (!apiKey || !athleteId) {
      return new Response("Missing hardcoded config", { status: 500 });
    }

    const authHeader = "Basic " + btoa(`API_KEY:${apiKey}`);

    // Heutiges Datum (UTC)
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const todayDate = new Date(today + "T00:00:00Z");

    // Montag dieser Woche bestimmen
    const weekday = todayDate.getUTCDay(); // 0=So,1=Mo,...
    const offset = weekday === 0 ? 6 : weekday - 1;
    const mondayDate = new Date(todayDate);
    mondayDate.setUTCDate(mondayDate.getUTCDate() - offset);
    const mondayStr = mondayDate.toISOString().slice(0, 10);

    try {
      // --- 1) Wellness HEUTE holen ---
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

      if (ctl == null || atl == null) {
        return new Response("No ctl/atl data", { status: 200 });
      }

      // --- 2) Tagesziel (heute) berechnen ---
      const dailyTarget = computeDailyTarget(ctl, atl);

      // --- 3) Montag-Wellness holen für Wochenbasis ---
      const mondayWellnessRes = await fetch(
        `${BASE_URL}/athlete/${athleteId}/wellness/${mondayStr}`,
        { headers: { Authorization: authHeader } }
      );

      let ctlMon;
      let atlMon;
      let dailyMonTarget;

      if (mondayWellnessRes.ok) {
        const mon = await mondayWellnessRes.json();
        ctlMon = mon.ctl ?? ctl;
        atlMon = mon.atl ?? atl;
        dailyMonTarget = computeDailyTarget(ctlMon, atlMon);
      } else {
        // Fallback: heutige Werte nehmen
        ctlMon = ctl;
        atlMon = atl;
        dailyMonTarget = dailyTarget;
      }

      // --- 4) Zustand der aktuellen Woche (Erholt/Normal/Müde) ---
      const { state: weekState } = classifyWeek(ctl, atl, rampRate);

// Basis-Faktor je nach Zustand
let factor = 7; // Normal
if (weekState === "Erholt") factor = 8;
if (weekState === "Müde") factor = 5.5;

// Basis-Wochenziel aus Montag
let weeklyTarget = dailyMonTarget * factor;

// 🎯 Ramp-Ziel: ca. 1.0 CTL/Woche (zwischen 0.8 und 1.3)
const targetRampMid = 1.0;

// Nur wenn du NICHT müde bist, drehen wir an der Stellschraube
if (weekState !== "Müde") {
  // positive rampError = zu flach -> mehr Load
  const rampError = targetRampMid - rampRate;

  // Verstärkung: 0.1  -> bei rampRate 0.3 ~ +7%
  let adjust = 1 + rampError * 0.1;

  // Sicherheits-Caps: max +15%, min -10%
  adjust = Math.max(0.9, Math.min(1.15, adjust));

  weeklyTarget = weeklyTarget * adjust;
}

// final runden
weeklyTarget = Math.round(Math.max(0, weeklyTarget));

      // --- 5) Bisherige Wochen-Load (Montag–heute) summieren (ctlLoad) ---
      let weekLoad = 0;

      const weekRes = await fetch(
        `${BASE_URL}/athlete/${athleteId}/wellness?oldest=${mondayStr}&newest=${today}&cols=id,ctlLoad`,
        { headers: { Authorization: authHeader } }
      );

      if (weekRes.ok) {
        const weekArr = await weekRes.json();
        for (const day of weekArr) {
          if (day.ctlLoad != null) weekLoad += day.ctlLoad;
        }
      }

      const weeklyRemaining = Math.max(
        0,
        Math.round(weeklyTarget - weekLoad)
      );

      // --- 6) WochenPlan-Text für HEUTE ---
      const emojiToday = stateEmoji(weekState);
      const planTextToday = `Rest ${weeklyRemaining} | ${emojiToday} ${weekState}`;

      // --- 7) Wellness für HEUTE updaten (Ist-Woche) ---
      const payloadToday = {
        id: today,
        [dailyField]: dailyTarget,        // TageszielTSS
        [planField]: planTextToday,       // WochenPlan (Rest + Emoji + Zustand)
        [weeklyTargetField]: weeklyTarget // WochenzielTSS (volles Wochenziel)
      };

      const updateRes = await fetch(
        `${BASE_URL}/athlete/${athleteId}/wellness/${today}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: authHeader
          },
          body: JSON.stringify(payloadToday)
        }
      );

      if (!updateRes.ok) {
        const text = await updateRes.text();
        return new Response(
          `Failed to update wellness: ${updateRes.status} ${text}`,
          { status: 500 }
        );
      }

      // --- 8) Zukunfts-Wochen simulieren (aktuelle + 3 weitere Montage) ---
      const WEEKS_TO_SIMULATE = 9; // 0 = aktuelle Woche, 1-3 = Zukunft
      await simulatePlannedWeeks(
        ctlMon,
        atlMon,
        weekState,
        weeklyTarget,
        mondayDate,
        WEEKS_TO_SIMULATE,
        authHeader,
        athleteId,
        planField,
        weeklyTargetField
      );

      return new Response(
        `OK: Tagesziel=${dailyTarget}, Wochenziel=${weeklyTarget}, WochenPlan="${planTextToday}"`,
        { status: 200 }
      );

    } catch (err) {
      return new Response("Unexpected error: " + err.toString(), {
        status: 500
      });
    }
  }
};
