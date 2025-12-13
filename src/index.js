/**
 * ============================================================
 * 🚦 IntervalsLimiterCoach_AllInOne.js
 * ============================================================
 * Features:
 *  ✅ PA:HR Drift aus Streams (echte Aerobe Basis)
 *  ✅ Effizienztrend (14 vs. 14 Tage)
 *  ✅ Status-Ampel (heutige Fitness)
 *  ✅ Phasenempfehlung (Grundlage / Aufbau / Deload)
 *  ✅ 6-Wochen TSS-Simulation (CTL/ATL-basiert)
 *  ✅ Sanity-Check & Debug
 * ============================================================
 */

const BASE_URL = "https://intervals.icu/api/v1";
const API_KEY = "API_KEY";
const API_SECRET = "1xg1v04ym957jsqva8720oo01";
const ATHLETE_ID = "i105857";
const COMMENT_FIELD = "comments";
const DEBUG = true;

// ============================================================
// 🧰 Utility
// ============================================================
function median(values) {
  if (!values?.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ============================================================
// 🫀 Drift (PA:HR) — mit Stream-Fallback
// ============================================================

async function computePaHrDecoupling(time, hr, velocity) {
  if (!time || !hr || !velocity) return null;
  const n = Math.min(time.length, hr.length, velocity.length);
  if (n < 200) return null;
  const mid = Math.floor(n / 2);
  const rel1 = velocity.slice(0, mid).reduce((a, v, i) => a + v / hr[i], 0) / mid;
  const rel2 = velocity.slice(mid).reduce((a, v, i) => a + v / hr[i + mid], 0) / (n - mid);
  if (!rel1 || !isFinite(rel1)) return null;
  const drift = Math.abs((rel2 - rel1) / rel1);
  if (DEBUG) console.log("Drift berechnet:", drift.toFixed(4));
  return drift;
}

async function computeDriftFromStream(activityId, authHeader) {
  try {
    const url = `${BASE_URL}/activity/${activityId}/streams.json?types=time,heartrate,velocity_smooth`;
    const res = await fetch(url, { headers: { Authorization: authHeader } });
    if (!res.ok) return null;
    const streams = await res.json();
    const get = (t) => streams.find(s => s.type === t)?.data ?? null;
    return computePaHrDecoupling(get("time"), get("heartrate"), get("velocity_smooth"));
  } catch (e) {
    if (DEBUG) console.log("Drift Stream Error", e);
    return null;
  }
}

function extractActivityDecoupling(a) {
  const keys = ["pahr_decoupling", "pwhr_decoupling", "decoupling"];
  for (const k of keys) {
    const v = a[k];
    if (typeof v === "number" && isFinite(v)) {
      let x = Math.abs(v);
      if (x > 1) x = x / 100;
      return x;
    }
  }
  return null;
}

function isGaRun(a, hrMax) {
  const type = (a.type || "").toLowerCase();
  if (!type.includes("run")) return false;
  const dur = a.moving_time ?? 0;
  const hr = a.average_heartrate ?? null;
  if (!hr || dur < 40 * 60) return false;
  const rel = hr / hrMax;
  return rel >= 0.7 && rel <= 0.82;
}

async function extractDriftStats(activities, hrMax, authHeader) {
  const drifts = [];
  for (const a of activities) {
    if (!isGaRun(a, hrMax)) continue;
    let drift = extractActivityDecoupling(a);
    if (drift == null) drift = await computeDriftFromStream(a.id, authHeader);
    if (drift != null) drifts.push(drift);
  }
  const med = median(drifts);
  if (DEBUG) console.log("Drift Median:", med);
  return { medianDrift: med, count: drifts.length };
}

// ============================================================
// ⚙️ Effizienztrend
// ============================================================
function computeEfficiency(a, hrMax) {
  const hr = a.average_heartrate ?? null;
  if (!hr || !hrMax) return null;
  const rel = hr / hrMax;
  if (rel < 0.7 || rel > 0.82) return null;
  const v = a.average_speed ?? null;
  return v ? v / hr : null;
}

function computeEfficiencyTrend(activities, hrMax) {
  const now = Date.now();
  const d14 = 14 * 24 * 3600 * 1000;
  const effLast = [];
  const effPrev = [];
  for (const a of activities) {
    if (!isGaRun(a, hrMax)) continue;
    const eff = computeEfficiency(a, hrMax);
    if (!eff) continue;
    const t = new Date(a.start_date ?? 0).getTime();
    if (now - t <= d14) effLast.push(eff);
    else if (now - t <= 2 * d14) effPrev.push(eff);
  }
  const mLast = median(effLast);
  const mPrev = median(effPrev);
  const trend = mLast && mPrev ? (mLast - mPrev) / mPrev : 0;
  if (DEBUG) console.log("EffTrend:", trend.toFixed(4));
  return trend;
}

// ============================================================
// 📈 TSS-Simulation (6 Wochen Vorschau)
// ============================================================

function getAtlMax(ctl) {
  if (ctl < 30) return 30;
  if (ctl < 60) return 45;
  if (ctl < 90) return 65;
  return 85;
}

function shouldDeload(ctl, atl) {
  const acwr = ctl > 0 ? atl / ctl : 1;
  if (acwr >= 1.5) return true;
  if (atl > getAtlMax(ctl)) return true;
  return false;
}

function calcNextWeekTarget(ctl, atl) {
  const CTL_DELTA_TARGET = 0.8;
  const DELOAD_FACTOR = 0.9;
  if (shouldDeload(ctl, atl)) {
    const tssMean = DELOAD_FACTOR * ctl;
    return { weekType: "DELOAD", weekTss: tssMean * 7 };
  }
  const ctlDelta = CTL_DELTA_TARGET;
  const weekTss = (ctl + 6 * ctlDelta) * 7;
  return { weekType: "BUILD", weekTss };
}

function simulateFutureWeeks(ctl, atl, weeks = 6) {
  const out = [];
  let currentCtl = ctl, currentAtl = atl;
  for (let w = 1; w <= weeks; w++) {
    const { weekTss, weekType } = calcNextWeekTarget(currentCtl, currentAtl);
    out.push({ week: w, weekType, weekTss: Math.round(weekTss) });
    currentAtl = (currentAtl + weekTss / 7) / 2;
    currentCtl = (currentCtl * 6 + weekTss / 7) / 7;
  }
  return out;
}

// ============================================================
// 🚦 Ampel + Phase + Sanity
// ============================================================

function statusColor(c) {
  return c === "green" ? "🟢" : c === "yellow" ? "🟡" : c === "red" ? "🔴" : "⚪";
}

function buildStatusAmpel({ dec, eff, ftp, rec }) {
  const markers = [];
  markers.push({
    name: "Aerobe Basis (Drift)",
    value: dec != null ? `${(dec * 100).toFixed(1)} %` : "k.A.",
    color: dec == null ? "white" : dec < 0.05 ? "green" : dec < 0.07 ? "yellow" : "red"
  });
  markers.push({
    name: "Effizienz (Speed/HR)",
    value: `${(eff * 100).toFixed(1)} %`,
    color: eff > 0.01 ? "green" : Math.abs(eff) <= 0.01 ? "yellow" : "red"
  });
  markers.push({
    name: "Schwelle (FTP/eFTP)",
    value: ftp ? `${ftp.old ?? "?"} → ${ftp.new ?? "?"}` : "k.A.",
    color: ftp && ftp.delta >= 0 ? "green" : "red"
  });
  markers.push({
    name: "Ermüdungsresistenz",
    value: rec != null ? rec.toFixed(2) : "k.A.",
    color: rec >= 0.65 ? "green" : rec >= 0.6 ? "yellow" : "red"
  });

  const table =
    "| Marker | Wert | Status |\n|:-------|:------:|:------:|\n" +
    markers.map(m => `| ${m.name} | ${m.value} | ${statusColor(m.color)} |`).join("\n");
  return { table, markers };
}

function buildPhaseRecommendation(markers) {
  const red = markers.filter(m => m.color === "red").map(m => m.name);
  if (!red.length) return "🏋️‍♂️ Aufbau – normale Trainingswoche beibehalten.";
  if (red.length === 1 && red[0].includes("Aerobe"))
    return "🫀 Grundlage – Fokus auf lange, ruhige GA1/Z2 Einheiten.";
  if (red.length > 1)
    return "🫀 Grundlage – mehrere Marker limitiert → ruhige Woche, Fokus auf aerobe Stabilität.";
  return "🏋️‍♂️ Aufbau – stabile Basis, kleine Technik- oder Schwellenreize möglich.";
}

function sanityCheck(status) {
  const reds = status.markers.filter(m => m.color === "red");
  if (reds.length && reds.every(m => m.value === "k.A.")) {
    throw new Error("❌ Fehler: Limitierer rot, aber keine Werte vorhanden!");
  }
  return true;
}

// ============================================================
// 🧮 MAIN
// ============================================================
async function handle(dryRun = true) {
  const auth = "Basic " + btoa(`${API_KEY}:${API_SECRET}`);
  const today = new Date();
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7));
  const mondayStr = monday.toISOString().slice(0, 10);

  const wRes = await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${mondayStr}`, {
    headers: { Authorization: auth }
  });
  const well = await wRes.json();
  const hrMax = well.hrMax ?? 175;
  const ctl = well.ctl ?? 60;
  const atl = well.atl ?? 65;
  const rec = well.recoveryIndex ?? 0.65;

  const start = new Date(monday);
  start.setUTCDate(start.getUTCDate() - 28);
  const actRes = await fetch(
    `${BASE_URL}/athlete/${ATHLETE_ID}/activities?oldest=${start
      .toISOString()
      .slice(0, 10)}&newest=${today.toISOString().slice(0, 10)}`,
    { headers: { Authorization: auth } }
  );
  const acts = await actRes.json();
  const runActs = acts.filter(a => a.type?.includes("Run"));

  // Analyse
  const { medianDrift: dec } = await extractDriftStats(runActs, hrMax, auth);
  const effTrend = computeEfficiencyTrend(runActs, hrMax);
  const ftp = {
    old: well.ftp_prev ?? well.ftp,
    new: well.ftp,
    delta: (well.ftp ?? 0) - (well.ftp_prev ?? 0)
  };

  const status = buildStatusAmpel({ dec, eff: effTrend, ftp, rec });
  sanityCheck(status);
  const phase = buildPhaseRecommendation(status.markers);

  // Simulation
  const progression = simulateFutureWeeks(ctl, atl, 6);

  // Kommentar
  const nextWeeks = progression.map(p => `W${p.week}: ${p.weekType} → ${p.weekTss}`).join(", ");
  const comment = [
    "🏁 **Status-Ampel (Heute)**",
    "",
    status.table,
    "",
    `**Phase:** ${phase}`,
    `**Wochentarget TSS:** ${progression[0].weekTss}`,
    `**Vorschau:** ${nextWeeks}`
  ].join("\n");

  if (DEBUG) console.log({ dec, effTrend, ftp, rec, phase, progression });

  if (!dryRun) {
    await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${mondayStr}`, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ [COMMENT_FIELD]: comment })
    });
  }

  return new Response(JSON.stringify({ status, phase, progression, comment }, null, 2), {
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
    if (new Date().getUTCDay() === 1) ctx.waitUntil(handle(false));
  }
};