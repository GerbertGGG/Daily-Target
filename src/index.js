const BASE_URL = "https://intervals.icu/api/v1";

export default {
  async fetch(request, env, ctx) {
    const apiKey = env.INTERVALS_API_KEY;
    const athleteId = env.INTERVALS_ATHLETE_ID;
    const dailyField = env.INTERVALS_TARGET_FIELD || "TageszielTSS";
    const planField = env.INTERVALS_PLAN_FIELD || "WochenPlan";

    if (!apiKey || !athleteId) {
      return new Response("Missing config", { status: 500 });
    }

    const authHeader = "Basic " + btoa(`API_KEY:${apiKey}`);

    // Heutiges Datum (UTC)
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const todayDate = new Date(today + "T00:00:00Z");

    // Montag dieser Woche
    const weekday = todayDate.getUTCDay(); // 0=So
    const offset = weekday === 0 ? 6 : weekday - 1;
    const mondayDate = new Date(todayDate);
    mondayDate.setUTCDate(mondayDate.getUTCDate() - offset);
    const mondayStr = mondayDate.toISOString().slice(0, 10);

    try {
      // --- 1) Wellness heute holen ---
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

      // --- 2) Tagesziel (Option B) ---
      const base = 1.0;
      const k = 0.05;
      const tsb = ctl - atl;
      const tsbClamped = Math.max(-20, Math.min(20, tsb));

      let dailyTss = ctl * (base + k * tsbClamped);
      dailyTss = Math.max(0, Math.min(dailyTss, ctl * 1.5));
      const dailyTarget = Math.round(dailyTss);

      // --- 3) Montag-Wellness für Wochen-Target ---
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
        dailyMonTarget = dailyTarget;
      }

      // --- 4) Woche klassifizieren (Build / Maintain / Deload) ---
      let weekMode = "Maintain";
      if (rampRate <= -0.5 && tsb >= -5) {
        weekMode = "Build";
      } else if (rampRate >= 1.0 || tsb <= -10 || atl > ctl + 5) {
        weekMode = "Deload";
      }

      let factor = 7;
      if (weekMode === "Build") factor = 8;
      if (weekMode === "Deload") factor = 5.5;

      const weeklyTarget = Math.round(dailyMonTarget * factor);

      // --- 5) Wöchentliche Load (ctlLoad) summieren ---
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

      // --- 6) Emoji wählen & WochenPlan bauen ---
      let modeEmoji = "⚖️";
      if (weekMode === "Build") modeEmoji = "🔥";
      if (weekMode === "Deload") modeEmoji = "🧘";

      const planText = `Rest ${weeklyRemaining} | ${modeEmoji} ${weekMode}`;

      // --- 7) Wellness PUT für HEUTE ---
      const payload = {
        id: today,
        [dailyField]: dailyTarget,
        [planField]: planText
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
        `OK: Tagesziel=${dailyTarget}, WochenPlan="${planText}"`,
        { status: 200 }
      );
    } catch (err) {
      return new Response("Unexpected error: " + err.toString(), {
        status: 500,
      });
    }
  },
};
