// Beach Fishing Radar — NOAA CO-OPS proxy
// Exposes exactly three routes. Fetches NOAA server-side, adds CORS headers,
// returns NOAA's JSON unmodified. No storage, no other data sources, no
// arbitrary URL passthrough.

const NOAA_BASE = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// NOAA station IDs are 7-digit numeric codes. Reject anything else before
// it ever reaches NOAA.
function validateStation(station) {
  return typeof station === "string" && /^[0-9]{7}$/.test(station);
}

function todayCompact(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

async function fetchNoaa(params) {
  const qs = new URLSearchParams({
    application: "BeachFishingRadarProxy",
    format: "json",
    units: "english",
    time_zone: "lst_ldt",
    ...params,
  });
  const url = `${NOAA_BASE}?${qs.toString()}`;

  let res;
  try {
    res = await fetch(url);
  } catch (networkErr) {
    return { ok: false, status: 502, body: { error: `Could not reach NOAA: ${networkErr.message}` } };
  }

  let json;
  try {
    json = await res.json();
  } catch (parseErr) {
    return { ok: false, status: 502, body: { error: "NOAA response was not valid JSON" } };
  }

  if (!res.ok) {
    return { ok: false, status: res.status, body: { error: `NOAA returned HTTP ${res.status}`, noaa: json } };
  }
  if (json.error) {
    // NOAA often returns HTTP 200 with an {error:{message}} body for a bad
    // station or no data — treat that as a real error, not a success.
    return { ok: false, status: 404, body: { error: json.error.message || "NOAA reported an error", noaa: json } };
  }
  return { ok: true, status: 200, body: json };
}

async function handleCurrent(station) {
  const result = await fetchNoaa({ station, product: "water_level", datum: "MLLW", date: "latest" });
  return jsonResponse(result.body, result.status);
}

async function handlePredictions(station) {
  const result = await fetchNoaa({
    station, product: "predictions", datum: "MLLW", interval: "hilo",
    begin_date: todayCompact(0), end_date: todayCompact(2),
  });
  return jsonResponse(result.body, result.status);
}

async function handleCurve(station) {
  const result = await fetchNoaa({
    station, product: "predictions", datum: "MLLW", interval: "h",
    begin_date: todayCompact(0), end_date: todayCompact(0),
  });
  return jsonResponse(result.body, result.status);
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const station = url.searchParams.get("station");

    if (url.pathname === "/") {
      return jsonResponse({ ok: true, routes: ["/tides/current?station=", "/tides/predictions?station=", "/tides/curve?station="] });
    }

    if (!["/tides/current", "/tides/predictions", "/tides/curve"].includes(url.pathname)) {
      return jsonResponse({ error: "Unknown route. Use /tides/current, /tides/predictions, or /tides/curve." }, 404);
    }

    if (!validateStation(station)) {
      return jsonResponse({ error: "Missing or invalid 'station' parameter — must be a 7-digit NOAA station ID." }, 400);
    }

    if (url.pathname === "/tides/current") return handleCurrent(station);
    if (url.pathname === "/tides/predictions") return handlePredictions(station);
    if (url.pathname === "/tides/curve") return handleCurve(station);
  },
};
