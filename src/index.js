//----------------------------------------------------------
// CONFIG
//----------------------------------------------------------
const BASE_URL = "https://intervals.icu/api/v1";
const API_KEY = "API_KEY";     
const API_SECRET = "1xg1v04ym957jsqva8720oo01";  
const ATHLETE_ID = "i105857";

const WEEKLY_TARGET_FIELD = "WochenzielTSS";
const PLAN_FIELD = "WochenPlan"; // Phase: Grundlage | Aufbau | Spezifisch

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
  return ((ACWR_SOFT_MAX - 1) * ctl) / (6 - ACWR_SOFT_MAX);
}

function computeWeekFromCtlDelta(ctl, atl, delta) {
  const tssMean = ctl + 6 * delta;
  const weekTss = tssMean * 7;

  const nextCtl = ctl + delta;
  const nextAtl = tssMean;
  const acwr = nextAtl / nextCtl;

  return {
    weekType: delta > 0 ? "BUILD" : "MAINTAIN",
    ctlDelta: delta,
    weekTss,
    tssMean,
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
  const acwr = nextAtl / nextCtl;

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
  if (shouldDeload(ctl, atl)) {
    return computeDeloadWeek(ctl, atl);
  }

  const dMaxSafe = maxSafeCtlDelta(ctl);
  let delta = CTL_DELTA_TARGET;

  if (!isFinite(dMaxSafe) || dMaxSafe <= 0) {
    delta = 0;
  } else if (dMaxSafe < delta) {
    delta = dMaxSafe;
  }

  return computeWeekFromCtlDelta(ctl, atl, delta);
}

function simulateFutureWeeks(ctl, atl, mondayDate, weeks, week0) {
  const progression = [];

  let nextCtl = week0.nextCtl;
  let nextAtl = week0.nextAtl;

  for (let i = 1; i <= weeks; i++) {
    const res = calcNextWeekTarget(nextCtl, nextAtl);

    const future = new Date(mondayDate);
    future.setUTCDate(future.getUTCDate() + 7 * i);
    const mondayStr = future.toISOString().slice(0, 10);

    progression.push({
      weekOffset: i,
      monday: mondayStr,
      weekType: res.weekType,
      weeklyTargetTss: Math.round(res.weekTss),
      ctl: res.nextCtl,
      atl: res.nextAtl,
      ctlDelta: res.ctlDelta,
      acwr: res.acwr
    });

    nextCtl = res.nextCtl;
    nextAtl = res.nextAtl;
  }

  return progression;
}

//----------------------------------------------------------
// Utility
//----------------------------------------------------------
function median(values) {
  if (!values || values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

//----------------------------------------------------------
// RUN-DECOUPLING LOGIC (with Streams!)
//----------------------------------------------------------

function isGaRunForDecoupling(a, hrMaxGlobal) {
  const type = (a.type || "").toLowerCase();
  if (!type.includes("run")) return false;

  const avg = a.average_heartrate;
  const max = a.max_heartrate;
  if (!avg || !max) return false;

  const duration = a.moving_time ?? a.elapsed_time ?? 0;
  if (duration < 45 * 60) return false;

  const hrMax = a.athlete_max_hr ?? hrMaxGlobal ?? 173;
  const relAvg = avg / hrMax;
  const relMax = max / hrMax;

  if (relAvg < 0.70 || relAvg > 0.78) return false;
  if (relMax > 0.85) return false;

  const name = (a.name || "").toLowerCase();
  if (/hit|interval|intervall|schwelle|30s|15\/15|berg|vo2|max/.test(name)) {
    return false;
  }

  return true;
}

async function loadStreams(id, authHeader) {
  const url = `${BASE_URL}/activity/${id}/streams?types=time,heartrate,velocity_smooth`;
  const res = await fetch(url, {
    headers: { Authorization: authHeader }
  });

  if (!res.ok) return null;
  return res.json();
}

function computeDecouplingFromStreams(streams) {
  if (
    !streams ||
    !streams.time ||
    !streams.heartrate ||
    !streams.velocity_smooth
  ) {
    return null;
  }

  const hr = streams.heartrate;
  const vel = streams.velocity_smooth;
  if (hr.length < 100) return null;

  const pacePerHr = vel.map((v, i) => {
    const speed = Math.max(v, 0.5);
    const heart = Math.max(hr[i], 40);
    return speed / heart;
  });

  const mid = Math.floor(pacePerHr.length / 2);
  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

  const avg1 = avg(pacePerHr.slice(0, mid));
  const avg2 = avg(pacePerHr.slice(mid));

  return (avg2 - avg1) / avg1;
}

async function extractRunDecouplingStats(activities, hrMaxGlobal, authHeader) {
  const drifts = [];
  let gaCount = 0;
  let gaWithDrift = 0;

  for (const a of activities) {
    if (!isGaRunForDecoupling(a, hrMaxGlobal)) continue;
    gaCount++;

    const streams = await loadStreams(a.id, authHeader);
    if (!streams) continue;

    const drift = computeDecouplingFromStreams(streams);
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

function decidePhaseFromRunDecoupling(drift) {
  if (drift == null) return "Grundlage";
  if (drift > 0.07) return "Grundlage";
  if (drift > 0.04) return "Aufbau";
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

    const monday = new Date(todayObj);
    monday.setUTCDate(monday.getUTCDate() - ((todayObj.getUTCDay() + 6) % 7));
    const mondayStr = monday.toISOString().slice(0, 10);

    //-----------------------------------------
    // Wellness (inkl. CTL, ATL, HRmax)
    //-----------------------------------------
    const wRes = await fetch(
      `${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${today}`,
      { headers: { Authorization: authHeader } }
    );
    const well = await wRes.json();

    const ctl = well.ctl ?? 0;
    const atl = well.atl ?? 0;
    const hrMaxGlobal = well.hrMax ?? well.max_hr ?? 173;

    //-----------------------------------------
    // Activities (28 Tage)
    //-----------------------------------------
    const start28 = new Date(monday);
    start28.setUTCDate(start28.getUTCDate() - 28);
    const start28Str = start28.toISOString().slice(0, 10);

    const actRes = await fetch(
      `${BASE_URL}/athlete/${ATHLETE_ID}/activities?oldest=${start28Str}&newest=${today}`,
      { headers: { Authorization: authHeader } }
    );

    let activities = [];
    const raw = await actRes.json();
    if (Array.isArray(raw)) activities = raw;
    else if (raw && raw.activities) activities = raw.activities;
    else activities = Object.values(raw);

    //-----------------------------------------
    // RUN Decoupling via Streams 💥
    //-----------------------------------------
    const decStats = await extractRunDecouplingStats(
      activities,
      hrMaxGlobal,
      authHeader
    );

    const phase = decidePhaseFromRunDecoupling(decStats.medianDrift);

    //-----------------------------------------
    // This Week
    //-----------------------------------------
    const thisWeekPlan = calcNextWeekTarget(ctl, atl);
    const weeklyTargetTss = Math.round(thisWeekPlan.weekTss);

    //-----------------------------------------
    // Future Weeks
    //-----------------------------------------
    const progression = simulateFutureWeeks(
      ctl,
      atl,
      monday,
      6,
      thisWeekPlan
    );

    //-----------------------------------------
    // Write to Wellness (only Monday + dryRun=false)
    //-----------------------------------------
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

    //-----------------------------------------
    // RETURN JSON
    //-----------------------------------------
    return new Response(
      JSON.stringify(
        {
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
              medianDriftPercent:
                decStats.medianDrift != null
                  ? decStats.medianDrift * 100
                  : null,
              totalActivities: activities.length
            }
          },
          progression
        },
        null,
        2
      ),
      { status: 200 }
    );
  } catch (err) {
    return new Response("Error: " + err, { status: 500 });
  }
}

//----------------------------------------------------------
// EXPORT
//----------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    return handle(true); // only show result
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handle(false)); // real update
  }
};
