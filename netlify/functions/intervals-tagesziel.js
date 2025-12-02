const BASE_URL = "https://intervals.icu/api/v1";

exports.handler = async function () {
  const apiKey = process.env.INTERVALS_API_KEY;
  const athleteId = process.env.INTERVALS_ATHLETE_ID;

  const dailyField =
    process.env.INTERVALS_TARGET_FIELD || "TageszielTSS";   // z.B. "TageszielTSS"
  const weeklyField =
    process.env.INTERVALS_WEEKLY_FIELD || "WochenzielTSS"; // Rest-Wochenziel

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
    // 1) Wellness heute holen (ctl/atl)
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

    // 3) Wochen-Target aus Montag ableiten
    let weeklyTarget = null;

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

    if (mondayWellnessRes.ok) {
      const mondayWellness = await mondayWellnessRes.json();
      const ctlMon = mondayWellness.ctl;
      const atlMon = mondayWellness.atl;

      if (ctlMon != null && atlMon != null) {
        let tsbMon = ctlMon - atlMon;
        const tsbMonClamped = Math.max(-20, Math.min(20, tsbMon));
        let dailyMonTss = ctlMon * (base + k * tsbMonClamped);

        if (dailyMonTss < 0) dailyMonTss = 0;
        const maxMonTss = ctlMon * 1.5;
        if (dailyMonTss > maxMonTss) dailyMonTss = maxMonTss;

        const dailyMonTarget = Math.round(dailyMonTss);

        weeklyTarget = dailyMonTarget * 7;
        console.log(
          `${today}: Wochenziel-Target aus Montag berechnet: dailyMon=${dailyMonTarget}, weeklyTarget=${weeklyTarget}`
        );
      } else {
        console.log(
          `${today}: Montag hat keine ctl/atl – fallback auf heutiges Tagesziel.`
        );
        weeklyTarget = dailyTarget * 7;
      }
    } else {
      const txt = await mondayWellnessRes.text();
      console.log(
        `${today}: Fehler beim Lesen des Montag-Wellness-Eintrags:`,
        mondayWellnessRes.status,
        txt
      );
      // Fallback: heutiges Tagesziel als Basis
      weeklyTarget = dailyTarget * 7;
    }

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

    // 6) Payload für heute bauen
    const payload = {
      id: today,
      [dailyField]: dailyTarget, // Tagesziel immer setzen
    };

    if (weeklyRemaining != null) {
      payload[weeklyField] = weeklyRemaining; // Rest-Wochenziel
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
      }`
    );

    return {
      statusCode: 200,
      body: `OK: Tagesziel=${dailyTarget}${
        weeklyRemaining != null ? `, Wochenrest=${weeklyRemaining}` : ""
      }`,
    };
  } catch (err) {
    console.error("Unerwarteter Fehler:", err);
    return { statusCode: 500, body: "Unexpected error" };
  }
};
