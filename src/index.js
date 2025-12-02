const BASE_URL = "https://intervals.icu/api/v1";

// 🔥 Hardcoded Variablen – HIER deine Werte eintragen!
const INTERVALS_API_KEY = "1xg1v04ym957jsqva8720oo01";     // z.B. 1xg1v0...
const INTERVALS_ATHLETE_ID = "i105857";        // z.B. i104975
const INTERVALS_TARGET_FIELD = "TageszielTSS";               // numerisches Feld in Wellness
const INTERVALS_PLAN_FIELD = "WochenPlan";                   // Textfeld in Wellness
const WEEKLY_TARGET_FIELD = "WochenzielTSS";  
const DAILY_TYPE_FIELD = "TagesTyp";// numerisches Feld für Wochenziel

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
  baseMondayDate,
  weeksToSim,
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

  // Woche 0 = aktuelle Woche, deshalb starten wir bei 1
  for (let w = 1; w < weeksToSim; w++) {
    const dailyLoad = prevTarget / 7;

    // --- Simulation CTL/ATL über 7 Tage ---
    let ctl = ctlStart;
    let atl = atlStart;

    for (let d = 0; d < 7; d++) {
      ctl = ctl + (dailyLoad - ctl) / tauCtl;
      atl = atl + (dailyLoad - atl) / tauAtl;
    }

    const ctlEnd = ctl;
    const atlEnd = atl;
    const rampSim = ctlEnd - ctlStart;

    // --- Wochenzustand der simulierten Woche ---
    const { state: simState } = classifyWeek(ctlEnd, atlEnd, rampSim);

    // --- RampRate-Regler (Variante B) ---
    let nextTarget = prevTarget;

    if (simState === "Müde") {
      // Erholungswoche
      nextTarget = Math.round(prevTarget * 0.8);
    } else {
      if (rampSim < 0.5) {
        nextTarget = Math.round(prevTarget * 1.15); // +15%
      }
      else if (rampSim < 0.8) {
        nextTarget = Math.round(prevTarget * 1.10); // +10%
      }
      else if (rampSim <= 1.3) {
        nextTarget = Math.round(prevTarget * 1.05); // +5%
      }
      else if (rampSim <= 1.6) {
        nextTarget = Math.round(prevTarget * 0.92); // -8%
      }
      else {
        nextTarget = Math.round(prevTarget * 0.85); // -15%
      }
    }

    // --- Sicherstellen, dass keine zu großen Sprünge passieren ---
    // Härtere Caps
    const maxIncrease = prevTarget * 1.20;
    const minDecrease = prevTarget * 0.75;

    nextTarget = Math.max(minDecrease, Math.min(nextTarget, maxIncrease));

    // --- Datum des zukünftigen Montags berechnen ---
    const mondayFutureDate = new Date(baseMondayDate);
    mondayFutureDate.setUTCDate(mondayFutureDate.getUTCDate() + 7 * w);
    const mondayId = mondayFutureDate.toISOString().slice(0, 10);

    // --- WochenPlan für geplante Wochen ---
    const emoji = stateEmoji(simState);
    const planText = `Rest ${nextTarget} | ${emoji} ${simState} (geplant)`;

    const payloadFuture = {
      id: mondayId,
      [weeklyTargetField]: nextTarget,
      [planField]: planText
    };

    // --- Schreiben in Wellness ---
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

    // --- Vorbereitung für nächste Woche ---
    ctlStart = ctlEnd;
    atlStart = atlEnd;
    prevTarget = nextTarget;
    prevState = simState;
  }
}

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
  
}

// ---- Worker-Handler ------------------------------------------------

export default {
  async fetch(request) {
    const apiKey = INTERVALS_API_KEY;
    const athleteId = INTERVALS_ATHLETE_ID;
    const dailyField = INTERVALS_TARGET_FIELD;
    const planField = INTERVALS_PLAN_FIELD;
    const weeklyTargetField = WEEKLY_TARGET_FIELD;
    const dailyTypeField = DAILY_TYPE_FIELD;

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

      // Schlaf & HRV
      const sleepSecs = wellness.sleepSecs ?? null;
      const sleepScore = wellness.sleepScore ?? null;
      const hrv = wellness.hrv ?? null;
      const sleepHours = sleepSecs != null ? sleepSecs / 3600 : null;

      // --- 2) Basis-Tagesziel (ohne Schlaf/HRV) ---
      const dailyTargetBase = computeDailyTarget(ctl, atl);

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
        dailyMonTarget = dailyTargetBase;
      }

      // --- 4) Zustand der aktuellen Woche (Erholt/Normal/Müde) ---
      const { state: weekState } = classifyWeek(ctl, atl, rampRate);

      // Wochenfaktor bestimmen
      let factor = 7; // Normal
      if (weekState === "Erholt") factor = 8;
      if (weekState === "Müde") factor = 5.5;

      let weeklyTarget = Math.round(dailyMonTarget * factor);

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

      // --- 6) TagesTyp bestimmen & Tagesziel anpassen (Schlaf + HRV + Woche) ---
      let dayType = "Solide";
      let dayEmoji = "🟡";
      let dailyAdj = 1.0;

      let goodRecovery = false;
      let badRecovery = false;
      let veryBadRecovery = false;

      if (sleepScore != null && sleepScore >= 75) goodRecovery = true;
      if (sleepScore != null && sleepScore <= 60) badRecovery = true;
      if (sleepScore != null && sleepScore <= 50) veryBadRecovery = true;

      if (sleepHours != null && sleepHours >= 8) goodRecovery = true;
      if (sleepHours != null && sleepHours <= 6) badRecovery = true;
      if (sleepHours != null && sleepHours <= 5.5) veryBadRecovery = true;

      if (hrv != null && hrv >= 45) goodRecovery = true;
      if (hrv != null && hrv <= 40) badRecovery = true;
      if (hrv != null && hrv <= 37) veryBadRecovery = true;

      if (weekState === "Müde" || veryBadRecovery) {
        if (veryBadRecovery) {
          dayType = "Rest";
          dayEmoji = "⚪";
          dailyAdj = 0.4;
        } else {
          dayType = "Locker";
          dayEmoji = "🟢";
          dailyAdj = 0.7;
        }
      } else if (weekState === "Erholt" && goodRecovery) {
        dayType = "Schlüssel";
        dayEmoji = "🔴";
        dailyAdj = 1.1;
      } else if (badRecovery) {
        dayType = "Locker";
        dayEmoji = "🟢";
        dailyAdj = 0.8;
      } else {
        dayType = "Solide";
        dayEmoji = "🟡";
        dailyAdj = 1.0;
      }

      // Sicherheitskappe
      dailyAdj = Math.max(0.4, Math.min(1.2, dailyAdj));

      const dailyTarget = Math.round(dailyTargetBase * dailyAdj);

      // --- 7) WochenPlan-Text für HEUTE ---
      const emojiToday = stateEmoji(weekState);
      const planTextToday = `Rest ${weeklyRemaining} | ${emojiToday} ${weekState}`;

      // --- 8) Wellness für HEUTE updaten (Ist-Woche) ---
      const payloadToday = {
        id: today,
        [dailyField]: dailyTarget,        // TageszielTSS (adjusted)
        [planField]: planTextToday,       // WochenPlan (Rest + Emoji + Zustand)
        [weeklyTargetField]: weeklyTarget,// WochenzielTSS (volles Wochenziel)
        [dailyTypeField]: `${dayEmoji} ${dayType}` // TagesTyp
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

      // --- 9) Zukunfts-Wochen simulieren (aktuelle + x weitere Montage) ---
      const WEEKS_TO_SIMULATE = 4; // 0 = aktuelle Woche, 1-3 = Zukunft
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
        `OK: Tagesziel=${dailyTarget}, Wochenziel=${weeklyTarget}, TagesTyp="${dayEmoji} ${dayType}", WochenPlan="${planTextToday}"`,
        { status: 200 }
      );

    } catch (err) {
      return new Response("Unexpected error: " + err.toString(), {
        status: 500
      });
    }
  }
};
