const BASE_URL = "https://intervals.icu/api/v1";
const INTERVALS_API_KEY = "1xg1v04ym957jsqva8720oo01";
const INTERVALS_ATHLETE_ID = "i105857";

const INTERVALS_TARGET_FIELD = "TageszielTSS";  // Tages-TSS
const INTERVALS_PLAN_FIELD = "WochenPlan";      // Plantext
const WEEKLY_TARGET_FIELD = "WochenzielTSS";    // Wochenziel (TSS)
const DAILY_TYPE_FIELD = "TagesTyp";            // z.B. "Mo,Mi,Fr,So"

const DEFAULT_PLAN_STRING = "Mo,Mi,Fr,So";
const DEFAULT_TRAINING_DAYS_PER_WEEK = 4.0;
const HARD_DAILY_CAP = 200;

const DAY_NAMES = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

function dayIdxFromJsDay(jsDay) {
  return jsDay === 0 ? 6 : jsDay - 1;
}

function parseTrainingDays(str) {
  if (!str || typeof str !== "string") return new Array(7).fill(false);
  const tokens = str.split(/[,\s;]+/).map(t => t.trim()).filter(t => t.length > 0);
  const selected = new Array(7).fill(false);
  for (const raw of tokens) {
    const t = raw.toLowerCase();
    const num = parseInt(t, 10);
    if (!isNaN(num) && num >= 1 && num <= 7) { selected[num-1] = true; continue; }
    if (t.startsWith("mo")) selected[0] = true;
    else if (t.startsWith("di")) selected[1] = true;
    else if (t.startsWith("mi")) selected[2] = true;
    else if (t.startsWith("do")) selected[3] = true;
    else if (t.startsWith("fr")) selected[4] = true;
    else if (t.startsWith("sa")) selected[5] = true;
    else if (t.startsWith("so")) selected[6] = true;
  }
  return selected;
}

function stateEmoji(state) {
  if (state === "Erholt") return "🔥";
  if (state === "Müde") return "🧘";
  return "⚖️";
}

// -------------------- NEUE TSS-FUNKTION --------------------
function calculateTSS({
  ctl,
  atl,
  rampRate = 0,
  weekState = null,
  planSelected = [true,false,true,false,true,false,false],
  weeklyTarget = 150,
  weeklyLoadSoFar = 0,
  dayIdx = 0
}) {
  const tsb = ctl - atl;
  const tsbClamped = Math.max(-20, Math.min(20, tsb));
  const baseDaily = ctl * (1.0 + 0.05 * tsbClamped);

  if (!weekState) {
    const tsbCritical = ctl < 50 ? -5 : ctl < 80 ? -10 : -15;
    const atlRatioThreshold = ctl < 50 ? 1.2 : ctl < 80 ? 1.3 : 1.4;
    const atlCtlRatio = ctl > 0 ? atl / ctl : Infinity;
    if (tsb >= -5 && rampRate <= -0.5) weekState = "Erholt";
    else if (tsb <= tsbCritical || atlCtlRatio >= atlRatioThreshold || rampRate >= 1.0) weekState = "Müde";
    else weekState = "Normal";
  }

  const remainingPlannedDays = planSelected.slice(dayIdx).filter(Boolean).length || 1;
  const remainingTSS = Math.max(0, weeklyTarget - weeklyLoadSoFar);
  const targetFromWeek = remainingTSS / remainingPlannedDays;

  const baseForToday = Math.max(baseDaily, targetFromWeek);

  let tsbFactor = 1.0;
  if (tsb >= 10) tsbFactor = 1.3;
  else if (tsb >= 5) tsbFactor = 1.15;
  else if (tsb >= 0) tsbFactor = 1.05;
  else if (tsb <= -15) tsbFactor = 0.5;
  else if (tsb <= -10) tsbFactor = 0.6;
  else if (tsb <= -5) tsbFactor = 0.8;

  let microFactor = 1.0;

  const avgTrainingDay = weeklyTarget / (planSelected.filter(Boolean).length || DEFAULT_TRAINING_DAYS_PER_WEEK);
  const maxDailyByCtl = ctl * 3.0;
  const maxDailyByWeek = avgTrainingDay * 2.5;
  const maxDaily = Math.min(HARD_DAILY_CAP, Math.max(baseDaily, Math.min(maxDailyByCtl, maxDailyByWeek)));

  const tssTargetRaw = baseForToday * tsbFactor * microFactor;
  return Math.round(Math.min(tssTargetRaw, maxDaily));
}

// -------------------- KLASSIFIZIERUNG --------------------
function classifyWeek(ctl, atl, rampRate) {
  const tsb = ctl - atl;
  let tsbCritical;
  if (ctl < 50) tsbCritical = -5;
  else if (ctl < 80) tsbCritical = -10;
  else tsbCritical = -15;

  let atlCtlRatio = ctl > 0 ? atl / ctl : Infinity;
  let atlRatioThreshold;
  if (ctl < 50) atlRatioThreshold = 1.2;
  else if (ctl < 80) atlRatioThreshold = 1.3;
  else atlRatioThreshold = 1.4;

  if (tsb >= -5 && rampRate <= -0.5) return { state: "Erholt", tsb };
  if (tsb <= tsbCritical || atlCtlRatio >= atlRatioThreshold || rampRate >= 1.0) return { state: "Müde", tsb };
  return { state: "Normal", tsb };
}

// -------------------- RAMP-RATE-WOCHENZIEL --------------------
function calculateWeeklyTSSForRampRate({ ctlStart, rampRate, trainingDays = 4 }) {
  const ctlIncrease = rampRate * 7;
  const dailyTSS = ctlStart + (ctlIncrease * 42 / 7);
  const weeklyTSS = dailyTSS * trainingDays;
  return Math.round(weeklyTSS);
}

// -------------------- SIMULATION --------------------
async function simulatePlannedWeeks(ctlStart, atlStart, weekStateStart, weeklyTargetStart, mondayDate, planSelected, authHeader, athleteId, weeksToSim, dryRun) {
  const tauCtl = 42;
  const tauAtl = 7;

  let dayWeights = planSelected.map(p => p ? 1 : 0);
  let sumWeights = dayWeights.reduce((a,b)=>a+b,0);
  if (sumWeights<=0){ dayWeights=[1,0,1,0,1,0,1]; sumWeights=4; }

  let ctl = ctlStart;
  let atl = atlStart;
  let prevTarget = weeklyTargetStart;
  let prevState = weekStateStart;

  const out = [];

  for (let w=1; w<=weeksToSim; w++){
    const ctlAtWeekStart = ctl;

    for (let d=0; d<7; d++){
      const share = dayWeights[d]/sumWeights;
      const load = prevTarget * share;
      ctl = ctl + (load - ctl)/tauCtl;
      atl = atl + (load - atl)/tauAtl;
    }

    const ctlEnd = ctl;
    const atlEnd = atl;
    const rampSim = ctlEnd - ctlAtWeekStart;

    const { state: simState, tsb: simTsb } = classifyWeek(ctlEnd, atlEnd, rampSim);

    let nextTarget = prevTarget;

    if (simState === "Müde"){
      const ratio = ctlEnd > 0 ? atlEnd/ctlEnd : Infinity;
      if (simTsb < -20 || ratio>1.4) nextTarget = prevTarget*0.8;
      else nextTarget = prevTarget*0.9;
    } else {
      if (rampSim<0.5) nextTarget = prevTarget*(simState==="Erholt"?1.12:1.08);
      else if (rampSim<1.0) nextTarget = prevTarget*(simState==="Erholt"?1.08:1.05);
      else if (rampSim<=1.5) nextTarget = prevTarget*1.02;
      else nextTarget = prevTarget*0.9;
    }

    const minWeekly = prevTarget*0.75;
    const maxWeekly = prevTarget*1.25;
    nextTarget = Math.max(minWeekly, Math.min(maxWeekly, nextTarget));
    nextTarget = Math.round(nextTarget/5)*5;

    const mondayFutureDate = new Date(mondayDate);
    mondayFutureDate.setUTCDate(mondayFutureDate.getUTCDate() + 7*w);
    const mondayId = mondayFutureDate.toISOString().slice(0,10);

    out.push({
      weekOffset:w,
      monday:mondayId,
      weeklyTarget:nextTarget,
      state:simState,
      tsb:simTsb,
      rampSim
    });

    prevTarget = nextTarget;
    prevState = simState;
  }

  return out;
}

// -------------------- HANDLE --------------------
async function handle(env, request){
  try{
    const url = request ? new URL(request.url) : null;
    const dryRun = url && url.searchParams.get("dryRun")==="1";

    const apiKey = INTERVALS_API_KEY;
    const athleteId = INTERVALS_ATHLETE_ID;
    if (!apiKey || !athleteId) return new Response("Missing config",{status:500});
    const authHeader = "Basic " + btoa(`API_KEY:${apiKey}`);

    const now = new Date();
    const today = now.toISOString().slice(0,10);
    const todayDate = new Date(today+"T00:00:00Z");
    const jsDay = todayDate.getUTCDay();
    const dayIdx = dayIdxFromJsDay(jsDay);

    const offset = jsDay===0?6:jsDay-1;
    const mondayDate = new Date(todayDate);
    mondayDate.setUTCDate(mondayDate.getUTCDate()-offset);
    const mondayStr = mondayDate.toISOString().slice(0,10);

    const lastMondayDate = new Date(mondayDate);
    lastMondayDate.setUTCDate(lastMondayDate.getUTCDate()-7);
    const lastMondayStr = lastMondayDate.toISOString().slice(0,10);
    const lastSundayDate = new Date(mondayDate);
    lastSundayDate.setUTCDate(lastSundayDate.getUTCDate()-1);
    const lastSundayStr = lastSundayDate.toISOString().slice(0,10);

    // Wellness heute abrufen
    const wellnessRes = await fetch(`${BASE_URL}/athlete/${athleteId}/wellness/${today}`, { headers:{Authorization:authHeader} });
    if (!wellnessRes.ok) return new Response(`Failed to fetch wellness today: ${wellnessRes.status}`,{status:500});
    const wellness = await wellnessRes.json();

    const ctl = wellness.ctl;
    const atl = wellness.atl;
    const rampRate = wellness.rampRate??0;
    if (ctl==null || atl==null) return new Response("No ctl/atl data",{status:200});

    const todaysDailyTypeRaw = wellness[DAILY_TYPE_FIELD];
    const todaysDailyType = todaysDailyTypeRaw==null ? "" : String(todaysDailyTypeRaw).trim();

    const { state: weekState, tsb } = classifyWeek(ctl, atl, rampRate);

    // Montag-Wellness
    let ctlMon, atlMon;
    let mondayWeeklyTarget = null;
    let mondayPlanString = "";

    const mondayWellnessRes = await fetch(`${BASE_URL}/athlete/${athleteId}/wellness/${mondayStr}`, { headers:{Authorization:authHeader} });
    if (mondayWellnessRes.ok){
      const mon = await mondayWellnessRes.json();
      ctlMon = mon.ctl??ctl;
      atlMon = mon.atl??atl;
      mondayWeeklyTarget = mon[WEEKLY_TARGET_FIELD]??null;
      const mondayDailyTypeRaw = mon[DAILY_TYPE_FIELD];
      mondayPlanString = mondayDailyTypeRaw==null?"":String(mondayDailyTypeRaw).trim();
    } else { ctlMon=ctl; atlMon=atl; }

    if (!mondayPlanString) mondayPlanString = DEFAULT_PLAN_STRING;

    if (todaysDailyType && todaysDailyType !== mondayPlanString){
      mondayPlanString = todaysDailyType;
      if(!dryRun) await fetch(`${BASE_URL}/athlete/${athleteId}/wellness/${mondayStr}`,{
        method:"PUT",
        headers:{ "Content-Type":"application/json", Authorization:authHeader },
        body: JSON.stringify({ id:mondayStr, [DAILY_TYPE_FIELD]:mondayPlanString })
      });
    }

    const planSelected = parseTrainingDays(mondayPlanString);

    // Wochenziel berechnen mit Ramp-Rate-Steuerung
    const trainingDaysCount = planSelected.filter(Boolean).length || DEFAULT_TRAINING_DAYS_PER_WEEK;
    const desiredRampRate = 1.0; // z.B. zwischen 0.8 und 1.3 anpassen

    let weeklyTarget;
    if (mondayWeeklyTarget!=null) weeklyTarget = mondayWeeklyTarget;
    else weeklyTarget = calculateWeeklyTSSForRampRate({
      ctlStart: ctlMon,
      rampRate: desiredRampRate,
      trainingDays: trainingDaysCount
    });

    // Woche laden
    let weekLoadUntilYesterday=0;
    try{
      const weekRes = await fetch(`${BASE_URL}/athlete/${athleteId}/wellness?oldest=${mondayStr}&newest=${today}&cols=id,ctlLoad`, { headers:{Authorization:authHeader} });
      if (weekRes.ok){
        const weekArr = await weekRes.json();
        for (const d of weekArr){
          if (!d.id || d.ctlLoad==null) continue;
          const dDate = new Date(d.id+"T00:00:00Z");
          if(dDate.getTime() < todayDate.getTime()) weekLoadUntilYesterday += d.ctlLoad;
        }
      }
    } catch(e){console.error(e);}

    // Tages-TSS berechnen
    const tssTarget = calculateTSS({
      ctl: ctlMon,
      atl: atlMon,
      rampRate,
      weekState,
      planSelected,
      weeklyTarget,
      weeklyLoadSoFar: weekLoadUntilYesterday,
      dayIdx
    });

    const tssLow = Math.round(tssTarget*0.8);
    const tssHigh = Math.round(tssTarget*1.2);

    const planTextToday = `Rest ${weeklyTarget-weekLoadUntilYesterday} | ${stateEmoji(weekState)} ${weekState}`;

    const payloadToday = {
      id: today,
      [INTERVALS_TARGET_FIELD]: tssTarget,
      [INTERVALS_PLAN_FIELD]: planTextToday,
      comments: `Tagesziel: ${tssTarget} TSS (Range ${tssLow}-${tssHigh})`
    };

    if (today===mondayStr && mondayWeeklyTarget==null) payloadToday[WEEKLY_TARGET_FIELD]=weeklyTarget;

    const updateRes = await fetch(`${BASE_URL}/athlete/${athleteId}/wellness/${today}`,{
      method:"PUT",
      headers:{ "Content-Type":"application/json", Authorization:authHeader },
      body: JSON.stringify(payloadToday)
    });

    if (!updateRes.ok) {
      const text = await updateRes.text();
      return new Response(`Failed to update wellness: ${updateRes.status} ${text}`,{status:500});
    }

    const futureWeeks = await simulatePlannedWeeks(
      ctlMon, atlMon, weekState, weeklyTarget, mondayDate, planSelected, authHeader, athleteId, 6, dryRun
    );

    if (dryRun){
      return new Response(JSON.stringify({
        dryRun:true,
        thisWeek:{ monday:mondayStr, weeklyTarget, alreadyDone:weekLoadUntilYesterday },
        weeklyProgression: futureWeeks.map(w=>({weekOffset:w.weekOffset, monday:w.monday, weeklyTarget:w.weeklyTarget, state:w.state}))
      }, null, 2), { status:200, headers:{"Content-Type":"application/json"} });
    }

    return new Response(`OK: Tagesziel=${tssTarget}, Wochenziel=${weeklyTarget}, Range=${tssLow}-${tssHigh}`, {status:200});

  } catch(err){
    console.error(err);
    return new Response("Unexpected error: "+(err.stack||String(err)),{status:500});
  }
}

// -------------------- EXPORT --------------------
export default {
  async fetch(request, env, ctx){ return handle(env, request); },
  async scheduled(event, env, ctx){ ctx.waitUntil(handle(env, null)); }
};
