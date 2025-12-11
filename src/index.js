const BASE_URL = "https://intervals.icu/api/v1";
const INTERVALS_API_KEY = "1xg1v04ym957jsqva8720oo01";
const INTERVALS_ATHLETE_ID = "i105857";

const INTERVALS_PLAN_FIELD = "WochenPlan";
const WEEKLY_TARGET_FIELD = "WochenzielTSS";
const DAILY_TYPE_FIELD = "TagesTyp";
const DEFAULT_PLAN_STRING = "Mo,Mi,Fr,So";

// ------------------- Hilfsfunktionen -------------------
function parseTrainingDays(str) {
  if (!str || typeof str !== "string") return new Array(7).fill(false);
  const tokens = str.split(/[,\s;]+/).map(t => t.trim()).filter(t => t.length>0);
  const selected = new Array(7).fill(false);
  for(const raw of tokens){
    const t = raw.toLowerCase();
    if(t.startsWith("mo")) selected[0]=true;
    else if(t.startsWith("di")) selected[1]=true;
    else if(t.startsWith("mi")) selected[2]=true;
    else if(t.startsWith("do")) selected[3]=true;
    else if(t.startsWith("fr")) selected[4]=true;
    else if(t.startsWith("sa")) selected[5]=true;
    else if(t.startsWith("so")) selected[6]=true;
  }
  return selected;
}

function stateEmoji(state){if(state==="Erholt")return "🔥"; if(state==="Müde")return "🧘"; return "⚖️";}

function classifyWeek(ctl, atl, rampRate){
  const tsb = ctl - atl;
  let tsbCritical = ctl<50?-5:ctl<80?-10:-15;
  const isTsbTired = tsb<=tsbCritical;
  let atlCtlRatio = ctl>0?atl/ctl:Infinity;
  let atlRatioThreshold = ctl<50?1.2:ctl<80?1.3:1.4;
  const isAtlHigh = atlCtlRatio>=atlRatioThreshold;
  const isRampHigh = rampRate>=1.0;
  const isRampLowAndFresh = rampRate<=-0.5 && tsb>=-5;

  if(isRampLowAndFresh) return {state:"Erholt", tsb};
  if(isRampHigh||isTsbTired||isAtlHigh) return {state:"Müde", tsb};
  return {state:"Normal", tsb};
}

function recommendWeekPhase(lastWeekMarkers, weekState){
  const decupling = lastWeekMarkers?.decupling ?? null;
  const pdc = lastWeekMarkers?.pdc ?? null;
  let phase = "Aufbau";
  if(!decupling||!pdc) phase="Grundlage";
  else if(decupling>5) phase="Grundlage";
  else if(pdc<0.9) phase="Intensiv";
  else phase="Aufbau";
  if(weekState==="Müde") phase="Erholung";
  return phase;
}

// ------------------- Berechnung Wochen-TSS -------------------
function computeWeeklyTssFromCtl(prevTss, ctl, ctlIncrease){
  // prevTss = bisherige Wochen-TSS
  // ctlIncrease = gewünschter CTL-Zuwachs pro Woche (0,8–1,3)
  const factor = 1 + ctlIncrease / ctl; // prozentualer Zuwachs basierend auf CTL
  return Math.round(prevTss * factor);
}

// ------------------- 6-Wochen Simulation -------------------
async function simulatePlannedWeeks(ctlStart, atlStart, weekStateStart, weeklyTargetStart, mondayDate, planSelected, authHeader, athleteId, weeksToSim, historicalMarkers, writeToIntervals = false){
  let dayWeights = planSelected.map(v=>v?1:0);
  if(dayWeights.reduce((a,b)=>a+b,0)===0) dayWeights=[1,0,1,0,1,0,1];

  let ctl = ctlStart, atl = atlStart, prevTarget = weeklyTargetStart, prevState = weekStateStart;
  const weeklyProgression = [];
  const tauCtl = 42, tauAtl = 7;

  for(let w=1; w<=weeksToSim; w++){
    const ctlAtWeekStart = ctl;

    // Tägliche Simulation
    for(let d=0; d<7; d++){
      const share = dayWeights[d]/dayWeights.reduce((a,b)=>a+b,0);
      const load = prevTarget * share;
      ctl += (load - ctl)/tauCtl;
      atl += (load - atl)/tauAtl;
    }

    const ctlEnd = ctl, atlEnd = atl;
    const rampSim = ctlEnd - ctlAtWeekStart;
    const {state: simState} = classifyWeek(ctlEnd, atlEnd, rampSim);

    // CTL-Zuwachs pro Woche
    let ctlIncrease = 1.0; // Standard
    if(simState==="Erholt") ctlIncrease = 1.2;
    if(simState==="Müde") ctlIncrease = 0;

    let nextTarget;
    if(ctlIncrease===0) nextTarget = Math.round(prevTarget*0.9);
    else nextTarget = computeWeeklyTssFromCtl(prevTarget, ctl, ctlIncrease);

    const mondayFutureDate = new Date(mondayDate);
    mondayFutureDate.setUTCDate(mondayFutureDate.getUTCDate() + 7*w);
    const mondayId = mondayFutureDate.toISOString().slice(0,10);

    const phase = recommendWeekPhase({}, simState);

    if(writeToIntervals){
      const payloadFuture = {
        id: mondayId,
        [WEEKLY_TARGET_FIELD]: nextTarget,
        [INTERVALS_PLAN_FIELD]: `Rest ${nextTarget} | ${stateEmoji(simState)} ${simState} | Phase: ${phase}`,
        comments: `Simulation Woche ${mondayId}`
      };
      try{
        const resFuture = await fetch(`${BASE_URL}/athlete/${athleteId}/wellness/${mondayId}`,{
          method:"PUT",
          headers:{"Content-Type":"application/json", Authorization:authHeader},
          body:JSON.stringify(payloadFuture)
        });
        if(!resFuture.ok){ const txt = await resFuture.text(); console.error("Failed to update future wellness:", mondayId,resFuture.status,txt); } 
        else if(resFuture.body) resFuture.body.cancel?.();
      }catch(e){console.error("Error updating future week:", e);} 
    }

    prevTarget = nextTarget;
    prevState = simState;
    weeklyProgression.push({weekOffset:w, monday:mondayId, weeklyTarget:nextTarget, state:simState, phase:phase});
  }

  return weeklyProgression;
}

// ------------------- handle() Hauptlogik -------------------
async function handle(env){
  try{
    const apiKey = INTERVALS_API_KEY, athleteId = INTERVALS_ATHLETE_ID;
    if(!apiKey||!athleteId) return new Response("Missing config",{status:500});
    const authHeader = "Basic "+btoa(`API_KEY:${apiKey}`);

    const now = new Date();
    const today = now.toISOString().slice(0,10);
    const todayDate = new Date(today+"T00:00:00Z");
    const jsDay = todayDate.getUTCDay();
    const offset = jsDay===0?6:jsDay-1;
    const mondayDate = new Date(todayDate);
    mondayDate.setUTCDate(mondayDate.getUTCDate()-offset);

    const wellnessRes = await fetch(`${BASE_URL}/athlete/${athleteId}/wellness/${today}`,{headers:{Authorization:authHeader}});
    if(!wellnessRes.ok){const text = await wellnessRes.text(); return new Response(`Failed to fetch wellness today: ${wellnessRes.status} ${text}`,{status:500});}
    const wellness = await wellnessRes.json();
    const ctl = wellness.ctl, atl = wellness.atl, rampRate = wellness.rampRate??0;
    if(ctl==null||atl==null) return new Response("No ctl/atl data",{status:200});

    const {state: weekState, tsb} = classifyWeek(ctl, atl, rampRate);
    const planSelected = parseTrainingDays(wellness[DAILY_TYPE_FIELD]??DEFAULT_PLAN_STRING);
    const weeklyTargetStart = wellness[WEEKLY_TARGET_FIELD] ?? 150;

    const mondayIsToday = jsDay === 1;
    let thisWeekTarget = weeklyTargetStart;
    let phaseNow = "Aufbau";
    let commentNow = "";

    if(mondayIsToday){
      let ctlIncrease = 1.0;
      if(weekState==="Erholt") ctlIncrease = 1.2;
      if(weekState==="Müde") ctlIncrease = 0;

      if(ctlIncrease===0) thisWeekTarget = Math.round(weeklyTargetStart*0.9);
      else thisWeekTarget = computeWeeklyTssFromCtl(weeklyTargetStart, ctl, ctlIncrease);

      phaseNow = recommendWeekPhase({}, weekState);

      commentNow = `Woche ${today} | Phase: ${phaseNow} | Zustand: ${weekState} | Wochenziel: ${thisWeekTarget} TSS
TSB=${tsb.toFixed(1)}, RampSim=${rampRate.toFixed(2)}`;
      
      const payloadToday = {
        id: today,
        [WEEKLY_TARGET_FIELD]: thisWeekTarget,
        [INTERVALS_PLAN_FIELD]: `Rest ${thisWeekTarget} | ${stateEmoji(weekState)} ${weekState} | Phase: ${phaseNow}`,
        comments: commentNow
      };
      try{
        const resUpdate = await fetch(`${BASE_URL}/athlete/${athleteId}/wellness/${today}`,{
          method:"PUT",
          headers:{"Content-Type":"application/json", Authorization:authHeader},
          body:JSON.stringify(payloadToday)
        });
        if(!resUpdate.ok){ const txt = await resUpdate.text(); console.error("Failed to update Monday:", resUpdate.status, txt);}
      }catch(e){console.error("Error updating Monday:", e);}
    }

    const weeklyProgression = await simulatePlannedWeeks(
      ctl, atl, weekState, thisWeekTarget, mondayDate, planSelected, authHeader, athleteId, 6, wellness.historicalMarkers??[], true
    );

    return new Response(JSON.stringify({
      monday: mondayIsToday,
      thisWeek:{target:thisWeekTarget, phase:phaseNow, comment:commentNow},
      weeklyProgression
    }, null, 2), {status:200});

  }catch(err){console.error("Unexpected error:",err); return new Response("Unexpected error: "+(err.stack??String(err)),{status:500});}
}

// ------------------- EXPORT -------------------
export default { async fetch(request, env, ctx){return handle(env);}, async scheduled(event, env, ctx){ctx.waitUntil(handle(env));} };
