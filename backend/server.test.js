import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { server } from './server.js';
import { AIRPORT, AIRPORTS, CHANNELS } from './config.js';
import { resolveStream, wavFromPcm, hasSpeech, transcribe, CHUNK_SECONDS, CHUNK_DURATION_MS, PCM_CHUNK_BYTES, SEGMENT_RETENTION, ASR_CONCURRENCY, trimSegmentMap } from './audio.js';

test('the airport channels use the requested mounts and tower frequencies', () => {
  assert.equal(AIRPORT.icao, 'KCDW');
  assert.deepEqual(AIRPORTS.map(airport => airport.icao), ['KCDW', 'KEWR', 'KJFK', 'KLAX']);
  assert.deepEqual(CHANNELS.map(channel => resolveStream(channel)), [
    'https://d.liveatc.net/kcdw2_atis',
    'https://d.liveatc.net/kcdw1',
    'https://d.liveatc.net/kcdw2_del_gnd_twr',
    'https://d.liveatc.net/kewr_twr',
    'https://d.liveatc.net/kjfk9_s',
    'https://d.liveatc.net/klax6',
    'https://d.liveatc.net/klax7',
  ]);
  assert.deepEqual(CHANNELS[1].frequencies.map(f => f.mhz), ['121.100', '121.900', '119.800']);
  assert.deepEqual(CHANNELS[3].frequencies.map(f => f.mhz), ['118.300']);
  assert.deepEqual(CHANNELS[4].frequencies.map(f => f.mhz), ['119.100', '123.900']);
  assert.deepEqual(CHANNELS[5].frequencies.map(f => f.mhz), ['128.500']);
  assert.deepEqual(CHANNELS[6].frequencies.map(f => f.mhz), ['124.500', '124.300', '125.200']);
  assert.equal(CHANNELS[3].sourcePage, 'https://www.liveatc.net/hlisten.php?mount=kewr_twr&icao=kewr');
  assert.equal(CHANNELS[5].sourcePage, 'https://www.liveatc.net/hlisten.php?mount=klax6&icao=klax');
  assert.equal(CHANNELS[6].sourcePage, 'https://www.liveatc.net/hlisten.php?mount=klax7&icao=klax');
});

test('live radio uses 5 second chunks with caption retention helpers', () => {
  assert.equal(CHUNK_SECONDS, 5);
  assert.equal(CHUNK_DURATION_MS, 5_000);
  assert.equal(PCM_CHUNK_BYTES, 16_000 * 2 * 5);
  assert.equal(SEGMENT_RETENTION, 36);
  assert.equal(ASR_CONCURRENCY, 2);
  const segments = new Map();
  for (let i = 1; i <= 40; i++) segments.set(i, Buffer.alloc(1));
  trimSegmentMap(segments);
  assert.equal(segments.size, 36);
  assert.equal(segments.has(1), false);
  assert.equal(segments.has(5), true);
  assert.equal(segments.has(40), true);
});

test('PCM becomes a valid mono 16 kHz WAV and silence is skipped', () => {
  const pcm = Buffer.alloc(32000);
  const wav = wavFromPcm(pcm);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.length, pcm.length + 44);
  assert.equal(hasSpeech(pcm), false);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(200, i);
  assert.equal(hasSpeech(pcm), true);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(5000, i);
  assert.equal(hasSpeech(pcm), true);
});

test('caption requests use DeepSeek speech to text with a WAV file', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://api.deepseek.com/v1/tools/asr');
    assert.equal(options.method, 'POST');
    assert.equal(options.body.get('file').type, 'audio/wav');
    return { ok: true, json: async () => ({ text: 'Caldwell tower, cleared to land.' }) };
  };
  try {
    assert.equal(await transcribe(Buffer.alloc(32000)), 'Caldwell tower, cleared to land.');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('caption requests retry transient fetch failures', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) {
      const error = new TypeError('fetch failed');
      error.cause = { code: 'ECONNRESET' };
      throw error;
    }
    return { ok: true, json: async () => ({ text: 'United nine zero one, taxi.' }) };
  };
  try {
    assert.equal(await transcribe(Buffer.alloc(32000)), 'United nine zero one, taxi.');
    assert.equal(calls, 3);
  } finally { globalThis.fetch = originalFetch; }
});

test('the server serves config and rejects unknown channels', async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.channels.length, 7);
    assert.deepEqual(config.airports.map(airport => airport.icao), ['KCDW', 'KEWR', 'KJFK', 'KLAX']);
    assert.equal(config.channels[0].frequencies[0].mhz, '135.500');
    assert.equal(config.channels[0].env, undefined);
    assert.equal((await fetch(`${base}/api/radio/unknown`)).status, 404);
    assert.equal((await fetch(`${base}/api/segments/none/1`)).status, 404);
    assert.equal((await fetch(`${base}/api/aircraft?icao=invalid`)).status, 404);
    assert.equal(config.captionsConfigured, Boolean(process.env.DEEPSEEK_API_KEY));
    assert.equal((await fetch(`${base}/`)).status, 200);
  } finally { server.close(); await once(server, 'close'); }
});
