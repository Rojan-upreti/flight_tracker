import { matchAircraftInCaption, openingShortCall } from './callsigns.js';

const HISTORY_MS = 90_000;
const POSITION_MS = 50_000;
const RULES = {
  KJFK: { surfaceNm: 4.2, closeNm: 5, approachNm: 18, departureNm: 10, fallbackNm: 25, monitorGroundNm: 15, maxAltitudeFt: 8500 },
  KEWR: { surfaceNm: 4.0, closeNm: 5, approachNm: 18, departureNm: 10, fallbackNm: 25, monitorGroundNm: 15, maxAltitudeFt: 8500 },
  KLAX: { surfaceNm: 4.5, closeNm: 6, approachNm: 30, departureNm: 12, fallbackNm: 35, monitorGroundNm: 15, maxAltitudeFt: 10000 },
  KCDW: { surfaceNm: 2.5, closeNm: 3, approachNm: 10, departureNm: 6, fallbackNm: 15, maxAltitudeFt: 4500 },
};

export function distanceNm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const angle = 2 * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2));
  return 3440.065 * angle;
}

function bearingTo(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function angleApart(a, b) { return Math.abs(((a - b + 540) % 360) - 180); }

export function updateAirportTraffic(airport, aircraft, previous = new Map(), now = Date.now()) {
  const rule = RULES[airport.icao];
  if (!rule) return { records: new Map(), candidates: [] };
  const records = new Map([...previous].filter(([, record]) => now - record.observedAt < HISTORY_MS));
  const candidates = [];
  for (const plane of aircraft) {
    if (!Number.isFinite(plane.lat) || !Number.isFinite(plane.lon)) continue;
    if (Number.isFinite(plane.positionAt) && now - plane.positionAt > POSITION_MS) continue;
    const distance = distanceNm(plane, airport);
    const monitorGroundNm = rule.monitorGroundNm || rule.surfaceNm;
    if (distance > Math.max(rule.approachNm + 5, monitorGroundNm)) continue;
    const previousRecord = records.get(plane.icao24);
    const seconds = previousRecord ? (now - previousRecord.observedAt) / 1000 : 0;
    const distanceTrend = seconds >= 2 && seconds <= 60 ? (distance - previousRecord.distanceNm) / seconds : 0;
    const altitudeFt = Number.isFinite(plane.altitudeM) ? plane.altitudeM * 3.28084 : null;
    const low = altitudeFt === null || altitudeFt <= rule.maxAltitudeFt;
    const headingDifference = Number.isFinite(plane.heading) ? angleApart(plane.heading, bearingTo(plane, airport)) : null;
    const toward = headingDifference !== null && headingDifference <= 70;
    const away = headingDifference !== null && headingDifference >= 110;
    const descending = Number.isFinite(plane.verticalRateMps) && plane.verticalRateMps < -0.75;
    const climbing = Number.isFinite(plane.verticalRateMps) && plane.verticalRateMps > 0.75;
    let phase = null;
    if (plane.onGround && distance <= rule.surfaceNm) phase = 'surface';
    else if (!plane.onGround && low) {
      if (distance <= rule.approachNm && (toward && (descending || distance <= rule.closeNm * 2) || descending && distanceTrend < -0.005)) phase = 'approach';
      else if (distance <= rule.departureNm && (away && (climbing || distance <= rule.closeNm) || climbing && distanceTrend > 0.005)) phase = 'departure';
      else if (distance <= rule.approachNm) phase = 'nearby';
    } else if (plane.onGround && distance <= monitorGroundNm) phase = 'nearby';
    const record = { ...plane, distanceNm: distance, distanceTrend, phase, observedAt: now };
    records.set(plane.icao24, record);
    if (phase) candidates.push(record);
  }
  candidates.sort((a, b) => a.distanceNm - b.distanceNm);
  return { records, candidates };
}

export function matchAirportCall(text, airport, candidates, regionalAircraft, { recent = null, allowShort = true, now = Date.now() } = {}) {
  const local = candidates.filter(plane => !Number.isFinite(plane.positionAt) || now - plane.positionAt <= POSITION_MS);
  if (allowShort) {
    const opening = openingShortCall(text, local, { recent, now });
    if (opening.match) return opening.match;
    if (opening.addressed) {
      const resolved = matchAircraftInCaption(text, opening.candidates, { recent, allowShort: false, now })
        || matchAircraftInCaption(text, opening.candidates, { recent, allowShort: true, now });
      if (!resolved) return null;
      // Clarifying an ambiguous opening number with the airline name is a high-confidence address.
      return resolved.kind === 'full' ? { ...resolved, confidence: 'high' } : resolved;
    }
  }
  const rule = RULES[airport.icao];
  const nearRegion = regionalAircraft.filter(plane => {
    if (!rule || !Number.isFinite(plane.lat) || !Number.isFinite(plane.lon)) return false;
    const distance = distanceNm(plane, airport);
    return distance <= rule.fallbackNm && (!plane.onGround || distance <= rule.surfaceNm)
      && (!Number.isFinite(plane.altitudeM) || plane.altitudeM * 3.28084 <= rule.maxAltitudeFt * 1.5)
      && (!Number.isFinite(plane.positionAt) || now - plane.positionAt <= POSITION_MS);
  });
  const options = { recent, allowShort: false, now };
  return matchAircraftInCaption(text, local, options)
    || matchAircraftInCaption(text, nearRegion, options)
    || (allowShort ? matchAircraftInCaption(text, local, { recent, allowShort: true, now }) : null);
}

export const PHASE_LABELS = { surface: 'Airport surface', approach: 'Possible approach', departure: 'Possible departure', nearby: 'Near airport' };
