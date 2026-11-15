import { updateAirportTraffic, matchAirportCall, PHASE_LABELS } from './airport-traffic.js';

const $ = id => document.getElementById(id);
const state = { airports: [], airport: null, airportMarker: null, channels: [], selected: null, selectedFrequency: null, aircraft: [], trafficByAirport: new Map(), trafficCandidates: [], lastAircraftUpdate: null, markersByIcao: new Map(), focusedIcao24: null, focusTimer: null, pendingFocus: null, recentCall: null, hadCaption: false, playing: false, connecting: false, captionSource: null, captionStandalone: false, segmentQueue: [], segmentBySequence: new Map(), currentSegment: null, segmentLoading: false, segmentToken: 0, activeBlobUrl: null, typewriterFrame: null, map: null, markers: null, audioContext: null, analyser: null, waveformFrame: null };
const audio = $('audio');

function clock() {
  const now = new Date();
  $('local-time').textContent = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
  $('utc-time').textContent = now.toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' }) + ' UTC';
}
clock(); setInterval(clock, 1000);

function setError(message) { $('error-message').hidden = !message; $('error-message').textContent = message || ''; }
function setPlayerStatus(value) { $('player-status').textContent = value; $('sync-state').textContent = value; $('player-hint').textContent = value === 'PLAYING' ? 'Live audio · captions attach as ready' : value === 'CONNECTING' ? 'Buffering the first 5 seconds…' : value === 'ERROR' ? 'Stream unavailable' : 'Press play to listen'; }
function clearTypewriter() { if (state.typewriterFrame) cancelAnimationFrame(state.typewriterFrame); state.typewriterFrame = null; $('live-line').classList.remove('fading'); }
function clearSegmentQueue() {
  for (const entry of state.segmentQueue) if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
  if (state.currentSegment?.blobUrl && state.currentSegment.blobUrl !== state.activeBlobUrl) URL.revokeObjectURL(state.currentSegment.blobUrl);
  state.segmentQueue = [];
  state.segmentBySequence.clear();
  state.currentSegment = null;
}
function stopCaptions() { if (state.captionSource) state.captionSource.close(); state.captionSource = null; state.captionStandalone = false; clearSegmentQueue(); clearFlightFocus(); state.hadCaption = false; $('caption-status').textContent = 'STANDBY'; $('caption-status').classList.remove('active'); $('caption-toggle').textContent = 'Start captions'; $('caption-toggle').setAttribute('aria-pressed', 'false'); $('caption-toggle').disabled = false; }
function stopAudio() { state.segmentToken++; audio.pause(); audio.removeAttribute('src'); audio.load(); if (state.activeBlobUrl) URL.revokeObjectURL(state.activeBlobUrl); state.activeBlobUrl = null; clearSegmentQueue(); state.segmentLoading = false; state.playing = false; clearFlightFocus(); clearTypewriter(); state.hadCaption = false; $('live-line').textContent = 'Press play for continuous live radio and captions.'; $('play-button').textContent = '▶'; $('play-button').classList.remove('playing'); $('play-button').setAttribute('aria-label', 'Play radio'); $('sync-play').textContent = '▶'; $('sync-play').setAttribute('aria-label', 'Play synchronized radio'); setPlayerStatus('READY'); if (!state.captionStandalone) stopCaptions(); }

function clearFlightFocus() {
  if (state.focusTimer) clearTimeout(state.focusTimer);
  state.focusTimer = null;
  state.pendingFocus = null;
  const marker = state.markersByIcao.get(state.focusedIcao24);
  marker?.getElement()?.classList.remove('aircraft-focused');
  marker?.setZIndexOffset(0);
  marker?.closePopup();
  state.focusedIcao24 = null;
  $('flight-focus').hidden = true;
}

function shouldFocusMatch(match) {
  if (!match || match.confidence === 'low') return false;
  if (!state.focusedIcao24 || state.focusedIcao24 === match.aircraft.icao24) return true;
  return match.confidence === 'high' && match.kind === 'full';
}

function focusAircraft(icao24, kind = 'full', durationMs = 5_000, confidence = 'high') {
  if (!shouldFocusMatch({ aircraft: { icao24 }, kind, confidence })) return false;
  const plane = state.aircraft.find(item => item.icao24 === icao24);
  const marker = state.markersByIcao.get(icao24);
  if (!plane || !marker || !state.map) {
    if (state.pendingFocus?.icao24 !== icao24) state.pendingFocus = { icao24, kind, durationMs, confidence, at: Date.now() };
    else state.pendingFocus = { ...state.pendingFocus, kind, durationMs, confidence };
    return false;
  }
  if (state.focusTimer) clearTimeout(state.focusTimer);
  state.focusTimer = null;
  state.pendingFocus = null;
  const previous = state.markersByIcao.get(state.focusedIcao24);
  if (previous && state.focusedIcao24 !== icao24) {
    previous.getElement()?.classList.remove('aircraft-focused');
    previous.setZIndexOffset(0);
    previous.closePopup();
  }
  state.focusedIcao24 = icao24;
  marker.getElement()?.classList.add('aircraft-focused');
  marker.setZIndexOffset(1000);
  $('flight-focus-callsign').textContent = plane.callsign;
  $('flight-focus-detail').textContent = `${kind === 'short' ? 'Short call' : 'Callsign'} · ${state.selected.shortName}`;
  $('flight-focus').hidden = false;
  state.map.flyTo([plane.lat, plane.lon], Math.max(state.map.getZoom(), 14), { duration: 1.2 });
  marker.openPopup();
  state.focusTimer = setTimeout(clearFlightFocus, Math.max(1000, durationMs));
  return true;
}

function selectChannel(channel) {
  if (state.selected?.id === channel.id) return;
  stopAudio(); stopCaptions(); clearFlightFocus(); state.recentCall = null; setError(''); state.selected = channel;
  document.querySelectorAll('.channel-button').forEach(button => { const active = button.dataset.id === channel.id; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  $('channel-title').textContent = channel.name;
  $('player-channel').textContent = channel.name;
  $('channel-subtitle').textContent = channel.description;
  state.selectedFrequency = channel.frequencies[0];
  $('sync-channel').textContent = channel.name;
  const jfkTabs = channel.airportIcao === 'KJFK' && channel.frequencies.length === 2;
  $('frequency-list').classList.toggle('frequency-tabs', jfkTabs);
  $('frequency-list').replaceChildren(...channel.frequencies.map((frequency, index) => {
    if (jfkTabs) {
      const tab = document.createElement('button'); tab.type = 'button'; tab.className = 'frequency-tab'; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(index === 0));
      const name = document.createElement('span'); name.textContent = frequency.facility;
      const mhz = document.createElement('strong'); mhz.textContent = frequency.mhz;
      tab.append(name, mhz);
      tab.addEventListener('click', () => { state.selectedFrequency = frequency; $('sync-channel').textContent = `${channel.name} · ${frequency.mhz}`; $('frequency-list').querySelectorAll('.frequency-tab').forEach(item => item.setAttribute('aria-selected', String(item === tab))); });
      return tab;
    }
    const row = document.createElement('div'); row.className = 'frequency-row';
    const name = document.createElement('span'); name.textContent = frequency.facility;
    const mhz = document.createElement('strong'); mhz.textContent = frequency.mhz;
    row.append(name, mhz); return row;
  }));
  $('frequency-list').setAttribute('role', jfkTabs ? 'tablist' : 'group');
  $('frequency-note').hidden = !jfkTabs;
  $('frequency-note').textContent = jfkTabs ? 'Both frequency tabs use the same combined Kennedy Ground / Tower feed.' : '';
  $('source-link').href = channel.sourcePage;
  $('transcript').innerHTML = '<div class="empty-transcript"><span class="caption-glyph">≋</span><strong>Awaiting transmission</strong><p>Start captions to follow this channel. A matched callsign will focus its aircraft on the map.</p></div>';
}

function selectAirport(icao, channelId) {
  const airport = state.airports.find(item => item.icao === icao);
  if (!airport) return;
  const changed = state.airport?.icao !== icao;
  state.airport = airport;
  document.title = `${airport.icao} · Airport Radio Tracker`;
  $('breadcrumb-icao').textContent = airport.icao;
  $('monitor-label').textContent = `${airport.icao} MONITOR`;
  $('airport-icao').textContent = airport.icao;
  $('radio-airport-id').textContent = `${airport.icao} / ${airport.region}`;
  $('local-clock-label').textContent = `LOCAL TIME · ${airport.icao}`;
  const title = $('airport-title');
  const words = airport.name.split(' ');
  const accent = document.createElement('span'); accent.textContent = words.pop();
  title.replaceChildren(document.createTextNode(words.join(' ') + ' '), accent);
  $('airport-description').textContent = `${airport.city} · ICAO ${airport.icao}`;
  $('heading-coordinates').innerHTML = `${airport.lat.toFixed(4)}° N<br>${Math.abs(airport.lon).toFixed(4)}° W`;
  $('osm-link').href = `https://www.openstreetmap.org/?mlat=${airport.lat}&mlon=${airport.lon}#map=14/${airport.lat}/${airport.lon}`;
  $('map-card').setAttribute('aria-label', `Map of ${airport.icao} and nearby aircraft`);
  $('recenter').title = `Center on ${airport.icao}`;
  $('recenter').setAttribute('aria-label', `Center map on ${airport.icao}`);
  document.querySelectorAll('.airport-group').forEach(group => {
    const active = group.dataset.icao === airport.icao;
    group.querySelector('.airport-item').classList.toggle('selected', active);
    group.querySelector('.airport-item').setAttribute('aria-expanded', String(active));
    group.querySelector('.channel-list').hidden = !active;
  });
  if (state.map) {
    state.map.setView([airport.lat, airport.lon], airport.zoom);
    state.airportMarker.setLatLng([airport.lat, airport.lon]).bindPopup(`<strong>${airport.icao} · ${airport.name}</strong><br>${airport.city}`);
    if (changed) state.markers.clearLayers();
  }
  if (changed) {
    clearFlightFocus(); state.recentCall = null; state.aircraft = []; state.trafficCandidates = []; state.lastAircraftUpdate = null; state.markersByIcao.clear();
    $('aircraft-count').textContent = '—'; $('tower-count').textContent = '—'; $('aircraft-metric').textContent = '—'; $('aircraft-updated').textContent = 'Updating…';
    updateAircraft();
  }
  const channel = state.channels.find(item => item.id === channelId && item.airportIcao === airport.icao) || state.channels.find(item => item.airportIcao === airport.icao);
  if (channel) selectChannel(channel);
}

function renderAirportList() {
  $('airport-total').textContent = String(state.airports.length).padStart(2, '0');
  $('airport-list').replaceChildren(...state.airports.map(airport => {
    const group = document.createElement('div'); group.className = 'airport-group'; group.dataset.icao = airport.icao;
    const button = document.createElement('button'); button.className = 'airport-item'; button.type = 'button'; button.setAttribute('aria-expanded', 'false');
    const code = document.createElement('span'); code.className = 'airport-code'; code.textContent = airport.code;
    const copy = document.createElement('span'); copy.className = 'airport-copy';
    const name = document.createElement('strong'); name.textContent = airport.shortName;
    const city = document.createElement('small'); city.textContent = airport.city;
    copy.append(name, city);
    const chevron = document.createElement('span'); chevron.className = 'airport-chevron'; chevron.textContent = '⌄';
    button.append(code, copy, chevron); button.addEventListener('click', () => selectAirport(airport.icao));
    const list = document.createElement('div'); list.className = 'channel-list'; list.hidden = true; list.setAttribute('aria-label', `${airport.icao} radio channels`);
    list.replaceChildren(...state.channels.filter(channel => channel.airportIcao === airport.icao).map(channel => {
      const item = document.createElement('button'); item.type = 'button'; item.className = 'channel-button'; item.dataset.id = channel.id; item.setAttribute('aria-pressed', 'false');
      const dot = document.createElement('span'); dot.className = 'channel-dot';
      const label = document.createElement('span'); label.textContent = channel.name;
      item.append(dot, label); item.addEventListener('click', () => selectAirport(airport.icao, channel.id)); return item;
    }));
    group.append(button, list); return group;
  }));
}

function setupVisualizer() {
  try {
    if (!state.audioContext) {
      state.audioContext = new AudioContext();
      const source = state.audioContext.createMediaElementSource(audio);
      state.analyser = state.audioContext.createAnalyser(); state.analyser.fftSize = 256;
      source.connect(state.analyser); state.analyser.connect(state.audioContext.destination);
    }
    state.audioContext.resume();
  } catch { /* Audio still plays when visualization is unavailable. */ }
}

function drawWaveform() {
  const canvas = $('waveform'), ctx = canvas.getContext('2d');
  const width = canvas.clientWidth * devicePixelRatio, height = 72 * devicePixelRatio;
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  ctx.clearRect(0, 0, width, height);
  const bars = 54, gap = width / bars, data = new Uint8Array(state.analyser?.frequencyBinCount || 128);
  if (state.analyser && state.playing) state.analyser.getByteFrequencyData(data);
  for (let i = 0; i < bars; i++) {
    const sample = data[Math.floor(i * data.length / bars)] || 0;
    const idle = 4 + Math.abs(Math.sin(i * 1.81)) * 8;
    const barHeight = Math.max(idle, sample / 255 * height * .9);
    ctx.fillStyle = state.playing ? (i < bars * .68 ? '#d5f476' : '#6eac91') : '#486979';
    ctx.fillRect(i * gap + gap * .18, (height - barHeight) / 2, Math.max(2, gap * .56), barHeight);
  }
  state.waveformFrame = requestAnimationFrame(drawWaveform);
}
drawWaveform();

function noteCaptionPending() {
  if (state.hadCaption) return;
  clearTypewriter();
  $('live-line').textContent = 'Live audio · caption pending…';
  $('live-line').classList.remove('fading');
}

function typeCaption(text, durationMs = 5_000) {
  if (!text) { noteCaptionPending(); return; }
  clearTypewriter();
  const line = $('live-line');
  const started = performance.now();
  let last = '';
  function frame(now) {
    const elapsed = now - started;
    const visibleCharacters = Math.min(text.length, Math.ceil(text.length * elapsed / Math.max(800, durationMs - 900)));
    const prefix = text.slice(0, visibleCharacters);
    const words = prefix.trim().split(/\s+/);
    const visible = words.slice(-30).join(' ');
    if (visible !== last) { line.textContent = visible; last = visible; }
    line.classList.toggle('fading', elapsed > durationMs - 900);
    if (elapsed < durationMs) state.typewriterFrame = requestAnimationFrame(frame);
  }
  line.textContent = '';
  state.typewriterFrame = requestAnimationFrame(frame);
}

function showCaption(entry) {
  if (!entry?.text) return;
  typeCaption(entry.text, entry.durationMs || 5_000);
  state.hadCaption = true;
  if (entry.captionShown) return;
  entry.captionShown = true;
  const empty = $('transcript').querySelector('.empty-transcript'); if (empty) empty.remove();
  const item = document.createElement('div'); item.className = 'caption-item';
  const header = document.createElement('div'); header.className = 'caption-item-head';
  const time = document.createElement('time'); time.textContent = new Date(entry.time || Date.now()).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const text = document.createElement('p'); text.textContent = entry.text;
  header.append(time);
  const match = matchAirportCall(entry.text, state.airport, state.trafficCandidates, state.aircraft, { recent: state.recentCall, allowShort: state.selected.id !== 'atis' });
  if (match && shouldFocusMatch(match)) {
    state.recentCall = { icao24: match.aircraft.icao24, at: Date.now() };
    focusAircraft(match.aircraft.icao24, match.kind, entry.durationMs || 5_000, match.confidence);
    const link = document.createElement('button'); link.type = 'button'; link.className = 'caption-flight-link'; link.textContent = `✈ ${match.aircraft.callsign}`;
    link.setAttribute('aria-label', `Focus map on ${match.aircraft.callsign}`);
    link.addEventListener('click', () => focusAircraft(match.aircraft.icao24, match.kind, entry.durationMs || 5_000, 'high'));
    header.append(link);
  } else if (match) {
    const link = document.createElement('button'); link.type = 'button'; link.className = 'caption-flight-link'; link.textContent = `✈ ${match.aircraft.callsign}`;
    link.setAttribute('aria-label', `Focus map on ${match.aircraft.callsign}`);
    link.addEventListener('click', () => focusAircraft(match.aircraft.icao24, match.kind, entry.durationMs || 5_000, 'high'));
    header.append(link);
  }
  item.append(header, text); $('transcript').prepend(item);
  $('caption-status').textContent = 'LIVE';
  while ($('transcript').children.length > 35) $('transcript').lastElementChild.remove();
}

function findSegment(sequence) {
  if (state.currentSegment?.sequence === sequence) return state.currentSegment;
  return state.segmentBySequence.get(sequence) || state.segmentQueue.find(entry => entry.sequence === sequence) || null;
}

function applyCaption(payload) {
  if (!payload?.text) return;
  let entry = findSegment(payload.sequence);
  if (!entry) {
    entry = { sequence: payload.sequence, text: payload.text, time: payload.time, durationMs: 5_000, captionShown: false };
  } else {
    entry.text = payload.text;
    entry.time = payload.time || entry.time;
  }
  showCaption(entry);
}

async function prefetchEntry(entry) {
  if (entry.blobUrl || entry.prefetchError) return entry;
  if (entry.prefetch) return entry.prefetch;
  entry.prefetch = (async () => {
    const response = await fetch(entry.audioUrl);
    if (!response.ok) throw new Error(`Audio segment returned HTTP ${response.status}`);
    const blob = await response.blob();
    entry.blobUrl = URL.createObjectURL(blob);
    return entry;
  })().catch(error => {
    entry.prefetchError = error;
    throw error;
  });
  return entry.prefetch;
}

async function playNextSegment() {
  if (!state.playing || state.segmentLoading || !state.segmentQueue.length || !audio.paused) return;
  state.segmentLoading = true;
  const token = state.segmentToken;
  const entry = state.segmentQueue.shift();
  state.currentSegment = entry;
  try {
    if (!entry.blobUrl) await prefetchEntry(entry);
    if (token !== state.segmentToken || !state.playing) return;
    if (entry.prefetchError) throw entry.prefetchError;
    if (state.activeBlobUrl && state.activeBlobUrl !== entry.blobUrl) URL.revokeObjectURL(state.activeBlobUrl);
    state.activeBlobUrl = entry.blobUrl;
    entry.blobUrl = null;
    audio.src = state.activeBlobUrl;
    await audio.play();
    if (token !== state.segmentToken || !state.playing) return;
    setPlayerStatus('PLAYING');
    if (entry.text) showCaption(entry);
    else noteCaptionPending();
    const next = state.segmentQueue[0];
    if (next) void prefetchEntry(next);
  } catch (error) {
    if (token === state.segmentToken) { setError(error.message); setPlayerStatus('ERROR'); }
  } finally {
    if (token === state.segmentToken) { state.segmentLoading = false; if (audio.paused && state.segmentQueue.length) void playNextSegment(); }
  }
}

function enqueueSegment(raw) {
  const entry = {
    channel: raw.channel,
    sequence: raw.sequence,
    text: raw.text || '',
    time: raw.time,
    durationMs: raw.durationMs || 5_000,
    audioUrl: raw.audioUrl,
    blobUrl: null,
    prefetch: null,
    prefetchError: null,
    captionShown: false,
  };
  state.segmentBySequence.set(entry.sequence, entry);
  if (state.captionStandalone) {
    if (entry.text) showCaption(entry);
    return;
  }
  state.segmentQueue.push(entry);
  void prefetchEntry(entry);
  void playNextSegment();
}

function startCaptions(standalone = false) {
  stopCaptions();
  if (!state.selected) return;
  if (!window.EventSource) { setError('This browser does not support live radio events.'); return; }
  const source = new EventSource(`/api/radio/${state.selected.id}`);
  state.captionSource = source; state.captionStandalone = standalone;
  $('caption-toggle').textContent = standalone ? 'Stop captions' : 'Captions on';
  $('caption-toggle').setAttribute('aria-pressed', 'true'); $('caption-toggle').disabled = !standalone;
  $('caption-status').textContent = 'LISTENING'; $('caption-status').classList.add('active');
  const emptyMessage = $('transcript').querySelector('.empty-transcript p');
  if (emptyMessage) emptyMessage.textContent = 'Buffering 5 seconds of live radio…';
  source.addEventListener('status', event => {
    if (source !== state.captionSource) return;
    const status = JSON.parse(event.data);
    const message = $('transcript').querySelector('.empty-transcript p');
    if (message) message.textContent = status.message;
    $('caption-status').textContent = status.processing ? 'PROCESSING' : 'LISTENING';
    $('caption-status').classList.add('active');
  });
  source.addEventListener('segment', event => {
    const entry = JSON.parse(event.data);
    if (source !== state.captionSource || entry.channel !== state.selected?.id) return;
    enqueueSegment(entry);
  });
  source.addEventListener('caption', event => {
    const payload = JSON.parse(event.data);
    if (source !== state.captionSource || payload.channel !== state.selected?.id) return;
    applyCaption(payload);
  });
  source.addEventListener('warning', event => { if (source === state.captionSource) setError(JSON.parse(event.data).message); });
  source.addEventListener('error', event => {
    if (source !== state.captionSource) return;
    if (event.data) {
      try { setError(JSON.parse(event.data).message); stopAudio(); setPlayerStatus('ERROR'); } catch { /* Ignore malformed status. */ }
    } else { $('caption-status').textContent = 'RECONNECTING'; }
    $('caption-status').classList.remove('active');
  });
}

$('caption-toggle').addEventListener('click', () => { if (state.captionSource) stopCaptions(); else startCaptions(true); });

function togglePlay() {
  if (state.playing) return stopAudio();
  setError(''); state.playing = true;
  setupVisualizer(); setPlayerStatus('CONNECTING');
  $('play-button').textContent = 'Ⅱ'; $('play-button').classList.add('playing'); $('play-button').setAttribute('aria-label', 'Stop radio');
  $('sync-play').textContent = 'Ⅱ'; $('sync-play').setAttribute('aria-label', 'Stop synchronized radio');
  $('live-line').textContent = 'Buffering the first 5 seconds of live radio…';
  startCaptions(false);
}

$('play-button').addEventListener('click', togglePlay);
$('sync-play').addEventListener('click', togglePlay);
$('mute-button').addEventListener('click', () => { audio.muted = !audio.muted; $('mute-button').textContent = audio.muted ? '×' : '◖))'; $('mute-button').setAttribute('aria-label', audio.muted ? 'Unmute audio' : 'Mute audio'); });
$('volume').addEventListener('input', event => { audio.volume = event.target.value / 100; $('volume-value').textContent = `${event.target.value}%`; }); audio.volume = .7;
audio.addEventListener('ended', () => {
  audio.removeAttribute('src');
  audio.load();
  if (!state.playing) return;
  if (state.segmentQueue.length) { setPlayerStatus('PLAYING'); void playNextSegment(); }
  else setPlayerStatus('CONNECTING');
});
audio.addEventListener('error', () => { if (audio.src && state.playing) { stopAudio(); setPlayerStatus('ERROR'); setError('The buffered audio segment could not be played.'); } });
function setupMap(airport) {
  if (!window.L) { $('map-fallback').hidden = false; return; }
  const map = L.map('map', { zoomControl: false }).setView([airport.lat, airport.lon], airport.zoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  state.airportMarker = L.marker([airport.lat, airport.lon], { icon: L.divIcon({ className: '', html: '<div class="airport-marker"></div>', iconSize: [25, 25], iconAnchor: [12, 12] }) }).addTo(map);
  state.map = map; state.markers = L.layerGroup().addTo(map);
  $('recenter').addEventListener('click', () => { const selected = state.airport; if (selected) { clearFlightFocus(); map.setView([selected.lat, selected.lon], selected.zoom); } });
  setTimeout(() => map.invalidateSize(), 100);
}

async function updateAircraft() {
  const icao = state.airport?.icao;
  if (!icao) return;
  try {
    const response = await fetch(`/api/aircraft?icao=${icao}`); const data = await response.json();
    if (state.airport?.icao !== icao) return;
    if (!response.ok) throw new Error(data.error);
    $('aircraft-count').textContent = data.aircraft.length;
    $('aircraft-metric').textContent = data.aircraft.length;
    $('map-data-source').textContent = data.sources?.opensky ? 'AIRCRAFT DATA: ADSB.FI + OPENSKY' : 'AIRCRAFT DATA: ADSB.FI';
    $('aircraft-updated').textContent = data.stale ? 'Cached' : new Date(data.updatedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (!state.map) return;
    if (state.lastAircraftUpdate === data.updatedAt) return;
    state.lastAircraftUpdate = data.updatedAt;
    state.aircraft = data.aircraft;
    const traffic = updateAirportTraffic(state.airport, data.aircraft, state.trafficByAirport.get(icao));
    state.trafficByAirport.set(icao, traffic.records);
    state.trafficCandidates = traffic.candidates;
    $('tower-count').textContent = traffic.candidates.length;
    const candidateByIcao = new Map(traffic.candidates.map(plane => [plane.icao24, plane]));
    const visible = new Set();
    data.aircraft.forEach(plane => {
      visible.add(plane.icao24);
      const heading = Number.isFinite(plane.heading) ? plane.heading : 0;
      const focused = plane.icao24 === state.focusedIcao24;
      const altitude = Number.isFinite(plane.altitudeM) ? `${Math.round(plane.altitudeM * 3.28084).toLocaleString()} ft` : 'Altitude unknown';
      const registration = plane.registration && plane.registration !== plane.callsign ? ` · ${plane.registration}` : '';
      const candidate = candidateByIcao.get(plane.icao24);
      const airportStatus = candidate ? ` · ${PHASE_LABELS[candidate.phase]} · ${candidate.distanceNm.toFixed(1)} NM from ${icao}` : '';
      const label = document.createElement('div'); label.textContent = `${plane.callsign}${registration} · ${plane.onGround ? 'On ground' : altitude}${airportStatus} · ${plane.source || 'Aircraft feed'}`;
      let marker = state.markersByIcao.get(plane.icao24);
      if (marker) {
        marker.setLatLng([plane.lat, plane.lon]);
        marker.setPopupContent(label);
      } else {
        marker = L.marker([plane.lat, plane.lon], { icon: L.divIcon({ className: focused ? 'aircraft-marker aircraft-focused' : 'aircraft-marker', html: `<span style="display:inline-block;transform:rotate(${heading}deg)">✈</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }), zIndexOffset: focused ? 1000 : 0 });
        marker.bindPopup(label, { autoPan: false }).addTo(state.markers);
        state.markersByIcao.set(plane.icao24, marker);
      }
      const element = marker.getElement();
      if (element) {
        element.classList.toggle('aircraft-focused', focused);
        element.classList.toggle('aircraft-opensky', plane.source === 'OpenSky');
        element.classList.toggle('airport-traffic', Boolean(candidate));
        const glyph = element.querySelector('span'); if (glyph) glyph.style.transform = `rotate(${heading}deg)`;
      }
    });
    for (const [icao24, marker] of state.markersByIcao) if (!visible.has(icao24)) { state.markers.removeLayer(marker); state.markersByIcao.delete(icao24); }
    if (state.focusedIcao24 && !state.markersByIcao.has(state.focusedIcao24)) clearFlightFocus();
    const pending = state.pendingFocus;
    if (pending && Date.now() - pending.at < 20_000) focusAircraft(pending.icao24, pending.kind, pending.durationMs, pending.confidence || 'high');
    else if (pending) state.pendingFocus = null;
  } catch { if (state.airport?.icao === icao) $('aircraft-updated').textContent = 'Unavailable'; }
}

async function init() {
  try {
    const response = await fetch('/api/config'); if (!response.ok) throw new Error('Unable to load airport configuration');
    const config = await response.json(); window.APP_CONFIG = config; state.channels = config.channels; state.airports = config.airports;
    renderAirportList(); setupMap(state.airports[0]); selectAirport(state.airports[0].icao); setInterval(updateAircraft, 5_000);
  } catch (error) { setError(error.message); }
}
init();
