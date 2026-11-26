const ADSB_REFRESH_MS = 5_000;
const OPENSKY_REFRESH_MS = 30_000;
const MAX_POSITION_AGE_MS = 50_000;
const REGIONS = {
  'ny-metro': {
    key: 'ny-metro',
    airports: new Set(['KCDW', 'KEWR', 'KJFK']),
    lat: 40.76,
    lon: -74.03,
    radiusNm: 100,
    bounds: { lamin: 39.55, lomin: -75.7, lamax: 41.95, lomax: -72.35 },
  },
  'la-basin': {
    key: 'la-basin',
    airports: new Set(['KLAX']),
    lat: 33.9425,
    lon: -118.408,
    radiusNm: 100,
    bounds: { lamin: 32.7, lomin: -119.7, lamax: 35.2, lomax: -117.0 },
  },
};
const caches = { adsb: new Map(), opensky: new Map() };

export function regionForAirport(icao = 'KCDW') {
  const code = String(icao || 'KCDW').toUpperCase();
  return Object.values(REGIONS).find(region => region.airports.has(code)) || REGIONS['ny-metro'];
}

function cached(cache, key, refreshMs, load) {
  const entry = cache.get(key);
  const now = Date.now();
  if (entry?.data && now - entry.fetchedAt < refreshMs) return Promise.resolve(entry.data);
  if (entry?.retryAt && now < entry.retryAt) return Promise.resolve(entry.data || null);
  if (entry?.pending) return entry.data ? Promise.resolve(entry.data) : entry.pending;
  const pending = load().then(data => {
    cache.set(key, { data, fetchedAt: Date.now() });
    return data;
  }).catch(error => {
    console.warn(`${key} aircraft feed refresh failed: ${error.message}`);
    cache.set(key, { data: entry?.data || null, fetchedAt: entry?.fetchedAt || 0, retryAt: Date.now() + (error.retryMs || 30_000) });
    return entry?.data || null;
  });
  cache.set(key, { ...entry, pending });
  return entry?.data ? Promise.resolve(entry.data) : pending;
}

export function normalizeAdsb(raw) {
  const updatedAt = Number(raw.now) || Date.now();
  return { updatedAt, aircraft: (raw.ac || []).filter(plane => plane.hex && Number.isFinite(plane.lat) && Number.isFinite(plane.lon)).map(plane => {
    const icao24 = plane.hex.replace(/^~/, '').toLowerCase();
    return {
      icao24, callsign: plane.flight?.trim() || plane.r?.trim() || icao24.toUpperCase(), registration: plane.r?.trim() || null,
      lat: plane.lat, lon: plane.lon, altitudeM: Number.isFinite(plane.alt_baro) ? plane.alt_baro * 0.3048 : null,
      onGround: plane.alt_baro === 'ground', speedMps: Number.isFinite(plane.gs) ? plane.gs * 0.514444 : null,
      heading: Number.isFinite(plane.track) ? plane.track : null,
      verticalRateMps: Number.isFinite(plane.baro_rate) ? plane.baro_rate * 0.00508 : null,
      positionAt: updatedAt - Math.max(0, Number(plane.seen_pos) || 0) * 1000, source: 'adsb.fi',
    };
  }) };
}

export function normalizeOpenSky(raw) {
  const updatedAt = Number(raw.time) * 1000 || Date.now();
  return { updatedAt, aircraft: (raw.states || []).filter(row => row[0] && Number.isFinite(row[5]) && Number.isFinite(row[6])).map(row => ({
    icao24: row[0].toLowerCase(), callsign: row[1]?.trim() || row[0].toUpperCase(), registration: null,
    lat: row[6], lon: row[5], altitudeM: row[7], onGround: Boolean(row[8]), speedMps: row[9], heading: row[10], verticalRateMps: row[11],
    positionAt: Number(row[3]) * 1000 || updatedAt, source: 'OpenSky',
  })) };
}

export function mergeAircraft(adsb, opensky, now = Date.now()) {
  const result = new Map();
  for (const plane of opensky?.aircraft || []) if (now - plane.positionAt <= MAX_POSITION_AGE_MS) result.set(plane.icao24, plane);
  const openskyOnly = new Set(result.keys());
  for (const plane of adsb?.aircraft || []) {
    if (now - plane.positionAt > MAX_POSITION_AGE_MS) continue;
    const previous = result.get(plane.icao24);
    if (previous) openskyOnly.delete(plane.icao24);
    const freshest = previous && previous.positionAt > plane.positionAt + 2_000 ? previous : plane;
    const callsign = [freshest.callsign, plane.callsign, previous?.callsign].find(value => value && value.toUpperCase() !== plane.icao24.toUpperCase()) || freshest.callsign;
    result.set(plane.icao24, {
      ...freshest,
      callsign,
      registration: plane.registration || previous?.registration || null,
      sources: previous ? ['adsb.fi', 'OpenSky'] : ['adsb.fi'],
    });
  }
  for (const icao24 of openskyOnly) result.set(icao24, { ...result.get(icao24), sources: ['OpenSky'] });
  return {
    updatedAt: Math.max(adsb?.updatedAt || 0, opensky?.updatedAt || 0),
    aircraft: [...result.values()],
    sources: { adsb: adsb?.aircraft.length || 0, opensky: opensky?.aircraft.length || 0, openskyOnly: openskyOnly.size },
    stale: !adsb || now - adsb.updatedAt > 15_000,
  };
}

async function loadAdsb(region) {
  const url = `https://opendata.adsb.fi/api/v3/lat/${region.lat}/lon/${region.lon}/dist/${region.radiusNm}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(9_000) });
  if (!response.ok) throw new Error(`adsb.fi returned HTTP ${response.status}`);
  return normalizeAdsb(await response.json());
}

async function loadOpenSky(region) {
  const url = `https://opensky-network.org/api/states/all?${new URLSearchParams(region.bounds)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(9_000) });
  if (!response.ok) {
    const error = new Error(`OpenSky returned HTTP ${response.status}`);
    if (response.status === 429) error.retryMs = Math.max(30_000, Number(response.headers.get('X-Rate-Limit-Retry-After-Seconds') || 300) * 1000);
    throw error;
  }
  return normalizeOpenSky(await response.json());
}

export async function nearbyAircraft(icao = 'KCDW') {
  const region = regionForAirport(icao);
  const openSkyPromise = cached(caches.opensky, region.key, OPENSKY_REFRESH_MS, () => loadOpenSky(region));
  const adsbPromise = cached(caches.adsb, region.key, ADSB_REFRESH_MS, () => loadAdsb(region));
  const adsb = await adsbPromise;
  const opensky = caches.opensky.get(region.key)?.data || (adsb ? null : await openSkyPromise);
  if (!adsb && !opensky) throw new Error('Both aircraft feeds are unavailable');
  return mergeAircraft(adsb, opensky);
}
