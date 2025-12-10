const BASE_URL = "https://intervals.icu/api/v1";

// 🔥 Hardcoded – später besser als Secrets
const INTERVALS_API_KEY = "1xg1v04ym957jsqva8720oo01";
const INTERVALS_ATHLETE_ID = "i105857";

const INTERVALS_TARGET_FIELD = "TageszielTSS";
const INTERVALS_PLAN_FIELD = "WochenPlan";
const WEEKLY_TARGET_FIELD = "WochenzielTSS";
const DAILY_TYPE_FIELD = "TagesTyp";
const DEFAULT_PLAN_STRING = "Mo,Mi,Fr,So";

// Helper: Wochentage
const DAY_NAMES = ["Mo","Di","Mi","Do","Fr","Sa","So"];
function dayIdxFromJsDay(jsDay){ return jsDay===0?6:jsDay-1; }
function parseTrainingDays(str){
  if(!str||typeof str!=="string") return new Array(7).fill(false);
  const tokens = str.split(/[,\s;]+/).map(t=>t.trim()).filter(t=>t.length>0);
  const selected = new Array(7).fill(false);
  for(const raw of tokens){
    const t = raw.toLowerCase();
    const num = parseInt(t,10);
    if(!isNaN(num)&&num>=1&&num<=7){ selected[num-1]=true; continue; }
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
function stateEmoji(state){ return state==="Erholt"?"🔥":state==="Müde"?"🧘":"⚖️"; }

// ---------------------------------------------------------
// Trainings-Logik: CTL/ATL/TSB
// ---------------------------------------------------------
function computeDailyTarget(ctl, atl){
  const tsb = ctl - atl;
  const tsbClamped = Math.max(-20, Math.min(20, tsb));
  const base = 1.0, k=0.05;
  const daily = ctl*(base + k*tsbClamped);
  return Math.round(Math.max(0, Math.min(daily, ctl*1.5)));
}

function classifyWeek(ctl, atl, rampRate){
  const tsb = ctl - atl;
  let tsbCritical = ctl<50?-5:ctl<80?-10:-15;
  const isTsbTired = tsb<=tsbCritical;
  const atlCtlRatio = ctl>0?atl/ctl:Infinity;
  const atlRatioThreshold = ctl<50?1.2:ctl<80?1.3:1.4;
  const isAtlHigh = atlCtlRatio>=atlRatioThreshold;
  const isRampHigh = rampRate>=1.0;
  const isRampLowAndFresh = rampRate<=-0.5 && tsb>=-5;

  if(isRampLowAndFresh) return {state:"Erholt", tsb};
  if(isRampHigh || isTsbTired || isAtlHigh) return {state:"Müde", tsb};
  return {state:"Normal", tsb};
}

// ---------------------------------------------------------
// Marker: Decoupling & PDC Lorang-style
// ---------------------------------------------------------
function computeMarkers(units){
  if(!Array.isArray(units)) return {decoupling:null, pdc:null};
  // GA1-only Decoupling (Herzfrequenz vs. Leistung)
  const gaUnits = units.filter(u=>u.zone==="GA1" && u.duration>=20);
  const decoupling = gaUnits.length>0?gaUnits.reduce((sum,u)=>sum+u.hrDecoupling,0)/gaUnits.length:null;
  // PDC: Peak Dauerleistung vs. VO2max
  const pdc = units.length>0?units.reduce((sum,u)=>sum+u.pdc,0)/units.length:null;
  return {decoupling, pdc};
}

// ---------------------------------------------------------
// Empfehlung 
function recommendWeekPhase(lastWeekMarkers, simState){
  const decupling = lastWeekMarkers?.decupling ?? 999; // große Zahl = sehr verschlissen
  const pdc = lastWeekMarkers?.pdc ?? 0.0;             // niedrig = Intensiv nötig

  let phase = "Aufbau"; 
  if(decupling > 5) phase = "Grundlage";        // zu verschlissen
  else if(pdc < 0.9) phase = "Intensiv";       // PDC zu niedrig
  else phase = "Aufbau";

  if(simState === "Müde") phase = "Erholung";   // Deload
  return phase;
}
// ---------------------------------------------------------
// 6-Wochen-Simulation inkl. Ramp & Marker
// ---------------------------------------------------------
async function simulatePlannedWeeks(
  ctlStart, atlStart, weekStateStart, weeklyTargetStart,
  mondayDate, planSelected, authHeader, athleteId, units, weeksToSim
){
  const tauCtl=42, tauAtl=7;
  let dayWeights = new Array(7).fill(0), countSelected=0;
  for(let i=0;i<7;i++) if(planSelected[i]){ dayWeights[i]=1; countSelected++; }
  if(countSelected===0){ dayWeights=[1,0,1,0,1,0,1]; countSelected=4; }
  const sumWeights = dayWeights.reduce((a,b)=>a+b,0);

  let ctl=ctlStart, atl=atlStart, prevTarget=weeklyTargetStart, prevState=weekStateStart;
  const weeklyProgression=[];

  for(let w=1;w<=weeksToSim;w++){
    const ctlWeekStart=ctl;
    for(let d=0;d<7;d++){
      const share = dayWeights[d]/sumWeights;
      const load = prevTarget*share;
      ctl += (load-ctl)/tauCtl;
      atl += (load-atl)/tauAtl;
    }

    const ctlEnd=ctl, atlEnd=atl;
    const rampSim = ctlEnd-ctlWeekStart;
    const { state: simState } = classifyWeek(ctlEnd, atlEnd, rampSim);

    // Tages- und Wochen-TSS Anpassung
    let multiplier=1.0;
    if(simState==="Müde") multiplier=0.8;
    else if(rampSim<0.5) multiplier=simState==="Erholt"?1.12:1.08;
    else if(rampSim<1.0) multiplier=simState==="Erholt"?1.08:1.05;
    else if(rampSim<=1.5) multiplier=1.02;
    else multiplier=0.9;

    let nextTarget = prevTarget*multiplier;
    nextTarget=Math.max(prevTarget*0.75, Math.min(prevTarget*1.25, nextTarget));
    nextTarget=Math.round(nextTarget/5)*5;

    const mondayFutureDate=new Date(mondayDate);
    mondayFutureDate.setUTCDate(mondayFutureDate.getUTCDate()+7*w);
    const mondayId=mondayFutureDate.toISOString().slice(0,10);

    // Marker & Phase
    const lastWeekMarkers = computeMarkers(units);
    const phase = recommendWeekPhase(lastWeekMarkers, simState);

    const emoji = stateEmoji(simState);
    const planText = `Rest ${nextTarget} | ${emoji} ${simState} | Phase: ${phase}`;

    const payloadFuture={
      id:mondayId,
      [WEEKLY_TARGET_FIELD]:nextTarget,
      [INTERVALS_PLAN_FIELD]:planText,
      comments:`Automatische Wochenphase: ${phase}, Decoupling=${lastWeekMarkers.decupling}, PDC=${lastWeekMarkers.pdc}`
    };

    try{
      const resFuture = await fetch(`${BASE_URL}/athlete/${athleteId}/wellness/${mondayId}`,{
        method:"PUT",
        headers:{"Content-Type":"application/json", Authorization: authHeader},
        body:JSON.stringify(payloadFuture)
      });
      if(!resFuture.ok){ const txt=await resFuture.text(); console.error("Failed to update future wellness:",mondayId,resFuture.status,txt); }
      else if(resFuture.body) resFuture.body.cancel?.();
    }catch(e){ console.error("Error updating future week:",e); }

    prevTarget=nextTarget;
    prevState=simState;

    weeklyProgression.push({weekOffset:w,monday:mondayId,weeklyTarget:nextTarget,state:simState,phase:phase});
  }
  return weeklyProgression;
}

// ---------------------------------------------------------
// Hauptlogik
// ---------------------------------------------------------
async function handle(env){
  try{
    const apiKey=INTERVALS_API_KEY;
    const athleteId=INTERVALS_ATHLETE_ID;
    if(!apiKey||!athleteId) return new Response("Missing config",{status:500});
    const authHeader="Basic "+btoa(`API_KEY:${apiKey}`);

    const now=new Date();
    const today=now.toISOString().slice(0,10);
    const todayDate=new Date(today+"T00:00:00Z");
    const jsDay=todayDate.getUTCDay();
    const dayIdx=dayIdxFromJsDay(jsDay);

    const offset=jsDay===0?6:jsDay-1;
    const mondayDate=new Date(todayDate);
    mondayDate.setUTCDate(mondayDate.getUTCDate()-offset);
    const mondayStr=mondayDate.toISOString().slice(0,10);

    // 1) Wellness heute
    const wellnessRes = await fetch(`${BASE_URL}/athlete/${athleteId}/wellness/${today}`,{headers:{Authorization:authHeader}});
    if(!wellnessRes.ok){ const text=await wellnessRes.text(); return new Response(`Failed to fetch wellness today: ${wellnessRes.status} ${text}`,{status:500}); }
    const wellness = await wellnessRes.json();
    const ctl=wellness.ctl, atl=wellness.atl;
    const rampRate=wellness.rampRate??0;
    if(ctl==null||atl==null) return new Response("No ctl/atl data",{status:200});
    const { state: weekState, tsb } = classifyWeek(ctl, atl, rampRate);
    const dailyTargetBase = computeDailyTarget(ctl, atl);

    // 2) Montag / Plan
    const planSelected=parseTrainingDays(wellness[DAILY_TYPE_FIELD]??DEFAULT_PLAN_STRING);

    // 3) 6 Wochen Simulation
    const weeklyTargetStart = wellness[WEEKLY_TARGET_FIELD]??Math.round(dailyTargetBase*7);
    const units = wellness.units??[]; // Trainings-Einheiten für Marker
    const weeklyProgression = await simulatePlannedWeeks(
      ctl, atl, weekState, weeklyTargetStart, mondayDate, planSelected, authHeader, athleteId, units, 6
    );

    return new Response(JSON.stringify({
      dryRun:true,
      thisWeek:{monday:mondayStr, weeklyTarget:weeklyTargetStart, alreadyDone:0, remaining:weeklyTargetStart},
      weeklyProgression
    },null,2),{status:200});

  }catch(err){ console.error("Unexpected error:",err); return new Response("Unexpected error: "+(err.stack??String(err)),{status:500}); }
}

// ---------------------------------------------------------
export default {
  async fetch(request, env, ctx){ return handle(env); },
  async scheduled(event, env, ctx){ ctx.waitUntil(handle(env)); }
};