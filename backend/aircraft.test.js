import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAdsb, normalizeOpenSky, mergeAircraft, nearbyAircraft } from './aircraft.js';

test('merges two live feeds by aircraft ID and keeps a fresh unique OpenSky plane', () => {
  const now = 1_000_000;
  const adsb = normalizeAdsb({ now, ac: [
    { hex: 'abc123', flight: 'AAL166 ', r: 'N123AA', lat: 40.64, lon: -73.78, alt_baro: 1200, gs: 130, track: 90, baro_rate: 600, seen_pos: 1 },
  ] });
  const opensky = normalizeOpenSky({ time: 1000, states: [
    ['abc123', 'AAL166 ', 'United States', 997, 999, -73.79, 40.65, 350, false, 60, 92],
    ['def456', 'DAL403 ', 'United States', 998, 999, -73.72, 40.71, 500, false, 80, 180, -2],
    ['old789', 'OLD789 ', 'United States', 900, 999, -73.60, 40.80, 500, false, 80, 180],
  ] });
  const result = mergeAircraft(adsb, opensky, now);
  assert.equal(result.aircraft.length, 2);
  assert.equal(result.sources.openskyOnly, 1);
  assert.equal(result.aircraft.find(plane => plane.icao24 === 'abc123').source, 'adsb.fi');
  assert.equal(result.aircraft.find(plane => plane.icao24 === 'abc123').registration, 'N123AA');
  assert.equal(result.aircraft.find(plane => plane.icao24 === 'abc123').verticalRateMps, 3.048);
  assert.equal(result.aircraft.find(plane => plane.icao24 === 'def456').source, 'OpenSky');
  assert.equal(result.aircraft.find(plane => plane.icao24 === 'def456').verticalRateMps, -2);
  assert.equal(mergeAircraft(null, opensky, now + 60_000).aircraft.length, 0);
});

test('both airport views share one regional request per source', async () => {
  const original = globalThis.fetch;
  const calls = [];
  const now = Date.now();
  globalThis.fetch = async url => {
    calls.push(String(url));
    if (String(url).includes('adsb.fi')) return { ok: true, json: async () => ({ now, ac: [{ hex: 'abc123', flight: 'AAL166', lat: 40.64, lon: -73.78, seen_pos: 0 }] }) };
    return { ok: true, json: async () => ({ time: Math.floor(now / 1000), states: [['def456', 'DAL403', 'United States', Math.floor(now / 1000), Math.floor(now / 1000), -73.72, 40.71, 500, false, 80, 180]] }) };
  };
  try {
    await nearbyAircraft();
    await nearbyAircraft();
    assert.equal(calls.filter(url => url.includes('adsb.fi')).length, 1);
    assert.equal(calls.filter(url => url.includes('opensky-network.org')).length, 1);
  } finally { globalThis.fetch = original; }
});
