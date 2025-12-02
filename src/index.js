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

    // ... hier der ganze CTL/ATL/TSB/Weekly-Plan-Code,
    // den wir schon für Netlify hatten, nur mit fetch/env statt process.env ...

    return new Response(`OK: ...`, { status: 200 });
  },
};
