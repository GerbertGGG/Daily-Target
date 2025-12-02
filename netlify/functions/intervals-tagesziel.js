const BASE_URL = "https://intervals.icu/api/v1";

exports.handler = async function () {
  const apiKey = process.env.INTERVALS_API_KEY;
  const athleteId = process.env.INTERVALS_ATHLETE_ID;

  const dailyField = process.env.INTERVALS_TARGET_FIELD || "TageszielTSS";
  const planField = process.env.INTERVALS_PLAN_FIELD || "WochenPlan";

  if (!apiKey || !athleteId) {
    console.error("Fehlende ENV Variablen (INTERVALS_API_KEY / INTERVALS_ATHLETE_ID)");
    return { statusCode: 500, body: "Missing config" };
  }

  // Heutiges Datum
  const today = new Date().toISOString().slice(0, 10);
  const todayDate = new Date(today + "T00:00:00Z");

  // Montag dieser Woche berechnen
  const weekday = todayDate.getUTCDay();  // 0=So
  const offset = weekday === 0 ? 6 : weekday - 1;
  const mondayDate = new Date(todayDate);
  mondayDate.setUTCDate(mondayDate.getUTCDate() - offset);
  const mondayStr = mondayDate.toISOString().slice(0, 10);

  try {
    // --- 1) Heute Wellness holen ---
    const wellnessRes = await fetch(
      `${BASE_URL}/athlete/${athleteId}/wellness/${today}`,
      {
        headers: {
          Authorization: "Basic " + Buffer.from(`API_KEY:${apiKey}`).toString("base64"),
        },
      }
    );

    if (!wellnessRes.ok) {
      const text = await wellnessRes.text();
      console.error("Fehler beim Wellness-GET:", text);
      return { statusCode: 500, body: "Failed to fetch wellness today" };
    }

    const wellness = await wellnessRes.json();
    const ctl = wellness.ctl;
    const atl = wellness.atl;
    const rampRate = wellness.rampRate ?? 0;
    if (ctl == null || atl == null) {
      return { statusCode: 200, body: "No ctl/atl data" };
    }

    // --- 2) Tagesziel berechnen (Option B) ---
    const tsb = ctl - atl;
    const tsbClamped = Math.max(-20, Math.min(20, tsb));

    const base = 1.0;
    const k = 0.05;

    let dailyTss = ctl * (base + k * tsbClamped);
    dailyTss = Math.max(0, Math.min(dailyTss, ctl * 1.5));

    const dailyTarget = Math.round(dailyTss);

    // --- 3) Montag-Wellness holen ---
    const mondayWellnessRes = await fetch(
      `${BASE_URL}/athlete/${athleteId}/wellness/${mondayStr}`,
      {
        headers: {
          Authorization: "Basic " + Buffer.from(`API_KEY:${apiKey}`).toString("base64"),
        },
      }
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

    // --- 4) Woche klassifizieren ---
    let weekMode = "Maintain";

    if (rampRate <= -0.5 && tsb >= -5) {
      weekMode = "Build";
    } else if (rampRate >= 1.0 || tsb <= -10 || atl > ctl + 5) {
      weekMode = "Deload";
    }

    // --- 5) Wochen-Target ---
    let factor = 7;
    if (weekMode === "Build") factor = 8;
    if (weekMode === "Deload") factor = 5.5;

    const weeklyTarget = Math.round(dailyMonTarget * factor);

    // --- 6) Wöchentliche Load summieren ---
    let weekLoad = 0;

    const weekRes = await fetch(
      `${BASE_URL}/athlete/${athleteId}/wellness?oldest=${mondayStr}&newest=${today}&cols=id,ctlLoad`,
      {
        headers: {
          Authorization: "Basic " + Buffer.from(`API_KEY:${apiKey}`).toString("base64"),
        },
      }
    );

    if (weekRes.ok) {
      const weekArr = await weekRes.json();
      for (const day of weekArr) {
        if (day.ctlLoad != null) weekLoad += day.ctlLoad;
      }
    }

    const weeklyRemaining = Math.max(0, Math.round(weeklyTarget - weekLoad));

    // --- 7) WochenPlan-Text ---
    const planText = `Rest ${weeklyRemaining} | ${weekMode}`;

    // --- 8) Wellness Updaten ---
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
          Authorization: "Basic " + Buffer.from(`API_KEY:${apiKey}`).toString("base64"),
        },
        body: JSON.stringify(payload),
      }
    );

    if (!updateRes.ok) {
      const text = await updateRes.text();
      console.error("Fehler beim Wellness-PUT:", updateRes.status, text);
      return { statusCode: 500, body: "Failed to update wellness" };
    }

    return {
      statusCode: 200,
      body: `OK: Tagesziel=${dailyTarget}, WochenPlan="${planText}"`,
    };

  } catch (err) {
    console.error("Unerwarteter Fehler:", err);
    return { statusCode: 500, body: "Unexpected error" };
  }
};
