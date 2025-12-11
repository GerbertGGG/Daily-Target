//----------------------------------------------------------
// CONFIG
//----------------------------------------------------------
const BASE_URL = "https://intervals.icu/api/v1";
const API_KEY = "API_KEY";
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
  const acwr = ctl > 0 ? atl / ctl : null;
  return (acwr != null && acwr >= ACWR_HARD_MAX) || atl > atlMax;
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

  return {
    weekType: ctlDelta > 0 ? "BUILD" : "MAINTAIN",
    ctlDelta,
    weekTss,
    tssMean,
    nextCtl: ctl + ctlDelta,
    nextAtl: tssMean,
    acwr: (ctl + ctlDelta) > 0 ? tssMean / (ctl + ctlDelta) : null
  };
}

function computeDeloadWeek(ctl, atl) {
  const tssMean = DELOAD_FACTOR * ctl;
  const weekTss = tssMean * 7;

  const ctlDelta = (tssMean - ctl) / 6;

  return {
    weekType: "DELOAD",
    ctlDelta,
    weekTss,
    tssMean,
    nextCtl: ctl + ctlDelta,
    nextAtl: tssMean,
    acwr: (ctl + ctlDelta) > 0 ? tssMean / (ctl + ctlDelta) : null
  };
}

function calcNextWeekTarget(ctl, atl) {
  if (shouldDeload(ctl, atl)) {
    return computeDeloadWeek(ctl, atl);
  }

  const dMax = maxSafeCtlDelta(ctl);
  let d = CTL_DELTA_TARGET;

  if (!isFinite(dMax) || dMax <= 0) d = 0;
  else if (dMax < d) d = dMax;

  return computeWeekFromCtlDelta(ctl, atl, d);
}

function simulateFutureWeeks(ctl, atl, mondayDate, weeks, week0) {
  const progression = [];

  let currCtl = week0.nextCtl;
  let currAtl = week0.nextAtl;

  for (let w = 1; w <= weeks; w++) {
    const res = calcNextWeekTarget(currCtl, currAtl);
    const futureMonday = new Date(mondayDate);
    futureMonday.setUTCDate(futureMonday.getUTCDate() + w * 7);

    progression.push({
      weekOffset: w,
      monday: futureMonday.toISOString().slice(0, 10),
      weekType: res.weekType,
      weeklyTargetTss: Math.round(res.weekTss),
      ctl: res.nextCtl,
      atl: res.nextAtl,
      ctlDelta: res.ctlDelta,
      acwr: res.acwr
    });

    currCtl = res.nextCtl;
    currAtl = res.nextAtl;
  }

  return progression;
}

//----------------------------------------------------------
// HELPER
//----------------------------------------------------------

function median(values) {
  if (!values?.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

//----------------------------------------------------------
// GA-RUN FILTER
//----------------------------------------------------------

function isGaRunForDecoupling(a, hrMaxGlobal) {
  const type = (a.type || "").toLowerCase();
  if (!type.includes("run")) return false;

  const hrAvg = a.average_heartrate;
  const hrMax = a.max_heartrate;
  if (!hrAvg || !hrMax) return false;

  const dur = a.moving_time ?? a.elapsed_time ?? a.icu_recording_time ?? 0;
  if (dur < 45 * 60) return false;

  const athleteMax = a.athlete_max_hr ?? hrMaxGlobal;
  if (!athleteMax) return false;

  const relAvg = hrAvg / athleteMax;
  const relMax = hrMax / athleteMax;

  if (relAvg < 0.70 || relAvg > 0.80) return false;
  if (relMax > 0.85) return false;

  const name = (a.name || "").toLowerCase();
  if (/hit|interval|intervall|schwelle|berg|30|vo2|max/.test(name)) return false;

  return true;
}

//----------------------------------------------------------
// STREAM-DECPLING BERECHNUNG
//----------------------------------------------------------

async function computeDecouplingFromStreams(authHeader, a) {
  const url = `${BASE_URL}/activity/${a.id}/streams?types=time,heartrate,distance,velocity_smooth,velocity,pace`;
  const res = await fetch(url, { headers: { Authorization: authHeader } });

  if (!res.ok) {
    console.log("❌ Stream API Fehler:", a.id, a.name, res.status);
    return null;
  }

  const streams = await res.json();
  if (!streams) {
    console.log("❌ Keine Streams empfangen:", a.id, a.name);
    return null;
  }

  const time = streams.time;
  const hr = streams.heartrate;
  const v1 = streams.velocity_smooth;
  const v2 = streams.velocity;
  const dist = streams.distance;

  if (!time || !hr) {
    console.log("❌ Keine HR oder Zeit:", a.id, a.name);
    return null;
  }

  if (hr.length < 200) {
    console.log("⚠️ HR Stream zu kurz (<200):", a.id, a.name, "len:", hr.length);
    return null;
  }

  // SPEED-Fallback
  let speed = v1 || v2;

  if (!speed) {
    if (dist) {
      console.log("ℹ️ Velocity fehlt → Geschwindigkeit aus Distanz berechnet");
      speed = [];
      for (let i = 1; i < dist.length; i++) {
        const ds = dist[i] - dist[i - 1];
        speed.push(Math.max(ds, 0.3));
      }
      speed.unshift(speed[0]);
    } else {
      console.log("❌ Keine velocity & keine distance:", a.id, a.name);
      return null;
    }
  }

  // Pa:Hr berechnen
  const pahr = speed.map((s, i) => s / Math.max(hr[i], 40));

  const mid = Math.floor(pahr.length / 2);
  const avg1 = pahr.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
  const avg2 = pahr.slice(mid).reduce((a, b) => a + b, 0) / (pahr.length - mid);

  const drift = (avg2 - avg1) / avg1;

  console.log("✅ Drift berechnet:", a.id, a.name, (drift * 100).toFixed(2) + "%");

  return drift;
}

//----------------------------------------------------------
// RUN-DECOUPLING STATS
//----------------------------------------------------------

async function extractRunDecouplingStats(activities, hrMaxGlobal, authHeader) {
  const drifts = [];
  let gaCount = 0;
  let gaWithDrift = 0;

  for (const a of activities) {
    if (!isGaRunForDecoupling(a, hrMaxGlobal)) continue;

    gaCount++;

    console.log("📌 GA-Run erkannt:", {
      id: a.id,
      name: a.name,
      duration: a.moving_time,
      hrAvg: a.average_heartrate,
      hrMax: a.max_heartrate
    });

    const drift = await computeDecouplingFromStreams(authHeader, a);

    if (drift == null) {
      console.log("⚠️ Kein Drift möglich:", a.id, a.name);
      continue;
    }

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
    const authHeader = "Basic " + btoa(`${API_KEY}:${API_SECRET}`);

    const today = new Date().toISOString().slice(0, 10);
    const todayObj = new Date(today + "T00:00:00Z");

    const offset = (todayObj.getUTCDay() + 6) % 7;
    const monday = new Date(todayObj);
    monday.setUTCDate(monday.getUTCDate() - offset);
    const mondayStr = monday.toISOString().slice(0, 10);

    // Wellness
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

    // Decoupling-Analyse
    const decStats = await extractRunDecouplingStats(activities, hrMaxGlobal, authHeader);
    const phase = decidePhaseFromRunDecoupling(decStats.medianDrift);

    // Wochenziel
    const thisWeekPlan = calcNextWeekTarget(ctl, atl);
    const weeklyTargetTss = Math.round(thisWeekPlan.weekTss);

    const progression = simulateFutureWeeks(ctl, atl, monday, 6, thisWeekPlan);

    // Schreiben
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

export default {
  async fetch(request) {
    return handle(true);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handle(false));
  }
};
