  const acts = await actRes.json();

  // 🏁 Rennen erkennen und in der Konsole + Kommentar loggen
  const raceEvents = logRaceEvents(acts);

  const runActs = acts.filter((a) => a.type?.includes("Run"));
  const rideActs = acts.filter((a) => a.type?.includes("Ride"));
  const runDrift = await extractDriftStats(runActs, hrMax, auth);
  const rideDrift = await extractDriftStats(rideActs, hrMax, auth);
  const runEff = computeEfficiencyTrend(runActs, hrMax);
  const rideEff = computeEfficiencyTrend(rideActs, hrMax);
  const runTable = buildStatusAmpel({ dec: runDrift.medianDrift, eff: runEff, rec, sport: "🏃‍♂️ Laufen" });
  const rideTable = buildStatusAmpel({ dec: rideDrift.medianDrift, eff: rideEff, rec, sport: "🚴‍♂️ Rad" });
  const phase = buildPhaseRecommendation(runTable.markers, rideTable.markers);
  const progression = simulateFutureWeeks(ctl, atl, 6);

  // 📝 Rennen in Textform für den Kommentar
  let raceSummary = "⚪ Keine Rennen im angegebenen Zeitraum.";
  if (raceEvents.length > 0) {
    raceSummary = raceEvents
      .map((r, i) => {
        const date = (r.start_date_local || r.start_date || "").slice(0, 10);
        const dist = r.distance ? (r.distance / 1000).toFixed(1) + " km" : "–";
        const tss = r.icu_training_load || "?";
        return `${i + 1}. ${r.name} (${date}) – ${dist} – ${tss} TSS`;
      })
      .join("\n");
  }

  const comment = [
    "🏁 **Status-Ampel (Heute)**",
    "",
    runTable.table,
    "",
    rideTable.table,
    "",
    `**Phase:** ${phase}`,
    `**Wochentarget TSS:** ${progression[0].weekTss}`,
    `**Vorschau:** ${progression.map((p) => `W${p.week}: ${p.weekType} → ${p.weekTss}`).join(", ")}`,
    "",
    "🏁 **Gefundene Rennen:**",
    raceSummary
  ].join("\n");