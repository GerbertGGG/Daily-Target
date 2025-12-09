const BASE_URL = "https://intervals.icu/api/v1";

// 🔥 Hardcoded – kannst du später nach env auslagern
const INTERVALS_API_KEY = "1xg1v04ym957jsqva8720oo01";
const INTERVALS_ATHLETE_ID = "i105857";

const INTERVALS_TARGET_FIELD = "TageszielTSS";  // numerisches Tagesziel (heute möglich)
const INTERVALS_PLAN_FIELD = "WochenPlan";      // kurzer Plantext
const WEEKLY_TARGET_FIELD = "WochenzielTSS";    // Wochenziel (TSS)
const DAILY_TYPE_FIELD = "TagesTyp";            // z.B. "Mo,Mi,Fr,So"

// Default-Trainingstage, falls nichts eingetragen
const DEFAULT_PLAN_STRING = "Mo,Mi,Fr,So";
const DEFAULT_TRAINING_DAYS_PER_WEEK = 4.0;

// Hartes Tages-Cap
const HARD_DAILY_CAP = 200;

// ---------------------------------------------------------
// Helper
// ---------------------------------------------------------

const DAY_NAMES = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

// jsDay: 0=So,1=Mo,... → idx: 0=Mo..6=So
function dayIdxFromJsDay(jsDay) {
  return jsDay === 0 ? 6 : jsDay - 1;
}

// parse "Mo,Mi,Fr,So" oder "1,3,5,7" → bool[7] für Mo..So
function parseTrainingDays(str) {
  if (!str || typeof str !== "string") return new Array(7).fill(false);

  const tokens = str
    .split(/[,\s;]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return new Array(7).fill(false);

  const selected = new Array(7).fill(false);

  for (const raw of tokens) {
    const t = raw.toLowerCase();
    // numerisch: 1=Mo..7=So
    const num = parseInt(t, 10);
    if (!isNaN(num) && num >= 1 && num <= 7) {
      selected[num - 1] = true;
      continue;
    }
    // deutsch Kurzformen
    if (t.startsWith("mo")) selected[0] = true;
    else if (t.startsWith("di")) selected[1] = true;
    else if (t.startsWith("mi")) selected[2] = true;
    else if (t.startsWith("do")) selected[3] = true;
    else if (t.startsWith("fr")) selected[4] = true;
    else if (t.startsWith("sa")) selected[5] = true;
    else if (t.startsWith("so")) selected[6] = true;
  }

  return selected;
}

function stateEmoji(state) {
  if (state === "Erholt") return "🔥";
  if (state === "Müde") return "🧘";
  return "⚖️";
}

// ---------------------------------------------------------
// Trainings-Logik: Fitness / Müdigkeit
// ---------------------------------------------------------

function computeDailyTarget(ctl, atl) {
  // einfache CTL/TSB-basierte Abschätzung
  const tsb = ctl - atl;
  const tsbClamped = Math.max(-20, Math.min(20, tsb));
  const base = 1.0;
  const k = 0.05;
  const daily = ctl * (base + k * tsbClamped);
  return Math.round(Math.max(0, Math.min(daily, ctl * 1.5)));
}

function classifyWeek(ctl, atl, rampRate) {
  const tsb = ctl - atl;

  let tsbCritical;
  if (ctl < 50) tsbCritical = -5;
  else if (ctl < 80) tsbCritical = -10;
  else tsbCritical = -15;

  const isTsbTired = tsb <= tsbCritical;

  let atlCtlRatio = Infinity;
  if (ctl > 0) atlCtlRatio = atl / ctl;

  let atlRatioThreshold;
  if (ctl < 50) atlRatioThreshold = 1.2;
  else if (ctl < 80) atlRatioThreshold = 1.3;
  else atlRatioThreshold = 1.4;

  const isAtlHigh = atlCtlRatio >= atlRatioThreshold;
  const isRampHigh = rampRate >= 1.0;
  const isRampLowAndFresh = rampRate <= -0.5 && tsb >= -5;

  if (isRampLowAndFresh) return { state: "Erholt", tsb };
  if (isRampHigh || isTsbTired || isAtlHigh) return { state: "Müde", tsb };
  return { state: "Normal", tsb };
}

// ---------------------------------------------------------
// 6-Wochen-Simulation
// ---------------------------------------------------------

async function simulatePlannedWeeks(
  ctlStart,
  atlStart,
  weekStateStart,
  weeklyTargetStart,
  mondayDate,
  planSelected,
  authHeader,
  athleteId,
  weeksToSim,
  dryRun
) {
  const tauCtl = 42;
  const tauAtl = 7;

  // Trainingsmuster aus Plan (bool[7]) → Gewichte pro Tag
  // Nur Tage mit planSelected[i] = true erhalten einen Anteil am Wochenload,
  // Nicht-Trainingstage bekommen 0 TSS.
  let dayWeights = new Array(7).fill(0); // Mo..So
  let countSelected = 0;
  for (let i = 0; i < 7; i++) {
    if (planSelected[i]) {
      dayWeights[i] = 1;
      countSelected++;
    }
  }
  if (countSelected === 0) {
    // Fallback, falls Plan leer → Mo,Mi,Fr,So
    dayWeights = [1, 0, 1, 0, 1, 0, 1];
    countSelected = 4;
  }

  let sumWeights = dayWeights.reduce((a, b) => a + b, 0);
  if (sumWeights <= 0) {
    dayWeights = [1, 0, 1, 0, 1, 0, 1];
    sumWeights = 4;
  }

  let ctl = ctlStart;
  let atl = atlStart;
  let prevTarget = weeklyTargetStart;
  let prevState = weekStateStart;

  for (let w = 1; w <= weeksToSim; w++) {
    const ctlAtWeekStart = ctl;

    // 7 Tage simulieren
    for (let d = 0; d < 7; d++) {
      const share = dayWeights[d] / sumWeights;
      const load = prevTarget * share; // TSS an diesem Tag (nur Trainingstage > 0)

      ctl = ctl + (load - ctl) / tauCtl;
      atl = atl + (load - atl) / tauAtl;
    }

    const ctlEnd = ctl;
    const atlEnd = atl;
    const rampSim = ctlEnd - ctlAtWeekStart;

    const { state: simState, tsb: simTsb } = classifyWeek(ctlEnd, atlEnd, rampSim);

    // Ramp-/Deload-Logik für geplante Wochen:
    let nextTarget = prevTarget;

    if (simState === "Müde") {
      const ratio = ctlEnd > 0 ? atlEnd / ctlEnd : Infinity;
      // starke Deload, wenn richtig müde (sehr negativer TSB oder hohe ATL/CTL-Ratio)
      if (simTsb < -20 || ratio > 1.4) {
        nextTarget = prevTarget * 0.8;   // starke Entlastungswoche
      } else {
        nextTarget = prevTarget * 0.9;   // mildere Entlastungswoche
      }
    } else {
      if (rampSim < 0.5) {
        // CTL stagniert → etwas stärker steigern
        nextTarget = prevTarget * (simState === "Erholt" ? 1.12 : 1.08);
      } else if (rampSim < 1.0) {
        nextTarget = prevTarget * (simState === "Erholt" ? 1.08 : 1.05);
      } else if (rampSim <= 1.5) {
        nextTarget = prevTarget * 1.02; // CTL steigt ohnehin ordentlich
      } else {
        // zu steile Ramp → leicht runter
        nextTarget = prevTarget * 0.9;
      }
    }

    // Caps: nicht komplett eskalieren oder abstürzen lassen
    const minWeekly = prevTarget * 0.75;
    const maxWeekly = prevTarget * 1.25;
    nextTarget = Math.max(minWeekly, Math.min(maxWeekly, nextTarget));

    // auf 5er runden
    nextTarget = Math.round(nextTarget / 5) * 5;

    const mondayFutureDate = new Date(mondayDate);
    mondayFutureDate.setUTCDate(mondayFutureDate.getUTCDate() + 7 * w);
    const mondayId = mondayFutureDate.toISOString().slice(0, 10);

    const emoji = stateEmoji(simState);
    const planText = `Rest ${nextTarget} | ${emoji} ${simState} (geplant)`;

    const payloadFuture = {
      id: mondayId,
      [WEEKLY_TARGET_FIELD]: nextTarget,
      [INTERVALS_PLAN_FIELD]: planText
    };

    if (!dryRun) {
      try {
        const resFuture = await fetch(
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
        if (!resFuture.ok) {
          const txt = await resFuture.text();
          console.error(
            "Failed to update future wellness:",
            mondayId,
            resFuture.status,
            txt
          );
        } else if (resFuture.body) {
          resFuture.body.cancel?.();
        }
      } catch (e) {
        console.error("Error updating future week:", e);
      }
    }

    prevTarget = nextTarget;
    prevState = simState;
  }
}

// ---------------------------------------------------------
// Hauptlogik (Heute planen + Simulation)
// ---------------------------------------------------------

async function handle(env, request) {
  try {
    const url = request ? new URL(request.url) : null;
    const dryRun = url && url.searchParams.get("dryRun") === "1";

    const apiKey = INTERVALS_API_KEY;
    const athleteId = INTERVALS_ATHLETE_ID;
    if (!apiKey || !athleteId) {
      return new Response("Missing config", { status: 500 });
    }
    const authHeader = "Basic " + btoa(`API_KEY:${apiKey}`);

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const todayDate = new Date(today + "T00:00:00Z");

    const jsDay = todayDate.getUTCDay();     // 0=So..6=Sa
    const dayIdx = dayIdxFromJsDay(jsDay);  // 0=Mo..6=So

    // Montag der aktuellen Woche ermitteln
    const offset = jsDay === 0 ? 6 : jsDay - 1;
    const mondayDate = new Date(todayDate);
    mondayDate.setUTCDate(mondayDate.getUTCDate() - offset);
    const mondayStr = mondayDate.toISOString().slice(0, 10);

    // Vorwoche (für Steigerungslogik)
    const lastMondayDate = new Date(mondayDate);
    lastMondayDate.setUTCDate(lastMondayDate.getUTCDate() - 7);
    const lastSundayDate = new Date(mondayDate);
    lastSundayDate.setUTCDate(lastSundayDate.getUTCDate() - 1);
    const lastMondayStr = lastMondayDate.toISOString().slice(0, 10);
    const lastSundayStr = lastSundayDate.toISOString().slice(0, 10);

    // -----------------------------------------------------
    // 1) Wellness heute
    // -----------------------------------------------------
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
      console.warn("No ctl/atl data for today");
      return new Response("No ctl/atl data", { status: 200 });
    }

    const todaysDailyTypeRaw = wellness[DAILY_TYPE_FIELD];
    const todaysDailyType =
      todaysDailyTypeRaw == null
        ? ""
        : typeof todaysDailyTypeRaw === "string"
        ? todaysDailyTypeRaw.trim()
        : String(todaysDailyTypeRaw).trim();

    const { state: weekState, tsb } = classifyWeek(ctl, atl, rampRate);
    const dailyTargetBase = computeDailyTarget(ctl, atl);

    // -----------------------------------------------------
    // 2) Montag-Wellness (Wochenziel + Plan von Montag)
    // -----------------------------------------------------
    let ctlMon, atlMon;
    let mondayWeeklyTarget = null;
    let mondayPlanString = "";

    const mondayWellnessRes = await fetch(
      `${BASE_URL}/athlete/${athleteId}/wellness/${mondayStr}`,
      { headers: { Authorization: authHeader } }
    );
    if (mondayWellnessRes.ok) {
      const mon = await mondayWellnessRes.json();
      ctlMon = mon.ctl ?? ctl;
      atlMon = mon.atl ?? atl;
      mondayWeeklyTarget = mon[WEEKLY_TARGET_FIELD] ?? null;
      const mondayDailyTypeRaw = mon[DAILY_TYPE_FIELD];
      mondayPlanString =
        mondayDailyTypeRaw == null
          ? ""
          : typeof mondayDailyTypeRaw === "string"
          ? mondayDailyTypeRaw.trim()
          : String(mondayDailyTypeRaw).trim();
    } else {
      ctlMon = ctl;
      atlMon = atl;
    }

    if (!mondayPlanString) {
      mondayPlanString = DEFAULT_PLAN_STRING;
    }

    // Wenn du HEUTE einen neuen Plan einträgst → Montag updaten,
    // damit die ganze Woche ihn nutzt.
    if (todaysDailyType && todaysDailyType !== mondayPlanString) {
      mondayPlanString = todaysDailyType;
      const payloadMonUpdate = {
        id: mondayStr,
        [DAILY_TYPE_FIELD]: mondayPlanString
      };
      if (!dryRun) {
        const putMon = await fetch(
          `${BASE_URL}/athlete/${athleteId}/wellness/${mondayStr}`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: authHeader
            },
            body: JSON.stringify(payloadMonUpdate)
          }
        );
        if (!putMon.ok && putMon.body) putMon.body.cancel?.();
      }
    }

    const planSelected = parseTrainingDays(mondayPlanString);
    const plannedNames = [];
    for (let i = 0; i < 7; i++) if (planSelected[i]) plannedNames.push(DAY_NAMES[i]);
    const planStringForComment = plannedNames.join(",");

    // -----------------------------------------------------
    // 3) Vorwoche Ziel + Ist für Steigerungslogik
    // -----------------------------------------------------
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
      } else if (lastMonWellRes.body) lastMonWellRes.body.cancel?.();
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
      } else if (lastWeekRes.body) lastWeekRes.body.cancel?.();
    } catch (e) {
      console.error("Error fetching last week load:", e);
    }

    // -----------------------------------------------------
    // 4) Wochenziel berechnen (mit Ramp-Cap & Low-CTL-Modus)
    // -----------------------------------------------------
    let weeklyTarget;

    // Niedrige CTL bekommen sanftere Basisfaktoren
    let baseFactor;
    if (ctlMon < 25) {
      // Einsteiger-Modus: etwas konservativer
      baseFactor = weekState === "Erholt" ? 7 : weekState === "Müde" ? 5 : 6;
    } else {
      baseFactor = weekState === "Erholt" ? 8 : weekState === "Müde" ? 5.5 : 7;
    }

    if (mondayWeeklyTarget != null) {
      // Rest der Woche: Montag-Ziel verwenden
      weeklyTarget = mondayWeeklyTarget;
    } else {
      // Heute = Montag oder Woche ohne Ziel → neu ansetzen
      let weeklyTargetRaw = Math.round(computeDailyTarget(ctlMon, atlMon) * baseFactor);

      const hitLastWeek =
        lastWeekTarget != null &&
        lastWeekActual != null &&
        lastWeekActual >= 0.9 * lastWeekTarget;

      if (hitLastWeek && weekState !== "Müde") {
        // niemals unter Vorwoche, wenn erfüllt und nicht müde
        let minAllowed = lastWeekTarget;

        // kleine Steigerung, wenn Form ok
        if (tsb >= 0) {
          const progFactor = weekState === "Erholt" ? 1.10 : 1.05;
          const progressive = lastWeekTarget * progFactor;
          minAllowed = Math.max(minAllowed, progressive);
        }

        weeklyTargetRaw = Math.max(weeklyTargetRaw, Math.round(minAllowed));
      }

      // Ramp-Cap: Wochenziel zusätzlich gegenüber Vorwoche begrenzen
      if (lastWeekActual != null && lastWeekActual > 0) {
        let rampLimit;
        if (ctlMon < 30) rampLimit = 1.15;      // max +15 % bei sehr niedriger CTL
        else if (ctlMon < 60) rampLimit = 1.10; // max +10 % bei mittlerer CTL
        else rampLimit = 1.08;                  // max +8 % bei hoher CTL

        const maxWeeklyTargetByRamp = lastWeekActual * rampLimit;
        weeklyTargetRaw = Math.min(
          weeklyTargetRaw,
          Math.round(maxWeeklyTargetByRamp)
        );
      }

      weeklyTarget = weeklyTargetRaw;
    }

    // -----------------------------------------------------
    // 5) Wochenload + Mikro-Infos
    // -----------------------------------------------------
    let weekLoad = 0;
    let weekLoadUntilYesterday = 0;
    let weekArr = [];
    const todayTime = todayDate.getTime();

    const weekRes = await fetch(
      `${BASE_URL}/athlete/${athleteId}/wellness?oldest=${mondayStr}&newest=${today}&cols=id,ctlLoad`,
      { headers: { Authorization: authHeader } }
    );
    if (weekRes.ok) {
      weekArr = await weekRes.json();
      for (const d of weekArr) {
        if (!d.id || d.ctlLoad == null) continue;
        const dDate = new Date(d.id + "T00:00:00Z");
        const load = d.ctlLoad;
        if (!isNaN(dDate.getTime())) {
          weekLoad += load;
          if (dDate.getTime() < todayTime) weekLoadUntilYesterday += load;
        }
      }
    } else if (weekRes.body) weekRes.body.cancel?.();

    const weeklyRemaining = Math.max(0, Math.round(weeklyTarget - weekLoad));
    const weekDone = Math.max(0, Math.min(weeklyTarget, weekLoad));

    let weekPercent = 0;
    if (weeklyTarget > 0) weekPercent = Math.round((weekDone / weeklyTarget) * 100);
    weekPercent = Math.max(0, Math.min(200, weekPercent));

    let weekBarFilled = 0;
    if (weeklyTarget > 0) weekBarFilled = Math.round((weekDone / weeklyTarget) * 10);
    weekBarFilled = Math.max(0, Math.min(10, weekBarFilled));
    const weekBar = "█".repeat(weekBarFilled) + "░".repeat(10 - weekBarFilled);

    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const daysSinceMonday = Math.round(
      (todayDate.getTime() - mondayDate.getTime()) / MS_PER_DAY
    );

    const ctlLoadByDate = new Map();
    for (const d of weekArr) {
      if (d.id && d.ctlLoad != null) ctlLoadByDate.set(d.id, d.ctlLoad);
    }

    let daysSinceLastTraining = daysSinceMonday + 1;
    for (let o = 0; o <= daysSinceMonday; o++) {
      const d = new Date(todayDate);
      d.setUTCDate(d.getUTCDate() - o);
      const id = d.toISOString().slice(0, 10);
      const load = ctlLoadByDate.get(id) ?? 0;
      if (load > 0) {
        daysSinceLastTraining = o;
        break;
      }
    }

    let consecutiveTrainingDays = 0;
    for (let o = 1; o <= daysSinceMonday; o++) {
      const d = new Date(todayDate);
      d.setUTCDate(d.getUTCDate() - o);
      const id = d.toISOString().slice(0, 10);
      const load = ctlLoadByDate.get(id) ?? 0;
      if (load > 0) consecutiveTrainingDays++;
      else break;
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
    const todayLoad = ctlLoadByDate.get(today) ?? 0;

    // -----------------------------------------------------
    // 6) Tagesziel – Wochenlogik + Mikro (mit clamp)
    // -----------------------------------------------------
    const trueRemaining = Math.max(0, weeklyTarget - weekLoadUntilYesterday);

    // verbleibende geplante Trainingstage (inkl. heute, falls geplant)
    let remainingPlannedDays = 0;
    for (let i = dayIdx; i < 7; i++) {
      if (planSelected[i]) remainingPlannedDays++;
    }

    let isPlannedTrainingDay = !!planSelected[dayIdx];

    let targetFromWeek = 0;
    let plannedShareToday = 0;
    if (isPlannedTrainingDay && remainingPlannedDays > 0) {
      plannedShareToday = trueRemaining / remainingPlannedDays;
      targetFromWeek = plannedShareToday;
    } else {
      targetFromWeek = 0; // kein Plan-Day → Plan drückt nicht
    }

    // was wäre heute physiologisch möglich (ohne Plan)?
    const baseFromFitness = dailyTargetBase;

    // Basis für das heutige Ziel:
    // - Ruhetage im Plan: wir ignorieren den Plan → nur Fitness
    // - Plantage: mindestens Plan, aber nicht unter Fitness
    let baseForToday = baseFromFitness;
    if (isPlannedTrainingDay && targetFromWeek > 0) {
      baseForToday = Math.max(baseFromFitness, targetFromWeek);
    }

    const combinedBase = baseForToday;

    // TSB-Faktor
    let tsbFactor = 1.0;
    if (tsb >= 10) tsbFactor = 1.3;
    else if (tsb >= 5) tsbFactor = 1.15;
    else if (tsb >= 0) tsbFactor = 1.05;
    else if (tsb <= -15) tsbFactor = 0.5;
    else if (tsb <= -10) tsbFactor = 0.6;
    else if (tsb <= -5) tsbFactor = 0.8;

    // Mikro-Faktor
    let microFactor = 1.0;
    let suggestRestDay = false;

    // nach Pause etwas mehr
    if (daysSinceLastTraining >= 2 && tsb >= 0) microFactor *= 1.2;
    if (daysSinceLastTraining >= 3 && tsb >= 0) microFactor *= 1.1;

    // Serien bremsen
    if (consecutiveTrainingDays >= 3) microFactor *= 0.8;
    if (consecutiveTrainingDays >= 4) microFactor *= 0.7;

    // geplante Trainingstage für Thresholds
    const plannedDaysCount =
      planSelected.filter(Boolean).length || DEFAULT_TRAINING_DAYS_PER_WEEK;
    const avgTrainingDay = weeklyTarget / plannedDaysCount;

    const heavyThreshold = Math.max(1.5 * avgTrainingDay, 60);
    const veryHeavyThreshold = Math.max(2.2 * avgTrainingDay, 90);

    if (yesterdayLoad >= veryHeavyThreshold && tsb <= -5) {
      microFactor *= 0.5;
      suggestRestDay = true;
    } else if (yesterdayLoad >= heavyThreshold && tsb <= 0) {
      microFactor *= 0.7;
    }

    const highTwoDayThreshold = Math.max(3.0 * avgTrainingDay, 120);
    if (last2DaysLoad >= highTwoDayThreshold && tsb <= -5) {
      microFactor *= 0.7;
    }

    // Mikro-Faktor clampen, damit es nicht komplett eskaliert
    microFactor = Math.max(0.6, Math.min(1.4, microFactor));

    let dailyTargetRaw = combinedBase * tsbFactor * microFactor;

    const maxDailyByCtl = ctl * 3.0;
    const maxDailyByWeek = avgTrainingDay * 2.5;

    // Hartes Tages-Cap zusätzlich zu CTL-/Wochen-Caps
    const maxDaily = Math.min(
      HARD_DAILY_CAP,
      Math.max(
        baseFromFitness,
        Math.min(maxDailyByCtl, maxDailyByWeek)
      )
    );

    dailyTargetRaw = Math.max(0, dailyTargetRaw);
    const tssTarget = Math.round(Math.min(dailyTargetRaw, maxDaily));

    const tssLow = Math.round(tssTarget * 0.8);
    const tssHigh = Math.round(tssTarget * 1.2);

    // -----------------------------------------------------
    // 7) Kommentar & Plantext
    // -----------------------------------------------------
    const emojiToday = stateEmoji(weekState);

    const commentText = `Tagesziel-Erklärung

Woche:
Ziel ${weeklyTarget} TSS
Fortschritt [${weekBar}] ${weekPercent}% (${weekLoad.toFixed(1)}/${weeklyTarget})
Geplante Trainingstage: ${planStringForComment || "(keine, Default: " + DEFAULT_PLAN_STRING + ")"}

Status:
CTL ${ctl.toFixed(1)} | ATL ${atl.toFixed(1)} | TSB ${tsb.toFixed(1)}
Wochentyp ${weekState}
Heutiger Plan-Tag: ${isPlannedTrainingDay ? "Ja" : "Nein"}

Mikro:
Tage seit letztem Training ${daysSinceLastTraining}, Serie ${consecutiveTrainingDays}
Gestern ${yesterdayLoad.toFixed(1)} TSS, Vorgestern ${twoDaysAgoLoad.toFixed(1)} TSS
Heute bisher: ${todayLoad.toFixed(1)} TSS
2-Tage-Load: ${last2DaysLoad.toFixed(1)} TSS
Empfehlung: ${
      suggestRestDay
        ? "eher Ruhetag oder nur sehr locker"
        : "normale Belastung möglich"
    }

Rechenweg (Plan vs. Ist):
trueRemaining (Rest vor heute) = ${trueRemaining.toFixed(1)} TSS
verbleibende geplante Trainingstage (inkl. heute, falls geplant): ${remainingPlannedDays}
geplanter Anteil heute (Plan) = ${plannedShareToday.toFixed(1)} TSS
targetFromWeek (Plan-Komponente heute) = ${targetFromWeek.toFixed(1)} TSS

Rechenweg (Tagesziel = was heute möglich wäre):
baseFromFitness (rein aus CTL/ATL) = ${baseFromFitness.toFixed(1)}
Basis für heutiges Ziel (baseForToday) = ${baseForToday.toFixed(1)}
tsbFactor = ${tsbFactor.toFixed(2)}, microFactor = ${microFactor.toFixed(2)}
dailyTargetRaw = ${dailyTargetRaw.toFixed(1)}, maxDaily = ${maxDaily.toFixed(1)}

Tagesziel: ${tssTarget} TSS
Range: ${tssLow}–${tssHigh} TSS (80–120%)`;

    const planTextToday = `Rest ${weeklyRemaining} | ${emojiToday} ${weekState}`;

    const payloadToday = {
      id: today,
      [INTERVALS_TARGET_FIELD]: tssTarget,
      [INTERVALS_PLAN_FIELD]: planTextToday,
      comments: commentText
    };

    // nur Montag schreibt Wochenziel explizit ins Feld, wenn noch nicht gesetzt
    if (today === mondayStr && mondayWeeklyTarget == null) {
      payloadToday[WEEKLY_TARGET_FIELD] = weeklyTarget;
    }

    if (!dryRun) {
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
      } else if (updateRes.body) updateRes.body.cancel?.();
    }

    // -----------------------------------------------------
    // 8) 6-Wochen-Simulation auf Basis HEUTE (nur wenn kein dryRun)
    // -----------------------------------------------------
    const WEEKS_TO_SIM = 6;
    if (!dryRun) {
      await simulatePlannedWeeks(
        ctlMon,            // CTL am Wochenanfang (Montag)
        atlMon,            // ATL am Wochenanfang
        weekState,         // aktueller Wochentyp
        weeklyTarget,      // aktuelles Wochenziel
        mondayDate,        // Date-Objekt des aktuellen Montags
        planSelected,      // bool[7] für Mo..So
        authHeader,
        athleteId,
        WEEKS_TO_SIM,
        dryRun
      );
    }

    // -----------------------------------------------------
    // 9) JSON-Ausgabe für Tests (inkl. Wochen-TSS-Infos)
    // -----------------------------------------------------
    const responseBody = {
      dryRun,
      date: today,
      weeklyTarget,
      weeklyRemaining,
      weekDone,
      weekPercent,
      lastWeek: {
        target: lastWeekTarget,
        actual: lastWeekActual
      },
      ctlMon,
      atlMon,
      ctlToday: ctl,
      atlToday: atl,
      tsb,
      weekState,
      plan: {
        mondayPlanString,
        planSelected: DAY_NAMES.map((n, i) => ({ day: n, selected: !!planSelected[i] })),
        isPlannedTrainingDay,
        remainingPlannedDays
      },
      daily: {
        tssTarget,
        tssLow,
        tssHigh,
        baseFromFitness,
        baseForToday,
        tsbFactor,
        microFactor,
        combinedBase,
        suggestRestDay
      }
    };

    return new Response(JSON.stringify(responseBody, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(
      "Unexpected error: " + (err && err.stack ? err.stack : String(err)),
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------
// EXPORT
// ---------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    return handle(env, request);
  },
  async scheduled(event, env, ctx) {
    // kein Request → dryRun = false
    ctx.waitUntil(handle(env, null));
  }
};
