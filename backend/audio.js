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

function fetchErrorMessage(error) {
  const cause = error?.cause;
  const detail = cause?.code || cause?.message || error?.message || 'unknown error';
  return detail === 'fetch failed' && cause?.message ? cause.message : detail;
}

function isRetryableCaptionError(error, status) {
  if (status === 429 || status === 503 || status === 504) return true;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return false;
  const code = error?.cause?.code || error?.code || '';
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN' || code === 'UND_ERR_CONNECT_TIMEOUT'
    || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT'
    || /fetch failed|network|socket|tls/i.test(String(error?.message || ''));
}

export async function transcribe(pcm, signal) {
  const wav = wavFromPcm(pcm);
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY is not configured');
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (signal?.aborted) throw Object.assign(new Error('Caption request aborted'), { name: 'AbortError' });
    try {
      const form = new FormData();
      form.append('file', new File([wav], 'radio.wav', { type: 'audio/wav' }));
      const timeout = AbortSignal.timeout(45_000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetch('https://api.deepseek.com/v1/tools/asr', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: combined,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const error = new Error(`DeepSeek captions returned HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
        if (attempt < 3 && isRetryableCaptionError(error, response.status)) {
          await new Promise(resolve => setTimeout(resolve, attempt * 400));
          lastError = error;
          continue;
        }
        throw error;
      }
      const data = await response.json();
      return typeof data.text === 'string' ? data.text.trim() : '';
    } catch (error) {
      lastError = error;
      if (signal?.aborted || error?.name === 'AbortError') throw Object.assign(new Error('Caption request aborted'), { name: 'AbortError' });
      if (attempt < 3 && isRetryableCaptionError(error)) {
        await new Promise(resolve => setTimeout(resolve, attempt * 400));
        continue;
      }
      throw new Error(`DeepSeek caption request failed (${fetchErrorMessage(error)})`);
    }
  }
  throw lastError || new Error('DeepSeek caption request failed');
}
