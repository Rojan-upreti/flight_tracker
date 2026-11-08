import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
const AUDIO_FILTER = 'highpass=f=180,lowpass=f=3500,acompressor=threshold=-26dB:ratio=3:attack=5:release=120,alimiter=limit=0.92';

export const CHUNK_SECONDS = 5;
export const CHUNK_DURATION_MS = CHUNK_SECONDS * 1000;
export const PCM_CHUNK_BYTES = 16_000 * 2 * CHUNK_SECONDS;
export const SEGMENT_RETENTION = 36;
export const ASR_CONCURRENCY = 2;

export function trimSegmentMap(segments, maxSize = SEGMENT_RETENTION) {
  while (segments.size > maxSize) segments.delete(segments.keys().next().value);
  return segments;
}

export function resolveStream(channel) {
  const override = process.env[channel.env];
  if (override) {
    const url = new URL(override);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Stream URL must use HTTP or HTTPS');
    return url.href;
  }
  return `https://d.liveatc.net/${channel.mount}`;
}

export async function startFfmpeg(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let response;
  try { response = await fetch(source, { signal: controller.signal }); }
  finally { clearTimeout(timer); }
  if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('audio/')) {
    await response.body?.cancel();
    throw new Error(`Audio source returned HTTP ${response.status} or did not provide audio`);
  }
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'pipe:0', '-af', AUDIO_FILTER, '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'];
  const ffmpeg = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const input = Readable.fromWeb(response.body);
  input.on('error', () => {});
  ffmpeg.stdin.on('error', () => input.destroy());
  ffmpeg.on('close', () => { input.destroy(); controller.abort(); });
  input.pipe(ffmpeg.stdin);
  return ffmpeg;
}

export function wavFromPcm(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function hasSpeech(pcm) {
  if (pcm.length < 32000) return false;
  let total = 0;
  for (let i = 0; i < pcm.length - 1; i += 64) total += Math.abs(pcm.readInt16LE(i));
  // ATC feeds are often quiet after squelch; keep skipping true silence but accept lower speech floors.
  return total / (pcm.length / 64) > 120;
}

export async function transcribe(pcm, signal) {
  const form = new FormData();
  form.append('file', new Blob([wavFromPcm(pcm)], { type: 'audio/wav' }), 'kcdw.wav');
  const response = await fetch('https://api.deepseek.com/v1/tools/asr', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` }, body: form, signal,
  });
  if (!response.ok) throw new Error(`DeepSeek captions returned HTTP ${response.status}`);
  const data = await response.json();
  return typeof data.text === 'string' ? data.text.trim() : '';
}
