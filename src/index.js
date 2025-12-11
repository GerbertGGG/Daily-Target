// index.js
// Vollständiger Worker-Code mit Marker-Vergleich (letzte Woche / diese Woche / letzte 42 Tage)
// Achtung: API_KEY etc. wie in deinem Original übernehmen

var BASE_URL = "https://intervals.icu/api/v1";
var INTERVALS_API_KEY = "1xg1v04ym957jsqva8720oo01";
var INTERVALS_ATHLETE_ID = "i105857";
var INTERVALS_PLAN_FIELD = "WochenPlan";
var WEEKLY_TARGET_FIELD = "WochenzielTSS";
var DAILY_TYPE_FIELD = "TagesTyp";
var DEFAULT_PLAN_STRING = "Mo,Mi,Fr,So";

function dayIdxFromJsDay(jsDay) {
  return jsDay === 0 ? 6 : jsDay - 1;
}

// Trainings-Tage parsen (z. B. "Mo,Mi,Fr")
function parseTrainingDays(str) {
  if (!str || typeof str !== "string") return new Array(7).fill(false);
  const tokens = str.split(/[,\s;]+/).map((t) => t.trim()).filter((t) => t.length > 0);
  const selected = new Array(7).fill(false);
  for (const raw of tokens) {
    const t = raw.toLowerCase();
    const num = parseInt(t, 10);
    if (!isNaN(num) && num >= 1 && num <= 7) {
      selected[num - 1] = true;
      continue;
    }
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
  return state === "Erholt" ? "\u{1F525}" : state === "Müde" ? "\u{1F9D8}" : "\u2696\uFE0F";
}

function computeDailyTarget(ctl, atl) {
  const tsb = ctl - atl;
  const tsbClamped = Math.max(-20, Math.min(20, tsb));
  const base = 1, k = 0.05;
  const daily = ctl * (base + k * tsbClamped);
  return Math.round(Math.max(0, Math.min(daily, ctl * 1.5)));
}

function classifyWeek(ctl, atl, rampRate) {
  const tsb = ctl - atl;
  let tsbCritical = ctl < 50 ? -5 : ctl < 80 ? -10 : -15;
  const isTsbTired = tsb <= tsbCritical;
  const atlCtlRatio = ctl > 0 ? atl / ctl : Infinity;
  const atlRatioThreshold = ctl < 50 ? 1.2 : ctl < 80 ? 1.3 : 1.4;
  const isAtlHigh = atlCtlRatio >= atlRatioThreshold;
  const isRampHigh = rampRate >= 1;
  const isRampLowAndFresh = rampRate <= -0.5 && tsb >= -5;
  if (isRampLowAndFresh) return { state: "Erholt", tsb };
  if (isRampHigh || isTsbTired || isAtlHigh) return { state: "Müde", tsb };
  return { state: "Normal", tsb };
}

// Robuste Datumserkennung aus einer Unit (verschiedene API-Formate)
function getUnitDate(u) {
  if (!u || typeof u !== "object") return null;

  // gängige Feldnamen prüfen
  const candidates = [
    u.start, u.start_time, u.startTime, u.timestamp, u.date, u.isoDate, u.day, u.started_at, u.begin, u.time
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const d = new Date(c);
      if (!isNaN(d.getTime())) return d;
    } catch (e) {}
  }

  // Falls numerische Zeitstempel vorhanden sind (Unix sec / ms)
  for (const k of Object.keys(u)) {
    const val = u[k];
    if (typeof val === "number") {
      // heuristik: > 1e12 => ms, > 1e9 => s
      if (val > 1e12) {
        const d = new Date(val);
        if (!isNaN(d.getTime())) return d;
      } else if (val > 1e9) {
        const d = new Date(val * 1000);
        if (!isNaN(d.getTime())) return d;
      }
    }
    // manchmal ist das Datum als string in anderen Feldern: versuche parse
    if (typeof val === "string") {
      const d = new Date(val);
      if (!isNaN(d.getTime())) return d;
    }
  }

  return null;
}

// computeMarkers: Mittelwerte für decoupling und pdc (decoupling = GA1 >=20min)
function computeMarkers(units) {
  if (!Array.isArray(units)) return { decoupling: null, pdc: null };
  const gaUnits = units.filter((u) => u && (u.zone === "GA1" || u.zone === "ga1" || u.zone === "Ga1") && (u.duration ?? 0) >= 20);
  const decoupling = gaUnits.length > 0
    ? gaUnits.reduce((sum, u) => sum + (u.hrDecoupling ?? 0), 0) / gaUnits.length
    : null;
  const pdc = units.length > 0
    ? units.reduce((sum, u) => sum + (u.pdc ?? 0), 0) / units.length
    : null;
  return { decoupling, pdc };
}

// Marker innerhalb eines Datumsbereichs berechnen (inklusive)
function computeMarkersInRange(allUnits, startDate, endDate) {
  if (!Array.isArray(allUnits)) return { decoupling: null, pdc: null };
  const startT = startDate.getTime();
  const endT = endDate.getTime();
  const filtered = allUnits.filter(u => {
    const d = getUnitDate(u);
    if (!d) return false;
    const t = d.getTime();
    return t >= startT && t <= endT;
  });
  return computeMarkers(filtered);
}

function fmtMarker(v) {
  if (v == null) return "keine Daten";
  if (typeof v === "number") return Number.isInteger(v) ? v.toString() : v.toFixed(2);
  return String(v);
}

function recommendWeekPhase(lastWeekMarkers, simState) {
  // lastWeekMarkers erwartet { decoupling, pdc }
  const decoupling = lastWeekMarkers?.decoupling ?? 999;
  const pdc = lastWeekMarkers?.pdc ?? 0;
  let phase = "Aufbau";
  if (decoupling > 5) phase = "Grundlage";
  else if (pdc < 0.9) phase = "Intensiv";
  else phase = "Aufbau";
  if (simState === "Müde") phase = "Erholung";
  return phase;
}

// simulatePlannedWeeks: Hauptlogik zur Simulation und Schreiben der Wochen
async function simulatePlannedWeeks(ctlStart, atlStart, weekStateStart, weeklyTargetStart, mondayDate, planSelected, authHeader, athleteId, units, weeksToSim) {
  const tauCtl = 42, tauAtl = 7;
  let dayWeights = new Array(7).fill(0), countSelected = 0;
  for (let i = 0; i < 7; i++) if (planSelected[i]) {
    dayWeights[i] = 1;
    countSelected++;
  }
  if (countSelected === 0) {
    dayWeights = [1, 0, 1, 0, 1, 0, 1];
    countSelected = 4;
  }
  const sumWeights = dayWeights.reduce((a, b) => a + b, 0);
  let ctl = ctlStart, atl = atlStart, prevTarget = weeklyTargetStart, prevState = weekStateStart;
  const weeklyProgression = [];

  for (let w = 1; w <= weeksToSim; w++) {
    const ctlWeekStart = ctl;
    // Simuliere die Woche Tag-für-Tag
    for (let d = 0; d < 7; d++) {
      const share = dayWeights[d] / sumWeights;
      const load = prevTarget * share;
      ctl += (load - ctl) / tauCtl;
      atl += (load - atl) / tauAtl;
    }
    const ctlEnd = ctl, atlEnd = atl;
    const rampSim = ctlEnd - ctlWeekStart;
    const { state: simState } = classifyWeek(ctlEnd, atlEnd, rampSim);

    // Multiplier basierend auf Zustand / Ramp
    let multiplier = 1;
    if (simState === "Müde") multiplier = 0.8;
    else if (rampSim < 0.5) multiplier = simState === "Erholt" ? 1.12 : 1.08;
    else if (rampSim < 1) multiplier = simState === "Erholt" ? 1.08 : 1.05;
    else if (rampSim <= 1.5) multiplier = 1.02;
    else multiplier = 0.9;

    let nextTarget = prevTarget * multiplier;
    nextTarget = Math.max(prevTarget * 0.75, Math.min(prevTarget * 1.25, nextTarget));
    nextTarget = Math.round(nextTarget / 5) * 5;

    // Datum für diese zukünftige Montags-Woche
    const mondayFutureDate = new Date(mondayDate);
    mondayFutureDate.setUTCDate(mondayFutureDate.getUTCDate() + 7 * w);
    const mondayId = mondayFutureDate.toISOString().slice(0, 10);

    // Datumsbereiche definieren:
    // letzte Woche vor dem Monday: monday-7 .. monday-1
    const lastWeekStart = new Date(mondayFutureDate);
    lastWeekStart.setUTCDate(lastWeekStart.getUTCDate() - 7);
    const lastWeekEnd = new Date(mondayFutureDate);
    lastWeekEnd.setUTCDate(lastWeekEnd.getUTCDate() - 1);

    // diese Woche (Woche des Monday): monday .. monday+6
    const thisWeekStart = new Date(mondayFutureDate);
    const thisWeekEnd = new Date(mondayFutureDate);
    thisWeekEnd.setUTCDate(thisWeekEnd.getUTCDate() + 6);

    // letzte 42 Tage vor dem Monday: monday-42 .. monday-1
    const days42Start = new Date(mondayFutureDate);
    days42Start.setUTCDate(days42Start.getUTCDate() - 42);
    const days42End = new Date(mondayFutureDate);
    days42End.setUTCDate(days42End.getUTCDate() - 1);

    // Marker berechnen
    const markersLastWeek = computeMarkersInRange(units, lastWeekStart, lastWeekEnd);
    const markersThisWeek = computeMarkersInRange(units, thisWeekStart, thisWeekEnd);
    const markers42 = computeMarkersInRange(units, days42Start, days42End);

    const decLast = fmtMarker(markersLastWeek.decoupling);
    const pdcLast = fmtMarker(markersLastWeek.pdc);
    const decThis = fmtMarker(markersThisWeek.decoupling);
    const pdcThis = fmtMarker(markersThisWeek.pdc);
    const dec42 = fmtMarker(markers42.decoupling);
    const pdc42 = fmtMarker(markers42.pdc);

    // Phase-Entscheidung: du kannst das Input-Set auswählen; hier nutze ich lastWeek als Default
    const phase = recommendWeekPhase(markersLastWeek, simState);
    const emoji = stateEmoji(simState);
    const planText = `Rest ${nextTarget} | ${emoji} ${simState} | Phase: ${phase}`;

    const comments = `Automatische Wochenphase: ${phase}
Decoupling (letzte Woche): ${decLast}, PDC (letzte Woche): ${pdcLast}
Decoupling (diese Woche): ${decThis}, PDC (diese Woche): ${pdcThis}
Decoupling (letzte 42 Tage): ${dec42}, PDC (letzte 42 Tage): ${pdc42}`;

    const payloadFuture = {
      id: mondayId,
      [WEEKLY_TARGET_FIELD]: nextTarget,
      [INTERVALS_PLAN_FIELD]: planText,
      comments
    };

    // Versuche das Wellness-Objekt für die Zukunft zu schreiben
    try {
      const resFuture = await fetch(`${BASE_URL}/athlete/${athleteId}/wellness/${mondayId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify(payloadFuture)
      });
      if (!resFuture.ok) {
        const txt = await resFuture.text();
        console.error("Failed to update future wellness:", mondayId, resFuture.status, txt);
      } else if (resFuture.body) {
        // keine Aktion nötig, ggf. Body stream schließen
        resFuture.body.cancel?.();
      }
    } catch (e) {
      console.error("Error updating future week:", e);
    }

    prevTarget = nextTarget;
    prevState = simState;
    weeklyProgression.push({ weekOffset: w, monday: mondayId, weeklyTarget: nextTarget, state: simState, phase });
  }

  return weeklyProgression;
}

// Haupt-Handler
async function handle(env) {
  try {
    const apiKey = INTERVALS_API_KEY;
    const athleteId = INTERVALS_ATHLETE_ID;
    if (!apiKey || !athleteId) return new Response("Missing config", { status: 500 });
    const authHeader = "Basic " + btoa(`API_KEY:${apiKey}`);

    const now = new Date();
    const today = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const todayDate = new Date(today + "T00:00:00Z");
    const jsDay = todayDate.getUTCDay();
    const dayIdx = dayIdxFromJsDay(jsDay);
    const offset = jsDay === 0 ? 6 : jsDay - 1;
    const mondayDate = new Date(todayDate);
    mondayDate.setUTCDate(mondayDate.getUTCDate() - offset);
    const mondayStr = mondayDate.toISOString().slice(0, 10);

    // Wellness abrufen
    const wellnessRes = await fetch(`${BASE_URL}/athlete/${athleteId}/wellness/${today}`, { headers: { Authorization: authHeader } });
    if (!wellnessRes.ok) {
      const text = await wellnessRes.text();
      return new Response(`Failed to fetch wellness today: ${wellnessRes.status} ${text}`, { status: 500 });
    }
    const wellness = await wellnessRes.json();
    const ctl = wellness.ctl, atl = wellness.atl;
    const rampRate = wellness.rampRate ?? 0;
    if (ctl == null || atl == null) return new Response("No ctl/atl data", { status: 200 });

    const { state: weekState, tsb } = classifyWeek(ctl, atl, rampRate);
    const dailyTargetBase = computeDailyTarget(ctl, atl);
    const planSelected = parseTrainingDays(wellness[DAILY_TYPE_FIELD] ?? DEFAULT_PLAN_STRING);
    const weeklyTargetStart = wellness[WEEKLY_TARGET_FIELD] ?? Math.round(dailyTargetBase * 7);
    const units = wellness.units ?? [];

    const weeklyProgression = await simulatePlannedWeeks(
      ctl,
      atl,
      weekState,
      weeklyTargetStart,
      mondayDate,
      planSelected,
      authHeader,
      athleteId,
      units,
      6
    );

    return new Response(JSON.stringify({
      dryRun: true,
      thisWeek: { monday: mondayStr, weeklyTarget: weeklyTargetStart, alreadyDone: 0, remaining: weeklyTargetStart },
      weeklyProgression
    }, null, 2), { status: 200 });
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response("Unexpected error: " + (err.stack ?? String(err)), { status: 500 });
  }
}

export default {
  async fetch(request, env, ctx) {
    return handle(env);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handle(env));
  }
};
