// Aircraft data uses ICAO flight identifiers (for example AAL166), while
// controllers normally speak the airline's telephony name (American 166).
const TELEPHONY = {
  AAL: ['AMERICAN', 'AMERICAN AIRLINES', 'AA', 'A A', 'ALPHA ALPHA LIMA'],
  DAL: ['DELTA', 'DL', 'DELTA AIR LINES'],
  UAL: ['UNITED', 'UA', 'UNITED AIRLINES'],
  JBU: ['JETBLUE', 'JET BLUE', 'B6'],
  SWA: ['SOUTHWEST', 'WN'],
  ASA: ['ALASKA', 'AS'],
  NKS: ['SPIRIT', 'SPIRIT WINGS'],
  FFT: ['FRONTIER', 'FRONTIER FLIGHT'],
  RPA: ['REPUBLIC', 'BRICKYARD'],
  SKW: ['SKYWEST'],
  EJA: ['EXECJET'],
  AAY: ['ALLEGIANT'],
  N: ['NOVEMBER'],
};

const DIGITS = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];
const TEENS = ['TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN'];
const TENS = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'];
const PHONETIC = { A: 'ALPHA', B: 'BRAVO', C: 'CHARLIE', D: 'DELTA', E: 'ECHO', F: 'FOXTROT', G: 'GOLF', H: 'HOTEL', I: 'INDIA', J: 'JULIET', K: 'KILO', L: 'LIMA', M: 'MIKE', N: 'NOVEMBER', O: 'OSCAR', P: 'PAPA', Q: 'QUEBEC', R: 'ROMEO', S: 'SIERRA', T: 'TANGO', U: 'UNIFORM', V: 'VICTOR', W: 'WHISKEY', X: 'XRAY', Y: 'YANKEE', Z: 'ZULU' };
const TOKEN_ALIASES = { ALFA: 'ALPHA', JULIETT: 'JULIET', X_RAY: 'XRAY', NINER: 'NINE', TREE: 'THREE', FIFE: 'FIVE', OH: 'ZERO' };
const INSTRUCTIONS = new Set(['TURN', 'CLIMB', 'DESCEND', 'MAINTAIN', 'CLEARED', 'TAXI', 'CONTACT', 'CROSS', 'HOLD', 'PROCEED', 'FOLLOW', 'LINE', 'REPORT', 'DEPART', 'SQUAWK', 'STOP', 'CONTINUE', 'TRAFFIC', 'HEADING']);
const FILLER = new Set(['UH', 'UM', 'AND', 'OKAY', 'ROGER', 'WELL']);

function words(text) {
  return String(text).toUpperCase().replace(/X[\s-]?RAY/g, 'XRAY').replace(/[^A-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).map(token => TOKEN_ALIASES[token] || token);
}

function underHundred(n) {
  if (n < 10) return [DIGITS[n]];
  if (n < 20) return [TEENS[n - 10]];
  return [TENS[Math.floor(n / 10)], ...(n % 10 ? [DIGITS[n % 10]] : [])];
}

function cardinal(n) {
  if (n < 100) return underHundred(n);
  if (n < 1000) return [DIGITS[Math.floor(n / 100)], 'HUNDRED', ...(n % 100 ? underHundred(n % 100) : [])];
  return [...underHundred(Math.floor(n / 1000)), 'THOUSAND', ...(n % 1000 ? cardinal(n % 1000) : [])];
}

function numberVariants(value) {
  const variants = [[value], [...value].map(digit => DIGITS[Number(digit)])];
  const n = Number(value);
  if (value.length > 1 && value.length <= 4 && !value.startsWith('0')) variants.push(cardinal(n));
  if (value.length === 3) variants.push([DIGITS[Number(value[0])], ...underHundred(Number(value.slice(1)))]);
  if (value.length === 4) variants.push([...underHundred(Number(value.slice(0, 2))), ...underHundred(Number(value.slice(2)))]);
  return [...new Map(variants.map(variant => [variant.join(' '), variant])).values()];
}

function parseCallsign(value) {
  const callsign = String(value || '').toUpperCase().replace(/\s+/g, '');
  const match = callsign.match(/^([A-Z]{1,3})(\d{1,4})([A-Z]{0,2})$/);
  return match ? { callsign, prefix: match[1], number: match[2], tail: match[3] } : null;
}

function sequenceAt(tokens, pattern, start) {
  return pattern.every((token, index) => tokens[start + index] === token);
}

function firstIndex(tokens, pattern) {
  for (let i = 0; i <= tokens.length - pattern.length; i++) if (sequenceAt(tokens, pattern, i)) return i;
  return -1;
}

function prefixes(prefix) {
  const aliases = [prefix, ...(TELEPHONY[prefix] || [])];
  if (prefix.length > 1) aliases.push([...prefix].join(' '), [...prefix].map(letter => PHONETIC[letter]).join(' '));
  return aliases.map(words);
}

function tails(tail) {
  if (!tail) return [[]];
  return [[tail], [...tail], [...tail].map(letter => PHONETIC[letter])];
}

function explicitIndex(tokens, parsed) {
  let earliest = firstIndex(tokens, [parsed.callsign]);
  for (const prefix of prefixes(parsed.prefix)) {
    if (prefix.length === 1) {
      const compact = firstIndex(tokens, [`${prefix[0]}${parsed.number}${parsed.tail}`]);
      if (compact >= 0 && (earliest < 0 || compact < earliest)) earliest = compact;
    }
    for (const number of numberVariants(parsed.number)) {
      for (const tail of tails(parsed.tail)) {
        for (const spacer of [[], ['FLIGHT']]) {
          const index = firstIndex(tokens, [...prefix, ...spacer, ...number, ...tail]);
          if (index >= 0 && (earliest < 0 || index < earliest)) earliest = index;
        }
      }
    }
  }
  return earliest;
}

function contentStart(tokens) {
  let start = 0;
  while (FILLER.has(tokens[start])) start++;
  return start;
}

function trafficIndex(tokens) {
  const index = tokens.indexOf('TRAFFIC');
  return index >= 0 ? index : -1;
}

function shortNumberAtStart(tokens, parsed) {
  const start = contentStart(tokens);
  for (const variant of numberVariants(parsed.number)) {
    if (!sequenceAt(tokens, variant, start)) continue;
    const following = tokens.slice(start + variant.length);
    const hasInstruction = following.some(token => INSTRUCTIONS.has(token));
    const briefCall = tokens.length - start <= variant.length + 2;
    if (hasInstruction || briefCall) return true;
  }
  return false;
}

function shortNumberAtEnd(tokens, parsed) {
  return numberVariants(parsed.number).some(variant => sequenceAt(tokens, variant, tokens.length - variant.length));
}

function result(plane, kind, confidence) {
  return { aircraft: plane, kind, confidence };
}

/** Resolves a number spoken at the start of a call, including ambiguity. */
export function openingShortCall(text, aircraft, { recent = null, now = Date.now() } = {}) {
  const tokens = words(text);
  const short = aircraft.map(plane => ({ plane, parsed: parseCallsign(plane.callsign) }))
    .filter(item => item.parsed && Number.isFinite(item.plane.lat) && Number.isFinite(item.plane.lon) && shortNumberAtStart(tokens, item.parsed));
  const candidates = short.map(item => item.plane);
  if (!short.length) return { addressed: false, match: null, candidates };
  const previous = recent && now - recent.at < 120_000 ? short.find(item => item.plane.icao24 === recent.icao24) : null;
  if (previous) return { addressed: true, match: result(previous.plane, 'short', 'medium'), candidates };
  if (short.length === 1) return { addressed: true, match: result(short[0].plane, 'short', 'high'), candidates };
  return { addressed: true, match: null, candidates };
}

/** Returns one unambiguous aircraft addressed in a caption, or null. */
export function matchAircraftInCaption(text, aircraft, { recent = null, allowShort = true, now = Date.now() } = {}) {
  const tokens = words(text);
  if (!tokens.length) return null;
  const start = contentStart(tokens);
  const cutoff = trafficIndex(tokens);
  const candidates = aircraft.map(plane => ({ plane, parsed: parseCallsign(plane.callsign) })).filter(item => item.parsed && Number.isFinite(item.plane.lat) && Number.isFinite(item.plane.lon));
  const full = candidates.map(item => ({ ...item, index: explicitIndex(tokens, item.parsed) })).filter(item => item.index >= 0).sort((a, b) => a.index - b.index);
  const beforeTraffic = cutoff < 0 ? full : full.filter(item => item.index < cutoff);
  const afterTraffic = cutoff < 0 ? [] : full.filter(item => item.index >= cutoff);

  function uniqueAtEarliest(list) {
    if (!list.length) return null;
    const first = list.filter(item => item.index === list[0].index);
    return first.length === 1 ? first[0] : null;
  }

  const openingFull = uniqueAtEarliest(beforeTraffic.filter(item => item.index === start));
  if (openingFull) return result(openingFull.plane, 'full', 'high');

  const primaryFull = uniqueAtEarliest(beforeTraffic);
  if (primaryFull) return result(primaryFull.plane, 'full', primaryFull.index <= start + 1 ? 'high' : 'medium');

  if (allowShort) {
    const recentValid = recent && now - recent.at < 120_000;
    const short = candidates.filter(item => shortNumberAtStart(tokens, item.parsed) || (recentValid && item.plane.icao24 === recent.icao24 && shortNumberAtEnd(tokens, item.parsed)));
    if (short.length) {
      const previous = recentValid ? short.find(item => item.plane.icao24 === recent.icao24) : null;
      if (previous) return result(previous.plane, 'short', 'medium');
      if (short.length === 1) return result(short[0].plane, 'short', 'high');
    }
  }

  // Traffic callouts are not the addressed aircraft unless nothing else matched.
  if (!beforeTraffic.length && afterTraffic.length === 1 && full.length === 1) {
    return result(afterTraffic[0].plane, 'full', 'low');
  }
  return null;
}
