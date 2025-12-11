const BASE_URL = "https://intervals.icu/api/v1";
const INTERVALS_API_KEY = "1xg1v04ym957jsqva8720oo01";
const INTERVALS_ATHLETE_ID = "i105857";

const INTERVALS_TARGET_FIELD = "TageszielTSS"; // <-- added: Tagesziel
const INTERVALS_PLAN_FIELD = "WochenPlan";
const WEEKLY_TARGET_FIELD = "WochenzielTSS";
const DAILY_TYPE_FIELD = "TagesTyp";
const DEFAULT_PLAN_STRING = "Mo,Mi,Fr,So";

const DAY_NAMES = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

function dayIdxFromJsDay(jsDay) { return jsDay === 0 ? 6 : jsDay - 1; }

function parseTrainingDays(str) {
  if (!str || typeof str !== "string") return new Array(7).fill(false);
  const tokens = str.split(/[,\s;]+/).map(t => t.trim()).filter(t => t.length>0);
  const selected = new Array(7).fill(false);
  for(const raw of tokens){
    const t = raw.toLowerCase();
    const num = parseInt(t,10);
    if(!isNaN(num) && num>=1 && num<=7){selected[num-1]=true; continue;}
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

function computeDailyTarget(ctl, atl){
  const tsb = ctl - atl;
  const tsbClamped = Math.max(-20, Math.min(20, tsb));
  const base = 1.0; const k = 0.05;
  const daily = ctl * (base + k*tsbClamped);
  return Math.round(Math.max(0, Math.min(daily, ctl*1.5)));
}

function classifyWeek(ctl, atl, rampRate){
  const tsb = ctl - atl;
  let tsbCritical;
  if(ctl<50) tsbCritical=-5;
  else if(ctl<80) tsbCritical=-10;
  else tsbCritical=-15;
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

// ------------------- Marker: Decoupling & PDC -------------------
function computeMarkers(units){
  if(!Array.isArray(units)) return {decupling:null,pdc:null};
  const gaUnits = units.filter(u=>u.type===undefined?false:(u.type==="GA1"||u.type==="GA2"));
  if(gaUnits.length===0) return {decupling:null,pdc:null};
  const decupling = gaUnits.reduce((sum,u)=>sum+(u.hrDecoupling??0),0)/gaUnits.length;
  const pdc = gaUnits.reduce((sum,u)=>sum+(u.pdc??0),0)/gaUnits.length;
  return {decupling,pdc};
}

// ------------------- Wochenphase -------------------
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

// ------------------- Langzeit-Briefing -------------------
function generateLongTermBriefing(mondayId, phase, simState, tssPrev, tssCurrent, lastWeekMarkers, markers42d, markers90d, rampSim){
  const currentMarkers = lastWeekMarkers || {decupling:null,pdc:null, prevDecupling:null, prevPDC:null};
  // safe values for percentage calcs
  const safe42 = markers42d || {tss: tssPrev || tssCurrent || 0, decupling: currentMarkers.decupling||0, pdc: currentMarkers.pdc||0};
  const safe90 = markers90d || {tss: tssPrev || tssCurrent || 0, decupling: currentMarkers.decupling||0, pdc: currentMarkers.pdc||0};
  const pct42 = safe42.tss?(((tssCurrent - safe42.tss) / safe42.tss) * 100).toFixed(0):"0";
  const pct90 = safe90.tss?(((tssCurrent - safe90.tss) / safe90.tss) * 100).toFixed(0):"0";

  return `Woche: ${mondayId} | Phase: ${phase} | SimState: ${simState}\n`+
`------------------------------------------------\n`+
`Vergleich Vorwoche: \n`+
`  TSS:        ${tssPrev} → ${tssCurrent}\n`+
`  Decoupling: ${lastWeekMarkers?.prevDecupling?.toFixed(2)??"-"} → ${currentMarkers.decupling?.toFixed(2)??"-"}\n`+
`  PDC:        ${lastWeekMarkers?.prevPDC?.toFixed(2)??"-"} → ${currentMarkers.pdc?.toFixed(2)??"-"}\n\n`+
`Trend 42 Tage:\n`+
`  TSS:        ${pct42}%\n`+
`  Decoupling: ${(currentMarkers.decupling - (safe42.decupling||0)).toFixed(2)}\n`+
`  PDC:        ${(currentMarkers.pdc - (safe42.pdc||0)).toFixed(2)}\n\n`+
`Trend 90 Tage:\n`+
`  TSS:        ${pct90}%\n`+
`  Decoupling: ${(currentMarkers.decupling - (safe90.decupling||0)).toFixed(2)}\n`+
`  PDC:        ${(currentMarkers.pdc - (safe90.pdc||0)).toFixed(2)}\n\n`+
`------------------------------------------------\n`+
`Beurteilung:\n`+
`- Aerobe Basis: ${((currentMarkers.decupling||0) < (lastWeekMarkers?.prevDecupling||0))?"verbessert":"stabil"}\n`+
`- Anaerobe Kapazität: ${((currentMarkers.pdc||0) > (lastWeekMarkers?.prevPDC||0))?"gesteigert":"stabil"}\n`+
`- Müdigkeit: Ramp=${rampSim.toFixed(2)} → Belastung ${simState}\n`+
`Empfehlung:\n`+
`- Weiter ${phase}, GA1/GA2 für Stabilität, gezielte Intensivintervalle einbauen\n`;
}

// ------------------- 6-Wochen Simulation -------------------
async function simulatePlannedWeeks(ctlStart, atlStart, weekStateStart, weeklyTargetStart, mondayDate, planSelected, authHeader, athleteId, weeksToSim, historicalMarkers){
  const tauCtl = 42, tauAtl = 7;
  let dayWeights = new Array(7).fill(0);
  let countSelected = 0;
  for(let i=0;i<7;i++) if(planSelected[i]){dayWeights[i]=1; countSelected++;}
  if(countSelected===0){dayWeights=[1,0,1,0,1,0,1]; countSelected=4;}
  let sumWeights = dayWeights.reduce((a,b)=>a+b,0);

  let ctl = ctlStart, atl = atlStart, prevTarget = weeklyTargetStart, prevState = weekStateStart;
  const weeklyProgression = [];

  for(let w=1;w<=weeksToSim;w++){
    const ctlAtWeekStart = ctl;
    for(let d=0;d<7;d++){
      const share = dayWeights[d]/sumWeights;
      const load = prevTarget*share;
      ctl = ctl + (load - ctl)/tauCtl;
      atl = atl + (load - atl)/tauAtl;
    }
    const ctlEnd = ctl, atlEnd = atl;
    const rampSim = ctlEnd-ctlAtWeekStart;
    const {state: simState} = classifyWeek(ctlEnd, atlEnd, rampSim);
    let nextTarget = prevTarget;
    if(simState==="Müde") nextTarget = prevTarget*0.8;
    else{
      if(rampSim<0.5) nextTarget = prevTarget*(simState==="Erholt"?1.12:1.08);
      else if(rampSim<1.0) nextTarget = prevTarget*(simState==="Erholt"?1.08:1.05);
      else if(rampSim<=1.5) nextTarget = prevTarget*1.02;
      else nextTarget = prevTarget*0.9;
    }
    nextTarget = Math.max(prevTarget*0.75,Math.min(prevTarget*1.25,nextTarget));
    nextTarget = Math.round(nextTarget/5)*5;

    const mondayFutureDate = new Date(mondayDate);
    mondayFutureDate.setUTCDate(mondayFutureDate.getUTCDate()+7*w);
    const mondayId = mondayFutureDate.toISOString().slice(0,10);

    const lastWeekMarkers = historicalMarkers[w-1] || {decupling:3,pdc:0.95, prevDecupling:3, prevPDC:0.95};
    const phase = recommendWeekPhase(lastWeekMarkers, simState);

    const markers42d = historicalMarkers[Math.max(0,w-6)] || lastWeekMarkers;
    const markers90d = historicalMarkers[Math.max(0,w-13)] || lastWeekMarkers;
    const briefing = generateLongTermBriefing(mondayId, phase, simState, prevTarget, nextTarget, lastWeekMarkers, markers42d, markers90d, rampSim);

    const payloadFuture = {
      id:mondayId,
      [WEEKLY_TARGET_FIELD]: nextTarget,
      [INTERVALS_PLAN_FIELD]: `Rest ${nextTarget} | ${stateEmoji(simState)} ${simState} | Phase: ${phase}`,
      comments: briefing
    };

    try{
      const resFuture = await fetch(`${BASE_URL}/athlete/${athleteId}/wellness/${mondayId}`,{
        method:"PUT",
        headers:{"Content-Type":"application/json", Authorization:authHeader},
        body:JSON.stringify(payloadFuture)
      });
      if(!resFuture.ok){const txt = await resFuture.text(); console.error("Failed to update future wellness:", mondayId,resFuture.status,txt);} 
      else if(resFuture.body) resFuture.body.cancel?.();
    }catch(e){console.error("Error updating future week:", e);} 

    prevTarget = nextTarget;
    prevState = simState;
    weeklyProgression.push({weekOffset:w, monday:mondayId, weeklyTarget:nextTarget, state:simState, phase:phase});
  }
  return weeklyProgression;
}

// ------------------- Hauptlogik -------------------
// ------------------- Hauptlogik (korrigierte Version) -------------------
async function handle(env) {
  try {
    const apiKey = INTERVALS_API_KEY, athleteId = INTERVALS_ATHLETE_ID;
    if (!apiKey || !athleteId) return new Response("Missing config", { status: 500 });
    const authHeader = "Basic " + btoa(`API_KEY:${apiKey}`);

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const todayDate = new Date(today + "T00:00:00Z");
    const jsDay = todayDate.getUTCDay();
    const offset = jsDay === 0 ? 6 : jsDay - 1;
    const mondayDate = new Date(todayDate);
    mondayDate.setUTCDate(mondayDate.getUTCDate() - offset);

    // Hole Wellness für heute
    const wellnessRes = await fetch(`${BASE_URL}/athlete/${athleteId}/wellness/${today}`, { headers: { Authorization: authHeader } });
    if (!wellnessRes.ok) {
      const text = await wellnessRes.text();
      return new Response(`Failed to fetch wellness today: ${wellnessRes.status} ${text}`, { status: 500 });
    }
    const wellness = await wellnessRes.json();

    const ctl = wellness.ctl, atl = wellness.atl, rampRate = wellness.rampRate ?? 0;
    if (ctl == null || atl == null) return new Response("No ctl/atl data", { status: 200 });

    const { state: weekState, tsb } = classifyWeek(ctl, atl, rampRate);
    const dailyTargetBase = computeDailyTarget(ctl, atl);

    // --- Schreibe Tagesziel (TageszielTSS) & aktuellen Tages-Plan mit verbleibendem Rest ---
    // Berechne weeklyTargetStart (aus wellness oder berechnet)
    const weeklyTargetStart = wellness[WEEKLY_TARGET_FIELD] ?? Math.round(dailyTargetBase * 7);

    // Berechne Montag/Sonntag der laufenden Woche (UTC-basiert, wie zuvor)
    const todayDateObj = new Date(today + "T00:00:00Z");
    const jsDay2 = todayDateObj.getUTCDay();
    const offset2 = jsDay2 === 0 ? 6 : jsDay2 - 1;
    const mondayDateObj = new Date(todayDateObj);
    mondayDateObj.setUTCDate(mondayDateObj.getUTCDate() - offset2);
    const mondayStr = mondayDateObj.toISOString().slice(0, 10);
    const sundayDateObj = new Date(mondayDateObj);
    sundayDateObj.setUTCDate(sundayDateObj.getUTCDate() + 6);
    const sundayStr = sundayDateObj.toISOString().slice(0, 10);

    // Hole Aktivitäten dieser Woche und summiere schon erledigte TSS (defensiv)
    let doneTss = 0;
    try {
      const actsRes = await fetch(`${BASE_URL}/athlete/${athleteId}/activities?from=${mondayStr}&to=${sundayStr}`, {
        headers: { Authorization: authHeader }
      });
      if (actsRes.ok) {
        const actsJson = await actsRes.json();
        const activities = actsJson.activities ?? actsJson.data ?? [];
        for (const a of activities) {
          // best-effort: unterschiedliche Feldnamen unterstützen
          const aDate = (a.start_date_local || a.start_date || a.date || "").slice(0, 10);
          if (!aDate) continue;
          if (aDate > today) continue; // zukünftige Einträge ignorieren
          const t = a.tss ?? a.tss_total ?? (a.metrics && a.metrics.tss) ?? 0;
          doneTss += (typeof t === "number" ? t : Number(t) || 0);
        }
      } else {
        console.error("Failed to fetch activities for week (for doneTss):", actsRes.status, await actsRes.text());
      }
    } catch (e) {
      console.error("Error fetching activities for doneTss:", e);
    }

    const remaining = Math.max(0, Math.round(weeklyTargetStart - doneTss));

    // Erstelle Plan-Text für den Tag: nur "Rest X" (Phase nur am Montag in Wochen-Plan/Kommentare)
    const dayPlanText = `Rest ${remaining}`;

    // Schreibe Tagesziel und Tages-Plan in today's wellness
    try {
      const payloadToday = {
        id: today,
        [INTERVALS_TARGET_FIELD]: Math.round(dailyTargetBase),
        [INTERVALS_PLAN_FIELD]: dayPlanText
      };
      const updateRes = await fetch(`${BASE_URL}/athlete/${athleteId}/wellness/${today}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify(payloadToday)
      });
      if (!updateRes.ok) {
        const txt = await updateRes.text();
        console.error("Failed to update today's wellness (target/plan):", updateRes.status, txt);
      } else {
        console.log("Updated today's Tagesziel and TagesPlan (Rest):", payloadToday);
      }
    } catch (e) {
      console.error("Error writing today's target/plan (rest):", e);
    }

    // Restliche Simulation (6 Wochen) wie gehabt
    const planSelected = parseTrainingDays(wellness[DAILY_TYPE_FIELD] ?? DEFAULT_PLAN_STRING);
    const historicalMarkers = wellness.historicalMarkers ?? [];
    const weeklyProgression = await simulatePlannedWeeks(ctl, atl, weekState, weeklyTargetStart, mondayDate, planSelected, authHeader, athleteId, 6, historicalMarkers);

    return new Response(JSON.stringify({
      dryRun: true,
      thisWeek: { monday: mondayStr, weeklyTarget: weeklyTargetStart, alreadyDone: Math.round(doneTss), remaining: remaining },
      weeklyProgression
    }, null, 2), { status: 200 });

  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response("Unexpected error: " + (err.stack ?? String(err)), { status: 500 });
  }
}


// ------------------- EXPORT -------------------
export default { async fetch(request, env, ctx){return handle(env);}, async scheduled(event, env, ctx){ctx.waitUntil(handle(env));} };
