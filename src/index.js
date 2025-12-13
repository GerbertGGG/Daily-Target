var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var BASE_URL = "https://intervals.icu/api/v1";
var API_KEY = "API_KEY";
var API_SECRET = "1xg1v04ym957jsqva8720oo01";
var ATHLETE_ID = "i105857";
var COMMENT_FIELD = "comments";
var DEBUG = true;

// =========================
// 📊 Hilfsfunktionen
// =========================
function median(values) {
  if (!values?.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
__name(median, "median");

function isGaSession(a, hrMax) {
  const type = (a.type || "").toLowerCase();
  if (!type.match(/run|ride/)) return false;
  const dur = a.moving_time ?? 0;
  const hr = a.average_heartrate ?? null;
  const ifVal = a.IF ?? null;
  const name = (a.name || "").toLowerCase();
  if (dur < 40 * 60) return false;
  if (!hr || !hrMax) return false;
  const rel = hr / hrMax;
  if (rel < 0.7 || rel > 0.82) return false;
  if (ifVal && ifVal > 0.8) return false;
  if (/intervall|interval|schwelle|vo2|max|berg|test|30s|30\/15|15\/15/i.test(name)) return false;
  return true;
}
__name(isGaSession, "isGaSession");

async function computePaHrDecoupling(time, hr, velocity) {
  if (!time || !hr || !velocity) return null;
  const n = Math.min(time.length, hr.length, velocity.length);
  if (n < 200) return null;
  const mid = Math.floor(n / 2);
  const rel1 = velocity.slice(0, mid).reduce((a, v, i) => a + v / hr[i], 0) / mid;
  const rel2 = velocity.slice(mid).reduce((a, v, i) => a + v / hr[i + mid], 0) / (n - mid);
  if (!rel1 || !isFinite(rel1)) return null;
  return Math.abs((rel2 - rel1) / rel1);
}
__name(computePaHrDecoupling, "computePaHrDecoupling");

async function computeDriftFromStream(activityId, authHeader) {
  try {
    const url = `${BASE_URL}/activity/${activityId}/streams.json?types=time,heartrate,velocity_smooth`;
    const res = await fetch(url, { headers: { Authorization: authHeader } });
    if (!res.ok) return null;
    const streams = await res.json();
    const get = (t) => streams.find((s) => s.type === t)?.data ?? null;
    return computePaHrDecoupling(get("time"), get("heartrate"), get("velocity_smooth"));
  } catch (e) {
    if (DEBUG) console.log("Drift Stream Error", e);
    return null;
  }
}
__name(computeDriftFromStream, "computeDriftFromStream");

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
__name(extractActivityDecoupling, "extractActivityDecoupling");

async function extractDriftStats(activities, hrMax, authHeader) {
  const drifts = [];
  for (const a of activities) {
    if (!isGaSession(a, hrMax)) continue;
    let drift = extractActivityDecoupling(a);
    if (drift == null) drift = await computeDriftFromStream(a.id, authHeader);
    if (drift != null) drifts.push(drift);
  }
  const med = median(drifts);
  if (DEBUG) console.log(`Drift Median (${activities[0]?.type ?? "?"}):`, med);
  return { medianDrift: med, count: drifts.length };
}
__name(extractDriftStats, "extractDriftStats");

function computeEfficiency(a, hrMax) {
  const hr = a.average_heartrate ?? null;
  if (!hr || !hrMax) return null;
  const rel = hr / hrMax;
  if (rel < 0.7 || rel > 0.82) return null;
  const v = a.average_speed ?? a.avg_speed ?? null;
  return v ? v / hr : null;
}
__name(computeEfficiency, "computeEfficiency");

function computeEfficiencyTrend(activities, hrMax) {
  const now = Date.now();
  const d14 = 14 * 24 * 3600 * 1e3;
  const effLast = [], effPrev = [];
  for (const a of activities) {
    if (!isGaSession(a, hrMax)) continue;
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
__name(computeEfficiencyTrend, "computeEfficiencyTrend");

// =========================
// 📅 Neue Funktion: Kalendereinträge (zukünftige 
// 🏁 Zukünftige Rennen (Kategorie: A-Rennen, B-Rennen, C-Rennen) aus dem Kalender abrufen
async function fetchUpcomingRaces(authHeader) {
  const start = new Date();
  const end = new Date();
  end.setUTCDate(start.getUTCDate() + 180); // 6 Monate nach vorn

  const url = `${BASE_URL}/athlete/${ATHLETE_ID}/events?oldest=${start.toISOString().slice(0,10)}&newest=${end.toISOString().slice(0,10)}`;
  const res = await fetch(url, { headers: { Authorization: authHeader } });

  if (!res.ok) {
    if (DEBUG) console.log("⚠️ Event-API fehlgeschlagen:", res.status);
    return [];
  }

  const events = await res.json();

  // 🔍 Filter nur nach Kategorie (z. B. A-Rennen, B-Rennen, C-Rennen)
  const races = events.filter(e => {
    const cat = (e.category || "").toLowerCase();
    return cat.includes("rennen");
  });

  if (DEBUG) {
    if (races.length > 0) {
      console.log(`🏁 Geplante Rennen (${races.length}):`);
      races.forEach(r =>
        console.log(`- ${r.name} (${r.category}) am ${r.start_date_local || r.start_date}`)
      );
    } else {
      console.log("⚪ Keine geplanten Rennen mit Kategorie 'Rennen' gefunden.");
    }
  }

  return races;
}
__name(fetchUpcomingRaces, "fetchUpcomingRaces");

  const entries = await res.json();
  const races = entries.filter(e => {
    const cat = (e.category || "").toLowerCase();
    const name = (e.name || "").toLowerCase();
    return (
      cat.includes("rennen") ||
      name.includes("rennen") ||
      name.includes("lauf") ||
      name.includes("marathon") ||
      name.includes("triathlon") ||
      name.includes("ironman")
    );
  });

  if (DEBUG) {
    if (races.length)
      console.log(`🏁 Gefundene geplante Rennen (${races.length}):`, races.map(r => `${r.name} – ${r.start_date_local || r.start_date}`));
    else
      console.log("⚪ Keine geplanten Rennen im Kalender gefunden.");
  }

  return races;
}
__name(fetchUpcomingRaces, "fetchUpcomingRaces");

// =========================
// 📈 Trainingslogik
// =========================
var CTL_DELTA_TARGET = 0.8;
var ACWR_SOFT_MAX = 1.3;
var ACWR_HARD_MAX = 1.5;
var DELOAD_FACTOR = 0.9;

function getAtlMax(ctl) {
  if (ctl < 30) return 30;
  if (ctl < 60) return 45;
  if (ctl < 90) return 65;
  return 85;
}
__name(getAtlMax, "getAtlMax");

function shouldDeload(ctl, atl) {
  const acwr = ctl > 0 ? atl / ctl : 1;
  if (acwr >= ACWR_HARD_MAX) return true;
  if (atl > getAtlMax(ctl)) return true;
  return false;
}
__name(shouldDeload, "shouldDeload");

function maxSafeCtlDelta(ctl) {
  if (ctl <= 0) return CTL_DELTA_TARGET;
  const numerator = (ACWR_SOFT_MAX - 1) * ctl;
  const denominator = 6 - ACWR_SOFT_MAX;
  const d = numerator / denominator;
  if (!isFinite(d) || d <= 0) return 0;
  return d;
}
__name(maxSafeCtlDelta, "maxSafeCtlDelta");

function computeWeekFromCtlDelta(ctl, atl, ctlDelta) {
  const tssMean = ctl + 6 * ctlDelta;
  const weekTss = tssMean * 7;
  const nextCtl = ctl + ctlDelta;
  const nextAtl = tssMean;
  const acwr = nextCtl > 0 ? nextAtl / nextCtl : null;
  const weekType = ctlDelta > 0 ? "BUILD" : ctlDelta < 0 ? "DELOAD" : "MAINTAIN";
  return { weekType, ctlDelta, weekTss, tssMean, nextCtl, nextAtl, acwr };
}
__name(computeWeekFromCtlDelta, "computeWeekFromCtlDelta");

function simulateFutureWeeks(ctl, atl, weeks = 6) {
  const out = [];
  let currentCtl = ctl, currentAtl = atl;
  for (let w = 1; w <= weeks; w++) {
    const res = computeWeekFromCtlDelta(currentCtl, currentAtl, 0.8);
    out.push({
      week: w,
      weekType: res.weekType,
      weekTss: Math.round(res.weekTss),
      ctl: res.nextCtl,
      atl: res.nextAtl,
      acwr: res.acwr
    });
    currentCtl = res.nextCtl;
    currentAtl = res.nextAtl;
  }
  return out;
}
__name(simulateFutureWeeks, "simulateFutureWeeks");

function statusColor(c) {
  return c === "green" ? "🟢" : c === "yellow" ? "🟡" : c === "red" ? "🔴" : "⚪";
}
__name(statusColor, "statusColor");

function buildStatusAmpel({ dec, eff, rec, sport }) {
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
    name: "Ermüdungsresistenz",
    value: rec != null ? rec.toFixed(2) : "k.A.",
    color: rec >= 0.65 ? "green" : rec >= 0.6 ? "yellow" : "red"
  });
  const table = `| ${sport} | Wert | Status |
|:-------|:------:|:------:|
` + markers.map((m) => `| ${m.name} | ${m.value} | ${statusColor(m.color)} |`).join("\n");
  return { table, markers };
}
__name(buildStatusAmpel, "buildStatusAmpel");

function buildPhaseRecommendation(runMarkers, rideMarkers) {
  const allRed = [...runMarkers, ...rideMarkers].filter((m) => m.color === "red");
  if (!allRed.length) return "🏋️‍♂️ Aufbau – normale Trainingswoche beibehalten.";
  if (allRed.some((m) => m.name.includes("Aerobe")))
    return "🧬 Grundlage – aerobe Basis limitiert, Fokus auf GA1/Z2 Einheiten.";
  if (allRed.length > 1)
    return "🧬 Grundlage – mehrere Marker limitiert → ruhige Woche, Fokus auf aerobe Stabilität.";
  return "🏋️‍♂️ Aufbau – stabile Basis, Technik- oder Schwellenreize möglich.";
}
__name(buildPhaseRecommendation, "buildPhaseRecommendation");

// =========================
// 🧠 Hauptlogik
// =========================
async function handle(dryRun = true) {
  const today = new Date();
  const auth = "Basic " + btoa(`${API_KEY}:${API_SECRET}`);

  // 📈 Wellnessdaten
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - (today.getUTCDay() + 6) % 7);
  const mondayStr = monday.toISOString().slice(0, 10);
  const wRes = await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${mondayStr}`, { headers: { Authorization: auth } });
  const well = await wRes.json();
  const hrMax = well.hrMax ?? 175;
  const ctl = well.ctl ?? 60;
  const atl = well.atl ?? 65;
  const rec = well.recoveryIndex ?? 0.65;

  // 📊 Aktivitäten der letzten 28 Tage
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 28);
  const actRes = await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/activities?oldest=${start.toISOString().slice(0,10)}&newest=${today.toISOString().slice(0,10)}`, { headers: { Authorization: auth } });
  const acts = await actRes.json();

  const runActs = acts.filter((a) => a.type?.includes("Run"));
  const rideActs = acts.filter((a) => a.type?.includes("Ride"));
  const runDrift = await extractDriftStats(runActs, hrMax, auth);
  const rideDrift = await extractDriftStats(rideActs, hrMax, auth);
  const runEff = computeEfficiencyTrend(runActs, hrMax);
  const rideEff = computeEfficiencyTrend(rideActs, hrMax);
  const runTable = buildStatusAmpel({ dec: runDrift.medianDrift, eff: runEff, rec, sport: "🏃‍♂️ Laufen" });
  const rideTable = buildStatusAmpel({ dec: rideDrift.medianDrift, eff: rideEff, rec, sport: "🚴‍♂️ Rad" });
  const phase = buildPhaseRecommendation(runTable.markers, rideTable.markers);
  const progression = simulateFutureWeeks(ctl, atl, 6);

  // 🏁 Zukünftige Rennen abrufen
  const raceEvents = await fetchUpcomingRaces(auth);

  let raceSummary = "⚪ Keine geplanten Rennen im nächsten halben Jahr.";
  if (raceEvents.length > 0) {
    raceSummary = raceEvents.map((r, i) => {
      const date = (r.start_date_local || r.start_date || "").slice(0, 10);
      const dist = r.distance ? (r.distance / 1000).toFixed(1) + " km" : "–";
      return `${i + 1}. ${r.name} (${date}) – ${dist}`;
    }).join("\n");
  }

  const comment = [
    "🏁 **Status-Ampel (Heute)**",
    "",
    runTable.table,
    "",
    rideTable.table,
    "",
    `**Phase:** ${phase}`,
    `**Wochentarget TSS:** ${progression[0].weekTss}`,
    `**Vorschau:** ${progression.map(p => `W${p.week}: ${p.weekType} → ${p.weekTss}`).join(", ")}`,
    "",
    "🏁 **Geplante Rennen (nächste 6 Monate):**",
    raceSummary
  ].join("\n");

  if (DEBUG) console.log({ runDrift, rideDrift, runEff, rideEff, phase, progression, raceEvents });
  if (!dryRun) {
    await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${mondayStr}`, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ [COMMENT_FIELD]: comment })
    });
  }

  return new Response(JSON.stringify({ run: runTable, ride: rideTable, phase, progression, races: raceEvents, comment }, null, 2), { status: 200 });
}
__name(handle, "handle");

var index_default = {
  async fetch(req) {
    const url = new URL(req.url);
    const write = ["1", "true", "yes"].includes(url.searchParams.get("write"));
    return handle(!write);
  },
  async scheduled(_, __, ctx) {
    if (new Date().getUTCDay() === 1) ctx.waitUntil(handle(false));
  }
};

export { index_default as default };