//----------------------------------------------------------
// CONFIG
//----------------------------------------------------------
const BASE_URL = "https://intervals.icu/api/v1";
const API_KEY = "API_KEY"; // später ersetzen
const API_SECRET = "1xg1v04ym957jsqva8720oo01";
const ATHLETE_ID = "i105857";

const WEEKLY_TARGET_FIELD = "WochenzielTSS";
const PLAN_FIELD = "WochenPlan";

//----------------------------------------------------------
// TRAINING LOAD / CTL / ATL Logik
//----------------------------------------------------------

// feste Ramp pro Woche
const CTL_DELTA_TARGET = 0.8;

// ACWR
const ACWR_SOFT_MAX = 1.3; // Zielbereich
const ACWR_HARD_MAX = 1.5; // Deload

// Deload-Faktor
const DELOAD_FACTOR = 0.9;

// ATL-Obergrenzen je Fitness-Level
function getAtlMax(ctl) {
  if (ctl < 30) return 30;
  if (ctl < 60) return 45;
  if (ctl < 90) return 65;
  return 85;
}

function shouldDeload(ctl, atl) {
  const atlMax = getAtlMax(ctl);
  const acwr = ctl > 0 ? atl / ctl : null;

  if (acwr != null && acwr >= ACWR_HARD_MAX) return true;
  if (atl > atlMax) return true;

  return false;
}

// maximal tolerierbare CTL-Steigerung
function maxSafeCtlDelta(ctl) {
  if (ctl <= 0) return CTL_DELTA_TARGET;

  const numerator = (ACWR_SOFT_MAX - 1) * ctl;
  const denominator = 6 - ACWR_SOFT_MAX;

  return numerator / denominator;
}

function computeWeekFromCtlDelta(ctl, atl, ctlDelta) {
  const tssMean = ctl + 6 * ctlDelta;
  const weekTss = tssMean * 7;

  const nextCtl = ctl + ctlDelta;
  const nextAtl = tssMean;
  const acwr = nextCtl > 0 ? nextAtl / nextCtl : null;

  return {
    weekType: ctlDelta > 0 ? "BUILD" : "MAINTAIN",
    ctlDelta,
    weekTss,
    nextCtl,
    nextAtl,
    acwr
  };
}

function computeDeloadWeek(ctl, atl) {
  const tssMean = DELOAD_FACTOR * ctl;
  const weekTss = tssMean * 7;

  const ctlDelta = (tssMean - ctl) / 6;
  const nextCtl = ctl + ctlDelta;
  const nextAtl = tssMean;
  const acwr = nextCtl > 0 ? nextAtl / nextCtl : null;

  return {
    weekType: "DELOAD",
    ctlDelta,
    weekTss,
    nextCtl,
    nextAtl,
    acwr
  };
}

function calcNextWeekTarget(ctl, atl) {
  if (shouldDeload(ctl, atl)) {
    return computeDeloadWeek(ctl, atl);
  }

  const dMaxSafe = maxSafeCtlDelta(ctl);
  let targetDelta = CTL_DELTA_TARGET;

  if (!isFinite(dMaxSafe) || dMaxSafe <= 0) {
    targetDelta = 0;
  } else if (dMaxSafe < targetDelta) {
    targetDelta = dMaxSafe;
  }

  return computeWeekFromCtlDelta(ctl, atl, targetDelta);
}

function simulateFutureWeeks(ctl, atl, mondayDate, weeks, week0) {
  const progression = [];
  let c = week0.nextCtl;
  let a = week0.nextAtl;

  for (let w = 1; w <= weeks; w++) {
    const res = calcNextWeekTarget(c, a);

    const d = new Date(mondayDate);
    d.setUTCDate(d.getUTCDate() + 7 * w);

    progression.push({
      weekOffset: w,
      monday: d.toISOString().slice(0, 10),
      weekType: res.weekType,
      weeklyTargetTss: Math.round(res.weekTss),
      ctl: res.nextCtl,
      atl: res.nextAtl,
      ctlDelta: res.ctlDelta,
      acwr: res.acwr
    });

    c = res.nextCtl;
    a = res.nextAtl;
  }

  return progression;
}

//----------------------------------------------------------
// HELPER
//----------------------------------------------------------
function median(values) {
  if (!values || values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

//----------------------------------------------------------
// STREAMS & DECOUPLING
//----------------------------------------------------------

async function loadStreams(id, authHeader) {
  const res = await fetch(
    `${BASE_URL}/activity/${id}/streams?types=time,distance,velocity,velocity_smooth,heartrate,pace`,
    { headers: { Authorization: authHeader } }
  );

  if (!res.ok) return null;
  return res.json();
}

function getSpeedStream(streams) {
  if (streams.velocity) return streams.velocity;
  if (streams.velocity_smooth) return streams.velocity_smooth;

  // Intervals pace = seconds per km → speed = 1000 / paceSeconds
  if (streams.pace) return streams.pace.map(p => (p > 0 ? 1000 / p : 0));

  // fallback: speed aus distance/time differenzen
  if (streams.distance && streams.time) {
    const dist = streams.distance;
    const time = streams.time;
    const speed = [];

    for (let i = 1; i < dist.length; i++) {
      const d = dist[i] - dist[i - 1];
      const t = time[i] - time[i - 1];
      speed.push(t > 0 ? d / t : 0);
    }
    return speed;
  }

  return null;
}

function computeDecouplingFromStreams(streams) {
  if (!streams || !streams.heartrate) return null;

  const hr = streams.heartrate;
  if (hr.length < 100) return null;

  const speed = getSpeedStream(streams);
  if (!speed || speed.length < hr.length / 2) return null;

  const pacePerHr = speed.map((s, i) => {
    const sp = Math.max(s, 0.5);
    const h = Math.max(hr[i], 40);
    return sp / h;
  });

  const mid = Math.floor(pacePerHr.length / 2);
  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

  const avg1 = avg(pacePerHr.slice(0, mid));
  const avg2 = avg(pacePerHr.slice(mid));

  return (avg2 - avg1) / avg1; // Beispiel: 0.05 = 5 %
}

//----------------------------------------------------------
// RUN FILTER (GA-Läufe)
//----------------------------------------------------------
function isGaRunForDecoupling(a, hrMaxGlobal) {
  const type = (a.type || "").toLowerCase();
  if (!type.includes("run")) return false;

  const hrAvg = a.average_heartrate;
  const hrMax = a.max_heartrate;
  if (!hrAvg || !hrMax) return false;

  const duration =
    a.moving_time ?? a.elapsed_time ?? a.icu_recording_time ?? 0;
  if (duration < 45 * 60) return false;

  const athleteMax = a.athlete_max_hr ?? hrMaxGlobal;
  const relAvg = hrAvg / athleteMax;
  const relMax = hrMax / athleteMax;

  if (relAvg < 0.70 || relAvg > 0.80) return false;
  if (relMax > 0.85) return false;

  const name = (a.name || "").toLowerCase();
  if (/hit|intervall|interval|schwelle|vo2|max|berg|30|15/i.test(name)) {
    return false;
  }

  return true;
}

//----------------------------------------------------------
// RUN DECOUPLING STATS
//----------------------------------------------------------
async function extractRunDecouplingStats(activities, hrMaxGlobal, authHeader) {
  let gaCount = 0;
  let gaWithDrift = 0;
  const drifts = [];

  for (const a of activities) {
    if (!isGaRunForDecoupling(a, hrMaxGlobal)) continue;
    gaCount++;

    const streams = await loadStreams(a.id, authHeader);
    if (!streams) continue;

    const drift = computeDecouplingFromStreams(streams);
    if (drift == null) continue;

    drifts.push(drift);
    gaWithDrift++;
  }

  return {
    medianDrift: median(drifts),
    count: drifts.length,
    gaCount,
    gaWithDrift
  };
}

//----------------------------------------------------------
// PHASE LOGIK
//----------------------------------------------------------
function decidePhaseFromRunDecoupling(d) {
  if (d == null) return "Grundlage";

  if (d > 0.07) return "Grundlage";
  if (d > 0.04) return "Aufbau";
  return "Spezifisch";
}

//----------------------------------------------------------
// MAIN HANDLER
//----------------------------------------------------------
async function handle(dryRun = true) {
  try {
    const authHeader = "Basic " + btoa(`${API_KEY}:${API_SECRET}`);

    const today = new Date().toISOString().slice(0, 10);
    const todayObj = new Date(today + "T00:00:00Z");

    const offset = (todayObj.getUTCDay() + 6) % 7;
    const monday = new Date(todayObj);
    monday.setUTCDate(monday.getUTCDate() - offset);
    const mondayStr = monday.toISOString().slice(0, 10);

    // Wellness (CTL/ATL)
    const wRes = await fetch(
      `${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${today}`,
      { headers: { Authorization: authHeader } }
    );
    const well = await wRes.json();

    const ctl = well.ctl ?? 0;
    const atl = well.atl ?? 0;
    const hrMaxGlobal = well.hrMax ?? well.max_hr ?? 173;

    // Activities 28 Tage
    const start28 = new Date(monday);
    start28.setUTCDate(start28.getUTCDate() - 28);
    const start28Str = start28.toISOString().slice(0, 10);

    const actRes = await fetch(
      `${BASE_URL}/athlete/${ATHLETE_ID}/activities?oldest=${start28Str}&newest=${today}`,
      { headers: { Authorization: authHeader } }
    );
    const activities = await actRes.json();

    // Decoupling berechnen
    const decStats = await extractRunDecouplingStats(activities, hrMaxGlobal, authHeader);
    const phase = decidePhaseFromRunDecoupling(decStats.medianDrift);

    // Wochenziel berechnen
    const thisWeekPlan = calcNextWeekTarget(ctl, atl);
    const weeklyTargetTss = Math.round(thisWeekPlan.weekTss);

    const progression = simulateFutureWeeks(
      ctl,
      atl,
      monday,
      6,
      thisWeekPlan
    );

    // Schreiben am Montag
    if (!dryRun) {
      const body = {
        [WEEKLY_TARGET_FIELD]: weeklyTargetTss,
        [PLAN_FIELD]: phase
      };

      await fetch(
        `${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${mondayStr}`,
        {
          method: "PUT",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        }
      );
    }

    return new Response(JSON.stringify({
      dryRun,
      thisWeek: {
        monday: mondayStr,
        ctl,
        atl,
        atlMax: getAtlMax(ctl),
        hrMaxGlobal,
        weekType: thisWeekPlan.weekType,
        weeklyTargetTss,
        ctlDelta: thisWeekPlan.ctlDelta,
        acwr: thisWeekPlan.acwr,
        phase,
        runDecoupling: {
          ...decStats,
          medianDriftPercent: decStats.medianDrift != null ? decStats.medianDrift * 100 : null,
          totalActivities: activities.length
        }
      },
      progression
    }, null, 2), { status: 200 });

  } catch (err) {
    return new Response("Error: " + err, { status: 500 });
  }
}

// Worker Export
export default {
  async fetch(request, env, ctx) {
    return handle(true);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handle(false));
  }
};
