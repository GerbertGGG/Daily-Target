/**
 * ============================================================
 * 🧠 IntervalsLimiterWorker.js
 * Autor: CoachGPT (Intervals icu Training Coach v3.0)
 * ------------------------------------------------------------
 * Funktion:
 *  - Automatische Phasen- und Limitierer-Erkennung
 *  - Kommentar-Schreibung in Intervals.icu (Feld: comments)
 *  - Voll kompatibel mit Unified Reporting Framework v5.1
 * ============================================================
 */

const BASE_URL = "https://intervals.icu/api/v1";
const API_KEY = "API_KEY";
const API_SECRET = "1xg1v04ym957jsqva8720oo01";
const ATHLETE_ID = "i105857";

const WEEKLY_TARGET_FIELD = "WochenzielTSS";
const PLAN_FIELD = "WochenPlan";
const COMMENT_FIELD = "comments";

const CTL_DELTA_TARGET = 0.8;
const ACWR_SOFT_MAX = 1.3;
const ACWR_HARD_MAX = 1.5;
const DELOAD_FACTOR = 0.9;
const EFF_TREND_UPGRADE_MIN = 0.01;

// ---------------- Helper Functions ----------------

function getAtlMax(ctl) {
  if (ctl < 30) return 30;
  if (ctl < 60) return 45;
  if (ctl < 90) return 65;
  return 85;
}
function isUtcMonday() {
  return new Date().getUTCDay() === 1;
}
function shouldDeload(ctl, atl) {
  const atlMax = getAtlMax(ctl);
  const acwr = ctl > 0 ? atl / ctl : 1.0;
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
  let delta = Math.min(dMaxSafe, CTL_DELTA_TARGET);
  return computeWeekFromCtlDelta(ctl, atl, delta);
}
function median(v) {
  if (!v || !v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// ---------------- GA-Run Filters ----------------

function isGaRun(a, hrMax) {
  const type = (a.type || "").toLowerCase();
  if (!type.includes("run")) return false;
  const dur = a.moving_time ?? 0;
  if (dur < 40 * 60) return false;
  const hrAvg = a.average_heartrate;
  if (!hrAvg || hrAvg < 90) return false;
  const rel = hrAvg / hrMax;
  return rel >= 0.7 && rel <= 0.82;
}

function extractDrift(a) {
  const v = a.pahr_decoupling ?? a.pa_hr_decoupling ?? null;
  if (typeof v !== "number" || !isFinite(v)) return null;
  return Math.abs(v > 1 ? v / 100 : v);
}

async function computeDecoupling(activities, hrMax, authHeader) {
  const drifts = [];
  for (const a of activities) {
    if (!isGaRun(a, hrMax)) continue;
    const d = extractDrift(a);
    if (d != null) drifts.push(d);
  }
  return { medianDrift: median(drifts), count: drifts.length };
}

// ---------------- Effizienztrend ----------------

function extractEff(a, hrMax) {
  const v = a.average_speed;
  const hr = a.average_heartrate;
  if (!v || !hr) return null;
  const rel = hr / hrMax;
  if (rel < 0.7 || rel > 0.82) return null;
  return v / hr;
}

function effTrend(activities, hrMax) {
  const now = Date.now();
  const d14 = 14 * 24 * 3600 * 1000;
  const effLast = [], effPrev = [];
  for (const a of activities) {
    if (!isGaRun(a, hrMax)) continue;
    const e = extractEff(a, hrMax);
    if (!e) continue;
    const t = new Date(a.start_date ?? a.start_time ?? 0).getTime();
    if (!t) continue;
    if (now - t <= d14) effLast.push(e);
    else if (now - t <= 2 * d14) effPrev.push(e);
  }
  const mLast = median(effLast), mPrev = median(effPrev);
  const trend = mLast && mPrev ? (mLast - mPrev) / mPrev : null;
  return { effTrend: trend, mLast, mPrev, nLast: effLast.length, nPrev: effPrev.length };
}

// ---------------- Limiters ----------------

function detectLimiters(dec, eff, well) {
  const lim = [];
  const rec = well.recoveryIndex ?? 0.7;
  if (dec && dec > 0.07)
    lim.push("🫀 Aerobe Basis limitiert — mehr lange Z2-Läufe (Drift " + (dec*100).toFixed(1) + "%)");
  if (rec < 0.6)
    lim.push("🧠 Ermüdungsresistenz limitiert — Deload oder Recovery-Block");
  if (eff.effTrend != null && eff.effTrend < 0)
    lim.push("⚙️ Ökonomie limitiert — Technik & Kadenzarbeit (EffTrend " + (eff.effTrend*100).toFixed(1) + "%)");
  return lim;
}

// ---------------- Comment Composer ----------------

function buildComment({ phase, ctl, atl, acwr, weeklyTss, decStats, effStats, limiters }) {
  const driftStr = decStats?.medianDrift != null ? (decStats.medianDrift*100).toFixed(1)+"%" : "k.A.";
  const effStr = effStats?.effTrend != null ? (effStats.effTrend*100).toFixed(1)+"%" : "k.A.";
  const limBlock = limiters.length ? "\n\n🏁 Limitierer & Empfehlungen:\n" + limiters.join("\n") : "";
  return [
    "Coaching-Notiz",
    "",
    `• Phase: ${phase}`,
    `• Wochenziel TSS: ~${weeklyTss}`,
    `• Aktuelle Last: CTL ${ctl.toFixed(1)}, ATL ${atl.toFixed(1)}, ACWR ${acwr.toFixed(2)}`,
    `• GA-Qualität: medianer Drift ${driftStr}`,
    `• Effizienztrend: ${effStr}`,
    limBlock
  ].join("\n");
}

// ---------------- MAIN ----------------

async function handle(dryRun = true) {
  const auth = "Basic " + btoa(`${API_KEY}:${API_SECRET}`);

  const today = new Date();
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7));
  const mondayStr = monday.toISOString().slice(0, 10);

  // Load wellness
  const wRes = await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${mondayStr}`, {
    headers: { Authorization: auth }
  });
  const well = await wRes.json();
  const ctl = well.ctl ?? 0, atl = well.atl ?? 0, hrMax = well.hrMax ?? 175;

  // Load 28d activities
  const start = new Date(monday); start.setUTCDate(start.getUTCDate() - 28);
  const aRes = await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/activities?oldest=${start.toISOString().slice(0,10)}&newest=${today.toISOString().slice(0,10)}`,
    { headers: { Authorization: auth } });
  const activities = await aRes.json();

  // Compute drift + eff + limiter
  const decStats = await computeDecoupling(activities, hrMax, auth);
  const effStats = effTrend(activities, hrMax);
  const thisWeek = calcNextWeekTarget(ctl, atl);
  const limiters = detectLimiters(decStats.medianDrift, effStats, well);

  // Phase decision
  const phase = decStats.medianDrift > 0.07
    ? "Grundlage"
    : effStats.effTrend < 0.01 ? "Aufbau" : "Intensiv";

  // Comment text
  const comment = buildComment({
    phase,
    ctl,
    atl,
    acwr: thisWeek.acwr,
    weeklyTss: Math.round(thisWeek.weekTss),
    decStats,
    effStats,
    limiters
  });

  if (!dryRun) {
    const body = {
      [WEEKLY_TARGET_FIELD]: Math.round(thisWeek.weekTss),
      [PLAN_FIELD]: phase,
      [COMMENT_FIELD]: comment
    };
    await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${mondayStr}`, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  return new Response(JSON.stringify({ phase, ctl, atl, decStats, effStats, limiters, comment }, null, 2), {
    status: 200
  });
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const write = ["1", "true", "yes"].includes(url.searchParams.get("write"));
    return handle(!write);
  },
  async scheduled(_, __, ctx) {
    if (isUtcMonday()) ctx.waitUntil(handle(false));
  }
};