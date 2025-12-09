const BASE_URL = "https://intervals.icu/api/v1";

// 🔥 Hardcoded Variablen – später ideal als Secrets/KV hinterlegen
const INTERVALS_API_KEY = "1xg1v04ym957jsqva8720oo01";
const INTERVALS_ATHLETE_ID = "i105857";
const INTERVALS_TARGET_FIELD = "TageszielTSS";
const INTERVALS_PLAN_FIELD = "WochenPlan";
const WEEKLY_TARGET_FIELD = "WochenzielTSS";
const DAILY_TYPE_FIELD = "TagesTyp"; // bleibt ungenutzt, aber existiert

// Fallback: angenommene Anzahl Trainingstage pro Woche
const TRAINING_DAYS_PER_WEEK = 4.0;

// Taper-Konstanten (für Events)
const TAPER_MIN_DAYS = 3;
const TAPER_MAX_DAYS = 21;
const TAPER_DAILY_START = 0.8;
const TAPER_DAILY_END = 0.3;

// KV-Key für das Muster
const WEEKDAY_PATTERN_KEY = "weekdayPatternRaw";

// Lernrate für das exponentielle Lernen
// 0.7 = reagiert recht schnell auf neue Gewohnheiten
const PATTERN_ALPHA = 0.7;

// ---------------------------------------------------------
// Lernendes Wochentagsmuster (KV) – aktuell nur gepflegt,
// noch nicht super aggressiv genutzt
// ---------------------------------------------------------

function normalizePattern(rawPattern) {
  let sum = rawPattern.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    // absoluter Fallback: gleichmäßig
    rawPattern = [1, 1, 1, 1, 1, 1, 1];
    sum = 7;
  }
  return rawPattern.map((v) => (sum > 0 ? v / sum : 0));
}

async function initWeekdayPatternFromHistory(env, athleteId, authHeader, todayDate) {
  if (!env || !env.KV || !env.KV.put) {
    console.warn("KV binding missing in init – using simple equal fallback pattern.");
    return [1, 1, 1, 1, 1, 1, 1];
  }

  const HISTORY_WEEKS_INIT = 12;
  const startDate = new Date(todayDate);
  startDate.setUTCDate(startDate.getUTCDate() - HISTORY_WEEKS_INIT * 7);
  const oldest = startDate.toISOString().slice(0, 10);
  const newest = todayDate.toISOString().slice(0, 10);

  let rawPattern = new Array(7).fill(0); // Mo..So

  try {
    const histRes = await fetch(
      `${BASE_URL}/athlete/${athleteId}/wellness?oldest=${oldest}&newest=${newest}&cols=id,ctlLoad`,
      { headers: { Authorization: authHeader } }
    );
    if (histRes.ok) {
      const histArr = await histRes.json();
      for (const d of histArr) {
        if (!d.id || d.ctlLoad == null) continue;
        const dateObj = new Date(d.id + "T00:00:00Z");
        if (isNaN(dateObj.getTime())) continue;
        const wd = dateObj.getUTCDay(); // 0=So,1=Mo...
        let idx;
        if (wd === 0) idx = 6; // So -> 6
        else idx = wd - 1;     // Mo->0, Di->1, ...
        if (idx >= 0 && idx < 7) {
          rawPattern[idx] += d.ctlLoad;
        }
      }
    } else if (histRes.body) {
      histRes.body.cancel?.();
    }
  } catch (e) {
    console.error("Error in initWeekdayPatternFromHistory:", e);
  }

  let sum = rawPattern.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    rawPattern = [1, 1, 1, 1, 1, 1, 1];
  }

  await env.KV.put(WEEKDAY_PATTERN_KEY, JSON.stringify(rawPattern));
  return rawPattern;
}

async function loadRawPattern(env, athleteId, authHeader, todayDate) {
  if (!env || !env.KV || !env.KV.get) {
    console.warn("KV binding missing – using simple equal fallback pattern.");
    return [1, 1, 1, 1, 1, 1, 1];
  }

  let rawStr = await env.KV.get(WEEKDAY_PATTERN_KEY);
  if (!rawStr) {
    return await initWeekdayPatternFromHistory(env, athleteId, authHeader, todayDate);
  }
  try {
    const arr = JSON.parse(rawStr);
    if (Array.isArray(arr) && arr.length === 7) {
      return arr.map((v) => (typeof v === "number" && isFinite(v) ? v : 0));
    }
  } catch (e) {
    console.error("Error parsing weekdayPatternRaw from KV:", e);
  }
  const rawPattern = [1, 1, 1, 1, 1, 1, 1];
  await env.KV.put(WEEKDAY_PATTERN_KEY, JSON.stringify(rawPattern));
  return rawPattern;
}

async function updatePatternWithYesterday(env, rawPattern, yesterdayDate, yesterdayLoad) {
  if (!yesterdayDate || yesterdayLoad == null) {
    return rawPattern;
  }

  const d = yesterdayDate;
  const wd = d.getUTCDay(); // 0=So,1=Mo...
  let idx;
  if (wd === 0) idx = 6;
  else idx = wd - 1;

  if (idx >= 0 && idx < 7) {
    const old = rawPattern[idx] ?? 0;
    const load = Math.max(0, yesterdayLoad);
    const updated = PATTERN_ALPHA * old + (1 - PATTERN_ALPHA) * load;
    rawPattern[idx] = updated;
  }

  if (env && env.KV && env.KV.put) {
    await env.KV.put(WEEKDAY_PATTERN_KEY, JSON.stringify(rawPattern));
  }

  return rawPattern;
}

// ---------------------------------------------------------
// Hilfsfunktionen Training / Müdigkeit / Taper
// ---------------------------------------------------------

function computeDailyTarget(ctl, atl) {
  const base = 1.0;
  const k = 0.05;
  const tsb = ctl - atl;
  const tsbClamped = Math.max(-20, Math.min(20, tsb));
  const dailyTss = ctl * (base + k * tsbClamped);
  return Math.round(Math.max(0, Math.min(dailyTss, ctl * 1.5)));
}

function classifyWeek(ctl, atl, rampRate) {
  const tsb = ctl - atl;

  let tsbCritical;
  if (ctl < 50) {
    tsbCritical = -5;
  } else if (ctl < 80) {
    tsbCritical = -10;
  } else {
    tsbCritical = -15;
  }
  const isTsbTired = tsb <= tsbCritical;

  let atlCtlRatio = Infinity;
  if (ctl > 0) {
    atlCtlRatio = atl / ctl;
  }

  let atlRatioThreshold;
  if (ctl < 50) {
    atlRatioThreshold = 1.2;
  } else if (ctl < 80) {
    atlRatioThreshold = 1.3;
  } else {
    atlRatioThreshold = 1.4;
  }
  const isAtlHigh = atlCtlRatio >= atlRatioThreshold;

  const isRampHigh = rampRate >= 1.0;
  const isRampLowAndFresh = rampRate <= -0.5 && tsb >= -5;

  if (isRampLowAndFresh) {
    return { state: "Erholt", tsb };
  }

  if (isRampHigh || isTsbTired || isAtlHigh) {
    return { state: "Müde", tsb };
  }

  return { state: "Normal", tsb };
}

function stateEmoji(state) {
  if (state === "Erholt") return "🔥";
  if (state === "Müde") return "🧘";
  return "⚖️";
}

// Nächstes Event holen (RACE/TARGET, optional)
async function getNextEventDate(athleteId, authHeader, todayStr) {
  const todayDate = new Date(todayStr + "T00:00:00Z");
  const futureDate = new Date(todayDate);
  futureDate.setUTCDate(todayDate.getUTCDate() + 90);
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
  if (candidates.length === 0) candidates = events;

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

// Sehr einfache Taperberechnung: so wählen, dass TSB am Event >= 0 (grobe Näherung)
function computeTaperDays(ctl0, atl0, normalLoad, daysToEvent) {
  if (daysToEvent <= 0) return 0;

  const tauCtl = 42;
  const tauAtl = 7;
  const maxTaper = Math.min(TAPER_MAX_DAYS, daysToEvent);
  let chosen = 0;

  for (let taperDays = TAPER_MIN_DAYS; taperDays <= maxTaper; taperDays++) {
    let ctl = ctl0;
    let atl = atl0;
    const taperStartIndex = daysToEvent - taperDays;

    for (let day = 0; day < daysToEvent; day++) {
      let factor = 1.0;

      if (day >= taperStartIndex) {
        if (taperDays <= 1) {
          factor = TAPER_DAILY_END;
        } else {
          const pos = day - taperStartIndex;
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

  if (chosen === 0) return maxTaper;
  return chosen;
}

// ---------------------------------------------------------
// HAUPTLOGIK
// ---------------------------------------------------------

async function handle(env) {
  try {
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

    const lastMondayDate = new Date(mondayDate);
    lastMondayDate.setUTCDate(lastMondayDate.getUTCDate() - 7);
    const lastSundayDate = new Date(mondayDate);
    lastSundayDate.setUTCDate(lastSundayDate.getUTCDate() - 1);
    const lastMondayStr = lastMondayDate.toISOString().slice(0, 10);
    const lastSundayStr = lastSundayDate.toISOString().slice(0, 10);

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

    const { state: weekState, tsb } = classifyWeek(ctl, atl, rampRate);
    const dailyTargetBase = computeDailyTarget(ctl, atl);

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

    // 2b) Vorwoche Ziel + Ist
    let lastWeekTarget = null;
    let lastWeekActual = null;

    try {
      const lastMonWellRes = await fetch(
        `${BASE_URL}/athlete/${athleteId}/wellness/${lastMondayStr}`,
        { headers: { Authorization: authHeader } }
      );
      if (lastMonWellRes.ok) {
        const lastMonWell = await lastMonWellRes.json();
        lastWeekTarget = lastMonWell[WEEKLY_TARGET_FIELD] ?? null;
      } else if (lastMonWellRes.body) {
        lastMonWellRes.body.cancel?.();
      }
    } catch (e) {
      console.error("Error fetching last Monday wellness:", e);
    }

    try {
      const lastWeekRes = await fetch(
        `${BASE_URL}/athlete/${athleteId}/wellness?oldest=${lastMondayStr}&newest=${lastSundayStr}&cols=id,ctlLoad`,
        { headers: { Authorization: authHeader } }
      );
      if (lastWeekRes.ok) {
        const lastWeekArr = await lastWeekRes.json();
        let sum = 0;
        for (const d of lastWeekArr) {
          if (d.ctlLoad != null) sum += d.ctlLoad;
        }
        lastWeekActual = sum;
      } else if (lastWeekRes.body) {
        lastWeekRes.body.cancel?.();
      }
    } catch (e) {
      console.error("Error fetching last week load:", e);
    }

    // 3) Wochenzustand → Faktor
    let factor = 7;
    if (weekState === "Erholt") factor = 8;
    if (weekState === "Müde") factor = 5.5;

    // 3b) Wochenziel
    let weeklyTarget;
    if (mondayWeeklyTarget != null) {
      weeklyTarget = mondayWeeklyTarget;
    } else {
      let weeklyTargetRaw = Math.round(computeDailyTarget(ctlMon, atlMon) * factor);

      const hitLastWeek =
        lastWeekTarget != null &&
        lastWeekActual != null &&
        lastWeekActual >= 0.95 * lastWeekTarget;

      if (hitLastWeek && weekState !== "Müde") {
        let minAllowed = lastWeekTarget;
        if (tsb >= 0) {
          const progFactor = (weekState === "Erholt") ? 1.10 : 1.05;
          const progressive = lastWeekTarget * progFactor;
          minAllowed = Math.max(minAllowed, progressive);
        }
        weeklyTargetRaw = Math.max(weeklyTargetRaw, Math.round(minAllowed));
      }

      weeklyTarget = weeklyTargetRaw;
    }

    // 4) Event & Taper (optional, wirkt nur auf Tagesziel)
    let taperDailyFactor = 1.0;
    let inTaper = false;

    try {
      const evt = await getNextEventDate(athleteId, authHeader, today);
      if (evt && evt.daysToEvent > 0) {
        const normalLoad = ctl;
        const taperDays = computeTaperDays(ctl, atl, normalLoad, evt.daysToEvent);

        if (taperDays > 0 && evt.daysToEvent <= taperDays) {
          const taperStartIndex = evt.daysToEvent - taperDays;
          const dayIndex = 0;

          let progress = 0;
          if (taperDays <= 1) {
            progress = 1;
          } else {
            const pos = dayIndex - taperStartIndex;
            const progressRaw = pos / (taperDays - 1);
            progress = Math.max(0, Math.min(1, progressRaw));
          }

          taperDailyFactor =
            TAPER_DAILY_START +
            (TAPER_DAILY_END - TAPER_DAILY_START) * progress;

          inTaper = true;
        }
      }
    } catch (e) {
      console.error("Error in event/taper logic:", e);
    }

    // 5) Wochenload + Mikrozyklus
    let weekLoad = 0;
    let weekArr = [];

    if (today !== mondayStr) {
      const weekRes = await fetch(
        `${BASE_URL}/athlete/${athleteId}/wellness?oldest=${mondayStr}&newest=${today}&cols=id,ctlLoad`,
        { headers: { Authorization: authHeader } }
      );
      if (weekRes.ok) {
        weekArr = await weekRes.json();
        for (const day of weekArr) {
          if (day.ctlLoad != null) weekLoad += day.ctlLoad;
        }
      } else if (weekRes.body) {
        weekRes.body.cancel?.();
      }
    }

    const weeklyRemaining = Math.max(0, Math.round(weeklyTarget - weekLoad));
    const weekDone = Math.max(0, Math.min(weeklyTarget, weekLoad));

    let weekPercent = 0;
    if (weeklyTarget > 0) {
      weekPercent = Math.round((weekDone / weeklyTarget) * 100);
    }
    weekPercent = Math.max(0, Math.min(200, weekPercent));

    let weekBarFilled = 0;
    if (weeklyTarget > 0) {
      weekBarFilled = Math.round((weekDone / weeklyTarget) * 10);
    }
    weekBarFilled = Math.max(0, Math.min(10, weekBarFilled));
    const weekBar = "█".repeat(weekBarFilled) + "░".repeat(10 - weekBarFilled);

    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const daysSinceMonday = Math.round(
      (todayDate.getTime() - mondayDate.getTime()) / MS_PER_DAY
    );

    const ctlLoadByDate = new Map();
    for (const day of weekArr) {
      if (day.id && day.ctlLoad != null) {
        ctlLoadByDate.set(day.id, day.ctlLoad);
      }
    }

    let daysSinceLastTraining = daysSinceMonday + 1;
    for (let offset = 0; offset <= daysSinceMonday; offset++) {
      const d = new Date(todayDate);
      d.setUTCDate(d.getUTCDate() - offset);
      const id = d.toISOString().slice(0, 10);
      const load = ctlLoadByDate.get(id) ?? 0;
      if (load > 0) {
        daysSinceLastTraining = offset;
        break;
      }
    }

    let consecutiveTrainingDays = 0;
    for (let offset = 1; offset <= daysSinceMonday; offset++) {
      const d = new Date(todayDate);
      d.setUTCDate(d.getUTCDate() - offset);
      const id = d.toISOString().slice(0, 10);
      const load = ctlLoadByDate.get(id) ?? 0;
      if (load > 0) {
        consecutiveTrainingDays++;
      } else {
        break;
      }
    }

    const yesterdayDate = new Date(todayDate);
    yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
    const yesterdayId = yesterdayDate.toISOString().slice(0, 10);
    const yesterdayLoad = ctlLoadByDate.get(yesterdayId) ?? 0;

    const twoDaysAgoDate = new Date(todayDate);
    twoDaysAgoDate.setUTCDate(twoDaysAgoDate.getUTCDate() - 2);
    const twoDaysAgoId = twoDaysAgoDate.toISOString().slice(0, 10);
    const twoDaysAgoLoad = ctlLoadByDate.get(twoDaysAgoId) ?? 0;

    const last2DaysLoad = yesterdayLoad + twoDaysAgoLoad;

    // 6) Lernendes Wochentagsmuster (nur gepflegt, nicht stark genutzt)
    let rawPattern = await loadRawPattern(env, athleteId, authHeader, todayDate);
    rawPattern = await updatePatternWithYesterday(env, rawPattern, yesterdayDate, yesterdayLoad);
    const weekdayWeights = normalizePattern(rawPattern);

    // 7) 
// 7) Tagesziel – jetzt mit lernender Wochenverteilung
let targetFromWeek;
{
  const jsDay = weekday;              // 0 = So, 1 = Mo, ...
  const dayIdx = jsDay === 0 ? 6 : jsDay - 1; // Mo..So = 0..6
  const weightToday = weekdayWeights[dayIdx] ?? 0;
  const sumWeights = weekdayWeights.reduce((a, b) => a + b, 0);

  if (sumWeights > 0 && weightToday > 0) {
    // Musterbasiert: Anteil dieser Wochentag-Last an der Wochenlast
    targetFromWeek = weeklyTarget * weightToday;
  } else {
    // Fallback: „klassisch“ über angenommene Trainingstage
    targetFromWeek = weeklyTarget / TRAINING_DAYS_PER_WEEK;
  }
}

const baseFromFitness = dailyTargetBase * taperDailyFactor;
const combinedBase = 0.8 * targetFromWeek + 0.2 * baseFromFitness;
    let tsbFactor = 1.0;
    if (tsb >= 10) tsbFactor = 1.4;
    else if (tsb >= 5) tsbFactor = 1.25;
    else if (tsb >= 0) tsbFactor = 1.10;
    else if (tsb <= -15) tsbFactor = 0.5;
    else if (tsb <= -10) tsbFactor = 0.6;
    else if (tsb <= -5) tsbFactor = 0.8;

    let microFactor = 1.0;
    let suggestRestDay = false;

    if (yesterdayLoad === 0 && tsb >= 0) {
      microFactor *= 1.10;
    }
    if (daysSinceLastTraining >= 2 && tsb >= 0) {
      microFactor *= 1.25;
    }
    if (daysSinceLastTraining >= 3 && tsb >= 0) {
      microFactor *= 1.10;
    }

    let fatigueFactor = 1.0;
    if (consecutiveTrainingDays >= 3) fatigueFactor = Math.min(fatigueFactor, 0.8);
    if (consecutiveTrainingDays >= 4) fatigueFactor = Math.min(fatigueFactor, 0.7);

    const avgTrainingDay = weeklyTarget / TRAINING_DAYS_PER_WEEK;
    const heavyThreshold = Math.max(1.5 * avgTrainingDay, 60);
    const veryHeavyThreshold = Math.max(2.3 * avgTrainingDay, 90);

    if (yesterdayLoad >= veryHeavyThreshold && tsb <= -5) {
      fatigueFactor = Math.min(fatigueFactor, 0.4);
      suggestRestDay = true;
    } else if (yesterdayLoad >= heavyThreshold && tsb <= 0) {
      fatigueFactor = Math.min(fatigueFactor, 0.6);
    }

    const highTwoDayThreshold = Math.max(3.0 * avgTrainingDay, 120);
    if (last2DaysLoad >= highTwoDayThreshold && tsb <= -5) {
      fatigueFactor = Math.min(fatigueFactor, 0.6);
    }

    microFactor *= fatigueFactor;

    let dailyTargetRaw = combinedBase * tsbFactor * microFactor;

    const maxDailyByCtl = ctl * 3.0;
    const maxDailyByWeek = avgTrainingDay * 2.5;
    const maxDaily = Math.max(
      baseFromFitness,
      Math.min(maxDailyByCtl, maxDailyByWeek)
    );

    dailyTargetRaw = Math.max(0, dailyTargetRaw);
    let dailyTarget = Math.round(Math.min(dailyTargetRaw, maxDaily));

    const tssTarget = dailyTarget;
    const tssLow = Math.round(tssTarget * 0.8);
    const tssHigh = Math.round(tssTarget * 1.2);

    const emojiToday = stateEmoji(weekState);
    const planTextToday = `Rest ${weeklyRemaining} | ${emojiToday} ${weekState}`;

    const commentText = `Tagesziel-Erklärung

Woche:
Ziel: ${weeklyTarget} TSS
Fortschritt: [${weekBar}] ${weekPercent}% (${weekLoad.toFixed(1)}/${weeklyTarget})

Status heute:
CTL ${ctl.toFixed(1)} | ATL ${atl.toFixed(1)} | TSB ${tsb.toFixed(1)}
Wochentyp: ${weekState} | Taper: ${inTaper ? "Ja" : "Nein"}

Mikrozyklus:
Tage seit letztem Training: ${daysSinceLastTraining}
Serien bis gestern: ${consecutiveTrainingDays}
Gestern: ${yesterdayLoad.toFixed(1)} TSS | Vorgestern: ${twoDaysAgoLoad.toFixed(1)} TSS
Letzte 2 Tage: ${last2DaysLoad.toFixed(1)} TSS
Empfehlung: ${
  suggestRestDay
    ? "Heute eher Ruhetag/locker."
    : "Normale Belastung ok."
}

Rechenweg (kompakt):
targetFromWeek ≈ ${targetFromWeek.toFixed(1)} TSS
baseFromFitness = ${baseFromFitness.toFixed(1)}
combinedBase = ${combinedBase.toFixed(1)}
tsbFactor = ${tsbFactor} | microFactor = ${microFactor.toFixed(2)}
dailyTargetRaw = ${dailyTargetRaw.toFixed(1)} | maxDaily = ${maxDaily.toFixed(1)}

Tagesziel: ${tssTarget} TSS
Range: ${tssLow}–${tssHigh} TSS (80–120%)`;


    const payloadToday = {
      id: today,
      [INTERVALS_TARGET_FIELD]: tssTarget,
      [INTERVALS_PLAN_FIELD]: planTextToday,
      comments: commentText
    };

    if (today === mondayStr && mondayWeeklyTarget == null) {
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
    } else if (updateRes.body) {
      updateRes.body.cancel?.();
    }

    return new Response(
      `OK: Tagesziel=${tssTarget}, Wochenziel=${weeklyTarget}, Range=${tssLow}-${tssHigh}, suggestRestDay=${suggestRestDay}`,
      { status: 200 }
    );
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response("Unexpected error: " + (err && err.stack ? err.stack : String(err)), {
      status: 500
    });
  }
}

// ---------------------------------------------------------
// EXPORT
// ---------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    return handle(env);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handle(env));
  }
};
