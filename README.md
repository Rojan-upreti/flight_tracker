# Airport Radio Tracker

A local monitor for KCDW, KEWR, KJFK, and KLAX with an OpenStreetMap map, nearby aircraft from adsb.fi and OpenSky, processed radio audio, and live captions. KCDW has ATIS and two clearance/ground/tower feeds; KEWR has Tower; KJFK has a combined Ground/Tower feed; KLAX has Final App and Dep/West App.

## Run

1. Install Node.js 20.12 or newer and FFmpeg. FFmpeg must be on `PATH`, or set `FFMPEG_PATH`.
2. Copy `.env.example` to `.env` and set `DEEPSEEK_API_KEY` if you want captions. The API key stays on the backend.
3. Start the server:

   ```sh
   npm start
   ```

4. Open `http://localhost:3000`.

Select a radio channel and press **Play** below the map or in the radio panel. Audio streams continuously in 5-second chunks and is sent to the browser as soon as each chunk is ready—DeepSeek captions are not required for playback. Captions arrive on a separate event keyed by the same chunk sequence and attach when ready (including while that chunk is playing). The caption uses a typewriter effect, shows roughly 30 words at once, and fades near the end of the chunk. **Start captions** runs text only. The initial delay is about 5 seconds of audio buffering; captions may lag briefly behind if transcription is slow, but audio is never skipped.

The map marks **possible tower traffic** for the selected airport using fresh position, ground status, altitude, heading, climb or descent, and distance from the airport. Its popup shows the inferred phase and distance. Recent aircraft observations are kept in browser memory for up to 90 seconds so movement can help classify an approach or departure. These labels are estimates: neither live feed confirms that an aircraft is scheduled to land at or depart from that airport.

When a caption names a nearby aircraft, the map highlights its marker, opens its callsign popup, and zooms in on that aircraft. The highlight lasts for that audio chunk, clears when it finishes, and switches to a new aircraft when the next caption names one. The marker keeps moving as new positions arrive. The matcher understands common airline telephony names, codes such as `AA 166`, spoken flight numbers, and phonetic registrations such as “November one two three Alpha Bravo.” A number alone is matched only against the selected airport's current tower candidates; an ambiguous number leaves the map unchanged. A full callsign can also match a nearby aircraft just outside the shortlist. The caption gets a button to refocus that aircraft briefly. Matching depends on a feed reporting a current position and callsign for the plane.

No npm dependencies are required. Map tiles and Leaflet load from the internet. The browser checks aircraft positions every 5 seconds. The backend uses regional aircraft queries: one New York metro query shared by KCDW/KEWR/KJFK, and a separate Los Angeles basin query for KLAX. Each region requests a 100 NM area from adsb.fi at most every 5 seconds and an OpenSky snapshot at most every 30 seconds. It merges aircraft by transponder ID and excludes positions older than 50 seconds. If one feed is unavailable, the other still supplies positions. No feed can guarantee every aircraft is visible. adsb.fi requires attribution and permits personal, non-commercial use. OpenSky's anonymous API has a 10-second time resolution and 400 daily credits, so its supplemental feed may pause when the quota is exhausted.

## Audio source

The supplied LiveATC links are **player pages**, not raw media URLs. The backend uses their matching direct mounts at `https://d.liveatc.net/`. These were reachable during development, though source access may change. If access is denied, set an authorized direct stream URL in `.env` (`KCDW_ATIS_STREAM_URL`, `KCDW_RADIO_1_STREAM_URL`, `KCDW_RADIO_2_STREAM_URL`, `KEWR_TOWER_STREAM_URL`, `KJFK_MAIN_TOWER_STREAM_URL`, `KLAX_FINAL_APP_STREAM_URL`, or `KLAX_DEP_WEST_APP_STREAM_URL`). The player shows an error if the source cannot be reached. LiveATC identifies the EWR mount as Tower #1 on 118.300 MHz, the JFK mount as a ground/tower feed (119.100 / 123.900 MHz), LAX Final App on 128.500 MHz, and LAX Dep/West App on 124.500 / 124.300 / 125.200 MHz.

FFmpeg applies a voice bandpass (180–3500 Hz), compression, and limiting before creating 5-second PCM chunks. Each WAV is stored for the browser immediately; the same PCM is transcribed in parallel (up to two chunks at once) and a `caption` SSE event is emitted when text is ready. Captions are aligned at the chunk level; word-by-word timing is an animation because DeepSeek does not provide word timestamps. Recent audio chunks are held in server memory (about three minutes) and expire after the listening session ends. Caption wording can contain errors, so do not use it for aviation decisions. JFK's 119.100 and 123.900 MHz tabs use the same combined feed; they cannot isolate each frequency with the supplied source.

Check the source provider's terms and obtain any required permission before distributing or hosting a product that rebroadcasts its audio. The source links remain visible in the interface.

## Endpoints

- `GET /api/config` — airport and channel definitions
- `GET /api/aircraft?icao=KCDW`, `?icao=KEWR`, `?icao=KJFK`, or `?icao=KLAX` — merged nearby aircraft from both feeds
- `GET /api/radio/:channel` — live radio SSE (`segment` for audio, `caption` for text by sequence)
- `GET /api/segments/:session/:sequence` — the exact WAV chunk for one event

Channel IDs: `atis`, `radio-1`, `radio-2`, `ewr-tower`, `jfk-main-tower`, `lax-final-app`, `lax-dep-west-app`.

## Live radio events

Each `/api/radio/:channel` session emits:

- `segment` — audio chunk metadata (`sequence`, `audioUrl`, `durationMs`) as soon as PCM is ready
- `caption` — DeepSeek text for that `sequence` when transcription finishes
- `status` / `warning` / `error` — buffering, caption lag, and stream failures

The browser prefetches WAV segments for continuous playback and attaches captions by sequence even if they arrive late.
