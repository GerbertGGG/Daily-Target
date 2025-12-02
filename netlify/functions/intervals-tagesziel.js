const BASE_URL = "https://intervals.icu/api/v1";

exports.handler = async function () {
  const apiKey = process.env.INTERVALS_API_KEY;
  const athleteId = process.env.INTERVALS_ATHLETE_ID;

  const dailyField =
    process.env.INTERVALS_TARGET_FIELD || "TageszielTSS";   // z.B. "TageszielTSS"
  const weeklyField =
    process.env.INTERVALS_WEEKLY_FIELD || "WochenzielTSS"; // Rest-Wochenziel
  const planField =
    process.env.INTERVALS_PLAN_FIELD || "WochenPlan";      // Textfeld für Build/Halten/Deload

  if (!apiKey || !athleteId) {
    console.error(
      "Fehlende ENV Variablen (INTERVALS_API_KEY / INTERVALS_ATHLETE_ID)"
    );
    return { statusCode: 500, body: "Missing config" };
  }

  // Heutiges Datum (UTC) als Wellness-ID
  const today = new Date().toISOString().slice(0, 10);
  const todayDate = new Date(today + "T00:00:00Z");

  // Montag dieser Woche bestimmen
  const weekday = todayDate.getUTCDay(); // 0=So,1=Mo,...
  const offset = weekday === 0 ? 6 : weekday - 1; // So -> 6 Tage zurück, sonst weekday-1
  const mondayDate = new Date(todayDate);
  mondayDate.setUTCDate(mondayDate.getUTCDate() - offset);
  const mondayStr = mondayDate.toISOString().slice(0, 10);

  try {
    // 1) Wellness heute holen (ctl/atl/rampRate)
    const wellnessRes = await fetch(
      `${BASE_URL}/athlete/${athleteId}/wellness/${today}`,
      {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(`API_KEY:${apiKey}`).toString("base64"),
        },
      }
    );

    if (!wellnessRes.ok) {
      const text = await wellnessRes.text();
      console.error("Fehler beim Wellness-GET (heute):", wellnessRes.status, text);
      return { statusCode: 500, body: "Failed to fetch wellness today" };
    }

    const wellness = await wellnessRes.json();
    const ctl = wellness.ctl;
    const atl = wellness.atl;
    const rampRate = wellness.rampRate ?? 0;

    if (ctl == null || atl == null) {
      console.log(`${today}: Keine ctl/atl-Daten vorhanden.`);
      return { statusCode: 200, body: "No ctl/atl data" };
    }

    // 2) Tagesziel (heute) berechnen – Option B
    let tsb = ctl - atl;
    const tsbClamped = Math.max(-20, Math.min(20, tsb));

    const base = 1.0; // 100 % von CTL
    const k = 0.05;   // +5 % pro TSB-Punkt

    let dailyTss = ctl * (base + k * tsbClamped);

    if (dailyTss < 0) dailyTss = 0;
    const maxTss = ctl * 1.5;
    if (dailyTss > maxTss) dailyTss = maxTss;

    const dailyTarget = Math.round(dailyTss);

    // 3) Wochen-Target aus Montag ableiten (DailyMontag * Faktor)
    let weeklyTarget = null;
    let weekMode = "Maintain";
    let weekFactor = 7;

    // Wellness vom Montag holen
    const mondayWellnessRes = await fetch(
      `${BASE_URL}/athlete/${athleteId}/wellness/${mondayStr}`,
      {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(`API_KEY:${apiKey}`).toString("base64"),
        },
      }
    );

    let dailyMonTarget = null;

    if (mondayWellnessRes.ok) {
      const mondayWellness = await mondayWellnessRes.json();
      const ctlMon = mondayWellness.ctl ?? ctl;
      const atlMon = mondayWellness.atl ?? atl;

      let tsbMon = ctlMon - atlMon;
      const tsbMonClamped = Math.max(-20, Math.min(20, tsbMon));
      let dailyMonTss = ctlMon * (base + k * tsbMonClamped);

      if (dailyMonTss < 0) dailyMonTss = 0;
      const maxMonTss = ctlMon * 1.5;
      if (dailyMonTss > maxMonTss) dailyMonTss = maxMonTss;

      dailyMonTarget = Math.round(dailyMonTss);
    } else {
      const txt = await mondayWellnessRes.text();
      console.log(
        `${today}: Fehler beim Lesen des Montag-Wellness-Eintrags:`,
        mondayWellnessRes.status,
        txt
      );
      // Fallback auf heutiges Tagesziel
      dailyMonTarget = dailyTarget;
    }

    // 3a) Woche klassifizieren (Build / Maintain / Deload)
    const tsbToday = ctl - atl;

    if (rampRate <= -0.5 && tsbToday >= -5) {
      weekMode = "Build";
      weekFactor = 8.0;    // etwas mehr als 7x Tagesziel
    } else if (rampRate >= 1.0 || tsbToday <= -10 || atl > ctl + 5) {
      weekMode = "Deload";
      weekFactor = 5.5;    // bewusst weniger
    } else {
      weekMode = "Maintain";
      weekFactor = 7.0;    // gleichbleibende Fitness
    }

    weeklyTarget = Math.round(dailyMonTarget * weekFactor);

    console.log(
      `${today}: Wochenmodus=${weekMode}, dailyMon=${dailyMonTarget}, weeklyTarget=${weeklyTarget}, rampRate=${rampRate.toFixed(
        2
      )}, TSB=${tsbToday.toFixed(2)}`
    );

    // 4) Bisherige Wochen-Load (Montag–heute) summieren (ctlLoad)
    let weekLoad = 0;

    const weekRes = await fetch(
      `${BASE_URL}/athlete/${athleteId}/wellness?oldest=${mondayStr}&newest=${today}&cols=id,ctlLoad`,
      {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(`API_KEY:${apiKey}`).toString("base64"),
        },
      }
    );

    if (weekRes.ok) {
      const weekData = await weekRes.json();
      if (Array.isArray(weekData)) {
        for (const day of weekData) {
          const load = day.ctlLoad;
          if (load != null) {
            weekLoad += load;
          }
        }
      }
      console.log(
        `${today}: Wochensumme ctlLoad (Montag–heute): ${weekLoad.toFixed(1)}`
      );
    } else {
      const txt = await weekRes.text();
      console.log(
        `${today}: Fehler beim Lesen der Wochen-Wellnessdaten:`,
        weekRes.status,
        txt
      );
    }

    // 5) Rest-Wochenziel
    let weeklyRemaining = null;
    if (weeklyTarget != null) {
      weeklyRemaining = Math.max(0, Math.round(weeklyTarget - weekLoad));
    }

    // Text für WochenPlan bauen
    let planText = `${weekMode}: Ziel ~${weeklyTarget} TSS, Rest ~${weeklyRemaining ?? 0} TSS (rampRate ${rampRate.toFixed(
      2
    )}, TSB ${tsbToday.toFixed(1)})`;

    // 6) Payload für heute bauen
    const payload = {
      id: today,
      [dailyField]: dailyTarget, // Tagesziel
    };

    if (weeklyRemaining != null) {
      payload[weeklyField] = weeklyRemaining; // Rest-Wochenziel
    }

    if (planField) {
      payload[planField] = planText;
    }

    // 7) Wellness für heute updaten
    const updateRes = await fetch(
      `${BASE_URL}/athlete/${athleteId}/wellness/${today}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization:
            "Basic " +
            Buffer.from(`API_KEY:${apiKey}`).toString("base64"),
        },
        body: JSON.stringify(payload),
      }
    );

    if (!updateRes.ok) {
      const text = await updateRes.text();
      console.error("Fehler beim Wellness-PUT:", updateRes.status, text);
      return { statusCode: 500, body: "Failed to update wellness" };
    }

    console.log(
      `${today}: CTL=${ctl.toFixed(2)}, ATL=${atl.toFixed(
        2
      )}, Tagesziel=${dailyTarget}${
        weeklyRemaining != null ? `, Wochenrest=${weeklyRemaining}` : ""
      }, Modus=${weekMode}`
    );

    return {
      statusCode: 200,
      body: `OK: Tagesziel=${dailyTarget}, Wochenrest=${weeklyRemaining}, Modus=${weekMode}`,
    };
  } catch (err) {
    console.error("Unerwarteter Fehler:", err);
    return { statusCode: 500, body: "Unexpected error" };
  }
};
