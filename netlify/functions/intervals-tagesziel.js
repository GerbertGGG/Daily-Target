

const BASE_URL = "https://intervals.icu/api/v1";

exports.handler = async function () {
  const apiKey = process.env.INTERVALS_API_KEY;
  const athleteId = process.env.INTERVALS_ATHLETE_ID;
  const targetField = process.env.INTERVALS_TARGET_FIELD || "TageszielTSS";

  if (!apiKey || !athleteId) {
    console.error("Fehlende ENV Variablen (INTERVALS_API_KEY / INTERVALS_ATHLETE_ID)");
    return { statusCode: 500, body: "Missing config" };
  }

  // Heute (UTC) im Format YYYY-MM-DD
  const today = new Date().toISOString().slice(0, 10);

  try {
    // 1) Wellness-Daten holen
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

    // 2) Option B Berechnung
    let tsb = ctl - atl;
    const tsbClamped = Math.max(-20, Math.min(20, tsb));
    const base = 1.0;   // 100% von CTL
    const k = 0.05;     // +5% pro TSB-Punkt

    let tss = ctl * (base + k * tsbClamped);

    if (tss < 0) tss = 0;
    const maxTss = ctl * 1.5;
    if (tss > maxTss) tss = maxTss;
    const targetTss = Math.round(tss);

    // 3) Wellness-Feld updaten
    const payload = {
      id: today,
      [targetField]: targetTss,
    };

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
      `${today}: CTL=${ctl}, ATL=${atl}, Ziel-TSS=${targetTss} eingetragen.`
    );

    return {
      statusCode: 200,
      body: `OK: Ziel-TSS=${targetTss}`,
    };
  } catch (err) {
    console.error("Unerwarteter Fehler:", err);
    return { statusCode: 500, body: "Unexpected error" };
  }
};
