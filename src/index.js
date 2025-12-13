/**
 * ============================================================
 * 🚦 IntervalsLimiterCoach_Finale.js
 * ============================================================
 * Features:
 *  ✅ Status-Ampel für heutige Fitness
 *  ✅ Einfache Phasenempfehlung (Grundlage / Aufbau)
 *  ✅ Wochen-TSS-Ziel dynamisch angepasst
 *  ✅ Sanity-Check & Debug-Log
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
// 🫀 Drift & Effizienz
// ============================================================
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

function computeEfficiency(a, hrMax) {
  const hr = a.average_heartrate ?? null;
  if (!hr || !hrMax) return null;
  const rel = hr / hrMax;
  if (rel < 0.7 || rel > 0.82) return null;
  const v = a.average_speed ?? null;
  return v ? v / hr : null;
}

// ============================================================
// 🚦 Ampel + Phase
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
  const e = eff ?? 0;
  markers.push({
    name: "Effizienz (Speed/HR)",
    value: `${(e * 100).toFixed(1)} %`,
    color: e > 0.01 ? "green" : Math.abs(e) <= 0.01 ? "yellow" : "red"
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

// ============================================================
// 📈 Wochen-TSS-Anpassung
// ============================================================
function adjustWeeklyTSS(baseTSS, phase) {
  if (phase.includes("Grundlage")) return Math.round(baseTSS * 0.9);
  if (phase.includes("Aufbau")) return Math.round(baseTSS * 1.05);
  return Math.round(baseTSS);
}

// ============================================================
// 🧠 Sanity-Check
// ============================================================
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
  const drifts = runActs.map(a => extractActivityDecoupling(a)).filter(x => x != null);
  const dec = median(drifts);
  const effVals = runActs.map(a => computeEfficiency(a, hrMax)).filter(x => x != null);
  const effTrend = (() => {
    const now = Date.now();
    const d14 = 14 * 24 * 3600 * 1000;
    const last = effVals.filter(a => now - new Date(a.start_date ?? 0).getTime() <= d14);
    const prev = effVals.filter(a => now - new Date(a.start_date ?? 0).getTime() > d14);
    const mLast = median(last), mPrev = median(prev);
    return mLast && mPrev ? (mLast - mPrev) / mPrev : 0;
  })();
  const ftp = {
    old: well.ftp_prev ?? well.ftp,
    new: well.ftp,
    delta: (well.ftp ?? 0) - (well.ftp_prev ?? 0)
  };
  const rec = well.recoveryIndex ?? 0.65;

  // Status + Phase
  const status = buildStatusAmpel({ dec, eff: effTrend, ftp, rec });
  sanityCheck(status);
  const phase = buildPhaseRecommendation(status.markers);
  const weekTSSBase = ctl * 7; // grobe Schätzung
  const weeklyTargetTSS = adjustWeeklyTSS(weekTSSBase, phase);

  // Kommentar
  const comment = [
    "🏁 **Status-Ampel (Heute)**",
    "",
    status.table,
    "",
    `**Phase:** ${phase}`,
    `**Wochentarget TSS:** ${weeklyTargetTSS}`
  ].join("\n");

  if (DEBUG) console.log({ dec, effTrend, ftp, rec, phase, weeklyTargetTSS });

  if (!dryRun) {
    await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${mondayStr}`, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ [COMMENT_FIELD]: comment })
    });
  }

  return new Response(JSON.stringify({ status, phase, weeklyTargetTSS, comment }, null, 2), {
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