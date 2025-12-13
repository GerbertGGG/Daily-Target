/**
 * ============================================================
 * 🚦 IntervalsLimiterCoach_Ampel.js
 * ============================================================
 * Features:
 *  ✅ Run + Ride kompatibel
 *  ✅ Echte PA:HR-Drift-Analyse (mit Stream-Fallback)
 *  ✅ Effizienztrend (14d vs prev14d)
 *  ✅ Status-Ampel (heutige Fitness)
 *  ✅ Kurz-Empfehlung basierend auf Limitierern
 *  ✅ Schreibt Ampel + Empfehlung in Intervals (comments)
 * ============================================================
 */

const BASE_URL = "https://intervals.icu/api/v1";
const API_KEY = "API_KEY";
const API_SECRET = "1xg1v04ym957jsqva8720oo01";
const ATHLETE_ID = "i105857";

// Intervals Feldnamen (deutsch)
const COMMENT_FIELD = "comments";

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
// 🫀 Drift / Decoupling
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
    const get = (type) => streams.find(st => st.type === type)?.data ?? null;
    const time = get("time");
    const hr = get("heartrate");
    const metric = get(discipline === "run" ? "velocity_smooth" : "watts");
    if (!time || !hr || !metric) return null;

    const mid = Math.floor(metric.length / 2);
    const rel1 = metric.slice(0, mid).reduce((a, b, i) => a + b / hr[i], 0) / mid;
    const rel2 = metric.slice(mid).reduce((a, b, i) => a + b / hr[i + mid], 0) / (metric.length - mid);
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
// ⚙️ Effizienztrend
// ============================================================

function extractEfficiency(a, hrMax, discipline) {
  const hr = a.average_heartrate ?? null;
  if (!hr || !hrMax) return null;
  const rel = hr / hrMax;
  if (rel < 0.7 || rel > 0.82) return null;
  if (discipline === "run") {
    const v = a.average_speed ?? null;
    return v ? v / hr : null;
  } else {
    const w = a.weighted_average_watts ?? null;
    return w ? w / hr : null;
  }
}

function computeEfficiencyTrend(activities, hrMax, discipline) {
  const now = Date.now();
  const d14 = 14 * 24 * 3600 * 1000;
  const effLast = [], effPrev = [];
  for (const a of activities) {
    if (!isGaSession(a, hrMax, discipline)) continue;
    const eff = extractEfficiency(a, hrMax, discipline);
    if (!eff) continue;
    const t = new Date(a.start_date ?? a.start_time ?? 0).getTime();
    if (!t) continue;
    if (now - t <= d14) effLast.push(eff);
    else if (now - t <= 2 * d14) effPrev.push(eff);
  }
  const mLast = median(effLast);
  const mPrev = median(effPrev);
  const trend = mLast && mPrev ? (mLast - mPrev) / mPrev : 0;
  return { effTrend: trend };
}

// ============================================================
// 🚦 STATUS-AMPEL + KURZ-EMPFEHLUNG
// ============================================================

function statusColor(marker) {
  if (marker === "green") return "🟢";
  if (marker === "yellow") return "🟡";
  if (marker === "red") return "🔴";
  return "⚪";
}

function buildStatusAmpel({ dec, eff, ftp, rec }) {
  const markers = [];

  markers.push({
    name: "Aerobe Basis (Drift)",
    value: dec != null ? `${(dec * 100).toFixed(1)} %` : "k.A.",
    color: dec == null ? "white" : dec < 0.05 ? "green" : dec < 0.07 ? "yellow" : "red"
  });

  const effTrend = eff?.effTrend ?? 0;
  markers.push({
    name: "Effizienz (Speed/HR oder Watt/HR)",
    value: `${(effTrend * 100).toFixed(1)} %`,
    color: effTrend > 0.01 ? "green" : Math.abs(effTrend) <= 0.01 ? "yellow" : "red"
  });

  const ftpDelta = ftp?.delta ?? 0;
  markers.push({
    name: "Schwelle (FTP/eFTP)",
    value: `${ftp.old ?? "?"} → ${ftp.new ?? "?"}`,
    color: ftpDelta >= 0 ? "green" : "red"
  });

  markers.push({
    name: "Muskuläre Ausdauer",
    value: dec > 0.07 && rec > 0.6 ? "↓" : "ok",
    color: dec > 0.07 && rec > 0.6 ? "red" : "green"
  });

  markers.push({
    name: "Ermüdungsresistenz",
    value: rec != null ? rec.toFixed(2) : "k.A.",
    color: rec >= 0.65 ? "green" : rec >= 0.6 ? "yellow" : "red"
  });

  markers.push({
    name: "Ökonomie / Technik",
    value: `${(effTrend * 100).toFixed(1)} %`,
    color: effTrend >= 0 ? "green" : "red"
  });

  const table =
    "| Marker | Wert | Status |\n|:-------|:------:|:------:|\n" +
    markers.map(m => `| ${m.name} | ${m.value} | ${statusColor(m.color)} |`).join("\n");

  return { table, markers };
}

function buildShortRecommendation(markers) {
  const red = markers.filter(m => m.color === "red").map(m => m.name);
  if (!red.length) return "✅ Alles stabil — normale Aufbauwoche beibehalten.";
  if (red.length === 1) {
    const l = red[0];
    if (l.includes("Aerobe")) return "🎯 Fokus: Aerobe Basis — 2–3× GA1-Läufe (60–90 min).";
    if (l.includes("Schwelle")) return "🎯 Fokus: Schwelle — 1× 2×20 min @ FTP.";
    if (l.includes("Muskuläre")) return "🎯 Fokus: Kraftausdauer — Hügelläufe oder Low-Cadence-Rides.";
    if (l.includes("Ermüdungs")) return "🎯 Fokus: Regeneration — 1 Woche -30 % Umfang, viel Schlaf.";
    if (l.includes("Ökonomie")) return "🎯 Fokus: Technik — Lauf- oder Trittfrequenzarbeit.";
  }
  if (red.length > 1)
    return "⚠️ Mehrere Limitierer aktiv — Fokus auf Regeneration und Z2-Grundlagenarbeit.";
  return "ℹ️ Halte dein Training stabil, kleine Technik- oder Kraftimpulse möglich.";
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
  const rideActs = acts.filter(a => a.type?.includes("Ride"));

  const runDec = await extractDecouplingStats(runActs, hrMax, auth, "run");
  const runEff = computeEfficiencyTrend(runActs, hrMax, "run");
  const rec = well.recoveryIndex ?? 0.65;
  const ftp = { old: well.ftp_prev ?? well.ftp, new: well.ftp, delta: (well.ftp ?? 0) - (well.ftp_prev ?? 0) };

  const status = buildStatusAmpel({ dec: runDec.medianDrift, eff: runEff, ftp, rec });
  const recommendation = buildShortRecommendation(status.markers);

  const comment = [
    "🏁 **Status-Ampel (Heute)**",
    "",
    status.table,
    "",
    `**Empfehlung:** ${recommendation}`
  ].join("\n");

  if (!dryRun) {
    const body = { [COMMENT_FIELD]: comment };
    await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${mondayStr}`, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  return new Response(JSON.stringify({ status, recommendation, comment }, null, 2), { status: 200 });
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