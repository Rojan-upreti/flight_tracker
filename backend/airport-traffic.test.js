import test from 'node:test';
import assert from 'node:assert/strict';
import { updateAirportTraffic, matchAirportCall } from '../frontend/airport-traffic.js';

const jfk = { icao: 'KJFK', lat: 40.639928, lon: -73.778692 };
const ewr = { icao: 'KEWR', lat: 40.6925, lon: -74.1687 };
const cdw = { icao: 'KCDW', lat: 40.8752, lon: -74.2814 };
const now = 1_000_000;

function plane(icao24, callsign, lat, lon, extra = {}) {
  return { icao24, callsign, lat, lon, altitudeM: 900, onGround: false, heading: 270, verticalRateMps: -2, positionAt: now, ...extra };
}

test('airport traffic selects surface, approach, and departure aircraft but excludes other airports', () => {
  const aircraft = [
    plane('a1', 'AAL166', jfk.lat, jfk.lon, { onGround: true, altitudeM: null }),
    plane('a2', 'DAL403', 40.64, -73.55),
    plane('a3', 'UAL901', 40.70, jfk.lon, { heading: 0, verticalRateMps: 2 }),
    plane('a4', 'JBU74', 41.1, -74.5, { onGround: true, altitudeM: null }),
    plane('a5', 'AAL992', 41.4, -74.7),
  ];
  const result = updateAirportTraffic(jfk, aircraft, new Map(), now);
  assert.deepEqual(result.candidates.map(item => item.callsign).sort(), ['AAL166', 'DAL403', 'UAL901']);
  assert.equal(result.candidates.find(item => item.callsign === 'AAL166').phase, 'surface');
  assert.equal(result.candidates.find(item => item.callsign === 'DAL403').phase, 'approach');
  assert.equal(result.candidates.find(item => item.callsign === 'UAL901').phase, 'departure');
  assert.equal(updateAirportTraffic(cdw, aircraft, new Map(), now).candidates.some(item => item.callsign === 'AAL166'), false);
  assert.equal(updateAirportTraffic(ewr, aircraft, new Map(), now).candidates.some(item => item.callsign === 'AAL166'), false);
});

test('EWR tower traffic classifies local surface and approach aircraft', () => {
  const aircraft = [
    plane('e1', 'UAL901', ewr.lat, ewr.lon, { onGround: true, altitudeM: null }),
    plane('e2', 'AAL166', 40.70, -73.90),
    plane('e3', 'JBU74', 41.2, -74.6, { onGround: true, altitudeM: null }),
  ];
  const result = updateAirportTraffic(ewr, aircraft, new Map(), now);
  assert.deepEqual(result.candidates.map(item => item.callsign).sort(), ['AAL166', 'UAL901']);
  assert.equal(result.candidates.find(item => item.callsign === 'UAL901').phase, 'surface');
  assert.equal(result.candidates.find(item => item.callsign === 'AAL166').phase, 'approach');
  assert.equal(matchAirportCall('United 901, taxi', ewr, result.candidates, aircraft, { now })?.aircraft.icao24, 'e1');
});

test('EWR includes ground traffic outside the surface ring as nearby and matches it', () => {
  const taxi = plane('e4', 'JBU74', 40.78, -74.05, { onGround: true, altitudeM: null });
  const result = updateAirportTraffic(ewr, [taxi], new Map(), now);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].phase, 'nearby');
  assert.ok(result.candidates[0].distanceNm > 4);
  assert.equal(matchAirportCall('74, hold short', ewr, result.candidates, [taxi], { now })?.aircraft.icao24, 'e4');
  assert.equal(matchAirportCall('JetBlue 74, taxi', ewr, result.candidates, [taxi], { now })?.aircraft.icao24, 'e4');
});

test('ambiguous opening short still matches a later full airline callsign', () => {
  const local = plane('a1', 'AAL166', jfk.lat, jfk.lon, { onGround: true, altitudeM: null });
  const competing = plane('a4', 'DAL166', jfk.lat + 0.01, jfk.lon, { onGround: true, altitudeM: null });
  const traffic = updateAirportTraffic(jfk, [local, competing], new Map(), now);
  const match = matchAirportCall('166, turn left. American one sixty six, cleared to land', jfk, traffic.candidates, [local, competing], { now });
  assert.equal(match?.aircraft.icao24, 'a1');
  assert.equal(match?.confidence, 'high');
});

test('opening address wins over a later traffic callsign for zoom confidence', () => {
  const local = plane('a1', 'AAL166', jfk.lat, jfk.lon, { onGround: true, altitudeM: null });
  const trafficPlane = plane('a5', 'DAL403', jfk.lat + 0.02, jfk.lon, { onGround: true, altitudeM: null });
  const traffic = updateAirportTraffic(jfk, [local, trafficPlane], new Map(), now);
  const match = matchAirportCall('American 166, turn left. Traffic Delta four zero three is ahead', jfk, traffic.candidates, [local, trafficPlane], { now });
  assert.equal(match?.aircraft.icao24, 'a1');
  assert.equal(match?.kind, 'full');
  assert.equal(match?.confidence, 'high');
});

test('number-only tower calls match only one current candidate for the selected airport', () => {
  const local = plane('a1', 'AAL166', jfk.lat, jfk.lon, { onGround: true, altitudeM: null });
  const farSameNumber = plane('a2', 'DAL166', 41.4, -74.7);
  const otherAirportGround = plane('a3', 'JBU74', 41.2, -74.6, { onGround: true, altitudeM: null });
  const traffic = updateAirportTraffic(jfk, [local, farSameNumber, otherAirportGround], new Map(), now);
  assert.equal(matchAirportCall('166, turn left', jfk, traffic.candidates, [local, farSameNumber, otherAirportGround], { now })?.aircraft.icao24, 'a1');
  assert.equal(matchAirportCall('JetBlue 74, taxi', jfk, traffic.candidates, [local, farSameNumber, otherAirportGround], { now }), null);
  const competing = plane('a4', 'DAL166', jfk.lat + 0.01, jfk.lon, { onGround: true, altitudeM: null });
  const ambiguous = updateAirportTraffic(jfk, [local, competing], new Map(), now);
  assert.equal(matchAirportCall('166, turn left', jfk, ambiguous.candidates, [local, competing], { now }), null);
  assert.equal(matchAirportCall('American 166, cleared to land', jfk, ambiguous.candidates, [local, competing], { now })?.aircraft.icao24, 'a1');
  const mentionedTraffic = plane('a5', 'DAL403', jfk.lat + 0.02, jfk.lon, { onGround: true, altitudeM: null });
  const withTraffic = updateAirportTraffic(jfk, [local, mentionedTraffic], new Map(), now);
  assert.equal(matchAirportCall('One sixty six, turn left. Traffic Delta four zero three is ahead', jfk, withTraffic.candidates, [local, mentionedTraffic], { now })?.aircraft.icao24, 'a1');
  assert.equal(matchAirportCall('One sixty six, turn left. Traffic Delta four zero three is ahead', jfk, [...ambiguous.candidates, mentionedTraffic], [local, competing, mentionedTraffic], { now }), null);
});

test('temporary airport traffic drops old positions and expires history', () => {
  const local = plane('a1', 'AAL166', jfk.lat, jfk.lon, { onGround: true, altitudeM: null });
  const first = updateAirportTraffic(jfk, [local], new Map(), now);
  assert.equal(first.candidates.length, 1);
  const old = updateAirportTraffic(jfk, [local], first.records, now + 60_000);
  assert.equal(old.candidates.length, 0);
  assert.equal(matchAirportCall('166, turn left', jfk, old.candidates, [local], { now: now + 60_000 }), null);
  assert.equal(updateAirportTraffic(jfk, [], old.records, now + 100_000).records.size, 0);
});
