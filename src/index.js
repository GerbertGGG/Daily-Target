const BASE_URL = "https://intervals.icu/api/v1";

// 🔥 Hardcoded Variablen – HIER deine Werte eintragen!
const INTERVALS_API_KEY = "1xg1v04ym957jsqva8720oo01";     // z.B. 1xg1v0...
const INTERVALS_ATHLETE_ID = "i105857";        // z.B. i104975
const INTERVALS_TARGET_FIELD = "TageszielTSS";               // numerisches Feld in Wellness
const INTERVALS_PLAN_FIELD = "WochenPlan";                   // Textfeld in Wellness
const WEEKLY_TARGET_FIELD = "WochenzielTSS";                 // numerisches Feld für Wochenziel

export default {
  async fetch(request) {
    const apiKey = INTERVALS_API_KEY;
    const athleteId = INTERVALS_ATHLETE_ID;
    const dailyField = INTERVALS_TARGET_FIELD;
    const planField = INTERVALS_PLAN_FIELD;
    const weeklyTargetField = WEEKLY_TARGET_FIELD;

    if (!apiKey || !athleteId) {
      return new Response("Missing hardcoded config", { status: 500 });
    }

    const authHeader = "Basic " + btoa(`API_KEY:${apiKey}`);

    // Heutiges Datum (UTC)
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const todayDate = new Date(today + "T00:00:00Z");

    // Montag dieser Woche bestimmen
    const weekday = todayDate.getUTCDay(); // 0=So,1=Mo,...
    const offset = weekday === 0 ? 6 : weekday - 1;
    const mondayDate = new Date(todayDate);
    mondayDate.setUTCDate(mondayDate.getUTCDate() - offset);
    const mondayStr = mondayDate.toISOString().slice(0, 10);

    try {
      // --- 1) Wellness HEUTE holen ---
      const wellnessRes = await fetch(
        `${BASE_URL}/athlete/${athleteId}/wellness/${today}`,
        { headers: { Authorization: authHeader } }
      );

      if (!wellnessRes.ok) {
        const text = await wellnessRes.text();
        return new Response(
          `Failed to fetch wellness today: ${wellnessRes.status} ${text}`,
          { status: 500 }
        );
      }

      const wellness = await wellnessRes.json();
      const ctl = wellness.ctl;
      const atl = wellness.atl;
      const rampRate = wellness.rampRate ?? 0;

      if (ctl == null || atl == null) {
        return new Response("No ctl/atl data", { status: 200 });
      }

      // --- 2) Tagesziel (Option B: base=1.0, k=0.05) ---
      const base = 1.0;
      const k = 0.05;
      const tsb = ctl - atl;
      const tsbClamped = Math.max(-20, Math.min(20, tsb));

      let dailyTss = ctl * (base + k * tsbClamped);
      dailyTss = Math.max(0, Math.min(dailyTss, ctl * 1.5));
      const dailyTarget = Math.round(dailyTss);

      // --- 3) Montag-Wellness für Wochenbasis ---
      const mondayWellnessRes = await fetch(
        `${BASE_URL}/athlete/${athleteId}/wellness/${mondayStr}`,
        { headers: { Authorization: authHeader } }
      );

      let dailyMonTarget;

      if (mondayWellnessRes.ok) {
        const mon = await mondayWellnessRes.json();
        const ctlMon = mon.ctl ?? ctl;
        const atlMon = mon.atl ?? atl;

        let tsbMon = ctlMon - atlMon;
        const tsbMonClamped = Math.max(-20, Math.min(20, tsbMon));

        let dailyMon = ctlMon * (base + k * tsbMonClamped);
        dailyMon = Math.max(0, Math.min(dailyMon, ctlMon * 1.5));

        dailyMonTarget = Math.round(dailyMon);
      } else {
        // Fallback: wenn Montagseintrag fehlt, nimm heutiges Tagesziel
        dailyMonTarget = dailyTarget;
      }

      // --- 4) Woche klassifizieren → Erholt / Normal / Müde ---
      // Logik bleibt wie vorher:
      // früher: Build      → jetzt: Erholt
      // früher: Maintain   → jetzt: Normal
      // früher: Deload     → jetzt: Müde

      let weekState = "Normal"; // Default

      // Erholt (vorher "Build"): RampRate leicht negativ & nicht zu müde
      if (rampRate <= -0.5 && tsb >= -5) {
        weekState = "Erholt";
      }
      // Müde (vorher "Deload"): zu hohe RampRate oder sehr negative TSB oder ATL deutlich über CTL
      else if (rampRate >= 1.0 || tsb <= -10 || atl > ctl + 5) {
        weekState = "Müde";
      }

      // Wochenfaktor je nach Zustand
      let factor = 7; // Normal
      if (weekState === "Erholt") factor = 8;    // etwas mehr Umfang
      if (weekState === "Müde") factor = 5.5;    // bewusst weniger

      const weeklyTarget = Math.round(dailyMonTarget * factor);

      // --- 5) Wöchentliche Load (ctlLoad) seit Montag summieren ---
      let weekLoad = 0;

      const weekRes = await fetch(
        `${BASE_URL}/athlete/${athleteId}/wellness?oldest=${mondayStr}&newest=${today}&cols=id,ctlLoad`,
        { headers: { Authorization: authHeader } }
      );

      if (weekRes.ok) {
        const weekArr = await weekRes.json();
        for (const day of weekArr) {
          if (day.ctlLoad != null) weekLoad += day.ctlLoad;
        }
      }

      const weeklyRemaining = Math.max(
        0,
        Math.round(weeklyTarget - weekLoad)
      );

      // --- 6) Emoji & WochenPlan-Text ---
      let modeEmoji = "⚖️"; // Normal
      if (weekState === "Erholt") modeEmoji = "🔥";
      if (weekState === "Müde") modeEmoji = "🧘";

      const planText = `Rest ${weeklyRemaining} | ${modeEmoji} ${weekState}`;

      // --- 7) Wellness für HEUTE updaten ---
      const payload = {
        id: today,
        [dailyField]: dailyTarget,        // TageszielTSS
        [planField]: planText,            // WochenPlan (Rest + Emoji + Zustand)
        [weeklyTargetField]: weeklyTarget // WochenzielTSS (volles Wochenziel)
      };

      const updateRes = await fetch(
        `${BASE_URL}/athlete/${athleteId}/wellness/${today}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: authHeader,
          },
          body: JSON.stringify(payload),
        }
      );

      if (!updateRes.ok) {
        const text = await updateRes.text();
        return new Response(
          `Failed to update wellness: ${updateRes.status} ${text}`,
          { status: 500 }
        );
      }

      return new Response(
        `OK: Tagesziel=${dailyTarget}, Wochenziel=${weeklyTarget}, WochenPlan="${planText}"`,
        { status: 200 }
      );

    } catch (err) {
      return new Response("Unexpected error: " + err.toString(), {
        status: 500,
      });
    }
  },
};

