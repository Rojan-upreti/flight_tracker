import test from 'node:test';
import assert from 'node:assert/strict';
import { matchAircraftInCaption } from '../frontend/callsigns.js';

const aircraft = [
  { icao24: 'aa0001', callsign: 'AAL166', lat: 40.64, lon: -73.78 },
  { icao24: 'de0002', callsign: 'DAL166', lat: 40.68, lon: -73.82 },
  { icao24: 'na0003', callsign: 'N123AB', lat: 40.87, lon: -74.28 },
  { icao24: 'jb0004', callsign: 'JBU74', lat: 40.67, lon: -73.81 },
];

test('matches airline names, codes, and spoken flight numbers', () => {
  for (const text of ['American 166, turn left heading 090', 'AA 166 cleared to land', 'AA166 cleared to land', 'American one sixty six contact tower', 'A A L 166 descend and maintain', 'Alpha Alpha Lima one six six, taxi via Alpha']) {
    assert.equal(matchAircraftInCaption(text, aircraft)?.aircraft.icao24, 'aa0001', text);
  }
  assert.equal(matchAircraftInCaption('JetBlue seven four, hold short', aircraft)?.aircraft.icao24, 'jb0004');
});

test('matches a phonetic registration', () => {
  assert.equal(matchAircraftInCaption('November one two three Alpha Bravo, cleared for takeoff', aircraft)?.aircraft.icao24, 'na0003');
});

test('short numbers require a unique aircraft or recent full callsign', () => {
  assert.equal(matchAircraftInCaption('166, turn left', aircraft), null);
  assert.equal(matchAircraftInCaption('166, turn left', aircraft, { recent: { icao24: 'aa0001', at: 1_000 }, now: 60_000 })?.aircraft.icao24, 'aa0001');
  assert.equal(matchAircraftInCaption('Cleared to land, one six six', aircraft, { recent: { icao24: 'aa0001', at: 1_000 }, now: 60_000 })?.aircraft.icao24, 'aa0001');
  assert.equal(matchAircraftInCaption('166, turn left', aircraft, { recent: { icao24: 'aa0001', at: 1_000 }, now: 180_000 }), null);
  assert.equal(matchAircraftInCaption('166, turn left', aircraft.filter(plane => plane.icao24 !== 'de0002'))?.aircraft.icao24, 'aa0001');
  assert.equal(matchAircraftInCaption('74, hold short', [aircraft[3]])?.aircraft.icao24, 'jb0004');
  assert.equal(matchAircraftInCaption('74, hold short', [aircraft[3], { icao24: 'sw0005', callsign: 'SWA74', lat: 40.66, lon: -73.80 }]), null);
});

test('runway numbers and ATIS shorthand do not trigger an aircraft match', () => {
  assert.equal(matchAircraftInCaption('Runway 166 is in use', aircraft), null);
  assert.equal(matchAircraftInCaption('166, turn left', [aircraft[0]], { allowShort: false }), null);
  assert.equal(matchAircraftInCaption('American 166, traffic Delta 166', aircraft)?.aircraft.icao24, 'aa0001');
});

test('traffic callouts are ignored unless they are the only match', () => {
  const withDelta = [...aircraft, { icao24: 'de0403', callsign: 'DAL403', lat: 40.65, lon: -73.79 }];
  const addressed = matchAircraftInCaption('American 166, traffic Delta four zero three is ahead', withDelta);
  assert.equal(addressed?.aircraft.icao24, 'aa0001');
  assert.equal(addressed?.confidence, 'high');
  assert.notEqual(addressed?.aircraft.icao24, 'de0403');
  const trafficOnly = matchAircraftInCaption('Traffic Delta four zero three is ahead', withDelta);
  assert.equal(trafficOnly?.aircraft.icao24, 'de0403');
  assert.equal(trafficOnly?.confidence, 'low');
  assert.equal(matchAircraftInCaption('166, turn left', aircraft.filter(plane => plane.icao24 !== 'de0002'))?.confidence, 'high');
});
