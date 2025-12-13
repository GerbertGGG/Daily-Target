/**
 * ============================================================
 * 🧠 IntervalsLimiterCoach.js (final version)
 * Autor: CoachGPT — Intervals icu Training Coach v3.0
 * ============================================================
 * Features:
 *  ✅ Run + Ride kompatibel
 *  ✅ Echte PA:HR-Decoupling-Analyse (mit Stream-Fallback)
 *  ✅ 6-Wochen-TSS-Simulation
 *  ✅ 5 Limitierer-Erkennung (aerobe Basis, Schwelle, muskuläre Ausdauer, Ermüdungsresistenz, Ökonomie)
 *  ✅ Automatische Wochenempfehlung (Trainingsfokus)
 *  ✅ Schreibt in Intervals (comments)
 * ============================================================
 */

const BASE_URL = "https://intervals.icu/api/v1";
const API_KEY = "API_KEY";
const API_SECRET = "1xg1v04ym957jsqva8720oo01";
const ATHLETE_ID = "i105857";

// Intervals Feldnamen (DE)
const WEEKLY_TARGET_FIELD = "WochenzielTSS";
const PLAN_FIELD = "WochenPlan";
const COMMENT_FIELD = "comments";

// Konfiguration
const CTL_DELTA_TARGET = 0.8;
const ACWR_SOFT_MAX = 1.3;
const ACWR_HARD_MAX = 1.5;
const DELOAD_FACTOR = 0.9;
const EFF_TREND_UPGRADE_MIN = 0.01;

// ============================================================
// ⚙️ Utility Functions
// ============================================================

function getAtlMax(ctl) {
  if (ctl < 30) return 30;
  if (ctl < 60) return 45;
  if (ctl < 90) return 65;
  return 85;
}

function shouldDeload(ctl, atl) {
  const atlMax = getAtlMax(ctl);
  const acwr = ctl > 0 ? atl / ctl : 1;
  return acwr >= ACWR_HARD_MAX || atl > atlMax;
}

function maxSafeCtlDelta(ctl) {
  if (ctl <= 0) return CTL_DELTA_TARGET;
  const d = ((ACWR_SOFT_MAX - 1) * ctl) / (6 - ACWR_SOFT_MAX);
  return !isFinite(d) || d <= 0 ? 0 : d;
}

function computeWeekFromCtlDelta(ctl, atl, ctlDelta) {
  const tssMean = ctl + 6 * ctlDelta;
  const weekTss = tssMean * 7;
  const nextCtl = ctl + ctlDelta;
  const nextAtl = tssMean;
  const acwr = nextCtl > 0 ? nextAtl / nextCtl : 1;
  const weekType =
    ctlDelta > 0 ? "BUILD" : ctlDelta < 0 ? "DELOAD" : "MAINTAIN";
  return { weekType, ctlDelta, weekTss, tssMean, nextCtl, nextAtl, acwr };
}

function computeDeloadWeek(ctl) {
  const tssMean = DELOAD_FACTOR * ctl;
  const weekTss = tssMean * 7;
  const ctlDelta = (tssMean - ctl) / 6;
  const nextCtl = ctl + ctlDelta;
  const acwr = nextCtl > 0 ? tssMean / nextCtl : 1;
  return { weekType: "DELOAD", ctlDelta, weekTss, nextCtl, acwr };
}

function calcNextWeekTarget(ctl, atl) {
  if (shouldDeload(ctl, atl)) return computeDeloadWeek(ctl);
  const dMaxSafe = maxSafeCtlDelta(ctl);
  const delta = Math.min(dMaxSafe, CTL_DELTA_TARGET);
  return computeWeekFromCtlDelta(ctl, atl, delta);
}

function simulateFutureWeeks(ctl, atl, mondayDate, weeks, firstPlan) {
  const out = [];
  let currentCtl = firstPlan.nextCtl;
  let currentAtl = firstPlan.nextAtl;
  for (let w = 1; w <= weeks; w++) {
    const res = calcNextWeekTarget(currentCtl, currentAtl);
    const monday = new Date(mondayDate);
    monday.setUTCDate(monday.getUTCDate() + 7 * w);
    out.push({
      weekOffset: w,
      monday: monday.toISOString().slice(0, 10),
      weekType: res.weekType,
      weeklyTargetTss: Math.round(res.weekTss),
      ctl: res.nextCtl,
      atl: res.nextAtl,
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
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ============================================================
// 🫀 Drift / Decoupling
// ============================================================

function extractActivityDecoupling(a) {
  const cand = ["pahr_decoupling", "pwhr_decoupling", "decoupling"];
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

function isGaSession(a, hrMax, discipline) {
  const type = (a.type || "").toLowerCase();
  if (discipline === "run" && !type.includes("run")) return false;
  if (discipline === "ride" && !type.includes("ride")) return false;

  const duration = a.moving_time ?? 0;
  if (duration < 40 * 60) return false;

  const hrAvg = a.average_heartrate ?? null;
  if (!hrAvg || !hrMax) return false;
  const rel = hrAvg / hrMax;
  return rel >= 0.7 && rel <= 0.82;
}

async function computeDriftFromStream(activityId, authHeader, discipline) {
  try {
    const url = `${BASE_URL}/activity/${activityId}/streams.json?types=time,heartrate,${discipline === "run" ? "velocity_smooth" : "watts"}`;
    const res = await fetch(url, { headers: { Authorization: authHeader } });
    if (!res.ok) return null;
    const streams = await res.json();

    const get = (type) => {
      const s = Array.isArray(streams)
        ? streams.find(st => st.type === type)
        : null;
      return s?.data ?? null;
    };
    const time = get("time");
    const hr = get("heartrate");
    const metric = get(discipline === "run" ? "velocity_smooth" : "watts");

    if (!time || !hr || !metric) return null;

    const mid = Math.floor(metric.length / 2);
    const half1 = metric.slice(0, mid);
    const half2 = metric.slice(mid);
    const hr1 = hr.slice(0, mid);
    const hr2 = hr.slice(mid);

    const rel1 = (half1.reduce((a, b, i) => a + b / hr1[i], 0)) / half1.length;
    const rel2 = (half2.reduce((a, b, i) => a + b / hr2[i], 0)) / half2.length;
    return Math.abs((rel2 - rel1) / rel1);
  } catch {
    return null;
  }
}

async function extractDecouplingStats(activities, hrMax, authHeader, discipline) {
  const drifts = [];
  for (const a of activities) {
    if (!isGaSession(a, hrMax, discipline)) continue;
    let drift = extractActivityDecoupling(a);
    if (drift == null) drift = await computeDriftFromStream(a.id, authHeader, discipline);
    if (drift != null) drifts.push(drift);
  }
  return { medianDrift: median(drifts), count: drifts.length };
}

// ============================================================
// ⚙️ Efficiency Trend
// ============================================================

function extractEfficiency(a, hrMax, discipline) {
  const hr = a.average_heartrate ?? null;
  if (!hr || !hrMax) return null;
  const rel = hr / hrMax;
  if (rel < 0.7 || rel > 0.82) return null;

  if (discipline === "run") {
    const v = a.average_speed ?? null;
    return v ? v / hr : null;
  } else if (discipline === "ride") {
    const w = a.weighted_average_watts ?? null;
    return w ? w / hr : null;
  }
  return null;
}

function computeEfficiencyTrend(activities, hrMax, discipline) {
  const now = Date.now();
  const d14 = 14 * 24 * 3600 * 1000;
  const effLast = [], effPrev = [];
  for (const a of activities) {
    if (!isGaSession(a, hrMax, discipline)) continue;
    const eff = extractEfficiency(a, hrMax, discipline);
    if (eff == null) continue;
    const ts = new Date(a.start_date ?? a.start_time ?? 0).getTime();
    if (!ts) continue;
    if (now - ts <= d14) effLast.push(eff);
    else if (now - ts <= 2 * d14) effPrev.push(eff);
  }
  const mLast = median(effLast);
  const mPrev = median(effPrev);
  const trend = mLast && mPrev ? (mLast - mPrev) / mPrev : null;
  return { effTrend: trend, mLast, mPrev };
}

// ============================================================
// 🧩 Limiter Analysis (5 Key Limiters)
// ============================================================

function detectLimiters(dec, eff, well) {
  const limiters = [];
  const rec = well.recoveryIndex ?? 0.7;

  if (dec && dec > 0.07)
    limiters.push("🫀 Aerobe Basis limitiert — mehr lange Z2-Läufe (Drift " + (dec*100).toFixed(1) + "%)");
  if (well.ftp && well.ftp < (well.ftp_prev ?? well.ftp))
    limiters.push("🔥 Schwelle limitiert — 1×/Woche Schwellenblock (2×20 min).");
  if (dec > 0.07 && rec > 0.6)
    limiters.push("🦵 Muskuläre Ausdauer limitiert — GA mit Höhenmetern / Low-Cadence-Ride.");
  if (rec < 0.6)
    limiters.push("🧠 Ermüdungsresistenz limitiert — Deload- oder Recovery-Block empfohlen.");
  if (eff.effTrend != null && eff.effTrend < 0)
    limiters.push("⚙️ Ökonomie limitiert — Technik-, Frequenz- oder Trittarbeit.");

  return limiters;
}

// ============================================================
// 🧠 Coaching Recommendation
// ============================================================

function buildRecommendation(limiters) {
  if (!limiters.length)
    return "✅ Keine deutlichen Limitierer — normale Aufbauwoche.";

  const recs = [];
  if (limiters.some(l => l.includes("Aerobe")))
    recs.push("• 2–3 × GA1/Z2 Einheiten (60–120 min) zur Stabilisierung der Basis");
  if (limiters.some(l => l.includes("Schwelle")))
    recs.push("• 1 × Schwellenblock (2 × 20 min) oder Race-Pace-Intervalle");
  if (limiters.some(l => l.includes("Muskuläre")))
    recs.push("• Kraftausdauer: Hügelläufe oder 5×5 min Low Cadence");
  if (limiters.some(l => l.includes("Ermüdungs")))
    recs.push("• Woche leicht reduzieren (−30 % TSS), Fokus auf Regeneration");
  if (limiters.some(l => l.includes("Ökonomie")))
    recs.push("• Lauftechnik, Kadenz, Trittfrequenz- oder Pedaltechnik-Drills");

  return "Was tun:\n" + recs.join("\n");
}

// ============================================================
// 💬 Comment Composer
// ============================================================

function buildComment({ discipline, phase, ctl, atl, acwr, weeklyTss, dec, eff, limiters, recommendation }) {
  const drift = dec?.medianDrift != null ? (dec.medianDrift*100).toFixed(1)+"%" : "k.A.";
  const effStr = eff?.effTrend != null ? (eff.effTrend*100).toFixed(1)+"%" : "k.A.";
  const limText = limiters.length ? "\n🏁 Limitierer:\n" + limiters.join("\n") : "";
  return [
    `🏋️‍♂️ Coaching-Notiz (${discipline.toUpperCase()})`,
    "",
    `• Phase: ${phase}`,
    `• Wochenziel TSS: ~${weeklyTss}`,
    `• CTL ${ctl.toFixed(1)}, ATL ${atl.toFixed(1)}, ACWR ${acwr.toFixed(2)}`,
    `• Drift: ${drift}`,
    `• Effizienztrend: ${effStr}`,
    limText,
    "",
    recommendation
  ].join("\n");
}

// ============================================================
// 🧮 Main
// ============================================================

async function handle(dryRun = true) {
  const auth = "Basic " + btoa(`${API_KEY}:${API_SECRET}`);
  const today = new Date();
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7));
  const mondayStr = monday.toISOString().slice(0, 10);

  const wRes = await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${mondayStr}`, { headers: { Authorization: auth } });
  const well = await wRes.json();
  const ctl = well.ctl ?? 0, atl = well.atl ?? 0, hrMax = well.hrMax ?? 175;

  const start = new Date(monday); start.setUTCDate(start.getUTCDate() - 28);
  const actRes = await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/activities?oldest=${start.toISOString().slice(0,10)}&newest=${today.toISOString().slice(0,10)}`, { headers: { Authorization: auth } });
  const acts = await actRes.json();

  const runActs = acts.filter(a => a.type?.includes("Run"));
  const rideActs = acts.filter(a => a.type?.includes("Ride"));

  const runDec = await extractDecouplingStats(runActs, hrMax, auth, "run");
  const rideDec = await extractDecouplingStats(rideActs, hrMax, auth, "ride");
  const runEff = computeEfficiencyTrend(runActs, hrMax, "run");
  const rideEff = computeEfficiencyTrend(rideActs, hrMax, "ride");

  const nextWeek = calcNextWeekTarget(ctl, atl);
  const future = simulateFutureWeeks(ctl, atl, monday, 6, nextWeek);

  const runLim = detectLimiters(runDec.medianDrift, runEff, well);
  const rideLim = detectLimiters(rideDec.medianDrift, rideEff, well);
  const allLim = [...runLim, ...rideLim];
  const rec = buildRecommendation(allLim);

  const comment = [
    buildComment({ discipline: "Run", phase: "auto", ctl, atl, acwr: nextWeek.acwr, weeklyTss: Math.round(nextWeek.weekTss), dec: runDec, eff: runEff, limiters: runLim, recommendation: rec }),
    "",
    buildComment({ discipline: "Ride", phase: "auto", ctl, atl, acwr: nextWeek.acwr, weeklyTss: Math.round(nextWeek.weekTss), dec: rideDec, eff: rideEff, limiters: rideLim, recommendation: rec })
  ].join("\n\n");

  if (!dryRun) {
    const body = {
      [WEEKLY_TARGET_FIELD]: Math.round(nextWeek.weekTss),
      [PLAN_FIELD]: "auto",
      [COMMENT_FIELD]: comment
    };
    await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${mondayStr}`, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  return new Response(JSON.stringify({ ctl, atl, runDec, rideDec, runEff, rideEff, limiters: allLim, recommendation: rec, comment, future }, null, 2), { status: 200 });
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const write = ["1", "true", "yes"].includes(url.searchParams.get("write"));
    return handle(!write);
  },
  async scheduled(_, __, ctx) {
    if (new Date().getUTCDay() === 1) ctx.waitUntil(handle(false));
  }
};