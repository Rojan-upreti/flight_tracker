import './env.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AIRPORT, AIRPORTS, CHANNELS, airportByIcao, channelById } from './config.js';
import { resolveStream, startFfmpeg, hasSpeech, transcribe, wavFromPcm, PCM_CHUNK_BYTES, CHUNK_DURATION_MS, ASR_CONCURRENCY, trimSegmentMap } from './audio.js';
import { nearbyAircraft } from './aircraft.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../frontend');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const radioSessions = new Map();

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sse(res, type, data) { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); }

async function aircraft(res) {
  try {
    json(res, 200, await nearbyAircraft());
  } catch (error) {
    json(res, 503, { error: `Aircraft positions unavailable: ${error.message}` });
  }
}

async function synchronizedRadio(res, channel) {
  let ffmpeg;
  try { ffmpeg = await startFfmpeg(resolveStream(channel)); }
  catch (error) { return json(res, 502, { error: error.message }); }
  const sessionId = randomUUID();
  const session = { segments: new Map(), closed: false };
  radioSessions.set(sessionId, session);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  sse(res, 'status', { message: 'Buffering 5 seconds of radio audio…', processing: false });
  const controller = new AbortController();
  let pending = Buffer.alloc(0), stopped = false, sequence = 0, stderr = '', asrActive = 0;
  const asrQueue = [];
  const heartbeat = setInterval(() => { if (!stopped) res.write(': keepalive\n\n'); }, 15_000);
  const stop = () => {
    if (stopped) return;
    stopped = true; session.closed = true; clearInterval(heartbeat); controller.abort(); ffmpeg.kill('SIGTERM');
    asrQueue.length = 0;
    const cleanup = setTimeout(() => radioSessions.delete(sessionId), 120_000);
    cleanup.unref();
  };
  res.on('close', stop);

  function captionStatus() {
    if (stopped) return;
    const busy = asrQueue.length > 0 || asrActive > 0;
    sse(res, 'status', { message: busy ? 'Captions catching up…' : 'Listening for radio calls…', processing: busy });
  }

  function kickAsr() {
    while (!stopped && asrActive < ASR_CONCURRENCY && asrQueue.length) {
      const job = asrQueue.shift();
      asrActive++;
      void (async () => {
        try {
          if (process.env.DEEPSEEK_API_KEY && hasSpeech(job.pcm)) {
            sse(res, 'status', { message: 'Captions catching up…', processing: true });
            let caption = await transcribe(job.pcm, controller.signal);
            if (/^(you|thank you|thanks)[.!]?$/i.test(caption)) caption = '';
            if (!stopped && caption) sse(res, 'caption', { channel: channel.id, sequence: job.id, text: caption, time: Date.now() });
          }
        } catch (error) {
          if (!stopped) sse(res, 'warning', { message: `Caption unavailable for this segment: ${error.message}` });
        } finally {
          asrActive--;
          captionStatus();
          kickAsr();
        }
      })();
    }
  }

  function emitSegment(pcm) {
    const id = ++sequence;
    session.segments.set(id, wavFromPcm(pcm));
    trimSegmentMap(session.segments);
    sse(res, 'segment', {
      channel: channel.id,
      sequence: id,
      text: '',
      time: Date.now(),
      durationMs: CHUNK_DURATION_MS,
      audioUrl: `/api/segments/${sessionId}/${id}`,
    });
    if (id === 1) sse(res, 'status', { message: 'Streaming live radio…', processing: false });
    asrQueue.push({ id, pcm });
    kickAsr();
  }

  ffmpeg.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1000); });
  ffmpeg.stdout.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= PCM_CHUNK_BYTES) {
      const pcm = pending.subarray(0, PCM_CHUNK_BYTES);
      pending = pending.subarray(PCM_CHUNK_BYTES);
      emitSegment(pcm);
    }
  });
  ffmpeg.on('error', error => { if (!stopped) { sse(res, 'error', { message: error.code === 'ENOENT' ? 'FFmpeg is required for radio audio.' : error.message }); res.end(); } });
  ffmpeg.on('close', () => { if (!stopped) { sse(res, 'error', { message: stderr.trim() || 'Audio stream ended.' }); res.end(); } });
}

async function staticFile(req, res, pathname) {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  const full = path.resolve(root, name);
  if (!full.startsWith(root + path.sep)) return json(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(full);
    res.writeHead(200, { 'Content-Type': mime[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch { json(res, 404, { error: 'Not found' }); }
}

export const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, 'http://localhost');
  const pathname = requestUrl.pathname;
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  if (pathname === '/api/config') return json(res, 200, { airport: AIRPORT, airports: AIRPORTS, channels: CHANNELS.map(({ env, mount, ...publicChannel }) => publicChannel), captionsConfigured: Boolean(process.env.DEEPSEEK_API_KEY) });
  if (pathname === '/api/aircraft') {
    const selected = airportByIcao((requestUrl.searchParams.get('icao') || AIRPORT.icao).toUpperCase());
    return selected ? aircraft(res) : json(res, 404, { error: 'Unknown airport' });
  }
  const segmentMatch = pathname.match(/^\/api\/segments\/([\w-]+)\/(\d+)$/);
  if (segmentMatch) {
    const segment = radioSessions.get(segmentMatch[1])?.segments.get(Number(segmentMatch[2]));
    if (!segment) return json(res, 404, { error: 'Audio segment expired' });
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': segment.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.end(segment);
  }
  const radioMatch = pathname.match(/^\/api\/radio\/([\w-]+)$/);
  if (radioMatch) {
    const channel = channelById(radioMatch[1]);
    return channel ? synchronizedRadio(res, channel) : json(res, 404, { error: 'Unknown channel' });
  }
  if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Unknown endpoint' });
  return staticFile(req, res, pathname);
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => console.log(`Airport tracker running at http://localhost:${port}`));
}
