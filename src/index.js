/**
 * ============================================================
 * IntervalsLimiterCoach v12 – Planned Races Edition (Final)
 * ============================================================
 * Features:
 * ✅ Geplante Rennen (planned=true, type=race, discipline)
 * ✅ A-Race aware (discipline → Run / Ride / Triathlon / Duathlon)
 * ✅ GA-Filter (Run≥40min, Ride≥50min, HF 70–82 %, 68–80 %, VI≤1.15, keine Intervalle)
 * ✅ VirtualRide erlaubt, solange keine Intervalle
 * ✅ Drift & Effizienz mit Stream-Fallback
 * ✅ CTL/ATL/TSS Simulation (Friel)
 * ✅ Montagsschutz (nur montags schreiben)
 * ✅ Ampel-Tabelle + Coaching-Kommentar
 * ============================================================
 */

const BASE_URL = "https://intervals.icu/api/v1";
const API_KEY = "API_KEY";
const API_SECRET = "1xg1v04ym957jsqva8720oo01";
const ATHLETE_ID = "i105857";
const COMMENT_FIELD = "comments";
const DEBUG = true;

// ============================================================
// 🧠 Utility
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
// 🫀 GA-Filter (Run & Ride, virtuell erlaubt, keine Intervalle)
// ============================================================
function isGaSession(a, hrMax) {
  const type = (a.type || "").toLowerCase();
  const name = (a.name || "").toLowerCase();
  const dur = a.moving_time ?? 0;
  const hr = a.average_heartrate ?? null;
  if (!hr || !hrMax) return false;
  const rel = hr / hrMax;

  // 🏃‍♂️ RUN
  if (type.includes("run")) {
    if (dur < 40 * 60) return false;
    if (rel < 0.70 || rel > 0.82) return false;
    if (/intervall|interval|vo2|max|schwelle|berg|30s|15\/15|test/i.test(name)) return false;
    return true;
  }

  // 🚴‍♂️ RIDE
  if (type.includes("ride")) {
    if (dur < 50 * 60) return false;
    if (rel < 0.68 || rel > 0.80) return false;
    if (/intervall|interval|vo2|max|schwelle|sweet|test|ramp|ftp|berg/i.test(name)) return false;
    const np = a.normalized_power ?? null;
    const avg = a.avg_power ?? a.average_watts ?? null;
    if (np && avg && np / avg > 1.15) return false;
    return true; // VirtualRide erlaubt
  }

  return false;
}

// ============================================================
// 🧮 Driftberechnung (mit Retry + Stream)
// ============================================================
async function computeDriftFromStream(a, authHeader) {
  try {
    const url = `${BASE_URL}/activity/${a.id}/streams.json?types=time,heartrate,velocity_smooth,watts_smooth,watts`;
    let res = await fetch(url, { headers: { Authorization: authHeader } });
    let streams;
    if (!res.ok) {
      await new Promise(r => setTimeout(r, 300));
      const retry = await fetch(url, { headers: { Authorization: authHeader } });
      if (!retry.ok) return null;
      streams = await retry.json();
    } else {
      streams = await res.json();
    }

    const get = (t) => streams.find(s => s.type === t)?.data ?? null;
    const time = get("time");
    const hr = get("heartrate");
    const vel = get("velocity_smooth");
    const power = get("watts_smooth") || get("watts");

    if (a.type?.includes("Ride") && power) {
      return computeDecoupling(time, hr, power);
    } else {
      return computeDecoupling(time, hr, vel);
    }
  } catch {
    return null;
  }
}

function computeDecoupling(time, hr, data) {
  if (!time || !hr || !data) return null;
  const n = Math.min(time.length, hr.length, data.length);
  if (n < 200) return null;
  const mid = Math.floor(n / 2);
  const rel1 = data.slice(0, mid).reduce((a, v, i) => a + v / hr[i], 0) / mid;
  const rel2 = data.slice(mid).reduce((a, v, i) => a + v / hr[i + mid], 0) / (n - mid);
  if (!rel1 || !isFinite(rel1)) return null;
  return Math.min(Math.abs((rel2 - rel1) / rel1), 0.15);
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

async function extractDriftStats(activities, hrMax, authHeader) {
  const drifts = [];
  for (const a of activities) {
    if (!isGaSession(a, hrMax)) continue;
    if (!a.average_heartrate || a.average_heartrate < 60) continue;
    let drift = extractActivityDecoupling(a);
    if (drift == null) drift = await computeDriftFromStream(a, authHeader);
    if (drift != null) drifts.push(drift);
  }
  return { medianDrift: median(drifts), count: drifts.length };
}

// ============================================================
// ⚙️ Effizienztrend
// ============================================================
function computeEfficiency(a, hrMax) {
  const hr = a.average_heartrate ?? null;
  if (!hr || !hrMax) return null;
  const rel = hr / hrMax;
  if (rel < 0.7 || rel > 0.82) return null;

  const type = a.type?.toLowerCase() ?? "";
  if (type.includes("ride")) {
    const power = a.weighted_average_watts ?? a.avg_power ?? null;
    if (power) return power / hr;
    const v = a.average_speed ?? a.avg_speed ?? null;
    return v ? v / hr : null;
  }

  const v = a.average_speed ?? a.avg_speed ?? null;
  return v ? v / hr : null;
}

function computeEfficiencyTrend(activities, hrMax) {
  const now = Date.now();
  const d14 = 14 * 24 * 3600 * 1000;
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
  return (mLast && mPrev) ? (mLast - mPrev) / mPrev : 0;
}

// ============================================================
// 🧮 CTL/ATL/TSS Simulation (Friel)
// ============================================================
const CTL_DELTA_TARGET = 0.8;

function computeWeekFromCtlDelta(ctl, atl, ctlDelta) {
  const tssMean = ctl + 6 * ctlDelta;
  const weekTss = tssMean * 7;
  const nextCtl = ctl + ctlDelta;
  const nextAtl = tssMean;
  const acwr = nextCtl > 0 ? nextAtl / nextCtl : null;
  const weekType = ctlDelta > 0 ? "BUILD" : ctlDelta < 0 ? "DELOAD" : "MAINTAIN";
  return { weekType, ctlDelta, weekTss, nextCtl, nextAtl, acwr };
}

function simulateFutureWeeks(ctl, atl, weeks = 6) {
  const out = [];
  let currentCtl = ctl, currentAtl = atl;
  for (let w = 1; w <= weeks; w++) {
    const res = computeWeekFromCtlDelta(currentCtl, currentAtl, CTL_DELTA_TARGET);
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

// ============================================================
// 🚦 Ampel & Phase
// ============================================================
function statusColor(c) {
  return c === "green" ? "🟢" : c === "yellow" ? "🟡" : c === "red" ? "🔴" : "⚪";
}

function buildStatusAmpel({ dec, eff, rec, sport }) {
  const markers = [];
  markers.push({
    name: "Aerobe Basis (Drift)",
    value: dec != null ? `${(dec * 100).toFixed(1)} %` : "k.A.",
    color: dec == null ? "white" : dec < 0.05 ? "green" : dec < 0.07 ? "yellow" : "red"
  });
  markers.push({
    name: "Effizienz (W/HR oder Speed/HR)",
    value: `${(eff * 100).toFixed(1)} %`,
    color: eff > 0.01 ? "green" : Math.abs(eff) <= 0.01 ? "yellow" : "red"
  });
  markers.push({
    name: "Ermüdungsresistenz",
    value: rec != null ? rec.toFixed(2) : "k.A.",
    color: rec >= 0.65 ? "green" : rec >= 0.6 ? "yellow" : "red"
  });

  const table =
    `| ${sport} | Wert | Status |\n|:-------|:------:|:------:|\n` +
    markers.map(m => `| ${m.name} | ${m.value} | ${statusColor(m.color)} |`).join("\n");
  return { table, markers };
}

function buildPhaseRecommendation(runMarkers, rideMarkers) {
  const allRed = [...runMarkers, ...rideMarkers].filter(m => m.color === "red");
  if (!allRed.length) return "🏋️‍♂️ Aufbau – normale Trainingswoche beibehalten.";
  if (allRed.some(m => m.name.includes("Aerobe")))
    return "🫀 Grundlage – aerobe Basis limitiert, Fokus auf GA1/Z2 Einheiten.";
  if (allRed.length > 1)
    return "🫀 Grundlage – mehrere Marker limitiert → ruhige Woche, Fokus auf aerobe Stabilität.";
  return "🏋️‍♂️ Aufbau – stabile Basis, Technik- oder Schwellenreize möglich.";
}

// ============================================================
// MAIN
// ============================================================
async function handle(dryRun = true) {
  const today = new Date();
  const isMonday = today.getUTCDay() === 1;
  if (!isMonday && !dryRun)
    return new Response(JSON.stringify({ status: "blocked", reason: "Nur montags erlaubt" }, null, 2));

  const auth = "Basic " + btoa(`${API_KEY}:${API_SECRET}`);
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7));
  const mondayStr = monday.toISOString().slice(0, 10);

  // Wellness
  const wRes = await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${mondayStr}`, { headers: { Authorization: auth } });
  const well = await wRes.json();
  const hrMax = well.hrMax ?? 175;
  const ctl = well.ctl ?? 60;
  const atl = well.atl ?? 65;
  const rec = well.recoveryIndex ?? 0.65;

  // ============================================================
  // 🏁 Geplante Rennen (12 Monate)
  // ============================================================
  const oldest = new Date();
  const newest = new Date();
  newest.setFullYear(newest.getFullYear() + 1);

  const evUrl = `${BASE_URL}/athlete/${ATHLETE_ID}/events?oldest=${oldest.toISOString().slice(0,10)}&newest=${newest.toISOString().slice(0,10)}&planned=true&type=race`;
  const evRes = await fetch(evUrl, { headers: { Authorization: auth } });

  const plannedEvents = evRes.ok ? await evRes.json() : [];
  const raceEvents = plannedEvents
    .filter(e => !e.completed && e.start_date_local)
    .map(e => ({
      ...e,
      start: new Date(e.start_date_local),
      discipline: (e.discipline || e.type || "").toLowerCase()
    }))
    .filter(e => e.start >= today)
    .sort((a,b) => a.start - b.start);

  const upcomingEvent = raceEvents[0] || null;

  let activeSport = "both";
  if (upcomingEvent) {
    const disc = upcomingEvent.discipline;
    if (disc.includes("run")) activeSport = "run";
    else if (disc.includes("ride") || disc.includes("bike")) activeSport = "ride";
    else if (disc.includes("tri") || disc.includes("duat")) activeSport = "both";
  }

  // ============================================================
  // Aktivitäten & Analysen
  // ============================================================
  const start = new Date(monday);
  start.setUTCDate(start.getUTCDate() - 28);
  const actRes = await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/activities?oldest=${start.toISOString().slice(0,10)}&newest=${today.toISOString().slice(0,10)}`, { headers: { Authorization: auth } });
  const acts = await actRes.json();
  const runActs = acts.filter(a => a.type?.includes("Run"));
  const rideActs = acts.filter(a => a.type?.includes("Ride"));

  const runDrift = await extractDriftStats(runActs, hrMax, auth);
  const rideDrift = await extractDriftStats(rideActs, hrMax, auth);
  const runEff = computeEfficiencyTrend(runActs, hrMax);
  const rideEff = computeEfficiencyTrend(rideActs, hrMax);

  const runTable = buildStatusAmpel({ dec: runDrift.medianDrift, eff: runEff, rec, sport: "🏃‍♂️ Laufen" });
  const rideTable = buildStatusAmpel({ dec: rideDrift.medianDrift, eff: rideEff, rec, sport: "🚴‍♂️ Rad" });

  let phase;
  if (activeSport === "run") phase = buildPhaseRecommendation(runTable.markers, []);
  else if (activeSport === "ride") phase = buildPhaseRecommendation([], rideTable.markers);
  else phase = buildPhaseRecommendation(runTable.markers, rideTable.markers);

  const progression = simulateFutureWeeks(ctl, atl, 6);

  // Kommentar
  const eventNote = upcomingEvent
    ? `🎯 Geplantes Rennen erkannt: ${upcomingEvent.name} (${upcomingEvent.discipline}) am ${upcomingEvent.start_date_local.slice(0,10)}`
    : `ℹ️ Kein geplantes Rennen gefunden – allgemeine Trainingsphase (Run + Ride kombiniert).`;

  const commentBlocks = [eventNote];

  if (activeSport === "run" || activeSport === "both")
    commentBlocks.push("", "🏃‍♂️ **Laufen**", runTable.table);
  if (activeSport === "ride" || activeSport === "both")
    commentBlocks.push("", "🚴‍♂️ **Rad**", rideTable.table);

  commentBlocks.push(
    "",
    `**Phase:** ${phase}`,
    `**Wochentarget TSS:** ${progression[0].weekTss}`,
    `**Vorschau:** ${progression.map(p => `W${p.week}: ${p.weekType} → ${p.weekTss}`).join(", ")}`
  );

  const comment = commentBlocks.join("\n");

  if (!dryRun) {
    await fetch(`${BASE_URL}/athlete/${ATHLETE_ID}/wellness/${mondayStr}`, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ [COMMENT_FIELD]: comment })
    });
  }

  const result = {
    event: upcomingEvent ? { name: upcomingEvent.name, discipline: upcomingEvent.discipline, date: upcomingEvent.start_date_local } : null,
    activeSport,
    run: runTable,
    ride: rideTable,
    phase,
    progression,
    comment
  };

  if (DEBUG) console.log(JSON.stringify(result, null, 2));
  return new Response(JSON.stringify(result, null, 2), { status: 200 });
}

// ============================================================
// Export (Fetch + Scheduler)
// ============================================================
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
  if (DEBUG) console.log(JSON.stringify(result, null, 2));
  return new Response(JSON.stringify(result, null, 2), { status: 200 });
};

// ============================================================
// Export (Fetch + Scheduler)
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const writeParam = url.searchParams.get("write");
    const shouldWrite =
      writeParam === "1" ||
      writeParam === "true" ||
      writeParam === "yes";

    const dryRun = !shouldWrite;
    return handle(dryRun);
  },

  async scheduled(event, env, ctx) {
    // Nur montags ausführen (UTC)
    const now = new Date();
    const isMonday = now.getUTCDay() === 1;
    if (!isMonday) return;
    ctx.waitUntil(handle(false));
  }
};