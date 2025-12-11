//----------------------------------------------------------
// CONFIG
//----------------------------------------------------------
const BASE_URL = "https://intervals.icu/api/v1";
const API_KEY = "API_KEY";     // später als Secret
const API_SECRET = "1xg1v04ym957jsqva8720oo01";
const ATHLETE_ID = "i105857";

const WEEKLY_TARGET_FIELD = "WochenzielTSS";
const PLAN_FIELD = "WochenPlan"; 

//----------------------------------------------------------
// CTL-/ATL-Logik
//----------------------------------------------------------

const CTL_DELTA_TARGET = 0.8;

const ACWR_SOFT_MAX = 1.3;
const ACWR_HARD_MAX = 1.5;

const DELOAD_FACTOR = 0.9;

function getAtlMax(ctl) {
  if (ctl < 30) return 30;
  if (ctl < 60) return 45;
  if (ctl < 90) return 65;
  return 85;
}

function shouldDeload(ctl, atl) {
  const atlMax = getAtlMax(ctl);
  let acwr = ctl > 0 ? atl / ctl : null;

  if (acwr != null && acwr >= ACWR_HARD_MAX) return true;
  if (atl > atlMax) return true;

  return false;
}

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
    tssMean,
    nextCtl,
    nextAtl,
    acwr
  };
}

function computeDeloadWeek(ctl) {
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
    tssMean,
    nextCtl,
    nextAtl,
    acwr
  };
}

function calcNextWeekTarget(ctl, atl) {
  if (shouldDeload(ctl, atl)) return computeDeloadWeek(ctl);

  const dMaxSafe = maxSafeCtlDelta(ctl);
  let d = CTL_DELTA_TARGET;

  if (!isFinite(dMaxSafe) || dMaxSafe <= 0) {
    d = 0;
  } else if (dMaxSafe < d) {
    d = dMaxSafe;
  }

  return computeWeekFromCtlDelta(ctl, atl, d);
}

function simulateFutureWeeks(ctlStart, atlStart, mondayDate, weeks, week0) {
  const progression = [];
  let ctl = week0.nextCtl;
  let atl = week0.nextAtl;

  for (let w = 1; w <= weeks; w++) {
    const week = calcNextWeekTarget(ctl, atl);

    const monday = new Date(mondayDate);
    monday.setUTCDate(monday.getUTCDate() + 7 * w);
    const mondayStr = monday.toISOString().slice(0, 10);

    progression.push({
      weekOffset: w,
      monday: mondayStr,
      weekType: week.weekType,
      weeklyTargetTss: Math.round(week.weekTss),
      ctl: week.nextCtl,
      atl: week.nextAtl,
      ctlDelta: week.ctlDelta,
      acwr: week.acwr
    });

    ctl = week.nextCtl;
    atl = week.nextAtl;
  }

  return progression;
}

//----------------------------------------------------------
// Utility
//----------------------------------------------------------
function median(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

//----------------------------------------------------------
// DECOUPLING FROM STREAMS (Pa:Hr Drift)
//----------------------------------------------------------

async function computeDecouplingFromStreams(activityId, authHeader) {
  const res = await fetch(
    `${BASE_URL}/activity/${activityId}/stream?types=time,heartrate,velocity_smooth`,
    { headers: { Authorization: authHeader } }
  );

  if (!res.ok) return null;
  const data = await res.json();

  const time = data.time;
  const hr = data.heartrate;
  const vel = data.velocity_smooth;

  if (!time || !hr || !vel || hr.length < 100) return null;

  const pacePerHr = vel.map((v, i) => {
    const speed = Math.max(v, 0.5);
    const hrVal = Math.max(hr[i], 40);
    return speed / hrVal;
  });

  const mid = Math.floor(pacePerHr.length / 2);
  const avg1 = pacePerHr.slice(0, mid).reduce((a, b) => a + b) / mid;
  const avg2 = pacePerHr.slice(mid).reduce((a, b) => a + b) / (pacePerHr.length - mid);

  return (avg2 - avg1) / avg1;
}

//----------------------------------------------------------
// GA-RUN FILTER
//----------------------------------------------------------

function isGaRunForDecoupling(a, hrMaxGlobal) {
  if (!a.type || !a.type.toLowerCase().includes("run")) return false;

  const hrAvg = a.average_heartrate;
  const hrMax = a.max_heartrate;
  if (!hrAvg || !hrMax) return false;

  const dur = a.moving_time ?? a.elapsed_time ?? a.icu_recording_time ?? 0;
  if (dur < 45 * 60) return false;

  const athleteMax = a.athlete_max_hr ?? hrMaxGlobal;
  const relAvg = hrAvg / athleteMax;
  const relMax = hrMax / athleteMax;

  if (relAvg < 0.70 || relAvg > 0.78) return false;
  if (relMax > 0.85) return false;

  const name = (a.name || "").toLowerCase();
  if (/hit|intervall|interval|schwelle|vo2|max|berg|30s|30\/15|15\/15/i.test(name)) {
    return false;
  }

  return true;
}

//----------------------------------------------------------
// FIND Decoupling (Activity field fallback)
//----------------------------------------------------------

function findRunDecoupling(a) {
  const keys = ["pahr_decoupling", "pa_hr_decoupling", "decoupling"];
  for (const k of keys) {
    const v = a[k];
    if (typeof v === "number" && isFinite(v)) {
      let x = Math.abs(v);
      if (x > 1) x /= 100; 
      return x;
    }
  }
  return null;
}

//----------------------------------------------------------
// Extract Statistics
//----------------------------------------------------------

async function extractRunDecouplingStats(activities, hrMax, authHeader) {
  const drifts = [];
  let gaCount = 0;
  let gaWithDrift = 0;

  for (const a of activities) {
    if (!isGaRunForDecoupling(a, hrMax)) continue;
    gaCount++;

    let drift = findRunDecoupling(a);
    if (drift == null) {
      drift = await computeDecouplingFromStreams(a.id, authHeader);
    }

    if (drift == null || !isFinite(drift)) continue;

    gaWithDrift++;
    drifts.push(drift);
  }

  return {
    medianDrift: median(drifts),
    count: drifts.length,
    gaCount,
    gaWithDrift
  };
}

//----------------------------------------------------------
// Phase Detection
//----------------------------------------------------------
function decidePhaseFromRunDecoupling(medianDrift) {
  if (medianDrift == null) return "Grundlage";
  if (medianDrift > 0.07) return "Grundlage";
  if (medianDrift > 0.04) return "Aufbau";
  return "Spezifisch";
}

//----------------------------------------------------------
// MAIN HANDLER
//----------------------------------------------------------

async function handle(dryRun = true) {
  try {
    const auth = "Basic " + btoa(`${API_KEY}:${API_SECRET}`);

    const today = new Date().toISOString().slice(0, 10);
    const todayObj = new Date(today + "T00:00:00Z");

    const offset = (todayObj.getUTCDay() + 6) % 7;
    const monday = new Date(todayObj);
    monday.setUTCDate(monday.getUTCDate() - offset);
    const mondayStr = monday.toISOString().slice(0, 10);

    const wRes = await fetch(
      `${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${today}`,
      { headers: { Authorization: auth } }
    );

    const well = await wRes.json();
    const ctl = well.ctl ?? 0;
    const atl = well.atl ?? 0;
    const hrMaxGlobal = well.hrMax ?? well.max_hr ?? 173;

    const start28 = new Date(monday);
    start28.setUTCDate(start28.getUTCDate() - 28);
    const start28Str = start28.toISOString().slice(0, 10);

    const actRes = await fetch(
      `${BASE_URL}/athlete/${ATHLETE_ID}/activities?oldest=${start28Str}&newest=${today}`,
      { headers: { Authorization: auth } }
    );
    let activities = await actRes.json();
    if (!Array.isArray(activities)) activities = Object.values(activities);

    const decStats = await extractRunDecouplingStats(activities, hrMaxGlobal, auth);
    const phase = decidePhaseFromRunDecoupling(decStats.medianDrift);

    const thisWeek = calcNextWeekTarget(ctl, atl);
    const weeklyTss = Math.round(thisWeek.weekTss);

    const progression = simulateFutureWeeks(ctl, atl, monday, 6, thisWeek);

    return new Response(JSON.stringify({
      dryRun,
      thisWeek: {
        monday: mondayStr,
        ctl,
        atl,
        atlMax: getAtlMax(ctl),
        hrMaxGlobal,
        weekType: thisWeek.weekType,
        weeklyTargetTss: weeklyTss,
        ctlDelta: thisWeek.ctlDelta,
        acwr: thisWeek.acwr,
        phase,
        runDecoupling: {
          ...decStats,
          medianDriftPercent: decStats.medianDrift ? decStats.medianDrift * 100 : null,
          totalActivities: activities.length
        }
      },
      progression
    }, null, 2));

  } catch (err) {
    console.error(err);
    return new Response("Error: " + err, { status: 500 });
  }
}

//----------------------------------------------------------
// EXPORT
//----------------------------------------------------------
export default {
  async fetch() {
    return handle(true);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handle(false));
  }
};
