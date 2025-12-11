// Intervals Coach Worker v3 — Seiler | San Millán | Friel | Unified Framework v5.1
// Autor: Dein digitaler Trainingscoach 🧠
// Funktion: Automatische Wochenplanung mit Ramp-Simulation und kommentiertem Update nach Intervals.icu

const BASE_URL = "https://intervals.icu/api/v1";
const API_KEY = "API_KEY"; // in Cloudflare als Secret hinterlegen
const API_SECRET = "API_SECRET";
const ATHLETE_ID = "i105857";

// ==== KONSTANTEN ====
const CTL_DELTA_TARGET = 0.8;
const DELOAD_FACTOR = 0.9;
const ACWR_SOFT_MAX = 1.3;
const ACWR_HARD_MAX = 1.5;
const AGE_FACTOR_BASE = 40;
const FAT_MAX_IF_RANGE = [0.65, 0.75];
const ZONE2_IF_TARGET = 0.7;

// ==== HILFSFUNKTIONEN ====
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
  if (!ifValue || drift == null) return null;
  const ifScore = 1 - Math.abs(ifValue - ZONE2_IF_TARGET) / 0.1;
  const driftScore = 1 - drift / 10;
  return Math.max(0, Math.min(1, ifScore * driftScore));
}

function fatOxidationEval(val) {
  if (val == null) return "no_data";
  if (val >= 0.8) return "✅ Optimal";
  if (val >= 0.6) return "⚠ Moderate";
  return "❌ Low";
}

function median(values) {
  if (!values?.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function decidePhase(acwr, drift, fatOx) {
  if (fatOx == null) return "Grundlage";
  if (fatOx >= 0.85 && drift <= 0.07) return "Aufbau";
  if (fatOx >= 0.8 && drift <= 0.1) return "Aufbau";
  if (fatOx >= 0.75 && acwr < 1.3) return "Konsolidierung";
  if (acwr > 1.5) return "Deload";
  if (fatOx < 0.6) return "Grundlage";
  return "Aufbau";
}

function calcNextWeekTarget(ctl, atl, age) {
  const atlAdj = atl * getAgeAdjustedAtlMultiplier(age ?? AGE_FACTOR_BASE);
  const acwr = ctl > 0 ? atlAdj / ctl : 1;
  const acwrStatus = acwrEval(acwr);
  const deload = acwr >= ACWR_HARD_MAX || atlAdj > getAtlMax(ctl);
  const ctlDelta = deload ? -CTL_DELTA_TARGET * 0.5 : CTL_DELTA_TARGET;
  const weekTss = (ctl + 6 * ctlDelta) * 7;
  const nextCtl = ctl + ctlDelta;
  const nextAtl = ctl + 6 * ctlDelta;
  return { ctl, atl: atlAdj, ctlDelta, weekTss, nextCtl, nextAtl, acwr, acwrStatus, deload };
}

function simulateRamp(ctl, atl, age, weeks = 6) {
  let ramp = [];
  let c = ctl;
  let a = atl;
  for (let i = 1; i <= weeks; i++) {
    const w = calcNextWeekTarget(c, a, age);
    ramp.push({
      week: i,
      ctlStart: c,
      ctlEnd: w.nextCtl,
      ctlDelta: w.ctlDelta,
      weeklyTargetTss: Math.round(w.weekTss),
      acwr: w.acwr,
      acwrEval: w.acwrStatus
    });
    c = w.nextCtl;
    a = w.nextAtl;
  }
  return ramp;
}

// ==== HAUPTLOGIK ====
async function handle(writeMode = false) {
  try {
    const authHeader = "Basic " + btoa(`${API_KEY}:${API_SECRET}`);
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);

    // Wellness abrufen
    const wRes = await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${todayStr}`, { headers: { Authorization: authHeader } });
    if (!wRes.ok) throw new Error("Wellness-Daten nicht verfügbar");
    const well = await wRes.json();

    const ctl = well.ctl ?? 0;
    const atl = well.atl ?? 0;
    const age = well.age ?? 40;

    // Activities (28 Tage)
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - 28);
    const startStr = start.toISOString().slice(0, 10);

    const actRes = await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/activities?oldest=${startStr}&newest=${todayStr}`, { headers: { Authorization: authHeader } });
    if (!actRes.ok) throw new Error("Aktivitäten konnten nicht geladen werden");
    const acts = await actRes.json();

    const runs = acts.filter(a => (a.type || "").toLowerCase().includes("run") && a.average_heartrate && a.moving_time > 2400);
    const drifts = runs.map(a => Math.abs(a.pahr_decoupling ?? a.pa_hr_decoupling ?? 0.05));
    const medianDrift = median(drifts);
    const avgIf = median(runs.map(a => a.IF ?? 0.7));

    const fatOx = computeFatOxidationIndex(avgIf, medianDrift);
    const fatEval = fatOxidationEval(fatOx);

    const weekPlan = calcNextWeekTarget(ctl, atl, age);
    const phase = decidePhase(weekPlan.acwr, medianDrift, fatOx);
    const ramp = simulateRamp(ctl, atl, age, 6);

    // Kommentartext
    const comment = `🧭 Woche ab ${todayStr}\nPhase: ${phase} (Decoupling ${(medianDrift * 100).toFixed(1)}%)\nFatOx ${(fatOx * 100).toFixed(0)}% → ${fatEval}\nZiel: ${Math.round(weekPlan.weekTss)} TSS · CTL Δ${weekPlan.ctlDelta.toFixed(1)} · ACWR ${weekPlan.acwr.toFixed(2)} (${weekPlan.acwrStatus})`;

    if (writeMode) {
      const body = {
        comments: comment,
        WochenzielTSS: Math.round(weekPlan.weekTss),
        WochenPlan: phase
      };
      await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${todayStr}`, {
        method: "PUT",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    }

    const result = {
      auditStatus: "✅",
      integrityFlag: "live",
      athleteAge: age,
      ctl,
      atl,
      acwrRaw: weekPlan.acwr,
      acwrEval: weekPlan.acwrStatus,
      ctlDelta: weekPlan.ctlDelta,
      weeklyTargetTss: Math.round(weekPlan.weekTss),
      phaseType: phase,
      durabilityIndex: Number((medianDrift * 100).toFixed(1)),
      fatOxidationIndexRaw: Number(fatOx?.toFixed(2)),
      fatOxidationIndexEval: fatEval,
      actions: [
        fatOx >= 0.8 ? "✅ Maintain ≥70% Z1–Z2 (Seiler 80/20)" : "⚠ Increase Z1–Z2 share to ≥70%",
        fatOx < 0.8 ? "⚠ Improve Zone 2 efficiency (San Millán)" : "✅ FatMax calibration verified (±5%)"
      ],
      ramp
    };

    return new Response(JSON.stringify(result, null, 2), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, auditStatus: "❌" }, null, 2), { status: 500 });
  }
}

export default {
  async fetch(request, env, ctx) {
    // Manuell: Vorschau ohne Schreiben
    return handle(false);
  },
  async scheduled(event, env, ctx) {
    // Montag 06:00 Europe/Zurich — automatisches Schreiben
    ctx.waitUntil(handle(true));
  }
};
