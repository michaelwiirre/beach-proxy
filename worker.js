// Beach Fishing Radar — NOAA CO-OPS + NDBC + trends (YouTube + RSS) + NWS precip + D1 trip logging
// Fetches everything server-side, adds CORS headers, returns clean JSON.
// RSS sources and NWS stations are allowlisted, not arbitrary. Trip logs
// persist to D1 (TRIPS_DB binding) — the only write-capable route here.

const NOAA_BASE = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
const NDBC_BASE = "https://www.ndbc.noaa.gov/data/realtime2";
const YOUTUBE_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const NWS_BASE = "https://api.weather.gov";

const RSS_SOURCES = {
  "snook-nook": { url: "https://snooknookfl.com/feed", name: "Snook Nook Bait & Tackle (Jensen Beach)" },
  "ponce-inlet": { url: "https://ponceinletcharters.com/2/feed", name: "Ponce Inlet Fishing Charters" },
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function validateCoopsStation(station) {
  return typeof station === "string" && /^[0-9]{7}$/.test(station);
}
function validateNdbcStation(station) {
  return typeof station === "string" && /^[A-Za-z0-9]{4,7}$/.test(station);
}
function validateIcaoStation(station) {
  return typeof station === "string" && /^[A-Za-z]{4}$/.test(station);
}
function todayCompact(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

async function fetchNoaa(params) {
  const qs = new URLSearchParams({ application: "BeachFishingRadarProxy", format: "json", units: "english", time_zone: "lst_ldt", ...params });
  const url = `${NOAA_BASE}?${qs.toString()}`;
  let res;
  try { res = await fetch(url); } catch (e) { return { ok: false, status: 502, body: { error: `Could not reach NOAA: ${e.message}` } }; }
  let json;
  try { json = await res.json(); } catch { return { ok: false, status: 502, body: { error: "NOAA response was not valid JSON" } }; }
  if (!res.ok) return { ok: false, status: res.status, body: { error: `NOAA returned HTTP ${res.status}`, noaa: json } };
  if (json.error) return { ok: false, status: 404, body: { error: json.error.message || "NOAA reported an error", noaa: json } };
  return { ok: true, status: 200, body: json };
}

async function handleCurrent(station) {
  const r = await fetchNoaa({ station, product: "water_level", datum: "MLLW", date: "latest" });
  return jsonResponse(r.body, r.status);
}
async function handlePredictions(station) {
  const r = await fetchNoaa({ station, product: "predictions", datum: "MLLW", interval: "hilo", begin_date: todayCompact(-1), end_date: todayCompact(2) });
  return jsonResponse(r.body, r.status);
}
async function handleCurve(station) {
  const r = await fetchNoaa({ station, product: "predictions", datum: "MLLW", interval: "h", begin_date: todayCompact(-1), end_date: todayCompact(1) });
  return jsonResponse(r.body, r.status);
}

function parseNdbcStandardMet(text) {
  const lines = text.trim().split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 3) return null;
  const parts = lines[2].trim().split(/\s+/);
  if (parts.length < 13) return null;
  const num = (v) => (v === undefined || v === "MM" ? null : parseFloat(v));
  const [YY, MM, DD, hh, mm, WDIR, WSPD, GST, WVHT, DPD, APD, MWD, PRES, ATMP, WTMP, DEWP, VIS, PTDY] = parts;
  return {
    observedAtUtc: `${YY}-${MM}-${DD}T${hh}:${mm}:00Z`,
    windDirDeg: num(WDIR), windSpeedMs: num(WSPD), gustMs: num(GST),
    waveHeightM: num(WVHT), dominantWavePeriodS: num(DPD), avgWavePeriodS: num(APD),
    waveDirDeg: num(MWD), pressureHpa: num(PRES), airTempC: num(ATMP),
    waterTempC: num(WTMP), dewPointC: num(DEWP), visibilityNmi: num(VIS), pressureTendencyHpa: num(PTDY),
  };
}

async function handleBuoyLatest(station) {
  const url = `${NDBC_BASE}/${station}.txt`;
  let res;
  try { res = await fetch(url); } catch (e) { return jsonResponse({ error: `Could not reach NDBC: ${e.message}` }, 502); }
  if (!res.ok) return jsonResponse({ error: `NDBC returned HTTP ${res.status} for station ${station}` }, res.status === 404 ? 404 : 502);
  const text = await res.text();
  const parsed = parseNdbcStandardMet(text);
  if (!parsed) return jsonResponse({ error: `Could not parse NDBC data for station ${station} (station may be offline)` }, 502);
  return jsonResponse({ station, ...parsed });
}

async function handleYoutubeTrends(query, env) {
  if (!env.YOUTUBE_API_KEY) return jsonResponse({ error: "YouTube API key not configured on the server." }, 500);
  const publishedAfter = new Date(Date.now() - 21 * 24 * 3600 * 1000).toISOString();
  const qs = new URLSearchParams({
    part: "snippet", type: "video", order: "date", maxResults: "6",
    publishedAfter, q: query, key: env.YOUTUBE_API_KEY,
  });
  let res;
  try { res = await fetch(`${YOUTUBE_SEARCH_URL}?${qs.toString()}`); }
  catch (e) { return jsonResponse({ error: `Could not reach YouTube: ${e.message}` }, 502); }
  let json;
  try { json = await res.json(); } catch { return jsonResponse({ error: "YouTube response was not valid JSON" }, 502); }
  if (!res.ok) return jsonResponse({ error: json?.error?.message || `YouTube returned HTTP ${res.status}` }, res.status);
  const items = (json.items || []).map((it) => ({
    videoId: it.id?.videoId,
    title: it.snippet?.title,
    channelTitle: it.snippet?.channelTitle,
    publishedAt: it.snippet?.publishedAt,
    thumbnailUrl: it.snippet?.thumbnails?.default?.url || null,
    link: it.id?.videoId ? `https://www.youtube.com/watch?v=${it.id.videoId}` : null,
  }));
  return jsonResponse({ query, items });
}

function parseRss(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of itemBlocks.slice(0, 6)) {
    const grab = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
      if (!m) return null;
      return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").replace(/<[^>]+>/g, "").trim();
    };
    const linkMatch = block.match(/<link[^>]*href="([^"]+)"/i) || block.match(/<link>([^<]+)<\/link>/i);
    items.push({
      title: grab("title"),
      link: linkMatch ? linkMatch[1] : null,
      pubDate: grab("pubDate") || grab("published") || grab("updated"),
      description: grab("description") || grab("summary"),
    });
  }
  return items;
}

async function handleRssTrends(sourceKey) {
  const source = RSS_SOURCES[sourceKey];
  if (!source) return jsonResponse({ error: `Unknown RSS source '${sourceKey}'.` }, 400);
  let res;
  try { res = await fetch(source.url); }
  catch (e) { return jsonResponse({ error: `Could not reach ${source.name}: ${e.message}` }, 502); }
  if (!res.ok) return jsonResponse({ error: `${source.name} returned HTTP ${res.status}` }, 502);
  const xml = await res.text();
  const items = parseRss(xml);
  if (items.length === 0) return jsonResponse({ error: `Could not parse any items from ${source.name} (feed format may have changed)` }, 502);
  return jsonResponse({ source: sourceKey, sourceName: source.name, items });
}

async function handlePrecip(station) {
  const url = `${NWS_BASE}/stations/${station.toUpperCase()}/observations/latest`;
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": "BeachFishingRadarProxy (personal project)" } });
  } catch (e) {
    return jsonResponse({ error: `Could not reach NWS: ${e.message}` }, 502);
  }
  if (!res.ok) {
    return jsonResponse({ error: `NWS returned HTTP ${res.status} for station ${station}` }, res.status === 404 ? 404 : 502);
  }
  let json;
  try {
    json = await res.json();
  } catch {
    return jsonResponse({ error: "NWS response was not valid JSON" }, 502);
  }
  const props = json.properties || {};
  const metersToInches = (m) => (m == null ? null : m * 39.3701);
  return jsonResponse({
    station: station.toUpperCase(),
    timestamp: props.timestamp || null,
    precipLastHourIn: metersToInches(props.precipitationLastHour?.value),
    precipLast3HoursIn: metersToInches(props.precipitationLast3Hours?.value),
    precipLast6HoursIn: metersToInches(props.precipitationLast6Hours?.value),
  });
}

// ---------------------------------------------------------------------
// TRIP LOGGING — the only write-capable routes in this Worker. Every
// logged trip freezes a snapshot of what the app predicted (score,
// presence, feeding, access, position, live conditions) alongside what
// actually happened, so predicted-vs-actual can be compared later.
// ---------------------------------------------------------------------
const VALID_OUTCOMES = ["caught", "hooked", "seen", "no_activity"];

async function handleTripLog(request, env) {
  if (!env.TRIPS_DB) return jsonResponse({ error: "Trips database is not bound to this Worker (TRIPS_DB binding missing)." }, 500);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Request body must be valid JSON." }, 400); }

  for (const field of ["beach_id", "species_id", "outcome"]) {
    if (!body[field]) return jsonResponse({ error: `Missing required field: ${field}` }, 400);
  }
  if (!VALID_OUTCOMES.includes(body.outcome)) {
    return jsonResponse({ error: `outcome must be one of: ${VALID_OUTCOMES.join(", ")}` }, 400);
  }

  const now = new Date().toISOString();
  const observedAt = body.observed_at || now;

  try {
    const result = await env.TRIPS_DB.prepare(
      `INSERT INTO trip_logs (
        beach_id, species_id, observed_at, logged_at, outcome, count, distance_yd_actual, notes,
        predicted_score, predicted_presence, predicted_feeding, predicted_access, predicted_zone,
        predicted_distance_min, predicted_distance_max, wave_ft, wind_kt, water_temp_f,
        clarity_score, clarity_label, tide_direction, tide_flow_pct, bait_tier, bait_level
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      body.beach_id, body.species_id, observedAt, now, body.outcome,
      body.count ?? null, body.distance_yd_actual ?? null, body.notes ?? null,
      body.predicted_score ?? null, body.predicted_presence ?? null, body.predicted_feeding ?? null,
      body.predicted_access ?? null, body.predicted_zone ?? null,
      body.predicted_distance_min ?? null, body.predicted_distance_max ?? null,
      body.wave_ft ?? null, body.wind_kt ?? null, body.water_temp_f ?? null,
      body.clarity_score ?? null, body.clarity_label ?? null,
      body.tide_direction ?? null, body.tide_flow_pct ?? null,
      body.bait_tier ?? null, body.bait_level ?? null
    ).run();
    return jsonResponse({ ok: true, id: result.meta.last_row_id });
  } catch (e) {
    return jsonResponse({ error: `Database write failed: ${e.message}` }, 500);
  }
}

async function handleTripList(url, env) {
  if (!env.TRIPS_DB) return jsonResponse({ error: "Trips database is not bound to this Worker (TRIPS_DB binding missing)." }, 500);
  const beachId = url.searchParams.get("beach_id");
  const speciesId = url.searchParams.get("species_id");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);

  let query = "SELECT * FROM trip_logs";
  const conditions = [];
  const binds = [];
  if (beachId) { conditions.push("beach_id = ?"); binds.push(beachId); }
  if (speciesId) { conditions.push("species_id = ?"); binds.push(speciesId); }
  if (conditions.length) query += " WHERE " + conditions.join(" AND ");
  query += " ORDER BY observed_at DESC LIMIT ?";
  binds.push(limit);

  try {
    const { results } = await env.TRIPS_DB.prepare(query).bind(...binds).all();
    return jsonResponse({ trips: results });
  } catch (e) {
    return jsonResponse({ error: `Database read failed: ${e.message}` }, 500);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);
    const station = url.searchParams.get("station");

    if (url.pathname === "/") {
      return jsonResponse({
        ok: true,
        routes: ["/tides/current?station=", "/tides/predictions?station=", "/tides/curve?station=", "/buoy/latest?station=", "/trends/youtube?query=", "/trends/rss?source=", "/weather/precip?station=", "/trips/log (POST)", "/trips/list?beach_id=&species_id=&limit="],
      });
    }

    if (["/tides/current", "/tides/predictions", "/tides/curve"].includes(url.pathname)) {
      if (!validateCoopsStation(station)) return jsonResponse({ error: "Missing or invalid 'station' — must be a 7-digit NOAA CO-OPS station ID." }, 400);
      if (url.pathname === "/tides/current") return handleCurrent(station);
      if (url.pathname === "/tides/predictions") return handlePredictions(station);
      if (url.pathname === "/tides/curve") return handleCurve(station);
    }

    if (url.pathname === "/buoy/latest") {
      if (!validateNdbcStation(station)) return jsonResponse({ error: "Missing or invalid 'station' — must be a valid NDBC station ID." }, 400);
      return handleBuoyLatest(station);
    }

    if (url.pathname === "/trends/youtube") {
      const query = url.searchParams.get("query");
      if (!query || query.length < 3 || query.length > 100) return jsonResponse({ error: "Missing or invalid 'query' parameter." }, 400);
      return handleYoutubeTrends(query, env);
    }

    if (url.pathname === "/trends/rss") {
      const source = url.searchParams.get("source");
      if (!source) return jsonResponse({ error: "Missing 'source' parameter." }, 400);
      return handleRssTrends(source);
    }

    if (url.pathname === "/weather/precip") {
      if (!validateIcaoStation(station)) {
        return jsonResponse({ error: "Missing or invalid 'station' — must be a 4-letter ICAO station ID (e.g. KMIA)." }, 400);
      }
      return handlePrecip(station);
    }

    if (url.pathname === "/trips/log") {
      if (request.method !== "POST") return jsonResponse({ error: "Use POST for /trips/log." }, 405);
      return handleTripLog(request, env);
    }

    if (url.pathname === "/trips/list") {
      return handleTripList(url, env);
    }

    return jsonResponse({ error: "Unknown route." }, 404);
  },
};
