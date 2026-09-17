// Beach Fishing Radar — NOAA CO-OPS + NDBC + trends (YouTube + RSS) + NWS precip
// + NWS forecast gridpoints + D1 trip logging + historical backfill +
// immutable prediction snapshots + Priority 13 regional forage harness +
// Priority 15 shared-model prediction engine integration.

import {
  MODEL_VERSION, MODEL_IMPLEMENTATION_FINGERPRINT, NOAA_STATIONS, NDBC_STATIONS, METAR_STATIONS,
  normalizeObservations, normalizeNoaaTideRows, convertNdbcRowToImperial,
  predictAsOfTimestamp,
} from "./shared-model.js";

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
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
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

// ---------------------------------------------------------------------
// PRIORITY 15 STAGE 2 — "Raw" internal functions extracted from the
// handlers below, so the Worker's own dataAccess implementation can call
// them in-process. Each existing HTTP route becomes a thin wrapper over
// its Raw counterpart — HTTP behavior is unchanged.
// ---------------------------------------------------------------------
async function fetchTideHistoryForDate(station, dateCompactStr) {
  const year = dateCompactStr.slice(0, 4), month = dateCompactStr.slice(4, 6), day = dateCompactStr.slice(6, 8);
  const d = new Date(Date.UTC(+year, +month - 1, +day));
  const pad = (n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10).replace(/-/g, ""); };
  return fetchNoaa({ station, product: "predictions", datum: "MLLW", interval: "hilo", begin_date: pad(-1), end_date: pad(1) });
}
async function handleTidesForDate(station, dateCompact) {
  const r = await fetchTideHistoryForDate(station, dateCompact);
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

async function fetchNdbcRowsForDate(station, dateCompact) {
  const url = `${NDBC_BASE}/${station}.txt`;
  let res;
  try { res = await fetch(url); } catch (e) { return { ok: false, status: 502, rows: [], error: `Could not reach NDBC: ${e.message}` }; }
  if (!res.ok) return { ok: false, status: res.status === 404 ? 404 : 502, rows: [], error: `NDBC returned HTTP ${res.status} for station ${station}` };
  const text = await res.text();
  const allRows = parseNdbcAllRows(text);
  const targetDatePrefix = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`;
  return { ok: true, status: 200, rows: allRows.filter((r) => r.observedAtUtc.startsWith(targetDatePrefix)) };
}
async function handleBuoyHistory(station, dateCompact) {
  const { ok, status, rows, error } = await fetchNdbcRowsForDate(station, dateCompact);
  if (!ok) return jsonResponse({ error }, status);
  if (rows.length === 0) return jsonResponse({ station, date: dateCompact, rows: [], note: "No data for this date — NDBC's realtime2 file only retains ~45 days, or the buoy may have been offline." });
  return jsonResponse({ station, date: dateCompact, rows });
}

async function handleYoutubeTrends(query, env) {
  if (!env.YOUTUBE_API_KEY) return jsonResponse({ error: "YouTube API key not configured on the server." }, 500);
  const publishedAfter = new Date(Date.now() - 21 * 24 * 3600 * 1000).toISOString();
  const qs = new URLSearchParams({ part: "snippet", type: "video", order: "date", maxResults: "6", publishedAfter, q: query, key: env.YOUTUBE_API_KEY });
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

async function fetchMetarRowsForDate(station, dateCompact) {
  const year = dateCompact.slice(0, 4), month = dateCompact.slice(4, 6), day = dateCompact.slice(6, 8);
  const start = `${year}-${month}-${day}T00:00:00Z`, end = `${year}-${month}-${day}T23:59:59Z`;
  const url = `${NWS_BASE}/stations/${station.toUpperCase()}/observations?start=${start}&end=${end}`;
  let res;
  try { res = await fetch(url, { headers: { "User-Agent": "BeachFishingRadarProxy (personal project)" } }); }
  catch (e) { return { ok: false, status: 502, rows: [], error: `Could not reach NWS: ${e.message}` }; }
  if (!res.ok) return { ok: false, status: res.status === 404 ? 404 : 502, rows: [], error: `NWS returned HTTP ${res.status} for station ${station}` };
  let json;
  try { json = await res.json(); } catch { return { ok: false, status: 502, rows: [], error: "NWS response was not valid JSON" }; }
  const metersToInches = (m) => (m == null ? null : m * 39.3701);
  const rows = (json.features || [])
    .map((f) => ({ timestamp: f.properties?.timestamp, precipLastHourIn: metersToInches(f.properties?.precipitationLastHour?.value) }))
    .filter((r) => r.timestamp)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return { ok: true, status: 200, rows };
}
async function handleWeatherHistory(station, dateCompact) {
  const { ok, status, rows, error } = await fetchMetarRowsForDate(station, dateCompact);
  if (!ok) return jsonResponse({ error }, status);
  return jsonResponse({ station: station.toUpperCase(), date: dateCompact, rows });
}

// ---------------------------------------------------------------------
// FORECAST (Priority 10, extracted for reuse Priority 15 Stage 2)
// ---------------------------------------------------------------------
const FORECAST_FIELDS = [
  "windSpeed", "windDirection", "windGust",
  "waveHeight", "wavePeriod", "waveDirection",
  "primarySwellHeight", "primarySwellDirection", "windWaveHeight",
  "probabilityOfPrecipitation", "quantitativePrecipitation", "pressure",
];
async function fetchForecastGridpointRaw(lat, lon) {
  let pointsRes;
  try { pointsRes = await fetch(`https://api.weather.gov/points/${lat},${lon}`, { headers: { "User-Agent": "BeachFishingRadarProxy (personal project)" } }); }
  catch (e) { return { error: `Could not reach NWS points lookup: ${e.message}`, status: 502 }; }
  if (!pointsRes.ok) return { error: `NWS points lookup returned HTTP ${pointsRes.status}`, status: pointsRes.status === 404 ? 404 : 502 };
  let pointsJson;
  try { pointsJson = await pointsRes.json(); } catch { return { error: "NWS points response was not valid JSON", status: 502 }; }
  const gridDataUrl = pointsJson.properties?.forecastGridData;
  const gridId = pointsJson.properties?.gridId, gridX = pointsJson.properties?.gridX, gridY = pointsJson.properties?.gridY;
  if (!gridDataUrl) return { error: "NWS did not return a gridpoint for this location", status: 502 };
  let gridRes;
  try { gridRes = await fetch(gridDataUrl, { headers: { "User-Agent": "BeachFishingRadarProxy (personal project)" } }); }
  catch (e) { return { error: `Could not reach NWS gridpoint data: ${e.message}`, status: 502 }; }
  if (!gridRes.ok) return { error: `NWS gridpoint returned HTTP ${gridRes.status}`, status: 502 };
  let gridJson;
  try { gridJson = await gridRes.json(); } catch { return { error: "NWS gridpoint response was not valid JSON", status: 502 }; }
  const props = gridJson.properties || {};
  const layers = {};
  for (const field of FORECAST_FIELDS) {
    if (props[field]?.values?.length) layers[field] = { uom: props[field].uom || null, values: props[field].values };
  }
  return { gridId, gridX, gridY, updateTime: props.updateTime || null, layers, fieldsPopulated: Object.keys(layers), fieldsRequested: FORECAST_FIELDS };
}
async function handleForecastGridpoint(lat, lon) {
  const result = await fetchForecastGridpointRaw(lat, lon);
  if (result.error) return jsonResponse(result, result.status || 502);
  return jsonResponse(result);
}

// ---------------------------------------------------------------------
// PRIORITY 15.1 — MFWAM wave forecast via Open-Meteo's Marine Weather API.
// Free for non-commercial use, no API key required. Global ~8km coverage
// means every beach gets a real wave value, not just ones near an NDBC
// buoy or inside NWS's coastal-waters marine zones. Requests explicit
// timezone=UTC so returned timestamps parse unambiguously with new Date().
// forecast_days=3 comfortably covers every horizon this app uses (up to
// +24h) with margin.
// ---------------------------------------------------------------------
const OPEN_METEO_MARINE_BASE = "https://marine-api.open-meteo.com/v1/marine";
async function fetchMarineForecastRaw(lat, lon) {
  const qs = new URLSearchParams({
    latitude: lat, longitude: lon, hourly: "wave_height,wave_period",
    models: "meteofrance_wave", timezone: "UTC", forecast_days: "3", cell_selection: "sea",
  });
  let res;
  try { res = await fetch(`${OPEN_METEO_MARINE_BASE}?${qs.toString()}`); }
  catch (e) { return { error: `Could not reach Open-Meteo Marine API: ${e.message}`, status: 502 }; }
  if (!res.ok) return { error: `Open-Meteo Marine API returned HTTP ${res.status}`, status: res.status === 404 ? 404 : 502 };
  let json;
  try { json = await res.json(); } catch { return { error: "Open-Meteo Marine API response was not valid JSON", status: 502 }; }
  if (json.error) return { error: json.reason || "Open-Meteo Marine API reported an error", status: 400 };
  return json;
}
async function handleMarineForecast(lat, lon) {
  const result = await fetchMarineForecastRaw(lat, lon);
  if (result.error) return jsonResponse(result, result.status || 502);
  return jsonResponse(result);
}

// ---------------------------------------------------------------------
// TRIP LOGGING
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
        wave_ft, wave_ft_source, wave_period_s, wind_kt, wind_kt_source, wind_dir_deg,
        water_temp_f, water_temp_f_source,
        clarity_score, clarity_label, clarity_source, tide_direction, tide_flow_pct, tide_source,
        bait_tier, bait_level, bait_source, moon_phase_name, moon_illumination_pct, moon_source,
        effort_minutes, observed_clarity, method, observed_surf
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      body.beach_id, body.trip_date, body.time_block, body.observed_at ?? null, now, body.notes ?? null,
      body.wave_ft ?? null, body.wave_ft_source ?? null, body.wave_period_s ?? null,
      body.wind_kt ?? null, body.wind_kt_source ?? null, body.wind_dir_deg ?? null,
      body.water_temp_f ?? null, body.water_temp_f_source ?? null,
      body.clarity_score ?? null, body.clarity_label ?? null, body.clarity_source ?? null,
      body.tide_direction ?? null, body.tide_flow_pct ?? null, body.tide_source ?? null,
      body.bait_tier ?? null, body.bait_level ?? null, body.bait_source ?? null,
      body.moon_phase_name ?? null, body.moon_illumination_pct ?? null, body.moon_source ?? null,
      body.effort_minutes ?? null, body.observed_clarity ?? null, body.method ?? null, body.observed_surf ?? null
    ).run();
    const tripId = tripResult.meta.last_row_id;
    for (const obs of body.observations) {
      if (!obs.subject_type || !obs.subject_id) continue;
      await env.TRIPS_DB.prepare(
        `INSERT INTO trip_observations (
          trip_id, subject_type, subject_id, sighted, bit, caught, count, distance_yd_actual,
          predicted_score, predicted_presence, predicted_feeding, predicted_access,
          predicted_zone, predicted_distance_min, predicted_distance_max,
          model_version, confidence, major_positive_factors, major_limiting_factors
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        tripId, obs.subject_type, obs.subject_id,
        obs.sighted ? 1 : 0, obs.subject_type === "species" ? (obs.bit ? 1 : 0) : null, obs.caught ? 1 : 0,
        obs.count ?? null, obs.distance_yd_actual ?? null,
        obs.predicted_score ?? null, obs.predicted_presence ?? null, obs.predicted_feeding ?? null, obs.predicted_access ?? null,
        obs.predicted_zone ?? null, obs.predicted_distance_min ?? null, obs.predicted_distance_max ?? null,
        obs.model_version ?? null, obs.confidence ?? null, obs.major_positive_factors ?? null, obs.major_limiting_factors ?? null
      ).run();
    }
    return jsonResponse({ ok: true, trip_id: tripId });
  } catch (e) { return jsonResponse({ error: `Database write failed: ${e.message}` }, 500); }
}

async function fetchTripsRaw(beachId, env) {
  if (!env.TRIPS_DB) return { trips: [], error: "Trips database is not bound to this Worker (TRIPS_DB binding missing)." };
  try {
    // Priority 15 Stage 2 audit fix — this was an N+1 pattern: 1 query for
    // trips, then 1 more PER trip for its observations (50 trips = 51
    // queries). Replaced with a single JOIN. The inner subquery applies
    // LIMIT 200 to trips BEFORE the join, so the row-multiplication from
    // joining observations never affects which/how-many trips are
    // returned — exactly the same 200-trip cap as before, one query
    // total regardless of how many trips or observations exist.
    const tripFilter = beachId ? "WHERE beach_id = ?" : "";
    const query = `
      SELECT t.id as trip_id, t.beach_id, t.trip_date, t.time_block, t.observed_at, t.logged_at, t.notes,
             t.wave_ft, t.wave_ft_source, t.wave_period_s, t.wind_kt, t.wind_kt_source, t.wind_dir_deg,
             t.water_temp_f, t.water_temp_f_source, t.clarity_score, t.clarity_label, t.clarity_source,
             t.tide_direction, t.tide_flow_pct, t.tide_source, t.bait_tier, t.bait_level, t.bait_source,
             t.moon_phase_name, t.moon_illumination_pct, t.moon_source, t.effort_minutes, t.observed_clarity, t.method, t.observed_surf,
             o.id as obs_id, o.subject_type, o.subject_id, o.sighted, o.bit, o.caught, o.count, o.distance_yd_actual,
             o.predicted_score, o.predicted_presence, o.predicted_feeding, o.predicted_access,
             o.predicted_zone, o.predicted_distance_min, o.predicted_distance_max,
             o.model_version, o.confidence, o.major_positive_factors, o.major_limiting_factors
      FROM (SELECT * FROM trips ${tripFilter} ORDER BY trip_date DESC, id DESC LIMIT 200) t
      LEFT JOIN trip_observations o ON o.trip_id = t.id
      ORDER BY t.trip_date DESC, t.id DESC, o.id`;
    const { results: rows } = beachId ? await env.TRIPS_DB.prepare(query).bind(beachId).all() : await env.TRIPS_DB.prepare(query).all();

    const tripsById = new Map();
    for (const row of rows) {
      let trip = tripsById.get(row.trip_id);
      if (!trip) {
        trip = {
          id: row.trip_id, beach_id: row.beach_id, trip_date: row.trip_date, time_block: row.time_block,
          observed_at: row.observed_at, logged_at: row.logged_at, notes: row.notes,
          wave_ft: row.wave_ft, wave_ft_source: row.wave_ft_source, wave_period_s: row.wave_period_s,
          wind_kt: row.wind_kt, wind_kt_source: row.wind_kt_source, wind_dir_deg: row.wind_dir_deg,
          water_temp_f: row.water_temp_f, water_temp_f_source: row.water_temp_f_source,
          clarity_score: row.clarity_score, clarity_label: row.clarity_label, clarity_source: row.clarity_source,
          tide_direction: row.tide_direction, tide_flow_pct: row.tide_flow_pct, tide_source: row.tide_source,
          bait_tier: row.bait_tier, bait_level: row.bait_level, bait_source: row.bait_source,
          moon_phase_name: row.moon_phase_name, moon_illumination_pct: row.moon_illumination_pct, moon_source: row.moon_source,
          effort_minutes: row.effort_minutes, observed_clarity: row.observed_clarity, method: row.method, observed_surf: row.observed_surf,
          observations: [],
        };
        tripsById.set(row.trip_id, trip);
      }
      if (row.obs_id != null) {
        trip.observations.push({
          id: row.obs_id, trip_id: row.trip_id, subject_type: row.subject_type, subject_id: row.subject_id,
          sighted: row.sighted, bit: row.bit, caught: row.caught, count: row.count, distance_yd_actual: row.distance_yd_actual,
          predicted_score: row.predicted_score, predicted_presence: row.predicted_presence, predicted_feeding: row.predicted_feeding, predicted_access: row.predicted_access,
          predicted_zone: row.predicted_zone, predicted_distance_min: row.predicted_distance_min, predicted_distance_max: row.predicted_distance_max,
          model_version: row.model_version, confidence: row.confidence, major_positive_factors: row.major_positive_factors, major_limiting_factors: row.major_limiting_factors,
        });
      }
    }
    return { trips: [...tripsById.values()] };
  } catch (e) { return { trips: [], error: `Database read failed: ${e.message}` }; }
}
async function handleTripList(url, env) {
  const beachId = url.searchParams.get("beach_id");
  const result = await fetchTripsRaw(beachId, env);
  if (result.error) return jsonResponse({ error: result.error }, 500);
  return jsonResponse(result);
}

// ---------------------------------------------------------------------
// PREDICTION SNAPSHOTS
// ---------------------------------------------------------------------
async function handleSnapshotSave(request, env) {
  if (!env.TRIPS_DB) return jsonResponse({ error: "Trips database is not bound to this Worker (TRIPS_DB binding missing)." }, 500);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Request body must be valid JSON." }, 400); }
  for (const field of ["beach_id", "species_id", "prediction_timestamp", "retrieved_at", "model_version"]) {
    if (!body[field]) return jsonResponse({ error: `Missing required field: ${field}` }, 400);
  }
  try {
    const result = await env.TRIPS_DB.prepare(
      `INSERT INTO prediction_snapshots (
        beach_id, species_id, prediction_timestamp, retrieved_at, model_version,
        presence, feeding, access, final_score, confidence,
        predicted_zone, predicted_distance_min, predicted_distance_max,
        wave_ft, wave_ft_source, wave_period_s, wind_kt, wind_kt_source, wind_dir_deg,
        water_temp_f, water_temp_f_source,
        clarity_score, clarity_label, clarity_source, tide_direction, tide_flow_pct, tide_source,
        bait_tier, bait_level, bait_source, bait_dominant_type, bait_freshness_tier, bait_observed_at_utc, bait_forage_strength,
        moon_phase_name, moon_illumination_pct, moon_source,
        is_future, forecast_grid_id, forecast_grid_x, forecast_grid_y, forecast_update_time,
        major_positive_factors, major_limiting_factors
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      body.beach_id, body.species_id, body.prediction_timestamp, body.retrieved_at, body.model_version,
      body.presence ?? null, body.feeding ?? null, body.access ?? null, body.final_score ?? null, body.confidence ?? null,
      body.predicted_zone ?? null, body.predicted_distance_min ?? null, body.predicted_distance_max ?? null,
      body.wave_ft ?? null, body.wave_ft_source ?? null, body.wave_period_s ?? null,
      body.wind_kt ?? null, body.wind_kt_source ?? null, body.wind_dir_deg ?? null,
      body.water_temp_f ?? null, body.water_temp_f_source ?? null,
      body.clarity_score ?? null, body.clarity_label ?? null, body.clarity_source ?? null,
      body.tide_direction ?? null, body.tide_flow_pct ?? null, body.tide_source ?? null,
      body.bait_tier ?? null, body.bait_level ?? null, body.bait_source ?? null,
      body.bait_dominant_type ?? null, body.bait_freshness_tier ?? null, body.bait_observed_at_utc ?? null, body.bait_forage_strength ?? null,
      body.moon_phase_name ?? null, body.moon_illumination_pct ?? null, body.moon_source ?? null,
      body.is_future ?? null, body.forecast_grid_id ?? null, body.forecast_grid_x ?? null, body.forecast_grid_y ?? null, body.forecast_update_time ?? null,
      body.major_positive_factors ?? null, body.major_limiting_factors ?? null
    ).run();
    return jsonResponse({ ok: true, snapshot_id: result.meta.last_row_id });
  } catch (e) { return jsonResponse({ error: `Database write failed: ${e.message}` }, 500); }
}
async function handleSnapshotList(url, env) {
  if (!env.TRIPS_DB) return jsonResponse({ error: "Trips database is not bound to this Worker (TRIPS_DB binding missing)." }, 500);
  const beachId = url.searchParams.get("beach_id");
  const speciesId = url.searchParams.get("species_id");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
  let query = "SELECT * FROM prediction_snapshots";
  const conditions = [], binds = [];
  if (beachId) { conditions.push("beach_id = ?"); binds.push(beachId); }
  if (speciesId) { conditions.push("species_id = ?"); binds.push(speciesId); }
  if (conditions.length) query += " WHERE " + conditions.join(" AND ");
  query += " ORDER BY id DESC LIMIT ?";
  binds.push(limit);
  try {
    const { results } = await env.TRIPS_DB.prepare(query).bind(...binds).all();
    return jsonResponse({ snapshots: results });
  } catch (e) { return jsonResponse({ error: `Database read failed: ${e.message}` }, 500); }
}

// ===========================================================================
// PRIORITY 13D — REGIONAL FORAGE VALIDATION HARNESS
// ===========================================================================
const FORAGE_EXTRACTOR_VERSION = "BFR_FORAGE_EXTRACTOR_LLM_V2";
const FORAGE_SOURCES_CONFIG = {
  spacefish: { regionId: "space-coast", homepageUrl: "https://spacefish.com/" },
  sitd: { regionId: "sebastian", homepageUrl: "https://www.sitd.us/our-world-famous-fishing-report" },
  junobait: { regionId: "palm-beach-north", homepageUrl: "https://junobait.substack.com/archive" },
};
function forageNow() { return new Date().toISOString(); }
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "BeachFishingRadarProxy (research/validation)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}
async function recordSourceFailure(env, sourceId, reason) {
  await env.TRIPS_DB.prepare(`UPDATE forage_source_health SET last_check_at=?, last_failure_at=?, last_failure_reason=? WHERE source_id=?`)
    .bind(forageNow(), forageNow(), reason, sourceId).run();
}
function requireForageAuth(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!env.FORAGE_DEV_TOKEN || token !== env.FORAGE_DEV_TOKEN) return jsonResponse({ error: "Unauthorized. Pass 'Authorization: Bearer <FORAGE_DEV_TOKEN>'." }, 401);
  return null;
}

function findAnchors(html, hrefPrefix) {
  const results = []; const tagRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi; let m;
  while ((m = tagRe.exec(html))) {
    const hrefMatch = m[1].match(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (!hrefMatch) continue;
    const href = hrefMatch[1] ?? hrefMatch[2];
    if (!href || !href.startsWith(hrefPrefix)) continue;
    results.push({ href: href.split("#")[0].split("?")[0], innerHtml: m[2] });
  }
  return results;
}
function findMetaContent(html, propertyValue) {
  const tagRe = /<meta\b([^>]*)>/gi; let m;
  while ((m = tagRe.exec(html))) {
    const propMatch = m[1].match(/(?:property|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const prop = propMatch ? (propMatch[1] ?? propMatch[2]) : null;
    if (prop !== propertyValue) continue;
    const contentMatch = m[1].match(/content\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (contentMatch) return contentMatch[1] ?? contentMatch[2];
  }
  return null;
}
function findElementByClass(html, tagName, classSubstring) {
  const openRe = new RegExp(`<${tagName}\\b([^>]*)>`, "gi"); let m;
  while ((m = openRe.exec(html))) {
    const classMatch = m[1].match(/class\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const classAttr = classMatch ? (classMatch[1] ?? classMatch[2]) : "";
    if (!classAttr.split(/\s+/).some((c) => c === classSubstring)) continue;
    let depth = 1, pos = openRe.lastIndex;
    const walkRe = new RegExp(`<${tagName}\\b[^>]*>|<\\/${tagName}>`, "gi"); walkRe.lastIndex = pos;
    let cm;
    while ((cm = walkRe.exec(html))) {
      if (cm[0].startsWith("</")) { depth--; if (depth === 0) return html.slice(pos, cm.index); }
      else depth++;
    }
    return null;
  }
  return null;
}
function stripHtmlTags(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#8217;/g, "'").replace(/&#8220;|&#8221;/g, '"')
    .replace(/\s+/g, " ").trim();
}
function resolveUrl(maybeRelative, baseUrl) { try { return new URL(maybeRelative, baseUrl).toString(); } catch { return null; } }

function extractSpacefishArticle(html) {
  const publishedAt = findMetaContent(html, "article:published_time") || findMetaContent(html, "og:updated_time");
  const title = findMetaContent(html, "og:title");
  const contentHtml = findElementByClass(html, "div", "entry-content");
  return { title, publishedAt, body: contentHtml ? stripHtmlTags(contentHtml) : null };
}
function extractSitdArticle(html) {
  return { title: findMetaContent(html, "og:title"), publishedAt: findMetaContent(html, "article:published_time"), body: null };
}
function extractJunoBaitArticle(html) {
  const publishedAt = findMetaContent(html, "article:published_time");
  const title = findMetaContent(html, "og:title");
  const contentHtml = findElementByClass(html, "div", "available-content");
  return { title, publishedAt, body: contentHtml ? stripHtmlTags(contentHtml) : null };
}
function discoverSpacefishArticles(html, baseUrl) {
  const seen = new Set(), out = [];
  for (const a of findAnchors(html, "https://spacefish.com/byte/")) { const u = resolveUrl(a.href, baseUrl); if (u && !seen.has(u)) { seen.add(u); out.push({ url: u }); } }
  return out;
}
function discoverSitdArticles(html, baseUrl) {
  const seen = new Set(), out = [];
  for (const a of findAnchors(html, "https://www.sitd.us/")) {
    const linkText = stripHtmlTags(a.innerHtml), u = resolveUrl(a.href, baseUrl);
    if (u && !seen.has(u) && /week of|fishing report|mullet|inlet fishing/i.test(linkText)) { seen.add(u); out.push({ url: u, title: linkText }); }
  }
  return out;
}
function discoverJunoBaitArticles(html, baseUrl) {
  const seen = new Set(), out = [];
  for (const a of findAnchors(html, "https://junobait.substack.com/p/")) { const u = resolveUrl(a.href, baseUrl); if (u && !seen.has(u)) { seen.add(u); out.push({ url: u }); } }
  return out;
}
const SOURCE_ADAPTERS = {
  spacefish: { discover: discoverSpacefishArticles, extractArticle: extractSpacefishArticle },
  sitd: { discover: discoverSitdArticles, extractArticle: extractSitdArticle },
  junobait: { discover: discoverJunoBaitArticles, extractArticle: extractJunoBaitArticle },
};

const FORAGE_EXTRACTION_SYSTEM_PROMPT = `You are a strict information-extraction tool for Florida surf-fishing reports. Your ONLY job is to extract forage/baitfish observations that are EXPLICITLY STATED in the article text. You are NOT a fishing expert and must NOT use fishing knowledge to fill gaps.

Extract zero or more observations, one per distinct claim. For each, output an object with exactly these fields:
- forageType: one of "mullet" | "menhaden" | "glass_minnows" | "pilchards" | "anchovies" | "sand_fleas" | "shrimp" | "general_baitfish"
- presence: "present" | "scarce" | "absent" | "unknown"
- concentration: "heavy" | "moderate" | "light" | null
- movement: "southbound" | "northbound" | "moving_through" | "stationary" | null
- trend: "increasing" | "stable" | "declining" | null
- temporalScope: "current_or_recent" | "future_expectation" | "historical" | "generic_advice"
- locationText: string or null (only if explicitly stated or established by a document section heading)
- supportingQuote: the exact minimal substring of the article text that supports this observation (must be verbatim)
- extractionConfidence: "high" | "moderate" | "low"

STRICT PROHIBITIONS — never infer bait from predator activity, never convert future/conditional language into "current_or_recent", never convert historical language into "current_or_recent", never convert fishing advice or bait-shop availability into an observation unless the same clause also contains a genuine current observation, never invent a location, never apply seasonal knowledge as if it were a report. When uncertain, prefer "generic_advice" or "low" confidence over guessing. Output ONLY a JSON array, nothing else.`;

async function callAnthropicExtractor(env, articleText, articleTitle) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": env.FORAGE_LLM_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: env.FORAGE_LLM_MODEL || "claude-sonnet-4-6", max_tokens: 1500, temperature: 0,
      system: FORAGE_EXTRACTION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `ARTICLE TITLE: ${articleTitle || "(none)"}\n\nARTICLE TEXT:\n${articleText}` }],
    }),
  });
  if (!res.ok) throw new Error(`LLM provider HTTP ${res.status}`);
  const json = await res.json();
  return { rawResponseText: (json.content || []).map((b) => b.text || "").join(""), model: env.FORAGE_LLM_MODEL || "claude-sonnet-4-6" };
}
const VALID_FORAGE_TYPES = ["mullet","menhaden","glass_minnows","pilchards","anchovies","sand_fleas","shrimp","general_baitfish"];
const VALID_PRESENCE = ["present","scarce","absent","unknown"];
const VALID_CONCENTRATION = ["heavy","moderate","light",null];
const VALID_MOVEMENT = ["southbound","northbound","moving_through","stationary",null];
const VALID_TREND = ["increasing","stable","declining",null];
const VALID_TEMPORAL = ["current_or_recent","future_expectation","historical","generic_advice"];
const VALID_CONFIDENCE = ["high","moderate","low"];
function validateExtraction(obj, articleRawText) {
  const errors = [];
  if (!VALID_FORAGE_TYPES.includes(obj.forageType)) errors.push("unsupported forageType");
  if (!VALID_PRESENCE.includes(obj.presence)) errors.push("unsupported presence");
  if (!VALID_CONCENTRATION.includes(obj.concentration)) errors.push("unsupported concentration");
  if (!VALID_MOVEMENT.includes(obj.movement)) errors.push("unsupported movement");
  if (!VALID_TREND.includes(obj.trend)) errors.push("unsupported trend");
  if (!VALID_TEMPORAL.includes(obj.temporalScope)) errors.push("missing/unsupported temporalScope");
  if (!VALID_CONFIDENCE.includes(obj.extractionConfidence)) errors.push("unsupported extractionConfidence");
  if (!obj.supportingQuote || typeof obj.supportingQuote !== "string") errors.push("missing supportingQuote");
  const schemaValid = errors.length === 0;
  const quoteValid = schemaValid && articleRawText.includes(obj.supportingQuote);
  if (schemaValid && !quoteValid) errors.push("supportingQuote not found verbatim");
  return { schemaValid, quoteValid, errors };
}

async function discoverAndStoreArticles(env, sourceId) {
  const config = FORAGE_SOURCES_CONFIG[sourceId];
  const adapter = SOURCE_ADAPTERS[sourceId];
  await env.TRIPS_DB.prepare(`UPDATE forage_source_health SET last_check_at=? WHERE source_id=?`).bind(forageNow(), sourceId).run();
  let homepageHtml;
  try { homepageHtml = await fetchText(config.homepageUrl); }
  catch (e) { await recordSourceFailure(env, sourceId, `homepage fetch failed: ${e.message}`); return { discovered: 0, error: e.message }; }
  await env.TRIPS_DB.prepare(`UPDATE forage_source_health SET last_successful_fetch_at=? WHERE source_id=?`).bind(forageNow(), sourceId).run();
  const candidates = adapter.discover(homepageHtml, config.homepageUrl);
  if (candidates.length === 0) { await recordSourceFailure(env, sourceId, "zero articles discovered -- adapter likely wrong, NOT evidence of no bait activity"); return { discovered: 0 }; }
  let newArticles = 0, newRevisions = 0;
  for (const candidate of candidates) {
    let article = await env.TRIPS_DB.prepare(`SELECT * FROM forage_source_articles WHERE article_url = ?`).bind(candidate.url).first();
    if (!article) {
      const ins = await env.TRIPS_DB.prepare(`INSERT INTO forage_source_articles (source_id, article_url, region_id, title, published_at, discovered_at) VALUES (?,?,?,?,?,?)`)
        .bind(sourceId, candidate.url, config.regionId, candidate.title || null, null, forageNow()).run();
      article = { id: ins.meta.last_row_id }; newArticles++;
    }
    let fetchStatus, body = null, publishedAt = null, title = candidate.title || null;
    try {
      const html = await fetchText(candidate.url);
      const ex = adapter.extractArticle(html);
      body = ex.body; publishedAt = ex.publishedAt; title = ex.title || title;
      fetchStatus = body ? "ok" : "parse_failed";
    } catch { fetchStatus = "fetch_failed"; }
    const hash = await sha256Hex(body || candidate.url);
    const existingRev = await env.TRIPS_DB.prepare(`SELECT id FROM forage_article_revisions WHERE article_id = ? AND content_hash = ?`).bind(article.id, hash).first();
    if (existingRev) continue;
    await env.TRIPS_DB.prepare(`INSERT INTO forage_article_revisions (article_id, fetched_at, raw_text, content_hash, fetch_status, extraction_status) VALUES (?,?,?,?,?,?)`)
      .bind(article.id, forageNow(), body || "", hash, fetchStatus, fetchStatus === "ok" ? "awaiting_extraction" : "not_applicable").run();
    newRevisions++;
    if (publishedAt || title) await env.TRIPS_DB.prepare(`UPDATE forage_source_articles SET published_at = COALESCE(published_at, ?), title = COALESCE(title, ?) WHERE id = ?`).bind(publishedAt, title, article.id).run();
    if (fetchStatus === "ok") await env.TRIPS_DB.prepare(`UPDATE forage_source_health SET last_article_discovered_at=? WHERE source_id=?`).bind(forageNow(), sourceId).run();
  }
  return { discovered: candidates.length, newArticles, newRevisions };
}

async function extractPendingArticles(env, limit = 10) {
  if (!env.FORAGE_LLM_API_KEY) return { extracted: 0, skipped: "no FORAGE_LLM_API_KEY configured" };
  const { results: pending } = await env.TRIPS_DB.prepare(
    `SELECT r.*, a.source_id, a.region_id, a.title FROM forage_article_revisions r JOIN forage_source_articles a ON r.article_id = a.id
     WHERE r.extraction_status = 'awaiting_extraction' AND r.fetch_status = 'ok' LIMIT ?`
  ).bind(limit).all();
  let processed = 0;
  for (const revision of pending) {
    const startedAt = forageNow();
    let llmResult, runStatus = "success", errorMsg = null, observations = null;
    try { llmResult = await callAnthropicExtractor(env, revision.raw_text, revision.title); }
    catch (e) { runStatus = "provider_error"; errorMsg = e.message; }
    if (runStatus === "success") {
      try {
        const cleaned = llmResult.rawResponseText.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
        observations = JSON.parse(cleaned);
        if (!Array.isArray(observations)) throw new Error("not an array");
      } catch (e) { runStatus = "invalid_json"; errorMsg = e.message; }
    }
    const runRes = await env.TRIPS_DB.prepare(
      `INSERT INTO forage_extraction_runs (article_revision_id, provider, model, extractor_version, started_at, completed_at, status, raw_response, observation_count, valid_observation_count, error) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(revision.id, "anthropic", llmResult?.model || (env.FORAGE_LLM_MODEL || "claude-sonnet-4-6"), FORAGE_EXTRACTOR_VERSION, startedAt, forageNow(), runStatus, llmResult?.rawResponseText ?? null, observations?.length ?? null, null, errorMsg).run();
    const runId = runRes.meta.last_row_id;
    if (runStatus !== "success") {
      await env.TRIPS_DB.prepare(`UPDATE forage_article_revisions SET extraction_status='extraction_failed' WHERE id=?`).bind(revision.id).run();
      await recordSourceFailure(env, revision.source_id, `${runStatus}: ${errorMsg}`);
      processed++; continue;
    }
    let validCount = 0;
    for (const obs of observations) {
      const { schemaValid, quoteValid, errors } = validateExtraction(obs, revision.raw_text);
      if (schemaValid && quoteValid) validCount++;
      await env.TRIPS_DB.prepare(
        `INSERT INTO forage_extractions (article_revision_id, run_id, source_id, region_id, provider, model, extractor_version, extracted_at, forage_type, presence, concentration, movement, trend, temporal_scope, location_text, supporting_quote, extraction_confidence, quote_valid, schema_valid, raw_json, rejection_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(revision.id, runId, revision.source_id, revision.region_id, "anthropic", llmResult.model, FORAGE_EXTRACTOR_VERSION, forageNow(),
        obs.forageType ?? null, obs.presence ?? null, obs.concentration ?? null, obs.movement ?? null, obs.trend ?? null, obs.temporalScope ?? null,
        obs.locationText ?? null, obs.supportingQuote ?? null, obs.extractionConfidence ?? null, quoteValid ? 1 : 0, schemaValid ? 1 : 0, JSON.stringify(obs), errors.length ? errors.join("; ") : null).run();
    }
    await env.TRIPS_DB.prepare(`UPDATE forage_extraction_runs SET valid_observation_count=? WHERE id=?`).bind(validCount, runId).run();
    const newStatus = observations.length === 0 ? "extracted_no_evidence" : validCount > 0 ? "extracted_valid" : "extracted_quarantined";
    await env.TRIPS_DB.prepare(`UPDATE forage_article_revisions SET extraction_status=? WHERE id=?`).bind(newStatus, revision.id).run();
    await env.TRIPS_DB.prepare(`UPDATE forage_source_health SET last_successful_extraction_at=? WHERE source_id=?`).bind(forageNow(), revision.source_id).run();
    processed++;
  }
  return { processed, checked: pending.length };
}

async function handleForageCheckSources(env) {
  const results = {};
  for (const sourceId of Object.keys(FORAGE_SOURCES_CONFIG)) results[sourceId] = await discoverAndStoreArticles(env, sourceId);
  return jsonResponse({ ok: true, results });
}
async function handleForageExtractPending(env) { return jsonResponse({ ok: true, ...(await extractPendingArticles(env)) }); }
async function handleForageHealth(env) { const { results } = await env.TRIPS_DB.prepare(`SELECT * FROM forage_source_health`).all(); return jsonResponse({ health: results }); }
async function handleForageDebugSource(request, env) {
  const body = await request.json();
  const sourceId = body.sourceId;
  if (!FORAGE_SOURCES_CONFIG[sourceId]) return jsonResponse({ error: "Unknown sourceId: " + Object.keys(FORAGE_SOURCES_CONFIG).join(", ") }, 400);
  const config = FORAGE_SOURCES_CONFIG[sourceId];
  const res = await fetch(config.homepageUrl, { headers: { "User-Agent": "BeachFishingRadarProxy (research/validation)" } });
  const text = await res.text();
  const candidates = SOURCE_ADAPTERS[sourceId].discover(text, config.homepageUrl);
  return jsonResponse({ sourceId, homepageUrl: config.homepageUrl, httpStatus: res.status, contentType: res.headers.get("content-type"), responseBytes: text.length, candidateArticleCount: candidates.length, discoveredUrls: candidates.slice(0, 3).map((c) => c.url), rawResponse: text });
}
async function handleForageDebugRevision(request, env) {
  const body = await request.json();
  const revision = await env.TRIPS_DB.prepare(`SELECT * FROM forage_article_revisions WHERE id = ?`).bind(body.revisionId).first();
  if (!revision) return jsonResponse({ error: "Unknown revisionId" }, 404);
  return jsonResponse({ revision });
}
async function handleForagePendingReview(env, url) {
  const filter = url.searchParams.get("filter") || "unreviewed";
  const source = url.searchParams.get("source");
  let query = `SELECT e.*, a.title, a.article_url, a.published_at, a.region_id as article_region
    FROM forage_extractions e
    JOIN forage_article_revisions rev ON e.article_revision_id = rev.id
    JOIN forage_source_articles a ON rev.article_id = a.id
    LEFT JOIN forage_extraction_reviews r ON r.extraction_id = e.id
    WHERE e.schema_valid = 1 AND e.quote_valid = 1`;
  const binds = [];
  if (filter === "unreviewed") query += ` AND r.id IS NULL`;
  if (source) { query += ` AND e.source_id = ?`; binds.push(source); }
  query += ` ORDER BY e.id DESC LIMIT 50`;
  const { results } = await env.TRIPS_DB.prepare(query).bind(...binds).all();
  const { results: countRows } = await env.TRIPS_DB.prepare(
    `SELECT COUNT(*) as c FROM forage_extractions e LEFT JOIN forage_extraction_reviews r ON r.extraction_id = e.id WHERE e.schema_valid=1 AND e.quote_valid=1 AND r.id IS NULL`
  ).all();
  return jsonResponse({ extractions: results, unreviewedCount: countRows[0]?.c ?? 0 });
}
async function handleForageSubmitReview(request, env) {
  const body = await request.json();
  if (!body.extractionId && !body.articleRevisionId) return jsonResponse({ error: "extractionId or articleRevisionId required" }, 400);
  let articleRevisionId = body.articleRevisionId;
  if (body.extractionId) {
    const ex = await env.TRIPS_DB.prepare(`SELECT article_revision_id FROM forage_extractions WHERE id=?`).bind(body.extractionId).first();
    articleRevisionId = ex?.article_revision_id;
  }
  await env.TRIPS_DB.prepare(
    `INSERT INTO forage_extraction_reviews (extraction_id, article_revision_id, reviewed_at, review_type, overall_correct, truth_forage_type, truth_presence, truth_concentration, truth_movement, truth_trend, truth_temporal_scope, truth_location_text, truth_supporting_quote, reviewer_notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(body.extractionId ?? null, articleRevisionId, forageNow(), body.extractionId ? "extraction_review" : "missed_evidence",
    body.overallCorrect ?? null, body.truthForageType ?? null, body.truthPresence ?? null, body.truthConcentration ?? null,
    body.truthMovement ?? null, body.truthTrend ?? null, body.truthTemporalScope ?? null, body.truthLocationText ?? null, body.truthSupportingQuote ?? null, body.notes ?? null).run();
  return jsonResponse({ ok: true });
}
async function handleForageMarkFullyReviewed(request, env) {
  const body = await request.json();
  await env.TRIPS_DB.prepare(`INSERT INTO forage_article_review_status (article_revision_id, fully_reviewed, fully_reviewed_at) VALUES (?, 1, ?) ON CONFLICT(article_revision_id) DO UPDATE SET fully_reviewed=1, fully_reviewed_at=?`)
    .bind(body.articleRevisionId, forageNow(), forageNow()).run();
  return jsonResponse({ ok: true });
}
async function handleForageMetrics(env, url) {
  const confidenceFilter = url.searchParams.get("confidence");
  let query = `SELECT r.*, e.presence as ai_presence, e.temporal_scope as ai_temporal_scope, e.concentration as ai_concentration, e.movement as ai_movement, e.trend as ai_trend, e.location_text as ai_location_text, e.extraction_confidence, e.source_id
    FROM forage_extraction_reviews r JOIN forage_extractions e ON r.extraction_id = e.id WHERE r.review_type = 'extraction_review'`;
  if (confidenceFilter === "high") query += ` AND e.extraction_confidence = 'high'`;
  const { results: reviews } = await env.TRIPS_DB.prepare(query).all();
  const aiCurrentPresent = reviews.filter((r) => r.ai_presence === "present" && r.ai_temporal_scope === "current_or_recent");
  const currentPresencePrecision = aiCurrentPresent.length ? { precision: aiCurrentPresent.filter((r) => r.truth_presence === "present" && r.truth_temporal_scope === "current_or_recent").length / aiCurrentPresent.length, n: aiCurrentPresent.length } : null;
  const dangerousFP = {
    futureToCurrent: aiCurrentPresent.filter((r) => r.truth_temporal_scope === "future_expectation").length,
    historicalToCurrent: aiCurrentPresent.filter((r) => r.truth_temporal_scope === "historical").length,
    adviceToCurrent: aiCurrentPresent.filter((r) => r.truth_temporal_scope === "generic_advice").length,
  };
  function fieldAccuracy(aiKey, truthKey) {
    const withTruth = reviews.filter((r) => r[truthKey] != null);
    if (withTruth.length === 0) return null;
    return { accuracy: withTruth.filter((r) => r[truthKey] === r[aiKey]).length / withTruth.length, n: withTruth.length };
  }
  return jsonResponse({
    confidenceFilter: confidenceFilter || "high+moderate", totalReviewed: reviews.length, currentPresencePrecision, dangerousFalsePositives: dangerousFP,
    temporalScopeAccuracy: fieldAccuracy("ai_temporal_scope", "truth_temporal_scope"), concentrationAccuracy: fieldAccuracy("ai_concentration", "truth_concentration"),
    movementAccuracy: fieldAccuracy("ai_movement", "truth_movement"), trendAccuracy: fieldAccuracy("ai_trend", "truth_trend"), locationAccuracy: fieldAccuracy("ai_location_text", "truth_location_text"),
  });
}
function forageReviewUiHtml() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Forage Review</title>
  <style>body{font-family:system-ui;max-width:700px;margin:20px auto;background:#0a0f14;color:#dce8ee}
  .card{background:#0f1720;border:1px solid #1f3444;border-radius:8px;padding:14px;margin-bottom:12px}
  .meta{color:#7590a0;font-size:12px;margin-bottom:8px} .quote{background:#070d14;padding:8px;border-radius:4px;font-style:italic;margin:8px 0}
  .field{display:inline-block;margin-right:10px;font-size:13px} button{padding:6px 14px;border-radius:4px;border:none;cursor:pointer;margin-right:6px}
  .correct{background:#17d9c4;color:#000} .incorrect{background:#ff6b6b;color:#000} #count{color:#f5a623}
  input{background:#070d14;color:#dce8ee;border:1px solid #1f3444;padding:3px;margin:2px}</style></head>
  <body><h2>Forage Extraction Review</h2>
  <div><label>Dev token: <input id="token" type="password"></label> <button onclick="load()">Load</button></div>
  <div id="count">Not loaded</div><div id="list"></div>
  <script>
  function authHeaders(){return {'Authorization':'Bearer '+document.getElementById('token').value};}
  function el(tag,props,children){const n=document.createElement(tag);if(props)for(const k in props){if(k==='style')n.style.cssText=props[k];else n[k]=props[k];}for(const c of (children||[]))n.appendChild(typeof c==='string'?document.createTextNode(c):c);return n;}
  async function load(){
    const res=await fetch('/forage/review/pending?filter=unreviewed',{headers:authHeaders()});
    const data=await res.json();
    document.getElementById('count').textContent=(data.unreviewedCount??'?')+' awaiting review';
    const list=document.getElementById('list'); list.innerHTML='';
    for(const e of (data.extractions||[])) list.appendChild(buildCard(e));
  }
  function buildCard(e){
    const card=el('div',{className:'card'});
    const meta=el('div',{className:'meta'});
    meta.append(document.createTextNode((e.source_id||'')+' | '+(e.published_at||'unknown date')+' | '+(e.article_region||'')+' | '));
    if(typeof e.article_url==='string'&&e.article_url.startsWith('https://')) meta.appendChild(el('a',{href:e.article_url,target:'_blank',style:'color:#3e8fff'},[e.title||e.article_url]));
    card.appendChild(meta);
    card.appendChild(el('div',{className:'quote'},[e.supporting_quote||'']));
    for(const v of [e.forage_type,e.presence,e.concentration||'-',e.movement||'-',e.trend||'-',e.temporal_scope,e.location_text||'no location',e.extraction_confidence+' confidence'])
      card.appendChild(el('span',{className:'field'},[String(v)]));
    card.appendChild(document.createElement('br'));
    const showForm=(prefill)=>{
      const form=el('div',{});
      const fieldMap=[['forageType','forage_type'],['presence','presence'],['concentration','concentration'],['movement','movement'],['trend','trend'],['temporalScope','temporal_scope'],['locationText','location_text']];
      const inputs={};
      for(const [key,aiField] of fieldMap){const input=el('input',{value:e[aiField]||''});inputs[key]=input;form.appendChild(el('div',{},[key+': ',input]));}
      const notes=el('input',{placeholder:'notes'}); form.appendChild(el('div',{},['notes: ',notes]));
      const submit=el('button',{className:prefill?'correct':'incorrect'},[prefill?'Submit as correct':'Submit correction']);
      submit.onclick=()=>review(e.id,prefill?1:0,{truthForageType:inputs.forageType.value||null,truthPresence:inputs.presence.value||null,truthConcentration:inputs.concentration.value||null,truthMovement:inputs.movement.value||null,truthTrend:inputs.trend.value||null,truthTemporalScope:inputs.temporalScope.value||null,truthLocationText:inputs.locationText.value||null,truthSupportingQuote:e.supporting_quote,notes:notes.value||null});
      form.appendChild(submit); card.appendChild(form);
    };
    const correctBtn=el('button',{className:'correct'},['Correct']); correctBtn.onclick=()=>{card.querySelectorAll('button').forEach(b=>b.remove());showForm(true);};
    const incorrectBtn=el('button',{className:'incorrect'},['Incorrect']); incorrectBtn.onclick=()=>{card.querySelectorAll('button').forEach(b=>b.remove());showForm(false);};
    card.appendChild(correctBtn); card.appendChild(incorrectBtn);
    return card;
  }
  async function review(id,overallCorrect,truth){
    await fetch('/forage/review/submit',{method:'POST',headers:{'Content-Type':'application/json',...authHeaders()},body:JSON.stringify({extractionId:id,overallCorrect,...truth})});
    load();
  }
  </script></body></html>`;
}
async function forageScheduledHandler(env) {
  for (const sourceId of Object.keys(FORAGE_SOURCES_CONFIG)) await discoverAndStoreArticles(env, sourceId);
  await extractPendingArticles(env, 10);
}

// ===========================================================================
// PUBLIC FORAGE EVIDENCE ENDPOINT (informational surface) — public, no auth.
// ===========================================================================
const FORAGE_BEACH_REGION_MAP = {
  "cocoa-beach": "space-coast", "melbourne-beach": "space-coast",
  "vero-beach": "sebastian", "fort-pierce": "sebastian",
  "juno-beach": "palm-beach-north", "jupiter-beach": "palm-beach-north", "palm-beach": "palm-beach-north",
};
const FORAGE_REGION_DISPLAY_NAMES = { "space-coast": "Space Coast", "sebastian": "Sebastian", "palm-beach-north": "Palm Beach North" };
const FORAGE_SOURCE_DISPLAY_NAMES = { spacefish: "Spacefish", sitd: "Sebastian Inlet District", junobait: "Juno Bait" };
function computeForageFreshnessLabel(publishedAt) {
  if (!publishedAt) return null;
  const hrs = (Date.now() - new Date(publishedAt).getTime()) / 3600000;
  if (hrs < 0 || hrs > 168) return null;
  if (hrs < 1) return "reported under 1h ago";
  if (hrs <= 48) return `reported ${Math.round(hrs)}h ago`;
  return `reported ${Math.round(hrs / 24)} days ago`;
}
async function handleForageEvidence(url, env) {
  const beachId = url.searchParams.get("beachId");
  if (!beachId) return jsonResponse({ error: "beachId required" }, 400);
  const regionId = FORAGE_BEACH_REGION_MAP[beachId];
  if (!regionId) return jsonResponse({ supported: false, evidence: [] });
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const { results } = await env.TRIPS_DB.prepare(`
    SELECT e.id, e.forage_type, e.presence, e.concentration, e.movement, e.trend, e.temporal_scope,
           e.location_text, e.supporting_quote, e.extraction_confidence,
           a.article_url, a.published_at, a.source_id,
           rv.overall_correct, rv.truth_forage_type, rv.truth_presence, rv.truth_concentration,
           rv.truth_movement, rv.truth_trend, rv.truth_temporal_scope, rv.truth_location_text, rv.truth_supporting_quote
    FROM forage_extractions e
    JOIN forage_article_revisions rev ON e.article_revision_id = rev.id
    JOIN forage_source_articles a ON rev.article_id = a.id
    LEFT JOIN (
      SELECT r1.* FROM forage_extraction_reviews r1
      WHERE r1.review_type = 'extraction_review'
        AND r1.id = (
          SELECT r2.id FROM forage_extraction_reviews r2
          WHERE r2.extraction_id = r1.extraction_id AND r2.review_type = 'extraction_review'
          ORDER BY r2.reviewed_at DESC, r2.id DESC LIMIT 1
        )
    ) rv ON rv.extraction_id = e.id
    WHERE e.region_id = ?
      AND e.schema_valid = 1 AND e.quote_valid = 1
      AND e.extraction_confidence IN ('high', 'moderate')
      AND a.published_at IS NOT NULL AND a.published_at >= ?
    ORDER BY a.published_at DESC
  `).bind(regionId, sevenDaysAgo).all();
  const seen = new Set();
  const evidence = [];
  for (const row of results) {
    const hasReview = row.overall_correct !== null && row.overall_correct !== undefined;
    const isIncorrect = row.overall_correct === 0;
    if (isIncorrect && !row.truth_forage_type) continue;
    const eff = hasReview
      ? { forageType: row.truth_forage_type, presence: row.truth_presence, concentration: row.truth_concentration,
          movement: row.truth_movement, trend: row.truth_trend, temporalScope: row.truth_temporal_scope,
          locationText: row.truth_location_text, supportingQuote: row.truth_supporting_quote || row.supporting_quote }
      : { forageType: row.forage_type, presence: row.presence, concentration: row.concentration,
          movement: row.movement, trend: row.trend, temporalScope: row.temporal_scope,
          locationText: row.location_text, supportingQuote: row.supporting_quote };
    if (eff.temporalScope !== "current_or_recent") continue;
    if (!VALID_FORAGE_TYPES.includes(eff.forageType)) continue;
    if (!VALID_PRESENCE.includes(eff.presence)) continue;
    const dedupeKey = `${row.article_url}|${eff.forageType}|${eff.presence}|${eff.concentration}|${eff.movement}|${eff.trend}|${eff.locationText}|${eff.supportingQuote}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const freshnessLabel = computeForageFreshnessLabel(row.published_at);
    if (!freshnessLabel) continue;
    evidence.push({
      forageType: eff.forageType, presence: eff.presence, concentration: eff.concentration,
      movement: eff.movement, trend: eff.trend, locationText: eff.locationText,
      supportingQuote: eff.supportingQuote,
      sourceName: FORAGE_SOURCE_DISPLAY_NAMES[row.source_id] || row.source_id,
      region: FORAGE_REGION_DISPLAY_NAMES[regionId] || regionId,
      publishedAt: row.published_at, freshnessLabel, articleUrl: row.article_url,
      reviewStatus: hasReview ? "human_reviewed" : "ai_extracted",
    });
  }
  return jsonResponse({ supported: true, regionId, evidence: evidence.slice(0, 10) });
}

// ===========================================================================
// PRIORITY 15 STAGE 2 — Worker dataAccess + developer parity test endpoint.
//
// CALL SCOPE — measured, not estimated (see Stage 2 audit report): call
// buildWorkerDataAccess(env) ONCE per whole issuance and reuse the same
// object across every beach/species/horizon in that issuance, NOT once
// per beach. Real 24-beach x 10-species x 7-horizon trace: per-beach
// scope = 192 real upstream fetches; issuance-wide scope = 128 (33%
// fewer) -- buoy fetches alone drop from 48 to 14 (71%) because multiple
// beaches genuinely share the same NDBC station. Trips/forecast show no
// difference (keyed per-beach by design, no cross-beach sharing possible
// with the current key shape). The dev/predict-parity endpoint below
// still calls this once per single-prediction request, which is correct
// for that narrow use — the "once per issuance" guidance applies once
// Stage 3 builds the real multi-beach issuance loop.
// ===========================================================================
function buildWorkerDataAccess(env) {
  const cache = new Map();
  async function cached(key, fn) {
    if (cache.has(key)) return cache.get(key);
    // Priority 15 Stage 2 audit fix — a rejected fn() would previously
    // stay cached for the rest of the issuance, permanently poisoning
    // that key even after a transient failure (e.g. one dropped NOAA
    // request). Now the key is removed on rejection so a later call with
    // the same key gets a genuine retry; the CURRENT caller still sees
    // the original rejection (re-thrown, not swallowed).
    const promise = fn().catch((err) => { cache.delete(key); throw err; });
    cache.set(key, promise);
    return promise;
  }
  return {
    fetchTideHistoryDay: (stationId, dateCompactStr) => cached(`tide:${stationId}:${dateCompactStr}`, async () => {
      const r = await fetchTideHistoryForDate(stationId, dateCompactStr);
      if (!r.ok) return [];
      const rows = normalizeNoaaTideRows(r.body?.predictions);
      return normalizeObservations({
        rows, stationId, stationName: NOAA_STATIONS[stationId]?.stationName,
        product: "predictions", parameter: "tide_height", unit: "ft", datum: "MLLW",
        sourceType: "official_prediction", reliability: 90, retrievedAt: new Date().toISOString(),
      });
    }),
    fetchBuoyHistoryDay: (stationId, dateCompactStr) => cached(`buoy:${stationId}:${dateCompactStr}`, async () => {
      const { rows } = await fetchNdbcRowsForDate(stationId, dateCompactStr);
      return (rows || []).map(convertNdbcRowToImperial);
    }),
    fetchWeatherHistoryDay: (stationId, dateCompactStr) => cached(`weather:${stationId}:${dateCompactStr}`, async () => {
      const { rows } = await fetchMetarRowsForDate(stationId, dateCompactStr);
      return rows || [];
    }),
    fetchForecastForBeach: (beach) => cached(`forecast:${beach.id}`, () => fetchForecastGridpointRaw(beach.lat, beach.lon)),
    fetchMarineForecastForBeach: (beach) => cached(`marine:${beach.id}`, () => fetchMarineForecastRaw(beach.lat, beach.lon)),
    fetchTripsList: (beachId) => cached(`trips:${beachId || "all"}`, () => fetchTripsRaw(beachId, env)),
  };
}

async function handleDevPredictParity(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Request body must be valid JSON." }, 400); }
  const { beachId, lat, lon, speciesId, timestamp } = body;
  if (!beachId || lat == null || lon == null || !speciesId || !timestamp) {
    return jsonResponse({ error: "Required: beachId, lat, lon, speciesId, timestamp. Dev-only endpoint — supply lat/lon directly (no beach lookup table in the Worker, avoids duplicating BEACHES from the app)." }, 400);
  }
  const beach = { id: beachId, lat, lon };
  const predictionTimestamp = new Date(timestamp);
  if (isNaN(predictionTimestamp.getTime())) return jsonResponse({ error: "Invalid timestamp." }, 400);
  let envelope;
  try { envelope = await predictAsOfTimestamp(beach, speciesId, predictionTimestamp, buildWorkerDataAccess(env)); }
  catch (e) { return jsonResponse({ error: `Worker-side prediction failed: ${e.message}`, stack: e.stack }, 500); }
  if (!envelope.result) return jsonResponse({ error: "No prediction possible (e.g. no tide data) for this beach/time.", envelope }, 200);
  return jsonResponse({
    beachId, speciesId, timestamp: predictionTimestamp.toISOString(),
    presence: envelope.result.presence, feeding: envelope.result.feeding, access: envelope.result.access,
    scoreRaw: envelope.result.scoreRaw, finalScore: envelope.result.score, confidence: envelope.result.confidence,
    position: envelope.result.position, factors: envelope.result.factors,
    isFuture: envelope.isFuture, environmentalInputs: envelope.environmentalInputs, sourceMeta: envelope.sourceMeta,
    MODEL_VERSION, MODEL_IMPLEMENTATION_FINGERPRINT,
  });
}

const FORAGE_DEV_ROUTES = ["/forage/check-sources","/forage/extract-pending","/forage/debug-source","/forage/debug-revision","/forage/review","/forage/review/pending","/forage/review/submit","/forage/review/mark-fully-reviewed","/forage/metrics","/forage/health","/dev/predict-parity"];

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
          "/forecast/gridpoint?lat=&lon=",
          "/trends/youtube?query=", "/trends/rss?source=",
          "/trips/log (POST)", "/trips/list?beach_id=&limit=",
          "/snapshots/save (POST)", "/snapshots/list?beach_id=&species_id=&limit=",
          "/forage/evidence?beachId= (public)",
          "/forage/* (dev/auth-only)", "/dev/predict-parity (POST, dev/auth-only)",
        ],
      });
    }

    if (["/tides/current", "/tides/predictions", "/tides/curve", "/tides/history"].includes(url.pathname)) {
      if (!validateCoopsStation(station)) return jsonResponse({ error: "Missing or invalid 'station' — must be a 7-digit NOAA CO-OPS station ID." }, 400);
      if (url.pathname === "/tides/current") return handleCurrent(station);
      if (url.pathname === "/tides/predictions") return handlePredictions(station);
      if (url.pathname === "/tides/curve") return handleCurve(station);
      if (url.pathname === "/tides/history") {
        if (!validateDateCompact(date)) return jsonResponse({ error: "Missing or invalid 'date' — must be YYYYMMDD." }, 400);
        return handleTidesForDate(station, date);
      }
    }

    if (url.pathname === "/buoy/latest" || url.pathname === "/buoy/history") {
      if (!validateNdbcStation(station)) return jsonResponse({ error: "Missing or invalid 'station' — must be a valid NDBC station ID." }, 400);
      if (url.pathname === "/buoy/latest") return handleBuoyLatest(station);
      if (!validateDateCompact(date)) return jsonResponse({ error: "Missing or invalid 'date' — must be YYYYMMDD." }, 400);
      return handleBuoyHistory(station, date);
    }

    if (url.pathname === "/forecast/gridpoint") {
      const lat = url.searchParams.get("lat"), lon = url.searchParams.get("lon");
      if (!lat || !lon || isNaN(+lat) || isNaN(+lon)) return jsonResponse({ error: "Missing or invalid 'lat'/'lon'." }, 400);
      return handleForecastGridpoint(lat, lon);
    }
    if (url.pathname === "/marine/forecast") {
      const lat = url.searchParams.get("lat"), lon = url.searchParams.get("lon");
      if (!lat || !lon || isNaN(+lat) || isNaN(+lon)) return jsonResponse({ error: "Missing or invalid 'lat'/'lon'." }, 400);
      return handleMarineForecast(lat, lon);
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
      if (!validateIcaoStation(station)) return jsonResponse({ error: "Missing or invalid 'station' — must be a 4-letter ICAO station ID (e.g. KMIA)." }, 400);
      if (url.pathname === "/weather/precip") return handlePrecip(station);
      if (!validateDateCompact(date)) return jsonResponse({ error: "Missing or invalid 'date' — must be YYYYMMDD." }, 400);
      return handleWeatherHistory(station, date);
    }

    if (url.pathname === "/trips/log") {
      if (request.method !== "POST") return jsonResponse({ error: "Use POST for /trips/log." }, 405);
      return handleTripLog(request, env);
    }
    if (url.pathname === "/trips/list") return handleTripList(url, env);

    if (url.pathname === "/snapshots/save") {
      if (request.method !== "POST") return jsonResponse({ error: "Use POST for /snapshots/save." }, 405);
      return handleSnapshotSave(request, env);
    }
    if (url.pathname === "/snapshots/list") return handleSnapshotList(url, env);

    if (url.pathname === "/forage/evidence") return handleForageEvidence(url, env);

    if (FORAGE_DEV_ROUTES.includes(url.pathname)) {
      const authError = requireForageAuth(request, env);
      if (authError) return authError;
    }
    if (url.pathname === "/forage/check-sources") { if (request.method !== "POST") return jsonResponse({ error: "POST only" }, 405); return handleForageCheckSources(env); }
    if (url.pathname === "/forage/extract-pending") { if (request.method !== "POST") return jsonResponse({ error: "POST only" }, 405); return handleForageExtractPending(env); }
    if (url.pathname === "/forage/debug-source") { if (request.method !== "POST") return jsonResponse({ error: "POST only" }, 405); return handleForageDebugSource(request, env); }
    if (url.pathname === "/forage/debug-revision") { if (request.method !== "POST") return jsonResponse({ error: "POST only" }, 405); return handleForageDebugRevision(request, env); }
    if (url.pathname === "/forage/review") return new Response(forageReviewUiHtml(), { headers: { "Content-Type": "text/html", ...CORS_HEADERS } });
    if (url.pathname === "/forage/review/pending") return handleForagePendingReview(env, url);
    if (url.pathname === "/forage/review/submit") { if (request.method !== "POST") return jsonResponse({ error: "POST only" }, 405); return handleForageSubmitReview(request, env); }
    if (url.pathname === "/forage/review/mark-fully-reviewed") { if (request.method !== "POST") return jsonResponse({ error: "POST only" }, 405); return handleForageMarkFullyReviewed(request, env); }
    if (url.pathname === "/forage/metrics") return handleForageMetrics(env, url);
    if (url.pathname === "/dev/predict-parity") { if (request.method !== "POST") return jsonResponse({ error: "POST only" }, 405); return handleDevPredictParity(request, env); }

    return jsonResponse({ error: "Unknown route." }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(forageScheduledHandler(env));
  },
};
