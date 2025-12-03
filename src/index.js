const BASE_URL = "https://intervals.icu/api/v1";

// 🔥 Hardcoded Variablen – HIER deine Werte eintragen!
const INTERVALS_API_KEY = "1xg1v04ym957jsqva8720oo01"; // z.B. 1xg1v0...
const INTERVALS_ATHLETE_ID = "i105857";                 // z.B. i104975
const INTERVALS_TARGET_FIELD = "TageszielTSS";          // numerisches Feld in Wellness
const INTERVALS_PLAN_FIELD = "WochenPlan";              // Textfeld in Wellness
const WEEKLY_TARGET_FIELD = "WochenzielTSS";            // numerisches Feld für Wochenziel
const DAILY_TYPE_FIELD = "TagesTyp";                    // Textfeld / Emoji-Feld für TagesTyp
const TRAINING_DAYS_PER_WEEK = 4.5;
// Taper-Konstanten (Variante C)
const TAPER_MIN_DAYS = 3;
const TAPER_MAX_DAYS = 21;
const TAPER_DAILY_START = 0.8;
const TAPER_DAILY_END = 0.3;

function computeDailyTarget(ctl, atl) {
  const base = 1.0;
  const k = 0.05;
  const tsb = ctl - atl;
  const tsbClamped = Math.max(-20, Math.min(20, tsb));
  let dailyTss = ctl * (base + k * tsbClamped);
  return Math.round(Math.max(0, Math.min(dailyTss, ctl * 1.5)));
}

function classifyWeek(ctl, atl, rampRate) {
  const tsb = ctl - atl;

  if (rampRate <= -0.5 && tsb >= -5) {
    return { state: "Erholt", tsb };
  }
  if (rampRate >= 1.0 || tsb <= -10 || atl > ctl + 5) {
    return { state: "Müde", tsb };
  }
  return { state: "Normal", tsb };
}

function stateEmoji(state) {
  if (state === "Erholt") return "🔥";
  if (state === "Müde") return "🧘";
  return "⚖️";
}

// Nächstes Event (RACE/TARGET oder erstes Event) holen
async function getNextEventDate(athleteId, authHeader, todayStr) {
  const todayDate = new Date(todayStr + "T00:00:00Z");
  const futureDate = new Date(todayDate);
  futureDate.setUTCDate(futureDate.getUTCDate() + 90);
  const futureStr = futureDate.toISOString().slice(0, 10);

  const res = await fetch(
    `${BASE_URL}/athlete/${athleteId}/events?oldest=${todayStr}&newest=${futureStr}`,
    { headers: { Authorization: authHeader } }
  );

  if (!res.ok) return null;

  const events = await res.json();
  if (!Array.isArray(events) || events.length === 0) return null;

  let candidates = events.filter(
    (e) => e.category === "RACE" || e.category === "TARGET"
  );
  if (candidates.length === 0) {
    candidates = events;
  }

  let bestEvent = null;
  let bestDate = null;

  for (const ev of candidates) {
    const startLocal = ev.start_date_local || ev.startDateLocal || null;
    if (!startLocal) continue;
    const d = new Date(startLocal);
    if (isNaN(d.getTime())) continue;

    const dDateOnly = new Date(d.toISOString().slice(0, 10) + "T00:00:00Z");
    if (dDateOnly < todayDate) continue;

    if (!bestDate || dDateOnly < bestDate) {
      bestDate = dDateOnly;
      bestEvent = ev;
    }
  }

  if (!bestDate) return null;

  const msDiff = bestDate.getTime() - todayDate.getTime();
  const daysToEvent = Math.round(msDiff / (1000 * 60 * 60 * 24));

  return {
    eventDate: bestDate.toISOString().slice(0, 10),
    daysToEvent
  };
}

// Taperlänge so wählen, dass Form (TSB) am Event-Tag >= 0 ist
function computeTaperDays(ctl0, atl0, normalLoad, daysToEvent) {
  if (daysToEvent <= 0) return 0;

  const tauCtl = 42;
  const tauAtl = 7;
  const maxTaper = Math.min(TAPER_MAX_DAYS, daysToEvent);

  let chosen = 0;

  for (let taperDays = TAPER_MIN_DAYS; taperDays <= maxTaper; taperDays++) {
    let ctl = ctl0;
    let atl = atl0;

    const taperStartIndex = daysToEvent - taperDays; // ab diesem Tag beginnt Taper

    for (let day = 0; day < daysToEvent; day++) {
      let factor = 1.0;

      if (day >= taperStartIndex) {
        if (taperDays <= 1) {
          factor = TAPER_DAILY_END;
        } else {
          const pos = day - taperStartIndex; // 0 .. taperDays-1
          const progress = Math.max(0, Math.min(1, pos / (taperDays - 1)));
          factor =
            TAPER_DAILY_START +
            (TAPER_DAILY_END - TAPER_DAILY_START) * progress;
        }
      }

      const load = normalLoad * factor;

      ctl = ctl + (load - ctl) / tauCtl;
      atl = atl + (load - atl) / tauAtl;
    }

    const tsbEvent = ctl - atl;
    if (tsbEvent >= 0) {
      chosen = taperDays;
      break;
    }
  }

  if (chosen === 0) {
    return maxTaper;
  }
  return chosen;
}

// Zukunfts-Wochen simulieren (RampRate-Regler, Variante B)
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

    for (let d = 0; d < 7; d++) {
      ctl = ctl + (dailyLoad - ctl) / tauCtl;
      atl = atl + (dailyLoad - atl) / tauAtl;
    }

    const ctlEnd = ctl;
    const atlEnd = atl;
    const rampSim = ctlEnd - ctlStart;

    const { state: simState } = classifyWeek(ctlEnd, atlEnd, rampSim);

    let nextTarget;

    if (simState === "Müde") {
      nextTarget = Math.round(prevTarget * 0.8); // Erholungswoche
    } else {
      if (rampSim < 0.5) {
        const factor = prevState === "Müde" ? 1.10 : 1.15; // nach Deload sanfter
        nextTarget = Math.round(prevTarget * factor);
      } else if (rampSim < 0.8) {
        nextTarget = Math.round(prevTarget * 1.10);
      } else if (rampSim <= 1.3) {
        nextTarget = Math.round(prevTarget * 1.05);
      } else if (rampSim <= 1.6) {
        nextTarget = Math.round(prevTarget * 0.92);
      } else {
        nextTarget = Math.round(prevTarget * 0.85);
      }
    }

    const maxIncrease = prevTarget * 1.20;
    const minDecrease = prevTarget * 0.75;
    nextTarget = Math.max(minDecrease, Math.min(nextTarget, maxIncrease));

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
// HAUPTLOGIK – wird von fetch UND scheduled benutzt
// ---------------------------------------------------------

async function handle() {
  const apiKey = INTERVALS_API_KEY;
  const athleteId = INTERVALS_ATHLETE_ID;

  if (!apiKey || !athleteId) {
    return new Response("Missing config", { status: 500 });
  }

  const authHeader = "Basic " + btoa(`API_KEY:${apiKey}`);

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const todayDate = new Date(today + "T00:00:00Z");

  const weekday = todayDate.getUTCDay(); // 0=So,1=Mo,...
  const offset = weekday === 0 ? 6 : weekday - 1;
  const mondayDate = new Date(todayDate);
  mondayDate.setUTCDate(mondayDate.getUTCDate() - offset);
  const mondayStr = mondayDate.toISOString().slice(0, 10);

  try {
    // 1) Wellness heute
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

    const dailyTargetBase = computeDailyTarget(ctl, atl);

    const sleepSecs = wellness.sleepSecs ?? null;
    const sleepScore = wellness.sleepScore ?? null;
    const hrv = wellness.hrv ?? null;
    const sleepHours = sleepSecs != null ? sleepSecs / 3600 : null;

    // 2) Montag-Werte
    const mondayWellnessRes = await fetch(
      `${BASE_URL}/athlete/${athleteId}/wellness/${mondayStr}`,
      { headers: { Authorization: authHeader } }
    );

    let ctlMon;
    let atlMon;
    let mondayWeeklyTarget = null;

    if (mondayWellnessRes.ok) {
      const mon = await mondayWellnessRes.json();
      ctlMon = mon.ctl ?? ctl;
      atlMon = mon.atl ?? atl;
      mondayWeeklyTarget = mon[WEEKLY_TARGET_FIELD] ?? null;
    } else {
      ctlMon = ctl;
      atlMon = atl;
    }

    // 3) Wochenzustand
    const { state: weekState } = classifyWeek(ctl, atl, rampRate);

    let factor = 7;
    if (weekState === "Erholt") factor = 8;
    if (weekState === "Müde") factor = 5.5;

    let weeklyTarget;

    // Nur am Montag neu berechnen
    if (today === mondayStr) {
      weeklyTarget = Math.round(computeDailyTarget(ctlMon, atlMon) * factor);
    } else if (mondayWeeklyTarget != null) {
      // unter der Woche das Montag-Wochenziel weiterverwenden
      weeklyTarget = mondayWeeklyTarget;
    } else {
      // Fallback: falls Montag noch leer ist
      weeklyTarget = Math.round(computeDailyTarget(ctlMon, atlMon) * factor);
    }

    // 4) Event & dynamische Taperlänge
    let taperDailyFactor = 1.0;
    let taperWeeklyFactor = 1.0;

    try {
      const evt = await getNextEventDate(athleteId, authHeader, today);
      if (evt && evt.daysToEvent > 0) {
        const normalLoad = ctl; // Variante C: ~Durchschnitts-TSS der letzten 42 Tage
        const taperDays = computeTaperDays(ctl, atl, normalLoad, evt.daysToEvent);

        if (taperDays > 0 && evt.daysToEvent <= taperDays) {
          const taperStartIndex = evt.daysToEvent - taperDays;
          const dayIndex = 0; // heute

          let progress = 0;
          if (taperDays <= 1) {
            progress = 1;
          } else {
            const pos = dayIndex - taperStartIndex;
            progress = Math.max(0, Math.min(1, pos / (taperDays - 1)));
          }

          taperDailyFactor =
            TAPER_DAILY_START +
            (TAPER_DAILY_END - TAPER_DAILY_START) * progress;

          const TAPER_WEEKLY_START = 0.9;
          const TAPER_WEEKLY_END = 0.6;
          taperWeeklyFactor =
            TAPER_WEEKLY_START +
            (TAPER_WEEKLY_END - TAPER_WEEKLY_START) * progress;
        }
      }
    } catch (e) {
      // Wenn Event-API scheitert, einfach ohne Taper weiter
      console.error("Error in event/taper logic:", e);
    }

    weeklyTarget = Math.round(weeklyTarget * taperWeeklyFactor);

    // 5) Wochenload summieren
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

    // 6) TagesTyp + Schlaf/HRV-Adjust
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

    if (hrv != null && hrv >= 42) goodRecovery = true;
    if (hrv != null && hrv <= 35) badRecovery = true;
    if (hrv != null && hrv <= 30) veryBadRecovery = true;

    if (weekState === "Müde" || veryBadRecovery) {
      dayType = "Rest";
      dayEmoji = "⚪";
      dailyAdj = 0.4;
    } else if (goodRecovery && weekState === "Erholt") {
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

    dailyAdj = Math.max(0.4, Math.min(1.2, dailyAdj));

    // --- NEU: verbleibende Tage dieser Woche (inkl. heute) für Catch-Up ---
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
const daysSinceMonday = Math.round(
  (todayDate.getTime() - mondayDate.getTime()) / MS_PER_DAY
);
const remainingDays = Math.max(1, 7 - daysSinceMonday);

// Wir tun so, als wären nur TRAINING_DAYS_PER_WEEK davon echte Trainingstage
const trainingDensity = TRAINING_DAYS_PER_WEEK / 7;
const effectiveRemaining = Math.max(1, remainingDays * trainingDensity);

// --- Basis-Tagesziel (Plan) ---
const planTarget = dailyTargetBase * taperDailyFactor * dailyAdj;

// --- Catch-Up-Logik: auf effektive Trainingstage verteilen ---
let catchupPerDay = 0;
if (weeklyRemaining > 0) {
  catchupPerDay = weeklyRemaining / effectiveRemaining;
}

// Wenn echter Rest-Tag: kein Catch-Up erzwingen
let rawDailyTarget;
if (dayType === "Rest") {
  rawDailyTarget = 0; // echter Off-Day
} else {
  rawDailyTarget = Math.max(planTarget, catchupPerDay);
}

// Hard-Cap nach oben, damit es nicht völlig eskaliert (max +50 % über Plan)
const cappedDailyTarget = Math.min(rawDailyTarget, planTarget * 1.5);

const dailyTarget = Math.round(cappedDailyTarget);

    // 7) WochenPlan
    const emojiToday = stateEmoji(weekState);
    const planTextToday = `Rest ${weeklyRemaining} | ${emojiToday} ${weekState}`;

    // 8) Wellness HEUTE updaten
    const payloadToday = {
      id: today,
      [INTERVALS_TARGET_FIELD]: dailyTarget,
      [INTERVALS_PLAN_FIELD]: planTextToday,
      [DAILY_TYPE_FIELD]: `${dayEmoji} ${dayType}`
    };

    // WochenzielTSS nur am Montag schreiben
    if (today === mondayStr) {
      payloadToday[WEEKLY_TARGET_FIELD] = weeklyTarget;
    }

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

    // 9) Zukünftige Wochen planen (aktuelle + 6 weitere Montage)
    const WEEKS_TO_SIMULATE = 7;
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
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response("Unexpected error: " + err.toString(), {
      status: 500
    });
  }
}

// ---------------------------------------------------------
// EXPORT: HTTP + CRON
// ---------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    return handle();
  },
  async scheduled(event, env, ctx) {
    // Cron-Trigger ruft dieselbe Logik auf
    ctx.waitUntil(handle());
  }
};
