// Beach Fishing Radar — NOAA CO-OPS + NDBC + trends (YouTube + RSS) + NWS precip
// + D1 trip logging + historical backfill (buoy/weather/tide history).
// Fetches everything server-side, adds CORS headers, returns clean JSON.

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

function validateCoopsStation(station) { return typeof station === "string" && /^[0-9]{7}$/.test(station); }
function validateNdbcStation(station) { return typeof station === "string" && /^[A-Za-z0-9]{4,7}$/.test(station); }
function validateIcaoStation(station) { return typeof station === "string" && /^[A-Za-z]{4}$/.test(station); }
function validateDateCompact(d) { return typeof d === "string" && /^[0-9]{8}$/.test(d); }
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
// Tide predictions are harmonic/deterministic, so "history" for any date
// within reason is just the same predictions product, scoped to that date
// (with a 1-day pad on each side so a request near midnight still resolves).
async function handleTidesForDate(station, dateCompact) {
  const d = new Date(Date.UTC(+dateCompact.slice(0, 4), +dateCompact.slice(4, 6) - 1, +dateCompact.slice(6, 8)));
  const pad = (n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10).replace(/-/g, ""); };
  const r = await fetchNoaa({ station, product: "predictions", datum: "MLLW", interval: "hilo", begin_date: pad(-1), end_date: pad(1) });
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

// Parses EVERY row in the file (up to 45 days of history per NDBC's own
// documentation), not just the newest one — this is what makes historical
// backfill possible without a new external data source.
function parseNdbcAllRows(text) {
  const lines = text.trim().split("\n").filter((l) => l.trim().length > 0);
  const rows = [];
  for (let i = 2; i < lines.length; i++) {
    const parts = lines[i].trim().split(/\s+/);
    if (parts.length < 13) continue;
    const num = (v) => (v === undefined || v === "MM" ? null : parseFloat(v));
    const [YY, MM, DD, hh, mm, WDIR, WSPD, GST, WVHT, DPD, APD, MWD, PRES, ATMP, WTMP, DEWP, VIS, PTDY] = parts;
    rows.push({
      observedAtUtc: `${YY}-${MM}-${DD}T${hh}:${mm}:00Z`,
      windDirDeg: num(WDIR), windSpeedMs: num(WSPD), gustMs: num(GST),
      waveHeightM: num(WVHT), dominantWavePeriodS: num(DPD), avgWavePeriodS: num(APD),
      waveDirDeg: num(MWD), pressureHpa: num(PRES), airTempC: num(ATMP),
      waterTempC: num(WTMP), dewPointC: num(DEWP), visibilityNmi: num(VIS), pressureTendencyHpa: num(PTDY),
    });
  }
  return rows;
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

// Returns every row NDBC has for the requested UTC date — the client picks
// the row nearest its desired time-block. NDBC only retains 45 days, so
// requests older than that will legitimately come back empty.
async function handleBuoyHistory(station, dateCompact) {
  const url = `${NDBC_BASE}/${station}.txt`;
  let res;
  try { res = await fetch(url); } catch (e) { return jsonResponse({ error: `Could not reach NDBC: ${e.message}` }, 502); }
  if (!res.ok) return jsonResponse({ error: `NDBC returned HTTP ${res.status} for station ${station}` }, res.status === 404 ? 404 : 502);
  const text = await res.text();
  const allRows = parseNdbcAllRows(text);
  const targetDatePrefix = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`;
  const dayRows = allRows.filter((r) => r.observedAtUtc.startsWith(targetDatePrefix));
  if (dayRows.length === 0) {
    return jsonResponse({ station, date: dateCompact, rows: [], note: "No data for this date \u2014 NDBC's realtime2 file only retains ~45 days, or the buoy may have been offline." });
  }
  return jsonResponse({ station, date: dateCompact, rows: dayRows });
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
    videoId: it.id?.videoId, title: it.snippet?.title, channelTitle: it.snippet?.channelTitle,
    publishedAt: it.snippet?.publishedAt, thumbnailUrl: it.snippet?.thumbnails?.default?.url || null,
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
    items.push({ title: grab("title"), link: linkMatch ? linkMatch[1] : null, pubDate: grab("pubDate") || grab("published") || grab("updated"), description: grab("description") || grab("summary") });
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
  try { res = await fetch(url, { headers: { "User-Agent": "BeachFishingRadarProxy (personal project)" } }); }
  catch (e) { return jsonResponse({ error: `Could not reach NWS: ${e.message}` }, 502); }
  if (!res.ok) return jsonResponse({ error: `NWS returned HTTP ${res.status} for station ${station}` }, res.status === 404 ? 404 : 502);
  let json;
  try { json = await res.json(); } catch { return jsonResponse({ error: "NWS response was not valid JSON" }, 502); }
  const props = json.properties || {};
  const metersToInches = (m) => (m == null ? null : m * 39.3701);
  return jsonResponse({
    station: station.toUpperCase(), timestamp: props.timestamp || null,
    precipLastHourIn: metersToInches(props.precipitationLastHour?.value),
    precipLast3HoursIn: metersToInches(props.precipitationLast3Hours?.value),
    precipLast6HoursIn: metersToInches(props.precipitationLast6Hours?.value),
  });
}

// NWS keeps a real rolling observation history at this same base path
// (no /latest) — returns a GeoJSON FeatureCollection. Known NWS API quirk:
// results aren't always chronologically sorted, so we sort defensively
// here rather than trust source order.
async function handleWeatherHistory(station, dateCompact) {
  const year = dateCompact.slice(0, 4), month = dateCompact.slice(4, 6), day = dateCompact.slice(6, 8);
  const start = `${year}-${month}-${day}T00:00:00Z`;
  const end = `${year}-${month}-${day}T23:59:59Z`;
  const url = `${NWS_BASE}/stations/${station.toUpperCase()}/observations?start=${start}&end=${end}`;
  let res;
  try { res = await fetch(url, { headers: { "User-Agent": "BeachFishingRadarProxy (personal project)" } }); }
  catch (e) { return jsonResponse({ error: `Could not reach NWS: ${e.message}` }, 502); }
  if (!res.ok) return jsonResponse({ error: `NWS returned HTTP ${res.status} for station ${station}` }, res.status === 404 ? 404 : 502);
  let json;
  try { json = await res.json(); } catch { return jsonResponse({ error: "NWS response was not valid JSON" }, 502); }
  const metersToInches = (m) => (m == null ? null : m * 39.3701);
  const rows = (json.features || [])
    .map((f) => ({
      timestamp: f.properties?.timestamp,
      precipLastHourIn: metersToInches(f.properties?.precipitationLastHour?.value),
    }))
    .filter((r) => r.timestamp)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return jsonResponse({ station: station.toUpperCase(), date: dateCompact, rows });
}

// ---------------------------------------------------------------------
// TRIP LOGGING — normalized: one `trips` row per logging session (shared
// conditions), many `trip_observations` rows (one per species/bait, with
// independent sighted/bit/caught flags). The only write-capable routes.
// ---------------------------------------------------------------------
async function handleTripLog(request, env) {
  if (!env.TRIPS_DB) return jsonResponse({ error: "Trips database is not bound to this Worker (TRIPS_DB binding missing)." }, 500);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Request body must be valid JSON." }, 400); }

  for (const field of ["beach_id", "trip_date", "time_block", "observations"]) {
    if (!body[field]) return jsonResponse({ error: `Missing required field: ${field}` }, 400);
  }
  if (!Array.isArray(body.observations) || body.observations.length === 0) {
    return jsonResponse({ error: "observations must be a non-empty array." }, 400);
  }

  const now = new Date().toISOString();
  try {
    const tripResult = await env.TRIPS_DB.prepare(
      `INSERT INTO trips (
        beach_id, trip_date, time_block, observed_at, logged_at, notes,
        wave_ft, wave_ft_source, wind_kt, wind_kt_source, water_temp_f, water_temp_f_source,
        clarity_score, clarity_label, clarity_source, tide_direction, tide_flow_pct,
        bait_tier, bait_level, moon_phase_name, moon_illumination_pct
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      body.beach_id, body.trip_date, body.time_block, body.observed_at ?? null, now, body.notes ?? null,
      body.wave_ft ?? null, body.wave_ft_source ?? null, body.wind_kt ?? null, body.wind_kt_source ?? null,
      body.water_temp_f ?? null, body.water_temp_f_source ?? null,
      body.clarity_score ?? null, body.clarity_label ?? null, body.clarity_source ?? null,
      body.tide_direction ?? null, body.tide_flow_pct ?? null,
      body.bait_tier ?? null, body.bait_level ?? null,
      body.moon_phase_name ?? null, body.moon_illumination_pct ?? null
    ).run();
    const tripId = tripResult.meta.last_row_id;

    for (const obs of body.observations) {
      if (!obs.subject_type || !obs.subject_id) continue;
      await env.TRIPS_DB.prepare(
        `INSERT INTO trip_observations (
          trip_id, subject_type, subject_id, sighted, bit, caught, count, distance_yd_actual,
          predicted_score, predicted_presence, predicted_feeding, predicted_access,
          predicted_zone, predicted_distance_min, predicted_distance_max
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        tripId, obs.subject_type, obs.subject_id,
        obs.sighted ? 1 : 0, obs.subject_type === "species" ? (obs.bit ? 1 : 0) : null, obs.caught ? 1 : 0,
        obs.count ?? null, obs.distance_yd_actual ?? null,
        obs.predicted_score ?? null, obs.predicted_presence ?? null, obs.predicted_feeding ?? null, obs.predicted_access ?? null,
        obs.predicted_zone ?? null, obs.predicted_distance_min ?? null, obs.predicted_distance_max ?? null
      ).run();
    }
    return jsonResponse({ ok: true, trip_id: tripId });
  } catch (e) {
    return jsonResponse({ error: `Database write failed: ${e.message}` }, 500);
  }
}

async function handleTripList(url, env) {
  if (!env.TRIPS_DB) return jsonResponse({ error: "Trips database is not bound to this Worker (TRIPS_DB binding missing)." }, 500);
  const beachId = url.searchParams.get("beach_id");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
  let query = "SELECT * FROM trips";
  const binds = [];
  if (beachId) { query += " WHERE beach_id = ?"; binds.push(beachId); }
  query += " ORDER BY trip_date DESC, id DESC LIMIT ?";
  binds.push(limit);
  try {
    const { results: trips } = await env.TRIPS_DB.prepare(query).bind(...binds).all();
    for (const trip of trips) {
      const { results: obs } = await env.TRIPS_DB.prepare("SELECT * FROM trip_observations WHERE trip_id = ?").bind(trip.id).all();
      trip.observations = obs;
    }
    return jsonResponse({ trips });
  } catch (e) {
    return jsonResponse({ error: `Database read failed: ${e.message}` }, 500);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
    const url = new URL(request.url);
    const station = url.searchParams.get("station");
    const date = url.searchParams.get("date");

    if (url.pathname === "/") {
      return jsonResponse({
        ok: true,
        routes: [
          "/tides/current?station=", "/tides/predictions?station=", "/tides/curve?station=",
          "/tides/history?station=&date=YYYYMMDD",
          "/buoy/latest?station=", "/buoy/history?station=&date=YYYYMMDD",
          "/weather/precip?station=", "/weather/history?station=&date=YYYYMMDD",
          "/trends/youtube?query=", "/trends/rss?source=",
          "/trips/log (POST)", "/trips/list?beach_id=&limit=",
        ],
      });
    }

    if (["/tides/current", "/tides/predictions", "/tides/curve", "/tides/history"].includes(url.pathname)) {
      if (!validateCoopsStation(station)) return jsonResponse({ error: "Missing or invalid 'station' \u2014 must be a 7-digit NOAA CO-OPS station ID." }, 400);
      if (url.pathname === "/tides/current") return handleCurrent(station);
      if (url.pathname === "/tides/predictions") return handlePredictions(station);
      if (url.pathname === "/tides/curve") return handleCurve(station);
      if (url.pathname === "/tides/history") {
        if (!validateDateCompact(date)) return jsonResponse({ error: "Missing or invalid 'date' \u2014 must be YYYYMMDD." }, 400);
        return handleTidesForDate(station, date);
      }
    }

    if (url.pathname === "/buoy/latest" || url.pathname === "/buoy/history") {
      if (!validateNdbcStation(station)) return jsonResponse({ error: "Missing or invalid 'station' \u2014 must be a valid NDBC station ID." }, 400);
      if (url.pathname === "/buoy/latest") return handleBuoyLatest(station);
      if (!validateDateCompact(date)) return jsonResponse({ error: "Missing or invalid 'date' \u2014 must be YYYYMMDD." }, 400);
      return handleBuoyHistory(station, date);
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

    if (url.pathname === "/weather/precip" || url.pathname === "/weather/history") {
      if (!validateIcaoStation(station)) return jsonResponse({ error: "Missing or invalid 'station' \u2014 must be a 4-letter ICAO station ID (e.g. KMIA)." }, 400);
      if (url.pathname === "/weather/precip") return handlePrecip(station);
      if (!validateDateCompact(date)) return jsonResponse({ error: "Missing or invalid 'date' \u2014 must be YYYYMMDD." }, 400);
      return handleWeatherHistory(station, date);
    }

    if (url.pathname === "/trips/log") {
      if (request.method !== "POST") return jsonResponse({ error: "Use POST for /trips/log." }, 405);
      return handleTripLog(request, env);
    }

    if (url.pathname === "/trips/list") return handleTripList(url, env);

    return jsonResponse({ error: "Unknown route." }, 404);
  },
};
