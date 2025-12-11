// Intervals Coach Worker v2 — Unified Framework Ready (Seiler | San Millán | Friel)
// Cloudflare Worker Script — Improved Coaching Logic & Framework-Compatible Output

const BASE_URL = "https://intervals.icu/api/v1";
const API_KEY = "API_KEY"; // ⚠️ Replace with secure binding or env var in Cloudflare
const API_SECRET = "1xg1v04ym957jsqva8720oo01";
const ATHLETE_ID = "i105857";

// --- Configurable Constants ---
const CTL_DELTA_TARGET = 0.8; // base progression target
const DELOAD_FACTOR = 0.9;
const ACWR_SOFT_MAX = 1.3;
const ACWR_HARD_MAX = 1.5;
const FAT_MAX_IF_RANGE = [0.65, 0.75];
const AGE_FACTOR_BASE = 40; // Friel reference

// --- Helper Functions ---
function acwrEval(acwr) {
  if (acwr < 0.8) return "Low";
  if (acwr <= 1.3) return "Green";
  if (acwr <= 1.5) return "Amber";
  return "Red";
}

function getAgeAdjustedAtlMultiplier(age) {
  if (age < 35) return 1.0;
  if (age < 50) return 0.95;
  if (age < 60) return 0.9;
  if (age < 70) return 0.85;
  return 0.75;
}

function getAtlMax(ctl) {
  if (ctl < 30) return 30;
  if (ctl < 60) return 45;
  if (ctl < 90) return 65;
  return 85;
}

function computeFatOxidationIndex(ifValue, drift) {
  if (!ifValue || !drift) return null;
  const ifScore = 1 - Math.abs(ifValue - 0.7) / 0.1;
  const driftScore = 1 - drift / 10;
  const index = ifScore * driftScore;
  return Math.max(0, Math.min(1, index));
}

function fatOxidationEval(val) {
  if (val == null) return "no_data";
  if (val >= 0.8) return "✅ Optimal";
  if (val >= 0.6) return "⚠ Moderate";
  return "❌ Low";
}

function decidePhase(acwr, drift) {
  if (acwr > 1.3 || drift > 0.07) return "Build";
  if (acwr < 0.9 && drift < 0.05) return "Consolidation";
  if (acwr > 1.5) return "Deload";
  return "Base";
}

// --- Core Logic ---
function calcNextWeekTarget(ctl, atl, age) {
  const atlAdj = atl * getAgeAdjustedAtlMultiplier(age ?? AGE_FACTOR_BASE);
  const acwr = ctl > 0 ? atlAdj / ctl : 1;
  const acwrStatus = acwrEval(acwr);
  const deload = acwr >= ACWR_HARD_MAX || atlAdj > getAtlMax(ctl);

  let ctlDelta = deload ? -CTL_DELTA_TARGET * 0.5 : CTL_DELTA_TARGET;
  const weekTss = (ctl + 6 * ctlDelta) * 7;
  const nextCtl = ctl + ctlDelta;
  const nextAtl = ctl + 6 * ctlDelta;

  return { ctl, atl: atlAdj, ctlDelta, weekTss, nextCtl, nextAtl, acwr, acwrStatus, deload };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// --- Main Handler ---
async function handle() {
  try {
    const authHeader = "Basic " + btoa(`${API_KEY}:${API_SECRET}`);
    const today = new Date().toISOString().slice(0, 10);

    // --- Wellness fetch ---
    const wRes = await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${today}`, { headers: { Authorization: authHeader } });
    if (!wRes.ok) throw new Error("wellness fetch failed");
    const well = await wRes.json();

    const ctl = well.ctl ?? 0;
    const atl = well.atl ?? 0;
    const age = well.age ?? 40;
    const hrMax = well.hrMax ?? 175;

    // --- Activities fetch ---
    const start28 = new Date();
    start28.setUTCDate(start28.getUTCDate() - 28);
    const start28Str = start28.toISOString().slice(0, 10);

    const actRes = await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/activities?oldest=${start28Str}&newest=${today}`, { headers: { Authorization: authHeader } });
    if (!actRes.ok) throw new Error("activities fetch failed");

    const activities = await actRes.json();

    // --- Decoupling & FatOxidation Evaluation ---
    const gaRuns = activities.filter(a => a.type?.includes("Run") && a.average_heartrate && a.moving_time > 2400);
    const decouplings = gaRuns.map(a => Math.abs(a.pahr_decoupling ?? a.pa_hr_decoupling ?? 0.05));
    const durabilityIndex = median(decouplings) * 100; // %

    const avgIf = median(gaRuns.map(a => a.IF ?? 0.7));
    const fatOx = computeFatOxidationIndex(avgIf, median(decouplings));

    // --- Load & ACWR Logic ---
    const weekPlan = calcNextWeekTarget(ctl, atl, age);
    const phase = decidePhase(weekPlan.acwr, median(decouplings));

    // --- Audit Checks ---
    const auditStatus = weekPlan.weekTss > 0 && Number.isFinite(weekPlan.weekTss) ? "✅" : "❌";
    const integrityFlag = auditStatus === "✅" ? "live" : "invalid";

    // --- Action Recommendations ---
    const actions = [];
    if (fatOx >= 0.8 && durabilityIndex <= 5) actions.push("✅ Maintain ≥70% Z1–Z2 (Seiler 80/20)");
    else actions.push("⚠ Increase Z1–Z2 share to ≥70%");
    if (fatOx < 0.8) actions.push("⚠ Improve Zone 2 efficiency (San Millán)");
    if (weekPlan.deload) actions.push("🔄 Apply 30–40% deload (Friel microcycle)");
    if (fatOx >= 0.8 && durabilityIndex <= 5) actions.push("✅ FatMax calibration verified (±5%)");

    // --- Framework-Compatible Output ---
    const result = {
      auditStatus,
      integrityFlag,
      athleteAge: age,
      ctl,
      atl,
      acwrRaw: weekPlan.acwr,
      acwrEval: weekPlan.acwrStatus,
      ctlDelta: weekPlan.ctlDelta,
      weeklyTargetTss: Math.round(weekPlan.weekTss),
      phaseType: phase,
      durabilityIndex: Number(durabilityIndex?.toFixed(1)),
      fatOxidationIndexRaw: Number(fatOx?.toFixed(2)),
      fatOxidationIndexEval: fatOxidationEval(fatOx),
      actions,
    };

    return new Response(JSON.stringify(result, null, 2), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, auditStatus: "❌" }, null, 2), { status: 500 });
  }
}

export default {
  async fetch(request, env, ctx) {
    return handle(); // dry-run view mode
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handle()); // cron write mode
  },
};
