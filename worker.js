// Beach Fishing Radar — NOAA CO-OPS + NDBC proxy
// Exposes tide routes (NOAA CO-OPS, JSON passthrough) and one buoy route
// (NDBC, which only offers plain text, so this parses it into JSON). No
// storage, no other data sources, no arbitrary URL passthrough.

const NOAA_BASE = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
const NDBC_BASE = "https://www.ndbc.noaa.gov/data/realtime2";

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

// NOAA CO-OPS station IDs are 7-digit numeric codes.
function validateCoopsStation(station) {
  return typeof station === "string" && /^[0-9]{7}$/.test(station);
}

// NDBC station IDs are 5-character: either all-digit buoy IDs (41112) or a
// 4-letter-plus-digit C-MAN code (FWYF1). Reject anything else.
function validateNdbcStation(station) {
  return typeof station === "string" && /^[A-Za-z0-9]{4,7}$/.test(station);
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
  } catch {
    return { ok: false, status: 502, body: { error: "NOAA response was not valid JSON" } };
  }

  if (!res.ok) {
    return { ok: false, status: res.status, body: { error: `NOAA returned HTTP ${res.status}`, noaa: json } };
  }
  if (json.error) {
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

// NDBC's standard meteorological file: two header lines (names, then units),
// then rows newest-first, whitespace-separated, "MM" for missing values.
// #YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE
function parseNdbcStandardMet(text) {
  const lines = text.trim().split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 3) return null; // need 2 header lines + at least 1 data row
  const parts = lines[2].trim().split(/\s+/);
  if (parts.length < 13) return null;
  const num = (v) => (v === undefined || v === "MM" ? null : parseFloat(v));
  const [YY, MM, DD, hh, mm, WDIR, WSPD, GST, WVHT, DPD, APD, MWD, PRES, ATMP, WTMP, DEWP, VIS, PTDY] = parts;
  return {
    observedAtUtc: `${YY}-${MM}-${DD}T${hh}:${mm}:00Z`,
    windDirDeg: num(WDIR),
    windSpeedMs: num(WSPD),
    gustMs: num(GST),
    waveHeightM: num(WVHT),
    dominantWavePeriodS: num(DPD),
    avgWavePeriodS: num(APD),
    waveDirDeg: num(MWD),
    pressureHpa: num(PRES),
    airTempC: num(ATMP),
    waterTempC: num(WTMP),
    dewPointC: num(DEWP),
    visibilityNmi: num(VIS),
    pressureTendencyHpa: num(PTDY),
  };
}

async function handleBuoyLatest(station) {
  const url = `${NDBC_BASE}/${station}.txt`;
  let res;
  try {
    res = await fetch(url);
  } catch (networkErr) {
    return jsonResponse({ error: `Could not reach NDBC: ${networkErr.message}` }, 502);
  }
  if (!res.ok) {
    return jsonResponse({ error: `NDBC returned HTTP ${res.status} for station ${station}` }, res.status === 404 ? 404 : 502);
  }
  const text = await res.text();
  const parsed = parseNdbcStandardMet(text);
  if (!parsed) {
    return jsonResponse({ error: `Could not parse NDBC data for station ${station} (station may be offline)` }, 502);
  }
  return jsonResponse({ station, ...parsed });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const station = url.searchParams.get("station");

    if (url.pathname === "/") {
      return jsonResponse({
        ok: true,
        routes: ["/tides/current?station=", "/tides/predictions?station=", "/tides/curve?station=", "/buoy/latest?station="],
      });
    }

    if (["/tides/current", "/tides/predictions", "/tides/curve"].includes(url.pathname)) {
      if (!validateCoopsStation(station)) {
        return jsonResponse({ error: "Missing or invalid 'station' parameter — must be a 7-digit NOAA CO-OPS station ID." }, 400);
      }
      if (url.pathname === "/tides/current") return handleCurrent(station);
      if (url.pathname === "/tides/predictions") return handlePredictions(station);
      if (url.pathname === "/tides/curve") return handleCurve(station);
    }

    if (url.pathname === "/buoy/latest") {
      if (!validateNdbcStation(station)) {
        return jsonResponse({ error: "Missing or invalid 'station' parameter — must be a valid NDBC station ID (e.g. 41112 or FWYF1)." }, 400);
      }
      return handleBuoyLatest(station);
    }

    return jsonResponse({ error: "Unknown route. Use /tides/current, /tides/predictions, /tides/curve, or /buoy/latest." }, 404);
  },
};
