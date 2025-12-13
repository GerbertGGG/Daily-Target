var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// =========================
// Config
// =========================
var BASE_URL = "https://intervals.icu/api/v1";
var API_KEY = "API_KEY";
var API_SECRET = "1xg1v04ym957jsqva8720oo01";
var ATHLETE_ID = "i105857";
var COMMENT_FIELD = "comments";
var DEBUG = true;

// =========================
// Helpers
// =========================
function median(values) {
  if (!values?.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
__name(median, "median");

function isGaSession(a, hrMax) {
  const type = (a.type || "").toLowerCase();
  if (!/run|ride/.test(type)) return false;
  if ((a.moving_time ?? 0) < 40 * 60) return false;
  if (!a.average_heartrate || !hrMax) return false;
  const rel = a.average_heartrate / hrMax;
  if (rel < 0.7 || rel > 0.82) return false;
  if (a.IF && a.IF > 0.8) return false;
  if (/intervall|vo2|max|schwelle|test|30\/15|15\/15/i.test(a.name ?? "")) return false;
  return true;
}
__name(isGaSession, "isGaSession");

// =========================
// Drift / Effizienz
// =========================
async function extractDriftStats(acts, hrMax) {
  const drifts = acts.filter(a => isGaSession(a, hrMax))
    .map(a => a.decoupling ?? null)
    .filter(v => typeof v === "number");
  return { medianDrift: median(drifts), count: drifts.length };
}
__name(extractDriftStats, "extractDriftStats");

function computeEfficiencyTrend(acts, hrMax) {
  const now = Date.now();
  const d14 = 14 * 864e5;
  const last = [], prev = [];
  for (const a of acts) {
    if (!isGaSession(a, hrMax)) continue;
    const eff = a.average_speed / a.average_heartrate;
    const t = new Date(a.start_date).getTime();
    if (now - t <= d14) last.push(eff);
    else if (now - t <= 2 * d14) prev.push(eff);
  }
  const m1 = median(last), m2 = median(prev);
  return m1 && m2 ? (m1 - m2) / m2 : 0;
}
__name(computeEfficiencyTrend, "computeEfficiencyTrend");

// =========================
// Marker + Phase
// =========================
function statusColor(c) {
  return c === "green" ? "🟢" : c === "yellow" ? "🟡" : c === "red" ? "🔴" : "⚪";
}
__name(statusColor, "statusColor");

function buildStatusAmpel({ dec, eff, rec, sport }) {
  const markers = [
    {
      name: "Aerobe Basis (Drift)",
      color: dec == null ? "white" : dec < 0.05 ? "green" : dec < 0.07 ? "yellow" : "red"
    },
    {
      name: "Effizienz (Speed/HR)",
      color: eff > 0.01 ? "green" : Math.abs(eff) <= 0.01 ? "yellow" : "red"
    },
    {
      name: "Ermüdungsresistenz",
      color: rec >= 0.65 ? "green" : rec >= 0.6 ? "yellow" : "red"
    }
  ];
  const table = `| ${sport} | Wert | Status |
|:--|:--:|:--:|
` + markers.map(m => `| ${m.name} |  | ${statusColor(m.color)} |`).join("\n");
  return { markers, table };
}
__name(buildStatusAmpel, "buildStatusAmpel");

function buildPhaseRecommendation(runMarkers, rideMarkers) {
  const reds = [...runMarkers, ...rideMarkers].filter(m => m.color === "red");
  if (!reds.length) return "🏋️‍♂️ Aufbau – stabile Basis, Technik- oder Schwellenreize möglich.";
  if (reds.some(m => m.name.includes("Aerobe")))
    return "🧬 Grundlage – Fokus GA1/Z2.";
  if (reds.length > 1)
    return "🧬 Grundlage – ruhige Woche.";
  return "🏋️‍♂️ Aufbau – vorsichtig dosieren.";
}
__name(buildPhaseRecommendation, "buildPhaseRecommendation");

// =========================
// Rennen
// =========================
function toLocalYMD(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

async function fetchUpcomingRaces(auth) {
  const s = new Date();
  const e = new Date(); e.setDate(s.getDate() + 180);
  const url = `${BASE_URL}/athlete/${ATHLETE_ID}/events?oldest=${toLocalYMD(s)}&newest=${toLocalYMD(e)}`;
  const res = await fetch(url, { headers: { Authorization: auth } });
  const ev = await res.json();
  return (Array.isArray(ev) ? ev : ev.events ?? [])
    .filter(r => r.category === "RACE_A");
}
__name(fetchUpcomingRaces, "fetchUpcomingRaces");

function getNextRace(races) {
  const now = Date.now();
  return races
    .map(r => ({ r, t: new Date(r.start_date_local).getTime() }))
    .filter(x => x.t >= now)
    .sort((a,b)=>a.t-b.t)[0]?.r ?? null;
}
__name(getNextRace, "getNextRace");

function detectRaceSport(r) {
  const t = String(r?.type ?? "").toLowerCase();
  if (t.includes("run")) return "run";
  if (t.includes("ride")) return "ride";
  return null;
}
__name(detectRaceSport, "detectRaceSport");

// =========================
// 🧠 Intervall-Empfehlung
// =========================
function buildIntervalRecommendation({ markers, daysToRace }) {
  const aer = markers.find(m => m.name.includes("Aerobe"));
  const eff = markers.find(m => m.name.includes("Effizienz"));

  if (aer?.color === "red")
    return "❌ **Keine Intervalle** – aerobe Basis zuerst stabilisieren.";

  if (daysToRace != null && daysToRace <= 14)
    return "🟡 **Kurze, lockere Intervalle** (z. B. 6×30″) – Frische priorisieren.";

  if (daysToRace != null && daysToRace <= 56 && eff?.color !== "red")
    return "🔴 **Lange rennspezifische Intervalle** (z. B. 3×8–12′ im Wettkampftempo).";

  return "🔵 **Kurze Intervalle (VO₂max)** (z. B. 30/30, 40/20, 5×3′).";
}
__name(buildIntervalRecommendation, "buildIntervalRecommendation");

// =========================
// Main
// =========================
async function handle(dryRun = true) {
  const auth = "Basic " + btoa(`${API_KEY}:${API_SECRET}`);

  const monday = new Date();
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  const mondayStr = monday.toISOString().slice(0,10);

  const well = await (await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${mondayStr}`, { headers:{Authorization:auth} })).json();
  const { hrMax=175, ctl=60, atl=65, recoveryIndex:rec=0.65 } = well;

  const start = new Date(); start.setDate(start.getDate() - 28);
  const acts = await (await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/activities?oldest=${start.toISOString().slice(0,10)}`, { headers:{Authorization:auth} })).json();

  const runActs = acts.filter(a => a.type?.includes("Run"));
  const rideActs = acts.filter(a => a.type?.includes("Ride"));

  const runTable = buildStatusAmpel({
    dec: (await extractDriftStats(runActs, hrMax)).medianDrift,
    eff: computeEfficiencyTrend(runActs, hrMax),
    rec,
    sport: "🏃‍♂️ Laufen"
  });

  const rideTable = buildStatusAmpel({
    dec: (await extractDriftStats(rideActs, hrMax)).medianDrift,
    eff: computeEfficiencyTrend(rideActs, hrMax),
    rec,
    sport: "🚴‍♂️ Rad"
  });

  const races = await fetchUpcomingRaces(auth);
  const nextRace = getNextRace(races);
  const raceSport = detectRaceSport(nextRace);

  const phase = raceSport === "run"
    ? buildPhaseRecommendation(runTable.markers, [])
    : raceSport === "ride"
      ? buildPhaseRecommendation([], rideTable.markers)
      : buildPhaseRecommendation(runTable.markers, rideTable.markers);

  let daysToRace = null;
  if (nextRace) {
    daysToRace = Math.round(
      (new Date(nextRace.start_date_local).getTime() - Date.now()) / 864e5
    );
  }

  const intervalMarkers =
    raceSport === "run" ? runTable.markers :
    raceSport === "ride" ? rideTable.markers :
    [...runTable.markers, ...rideTable.markers];

  const intervalRec = buildIntervalRecommendation({ markers: intervalMarkers, daysToRace });

  const comment = [
    "🏁 **Status-Ampel (Heute)**",
    "",
    runTable.table,
    "",
    rideTable.table,
    "",
    `**Phase:** ${phase}`,
    "",
    "🏃‍♂️ **Intervall-Empfehlung:**",
    intervalRec
  ].join("\n");

  if (!dryRun) {
    await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${mondayStr}`, {
      method:"PUT",
      headers:{Authorization:auth,"Content-Type":"application/json"},
      body:JSON.stringify({[COMMENT_FIELD]:comment})
    });
  }

  return new Response(JSON.stringify({ phase, intervalRec }, null, 2));
}

export default {
  fetch(req) {
    const w = new URL(req.url).searchParams.get("write");
    return handle(!["1","true","yes"].includes(w));
  },
  scheduled(_, __, ctx) {
    if (new Date().getUTCDay() === 1) ctx.waitUntil(handle(false));
  }
};