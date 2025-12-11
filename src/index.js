function computeExtendedMarkers(units, hrMax, ftp, ctl, atl) {
  if (!Array.isArray(units)) units = [];

  // --- ACWR ---
  const acwr = ctl > 0 ? atl / ctl : null;

  // --- Intensitätsverteilung ---
  let z1z2 = 0, z3z5 = 0, total = 0;

  for (const u of units) {
    if (!u.durationMinutes || u.hrAvg == null || hrMax <= 0) continue;

    const hrRel = u.hrAvg / hrMax;
    total += u.durationMinutes;

    if (hrRel <= 0.80) z1z2 += u.durationMinutes;      // Fundament
    else z3z5 += u.durationMinutes;                    // Intensiv-/Graubereich
  }

  const polarisationIndex = total > 0 ? z1z2 / total : null;

  // --- Quality Sessions ---
  const qualitySessions = units.filter(u =>
    ["Interval", "VO2Max", "Sprint"].includes(u.type)
  ).length;

  // --- Decoupling / Durability ---
  const gaUnits = units.filter(u =>
    u.durationMinutes >= 30 &&
    ["Endurance", "LongRide", "EasyRun"].includes(u.type) &&
    u.hrAvg != null &&
    u.wattsAvg != null &&
    u.wattsAvg > 0 &&
    u.hrAvg <= 0.85 * hrMax
  );

  let decoupling = null;
  if (gaUnits.length > 0) {
    const sum = gaUnits.reduce((acc, u) =>
      acc + ((u.hrAvg / u.wattsAvg) - 1)
    , 0);
    decoupling = sum / gaUnits.length;   // 0.03 = 3 %
  }

  // --- PDC ---
  let pdc = null;
  const peaks = units
    .filter(u => ["Interval", "VO2Max", "Sprint"].includes(u.type))
    .map(u => u.wattsMax ?? u.wattsAvg)
    .filter(v => v != null && v > 0);

  if (peaks.length > 0 && ftp > 0)
    pdc = Math.max(...peaks) / ftp;  // 1.20 = 120 % FTP

  return {
    decoupling,
    pdc,
    polarisationIndex,
    qualitySessions,
    acwr
  };
}


// ---------------------------------------------------------
// FITNESS-SCORES (🟢🟡🔴) — nach Seiler, San Millán, Friel, Foster
// ---------------------------------------------------------
function computeFitnessScores(m) {
  const score = {};

  // Aerobe Grundlage
  if (m.decoupling == null) score.aerobic = "🟡 (zu wenig GA-Daten)";
  else if (m.decoupling <= 0.05) score.aerobic = "🟢";
  else if (m.decoupling <= 0.08) score.aerobic = "🟡";
  else score.aerobic = "🔴";

  // Polarisation (80/20)
  if (m.polarisationIndex == null) score.polarisation = "🟡 (keine HR-Daten)";
  else if (m.polarisationIndex >= 0.80) score.polarisation = "🟢";
  else if (m.polarisationIndex >= 0.70) score.polarisation = "🟡";
  else score.polarisation = "🔴";

  // Anaerobe Leistungsfähigkeit
  if (m.pdc == null) score.anaerobic = "🟡 (keine intensiven Daten)";
  else if (m.pdc >= 0.95 && m.qualitySessions >= 2) score.anaerobic = "🟢";
  else if (m.pdc >= 0.85 && m.qualitySessions >= 1) score.anaerobic = "🟡";
  else score.anaerobic = "🔴";

  // Workload (ACWR)
  if (m.acwr == null) score.workload = "🟡 (keine Daten)";
  else if (m.acwr >= 0.8 && m.acwr <= 1.3) score.workload = "🟢";
  else if (m.acwr >= 0.7 && m.acwr <= 1.4) score.workload = "🟡";
  else score.workload = "🔴";

  return score;
}
