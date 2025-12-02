const BASE_URL = "https://intervals.icu/api/v1";

exports.handler = async function () {
  const apiKey = process.env.INTERVALS_API_KEY;
  const athleteId = process.env.INTERVALS_ATHLETE_ID;

  const dailyField =
    process.env.INTERVALS_TARGET_FIELD || "TageszielTSS";
  const weeklyField =
    process.env.INTERVALS_WEEKLY_FIELD || "WochenzielTSS";

  if (!apiKey || !athleteId) {
    console.error(
      "Fehlende ENV Variablen (INTERVALS_API_KEY / INTERVALS_ATHLETE_ID)"
    );
    return { statusCode: 500, body: "Missing config" };
  }

  // Heutiges Datum (UTC) als Wellness-ID
  const today = new Date().toISOString().slice(0, 10);

  // Wochentag bestimmen (0 = So, 1 = Mo, ...)
  const dow = new Date(today + "T00:00:00Z").getUTCDay();
  const isMonday = dow === 1;

  try {
    // 1) Wellness holen
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
      console.error("Fehler beim Wellness-GET:", wellnessRes.status, text);
      return { statusCode: 500, body: "Failed to fetch wellness" };
    }

    const wellness = await wellnessRes.json();
    const ctl = wellness.ctl;
    const atl = wellness.atl;

    if (ctl == null || atl == null) {
      console.log(`${today}: Keine ctl/atl-Daten vorhanden.`);
      return { statusCode: 200, body: "No ctl/atl data" };
    }

    // 2) Tagesziel berechnen (Option B)
    let tsb = ctl - atl;
    const tsbClamped = Math.max(-20, Math.min(20, tsb));

    const base = 1.0;  // 100 % von CTL
    const k = 0.05;    // +5 % pro TSB-Punkt

    let dailyTss = ctl * (base + k * tsbClamped);

    if (dailyTss < 0) dailyTss = 0;
    const maxTss = ctl * 1.5;
    if (dailyTss > maxTss) dailyTss = maxTss;

    const dailyTarget = Math.round(dailyTss);

    // 3) Payload bauen: Tagesziel immer, Wochenziel nur montags
    const payload = {
      id: today,
      [dailyField]: dailyTarget,
    };

    if (isMonday) {
      const weeklyTarget = Math.round(dailyTarget * 7);
      payload[weeklyField] = weeklyTarget;
      console.log(
        `${today}: Montag erkannt – WochenzielTSS=${weeklyTarget} wird gesetzt.`
      );
    } else {
      console.log(
        `${today}: Kein Montag – nur TageszielTSS=${dailyTarget} wird gesetzt.`
      );
    }

    // 4) Wellness updaten
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
      `${today}: CTL=${ctl}, ATL=${atl}, TageszielTSS=${dailyTarget}${
        isMonday ? ", Wochenziel gesetzt" : ""
      }`
    );
    return {
      statusCode: 200,
      body: `OK: Tagesziel=${dailyTarget}${
        isMonday ? " (inkl. Wochenziel)" : ""
      }`,
    };
  } catch (err) {
    console.error("Unerwarteter Fehler:", err);
    return { statusCode: 500, body: "Unexpected error" };
  }
};
