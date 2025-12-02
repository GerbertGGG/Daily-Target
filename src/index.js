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
  return Math.round(Math.max(0, Math.min(dailyTss, ctl * 1.5)));
}

// Wochenzustand
function classifyWeek(ctl, atl, rampRate) {
  const tsb = ctl - atl;

  if (rampRate <= -0.5 && tsb >= -5) return { state: "Erholt", tsb };
  if (rampRate >= 1.0 || tsb <= -10 || atl > ctl + 5) return { state: "Müde", tsb };
  return { state: "Normal", tsb };
}

// Emojis
function stateEmoji(state) {
  if (state === "Erholt") return "🔥";
  if (state === "Müde") return "🧘";
  return "⚖️";
}

// ---------------------------------------------------------
// ZUKUNFTS-WOCHEN SIMULATION
// Regeln: RampRate 0.8–1.3 anstreben, Variante B
// ---------------------------------------------------------

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

  let ctlStart = ctlMon0;
  let atlStart = atlMon0;
  let prevTarget = weeklyTarget0;
  let prevState = weekState0;

  for (let w = 1; w < weeksToSim; w++) {

    const dailyLoad = prevTarget / 7;
    let ctl = ctlStart;
    let atl = atlStart;

    // CTL/ATL Simulation
    for (let d = 0; d < 7; d++) {
      ctl = ctl + (dailyLoad - ctl) / tauCtl;
      atl = atl + (dailyLoad - atl) / tauAtl;
    }

    const ctlEnd = ctl;
    const atlEnd = atl;
    const rampSim = ctlEnd - ctlStart;

    const { state: simState } = classifyWeek(ctlEnd, atlEnd, rampSim);

    // RampRate-Regler
    let nextTarget;

    if (simState === "Müde") {
      nextTarget = Math.round(prevTarget * 0.8);      // Erholungswoche
    } else {
      if (rampSim < 0.5) nextTarget = Math.round(prevTarget * 1.15);
      else if (rampSim < 0.8) nextTarget = Math.round(prevTarget * 1.10);
      else if (rampSim <= 1.3) nextTarget = Math.round(prevTarget * 1.05);
      else if (rampSim <= 1.6) nextTarget = Math.round(prevTarget * 0.92);
      else nextTarget = Math.round(prevTarget * 0.85);
    }

    // Sicherheit: max +20%, min –25%
    const maxIncrease = prevTarget * 1.20;
    const minDecrease = prevTarget * 0.75;
    nextTarget = Math.max(minDecrease, Math.min(nextTarget, maxIncrease));

    // Zukünftigen Montag berechnen
    const mondayFutureDate = new Date(baseMondayDate);
    mondayFutureDate.setUTCDate(mondayFutureDate.getUTCDate() + 7 * w);
    const mondayId = mondayFutureDate.toISOString().slice(0, 10);

    const emoji = stateEmoji(simState);
    const planText = `Rest ${nextTarget} | ${emoji} ${simState} (geplant)`;

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

    ctlStart = ctlEnd;
    atlStart = atlEnd;
    prevTarget = nextTarget;
    prevState = simState;
  }
}

// ---------------------------------------------------------
// WORKER-HANDLER (Hauptlogik)
// ---------------------------------------------------------

export default {
  async fetch(request) {

    const apiKey = INTERVALS_API_KEY;
    const athleteId = INTERVALS_ATHLETE_ID;

    if (!apiKey || !athleteId) {
      return new Response("Missing config", { status: 500 });
    }

    const authHeader = "Basic " + btoa(`API_KEY:${apiKey}`);

    // Datum heute
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const todayDate = new Date(today + "T00:00:00Z");

    // Montag berechnen
    const weekday = todayDate.getUTCDay();
    const offset = weekday === 0 ? 6 : weekday - 1;
    const mondayDate = new Date(todayDate);
    mondayDate.setUTCDate(mondayDate.getUTCDate() - offset);
    const mondayStr = mondayDate.toISOString().slice(0, 10);

    // -----------------------------------------------------
    // 1) Wellness heute holen
    // -----------------------------------------------------
    const wellnessRes = await fetch(
      `${BASE_URL}/athlete/${athleteId}/wellness/${today}`,
      { headers: { Authorization: authHeader } }
    );

    if (!wellnessRes.ok) {
      return new Response("Wellness fetch failed", { status: 500 });
    }

    const wellness = await wellnessRes.json();
    const ctl = wellness.ctl;
    const atl = wellness.atl;
    const rampRate = wellness.rampRate ?? 0;

    if (ctl == null || atl == null) {
      return new Response("No ctl/atl", { status: 200 });
    }

    // Tagesziel vor Adjust
    const dailyTargetBase = computeDailyTarget(ctl, atl);

    // Schlaf & HRV
    const sleepSecs = wellness.sleepSecs ?? null;
    const sleepScore = wellness.sleepScore ?? null;
    const hrv = wellness.hrv ?? null;
    const sleepHours = sleepSecs != null ? sleepSecs / 3600 : null;

    // -----------------------------------------------------
    // 2) Montag-Werte holen
    // -----------------------------------------------------
    const mondayWellnessRes = await fetch(
      `${BASE_URL}/athlete/${athleteId}/wellness/${mondayStr}`,
      { headers: { Authorization: authHeader } }
    );

    let ctlMon, atlMon;
    if (mondayWellnessRes.ok) {
      const mon = await mondayWellnessRes.json();
      ctlMon = mon.ctl ?? ctl;
      atlMon = mon.atl ?? atl;
    } else {
      ctlMon = ctl;
      atlMon = atl;
    }

    // -----------------------------------------------------
    // 3) Wochenmodus bestimmen
    // -----------------------------------------------------
    const { state: weekState } = classifyWeek(ctl, atl, rampRate);

    let factor = 7; // Normal
    if (weekState === "Erholt") factor = 8;
    if (weekState === "Müde") factor = 5.5;

    let weeklyTarget = Math.round(computeDailyTarget(ctlMon, atlMon) * factor);

    // -----------------------------------------------------
    // 4) WochenRest berechnen
    // -----------------------------------------------------
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

    const weeklyRemaining = Math.max(0, Math.round(weeklyTarget - weekLoad));

    // -----------------------------------------------------
    // 5) TagesTyp bestimmen & Tagesziel anpassen
    // -----------------------------------------------------
    let dayType = "Solide";
    let dayEmoji = "🟡";
    let dailyAdj = 1.0;

    let goodRecovery = false;
    let badRecovery = false;
    let veryBadRecovery = false;

    // Schlafscore Regeln
    if (sleepScore != null && sleepScore >= 75) goodRecovery = true;
    if (sleepScore != null && sleepScore <= 60) badRecovery = true;
    if (sleepScore != null && sleepScore <= 50) veryBadRecovery = true;

    // Schlafstunden
    if (sleepHours != null && sleepHours >= 8) goodRecovery = true;
    if (sleepHours != null && sleepHours <= 6) badRecovery = true;
    if (sleepHours != null && sleepHours <= 5.5) veryBadRecovery = true;

    // HRV-Regeln
    if (hrv != null && hrv >= 42) goodRecovery = true;
    if (hrv != null && hrv <= 35) badRecovery = true;
    if (hrv != null && hrv <= 30) veryBadRecovery = true;

    if (weekState === "Müde" || veryBadRecovery) {
      dayType = "Rest";
      dayEmoji = "⚪";
      dailyAdj = 0.4;
    } 
    else if (goodRecovery && weekState === "Erholt") {
      dayType = "Schlüssel";
      dayEmoji = "🔴";
      dailyAdj = 1.1;
    } 
    else if (badRecovery) {
      dayType = "Locker";
      dayEmoji = "🟢";
      dailyAdj = 0.8;
    } 
    else {
      dayType = "Solide";
      dayEmoji = "🟡";
      dailyAdj = 1.0;
    }

    dailyAdj = Math.max(0.4, Math.min(1.2, dailyAdj));
    const dailyTarget = Math.round(dailyTargetBase * dailyAdj);

    // -----------------------------------------------------
    // 6) WochenPlan erzeugen
    // -----------------------------------------------------
    const emojiToday = stateEmoji(weekState);
    const planTextToday = `Rest ${weeklyRemaining} | ${emojiToday} ${weekState}`;

    // -----------------------------------------------------
    // 7) Heute updaten
    // -----------------------------------------------------
    const payloadToday = {
      id: today,
      [INTERVALS_TARGET_FIELD]: dailyTarget,
      [INTERVALS_PLAN_FIELD]: planTextToday,
      [WEEKLY_TARGET_FIELD]: weeklyTarget,
      [DAILY_TYPE_FIELD]: `${dayEmoji} ${dayType}`
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
      return new Response("Update failed", { status: 500 });
    }

    // -----------------------------------------------------
    // 8) Zukunft für 6 Wochen simulieren
    // -----------------------------------------------------
    const WEEKS_TO_SIMULATE = 7; // Woche 0 + 6 zukünftige Montage

    await simulatePlannedWeeks(
      ctlMon,
      atlMon,
      weekState,
      weeklyTarget,
      mondayDate,
      WEEKS_TO_SIMULATE,
      authHeader,
      athleteId,
      INTERVALS_PLAN_FIELD,
      WEEKLY_TARGET_FIELD
    );

    return new Response(
      `OK: Tagesziel=${dailyTarget}, Wochenziel=${weeklyTarget}`,
      { status: 200 }
    );
  }
};
