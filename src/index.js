// Erweiterte Version deines ursprünglichen Codes mit FatOxidation Integration (San Millán)

const BASE_URL = "https://intervals.icu/api/v1";
const API_KEY = "API_KEY";
const API_SECRET = "1xg1v04ym957jsqva8720oo01";
const ATHLETE_ID = "i105857";

const WEEKLY_TARGET_FIELD = "WochenzielTSS";
const PLAN_FIELD = "WochenPlan";

const CTL_DELTA_TARGET = 0.8;
const ACWR_SOFT_MAX = 1.3;
const ACWR_HARD_MAX = 1.5;
const DELOAD_FACTOR = 0.9;

// ---------------- CTL / ATL / ACWR ----------------

function getAtlMax(ctl) {
  if (ctl < 30) return 30;
  if (ctl < 60) return 45;
  if (ctl < 90) return 65;
  return 85;
}

function shouldDeload(ctl, atl) {
  const atlMax = getAtlMax(ctl);
  let acwr = null;
  if (ctl > 0) acwr = atl / ctl;
  if (acwr != null && acwr >= ACWR_HARD_MAX) return true;
  if (atl > atlMax) return true;
  return false;
}

function maxSafeCtlDelta(ctl) {
  if (ctl <= 0) return CTL_DELTA_TARGET;
  const numerator = (ACWR_SOFT_MAX - 1) * ctl;
  const denominator = 6 - ACWR_SOFT_MAX;
  const d = numerator / denominator;
  if (!isFinite(d) || d <= 0) return 0;
  return d;
}

function computeWeekFromCtlDelta(ctl, atl, ctlDelta) {
  const tssMean = ctl + 6 * ctlDelta;
  const weekTss = tssMean * 7;
  const nextCtl = ctl + ctlDelta;
  const nextAtl = tssMean;
  const acwr = nextCtl > 0 ? nextAtl / nextCtl : null;
  const weekType = ctlDelta > 0 ? "BUILD" : (ctlDelta < 0 ? "DELOAD" : "MAINTAIN");
  return { weekType, ctlDelta, weekTss, tssMean, nextCtl, nextAtl, acwr };
}

function computeDeloadWeek(ctl, atl) {
  const tssMean = DELOAD_FACTOR * ctl;
  const weekTss = tssMean * 7;
  const ctlDelta = (tssMean - ctl) / 6;
  const nextCtl = ctl + ctlDelta;
  const nextAtl = tssMean;
  const acwr = nextCtl > 0 ? nextAtl / nextCtl : null;
  return { weekType: "DELOAD", ctlDelta, weekTss, tssMean, nextCtl, nextAtl, acwr };
}

function calcNextWeekTarget(ctl, atl) {
  if (shouldDeload(ctl, atl)) return computeDeloadWeek(ctl, atl);
  const dMaxSafe = maxSafeCtlDelta(ctl);
  let targetDelta = CTL_DELTA_TARGET;
  if (dMaxSafe <= 0) targetDelta = 0;
  else if (dMaxSafe < targetDelta) targetDelta = dMaxSafe;
  return computeWeekFromCtlDelta(ctl, atl, targetDelta);
}

function simulateFutureWeeks(ctl, atl, mondayDate, weeks, firstWeekPlan) {
  const out = [];
  let currentCtl = firstWeekPlan.nextCtl;
  let currentAtl = firstWeekPlan.nextAtl;
  for (let w = 1; w <= weeks; w++) {
    const res = calcNextWeekTarget(currentCtl, currentAtl);
    const future = new Date(mondayDate);
    future.setUTCDate(future.getUTCDate() + 7 * w);
    const mondayStr = future.toISOString().slice(0, 10);
    out.push({
      weekOffset: w,
      monday: mondayStr,
      weekType: res.weekType,
      weeklyTargetTss: Math.round(res.weekTss),
      ctl: res.nextCtl,
      atl: res.nextAtl,
      ctlDelta: res.ctlDelta,
      acwr: res.acwr
    });
    currentCtl = res.nextCtl;
    currentAtl = res.nextAtl;
  }
  return out;
}

function median(values) {
  if (!values || !values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

// ---------------- GA-Filter & Decoupling ----------------

function isGaRunForDecoupling(a, hrMaxGlobal, debug) {
  const type = (a.type || "").toLowerCase();
  const entry = {
    id: a.id,
    name: a.name,
    duration: null,
    hrAvg: a.average_heartrate ?? null,
    hrMax: a.max_heartrate ?? null,
    relAvg: null,
    relMax: null,
    isGA: false,
    reason: []
  };

  if (!type.includes("run")) {
    entry.reason.push("not_run");
    debug.gaChecks.push(entry);
    return false;
  }

  const duration = a.moving_time ?? a.elapsed_time ?? a.icu_recording_time ?? 0;
  entry.duration = duration;
  if (!duration || duration < 40 * 60) {
    entry.reason.push("duration<40min");
    debug.gaChecks.push(entry);
    return false;
  }

  const athleteMax = a.athlete_max_hr ?? hrMaxGlobal ?? null;
  if (!athleteMax || athleteMax <= 0) {
    entry.reason.push("no_hr_max");
    debug.gaChecks.push(entry);
    return false;
  }

  const hrAvg = a.average_heartrate ?? null;
  const hrMax = a.max_heartrate ?? null;
  if (!hrAvg || !hrMax) {
    entry.reason.push("no_hr_data");
    debug.gaChecks.push(entry);
    return false;
  }

  const relAvg = hrAvg / athleteMax;
  const relMax = hrMax / athleteMax;
  entry.relAvg = relAvg;
  entry.relMax = relMax;

  if (relAvg < 0.70 || relAvg > 0.82) {
    entry.reason.push("hr_avg_outside_70_82");
    debug.gaChecks.push(entry);
    return false;
  }

  if (relMax > 0.95) {
    entry.reason.push("hr_max>95%");
    debug.gaChecks.push(entry);
    return false;
  }

  const name = (a.name || "").toLowerCase();
  if (/hit|intervall|interval|schwelle|vo2|max|berg|30s|30\/15|15\/15/i.test(name)) {
    entry.reason.push("name_intense");
    debug.gaChecks.push(entry);
    return false;
  }

  entry.isGA = true;
  entry.reason.push("GA_ok");
  debug.gaChecks.push(entry);
  return true;
}

function extractActivityDecoupling(a) {
  const cand = ["pahr_decoupling", "pa_hr_decoupling", "decoupling"];
  for (const k of cand) {
    const v = a[k];
    if (typeof v === "number" && isFinite(v)) {
      let x = Math.abs(v);
      if (x > 1) x = x / 100;
      return x;
    }
  }
  return null;
}

function computePaHrDecoupling(time, hr, velocity) {
  if (!time || !hr || !velocity) return null;
  const n = Math.min(time.length, hr.length, velocity.length);
  if (n < 100) return null;

  const pacePerHr = [];
  for (let i = 0; i < n; i++) {
    const v = Math.max(velocity[i] ?? 0, 0.5);
    const h = Math.max(hr[i] ?? 0, 40);
    pacePerHr.push(v / h);
  }

  const mid = Math.floor(pacePerHr.length / 2);
  if (mid < 10 || pacePerHr.length - mid < 10) return null;

  let sum1 = 0, sum2 = 0;
  for (let i = 0; i < pacePerHr.length; i++) {
    if (i < mid) sum1 += pacePerHr[i];
    else sum2 += pacePerHr[i];
  }

  const avg1 = sum1 / mid;
  const avg2 = sum2 / (pacePerHr.length - mid);
  if (!isFinite(avg1) || avg1 <= 0) return null;

  const drift = (avg2 - avg1) / avg1;
  return Math.abs(drift);
}

async function computeDriftFromStream(activityId, authHeader, debug) {
  try {
    const url = `${BASE_URL}/activity/${activityId}/streams.json?types=time,heartrate,velocity_smooth`;
    const res = await fetch(url, { headers: { Authorization: authHeader } });

    const entry = {
      id: activityId,
      ok: res.ok,
      lenTime: null,
      lenHr: null,
      lenVel: null,
      used: false,
      error: null
    };

    if (!res.ok) {
      entry.error = `http_${res.status}`;
      debug.streamChecks.push(entry);
      return null;
    }

    const streams = await res.json();
    const getStream = (type) => {
      const s = Array.isArray(streams)
        ? streams.find(st => st.type === type)
        : null;
      return s && Array.isArray(s.data) ? s.data : null;
    };

    const time = getStream("time");
    const hr = getStream("heartrate");
    const vel = getStream("velocity_smooth");

    entry.lenTime = time ? time.length : null;
    entry.lenHr = hr ? hr.length : null;
    entry.lenVel = vel ? vel.length : null;

    const drift = computePaHrDecoupling(time, hr, vel);
    if (drift == null) {
      entry.error = "drift_null";
      debug.streamChecks.push(entry);
      return null;
    }

    entry.used = true;
    debug.streamChecks.push(entry);

    debug.driftComputations.push({
      id: activityId,
      source: "stream",
      drift,
      driftPercent: drift * 100
    });

    return drift;
  } catch (e) {
    debug.streamChecks.push({
      id: activityId,
      ok: false,
      lenTime: null,
      lenHr: null,
      lenVel: null,
      used: false,
      error: "exception"
    });
    return null;
  }
}

async function extractRunDecouplingStats(activities, hrMaxGlobal, authHeader, debug) {
  const drifts = [];
  let gaCount = 0;
  let gaWithDrift = 0;

  for (const a of activities) {
    if (!isGaRunForDecoupling(a, hrMaxGlobal, debug)) continue;
    gaCount++;

    let drift = extractActivityDecoupling(a);
    if (drift != null) {
      gaWithDrift++;
      drifts.push(drift);
      debug.driftComputations.push({
        id: a.id,
        source: "activity",
        drift,
        driftPercent: drift * 100
      });
      continue;
    }

    drift = await computeDriftFromStream(a.id, authHeader, debug);
    if (drift != null) {
      gaWithDrift++;
      drifts.push(drift);
    }
  }

  const med = median(drifts);
  return {
    medianDrift: med,
    count: drifts.length,
    gaCount,
    gaWithDrift
  };
}

// --- San Millán FatOx Logic ---
function computeFatOxIndex(ifVal, drift) {
  if (!ifVal || drift == null) return null;
  const ifScore = 1 - Math.abs(ifVal - 0.7) / 0.1;
  const driftScore = 1 - drift / 10;
  const val = ifScore * driftScore;
  return Math.max(0, Math.min(1, val));
}

function fatOxEval(val) {
  if (val == null) return "no_data";
  if (val >= 0.8) return "✅ Optimal";
  if (val >= 0.6) return "⚠ Moderate";
  return "❌ Low";
}

function decidePhaseFromRunDecouplingAndFatOx(medianDrift, fatOx) {
  if (fatOx == null) return decidePhaseFromRunDecoupling(medianDrift);

  if (fatOx >= 0.85 && medianDrift <= 0.07) return "Aufbau";
  if (fatOx >= 0.8 && medianDrift <= 0.1) return "Aufbau";
  if (fatOx >= 0.75 && medianDrift > 0.1) return "Konsolidierung";
  if (fatOx < 0.6) return "Grundlage";
  return decidePhaseFromRunDecoupling(medianDrift);
}

// ---------------- MAIN ----------------

async function handle(dryRun = true) {
  try {
    const authHeader = "Basic " + btoa(`${API_KEY}:${API_SECRET}`);
    const debug = { gaChecks: [], streamChecks: [], driftComputations: [], phaseReason: null };

    const today = new Date().toISOString().slice(0, 10);
    const todayObj = new Date(today + "T00:00:00Z");
    const offset = (todayObj.getUTCDay() + 6) % 7;
    const monday = new Date(todayObj);
    monday.setUTCDate(monday.getUTCDate() - offset);
    const mondayStr = monday.toISOString().slice(0, 10);

    const wRes = await fetch(
      `${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${today}`,
      { headers: { Authorization: authHeader } }
    );
    if (!wRes.ok) {
      return new Response("Error loading wellness", { status: 500 });
    }
    const well = await wRes.json();
    const ctl = well.ctl ?? 0;
    const atl = well.atl ?? 0;
    const hrMaxGlobal = well.hrMax ?? well.max_hr ?? 173;

    const start28 = new Date(monday);
    start28.setUTCDate(start28.getUTCDate() - 28);
    const start28Str = start28.toISOString().slice(0, 10);

    const actRes = await fetch(
      `${BASE_URL}/athlete/${ATHLETE_ID}/activities?oldest=${start28Str}&newest=${today}`,
      { headers: { Authorization: authHeader } }
    );
    let activities = [];
    if (actRes.ok) {
      const raw = await actRes.json();
      if (Array.isArray(raw)) activities = raw;
      else if (raw && typeof raw === "object" && Array.isArray(raw.activities)) activities = raw.activities;
      else if (raw && typeof raw === "object") activities = Object.values(raw);
    }

    const decStats = await extractRunDecouplingStats(activities, hrMaxGlobal, authHeader, debug);
    const medianDrift = decStats.medianDrift;

    // FatOx aus IF-Median und Drift berechnen
    const ifValues = activities.filter(a => a.IF && a.type?.includes("Run")).map(a => a.IF);
    const medianIf = median(ifValues);
    const fatOx = computeFatOxIndex(medianIf, medianDrift);
    const fatEval = fatOxEval(fatOx);

    // Phase bestimmen mit FatOx-Einfluss
    const phase = decidePhaseFromRunDecouplingAndFatOx(medianDrift, fatOx);

    debug.phaseReason =
      medianDrift == null
        ? "medianDrift=null -> phase=Grundlage"
        : `medianDrift=${(medianDrift * 100).toFixed(2)}% · FatOx=${fatOx?.toFixed(2)} -> phase=${phase}`;

    // bereits oben berechnet – hier nicht erneut deklarieren
const progression = simulateFutureWeeks(ctl, atl, monday, 6, thisWeekPlan);

    const thisWeekPlan = calcNextWeekTarget(ctl, atl);
    const weeklyTargetTss = Math.round(thisWeekPlan.weekTss);
   

    if (!dryRun) {
      const body = {
        [WEEKLY_TARGET_FIELD]: weeklyTargetTss,
        [PLAN_FIELD]: phase,
        comments: `🧭 Woche ab ${mondayStr}\nPhase: ${phase} (Decoupling ${(medianDrift * 100).toFixed(1)}%)\nFatOx ${(fatOx * 100).toFixed(0)}% → ${fatEval}\nZiel: ${weeklyTargetTss} TSS · CTL Δ${thisWeekPlan.ctlDelta.toFixed(1)} · ACWR ${thisWeekPlan.acwr?.toFixed(2)}`
      };
      const putRes = await fetch(
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
      if (!putRes.ok) {
        return new Response("Error updating wellness", { status: 500 });
      }
    }

    const result = {
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
        fatOx: Number(fatOx?.toFixed(2)),
        fatOxEval: fatEval,
        runDecoupling: {
          ...decStats,
          medianDriftPercent:
            decStats.medianDrift != null ? decStats.medianDrift * 100 : null,
          totalActivities: activities.length
        }
      },
      progression,
      debug
    };

    return new Response(JSON.stringify(result, null, 2), { status: 200 });
  } catch (err) {
    return new Response("Error: " + err, { status: 500 });
  }
}

export default {
  async fetch(request, env, ctx) {
    // Vorschau nur ansehen
    return handle(true);
  },
  async scheduled(event, env, ctx) {
    // Montag = automatisch schreiben
    ctx.waitUntil(handle(false));
  }
};
