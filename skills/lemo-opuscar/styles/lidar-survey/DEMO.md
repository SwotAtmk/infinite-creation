# LiDAR Survey — our demo

One example among many. Don't reuse its story, arc, shots, props or timings.

Demo: *The Fields Under the Forest* 《林下的田》 (40.0 s) · `lidar-survey.mp4` · source in [`demo/`](demo/)

From the air, a patch of Ashford, Connecticut is only forest. A laser survey turns the photo into points, a cutting plane strips the canopy layer by layer, and the ground that is left condenses into a surface with stone walls on it: the field system of farms that were here, 3.4 km of wall traced in 0.74 km². One wall is cut and measured; the town's history comes in two numbers; the forest grows back over the walls. Chinese on screen, English narration, bilingual subtitles (Chinese line above, English line below). This is an unofficial film made from public-domain survey data and imagery; the U.S. Geological Survey, the USDA and the town of Ashford did not make or endorse it.

## Story & structure

Logline: from the air it is only forest; take away every return that hit a tree and the ground still holds the walls of the fields.

Arc: a claim (a July 2016 aerial photo, nothing but canopy) → the medium changes (a scan line turns the photo into the spring 2016 lidar cloud; 27.6 % of the returns reached the ground) → the peel (a horizontal plane steps down 30 → 0 m on the beat, returns above it lift away and glow, a ruler with the canopy's height histogram tracks it) → near silence over the bare ground returns → the turn (a second scan condenses the ground returns into a raking-lit surface; an impact) → the walls light up one after another as the camera rises → the measurements (3.4 km traced; a section through one wall from 1,451 raw ground returns: 0.56 m high, 2.5 m wide at half height) → history (Ashford 1870: 67.3 km² cleared farmland; 2006: 80.2 km² forest) → the forest grows back as a ghost over the glowing walls; end card.

Native moves spent: *photo to points* at the opening; *the canopy peel* as the signature shot; *points condense* at the turn; *the section* for the detail; *the window* (the survey area as a stage inside the dim, unpeeled cloud) throughout; *the regrowth* as the ending.

Every number and its source is in [`demo/FACTS.md`](demo/FACTS.md); measured values are labelled as measured or traced on screen.

## Shots

One continuous camera (C1 spline over time in target, distance, heading, pitch). Times in seconds.

| # | Time | Shot | Camera | Native move / note |
|---|---|---|---|---|
| 1 | 0.0–3.75 | NAIP July 2016 photo on the canopy surface, north up; label 2016 年 7 月 · 夏季航拍 | nadir, push 480 → 395 m with a 6° turn | the claim, held still enough to read as a photo |
| 2 | 3.75–6.9 | a scan line crosses left → right; behind it the photo is the point cloud (colour = height above ground) | crane down, tilt nadir → 44° | photo to points; crackle and sweep on the line |
| 3 | 6.9–10.0 | the cloud; reading 打到地面的回波 27.6 % (lands 7.5) | crane down to a low oblique, 105 m, 15° pitch | canopy as a layer above the ground returns |
| 4 | 10.0–13.1 | **signature**: the cutting plane at 30, 24, 18, 12, 6, 0 m, one step per beat; returns above lift away and glow; ruler + histogram on the right edge | slow orbit +12°, 92–105 m | the canopy peel; ticks divide, one descending blip per layer |
| 5 | 13.1–14.4 | only ground returns left, grey stripes of the scan pattern | orbit continues | near silence |
| 6 | 14.4–15.9 | a second scan condenses the ground returns into the surface (local relief ×2, raking sun from the north-west) | pull back 100 → 170 m | points condense; the impact |
| 7 | 15.6–20.0 | 22 traced walls light up in order along the network, amber hairlines on the crests | rising pull-back to 480 m, 48° | scale reveal of the field system |
| 8 | 20.0–24.4 | reading 已描出的石墙 3.4 km (rolls 20.0–20.6), 22 段 | drift, heading 12° → −12° | held 3.75 s |
| 9 | 24.4–28.75 | push to wall C; a section line glows across it; a chart of the 1,451 raw ground returns (vertical ×5) with the median profile and dimensions 0.56 m / 2.5 m | push 230 → 88 m, pitch 34° → 21°, creep | the section |
| 10 | 28.75–35.6 | crane up; card 1870 · 67.3 km² 开垦为农田 (29.4), card 2006 · 80.2 km² 为森林 (32.5), bars against the town's ~100 km² | crane up and back to 470 m, 56° | the surface dims a little under the cards |
| 11 | 33.75–40.0 | the canopy regrows as a faint additive ghost from the ground up; walls glow through; end card from 35.9 | slow rise 470 → 560 m | the regrowth |

## Score structure

96 BPM, 4/4 (beat 0.625 s); every picture cue on a beat or half-beat (`demo/tools/cuecheck.py`: 0 ms on 17 cues). D minor in the dry first half, F major from the turn.

| Section | Time | Palette | Notes |
|---|---|---|---|
| Canopy | 0–3.75 | forest bed (filtered wind in leaves, gusts, synthesized two-note bird calls), Dm pad | |
| Laser | 3.75–10 | FM blips on 8ths (D5 A5 F5 A5 …), scan sweep 700 → 3800 Hz with fine crackle, pulse bass D2/C2 on 8ths from 5.0 | the forest bed fades out by 5.2 |
| Peel | 10–13.1 | ticks 8ths → 16ths → 32nds, one FM ping per layer D6 A5 F5 D5 A4, upward shimmer sweeps | acceleration by subdivision |
| Silence | 13.1–14.4 | air bed only (−22 dB under the programme median), a reversed noise swell from 13.4 | |
| Turn | 14.4 | bass drum + gran cassa + timpani F2, a settling sweep; bowed vibraphone A4/E5 | −1.9 dB under the loudest moment, after a −16 dB dip |
| Walls | 15.6–20 | marimba on half-beats through F major pentatonic; pads F–Dm–B♭–C, pulse bass returns | the one wooden timbre |
| Measure | 20–28.75 | ratchet clicks while 3.4 rolls, ping C6 on landing; suck-out 24.1–24.4, sweep + timpani D2 + bass drum on the cut, ping A5 on the reading | |
| History | 28.75–35.6 | rising sine glide for each bar, marimba on its landing | |
| End | 33.75–40 | grains for the regrowth; forest bed J-cut from 34.4; F-major chord (marimba, pad, bowed vibraphone, soft timpani) | |

Mix (in `mix.py`): music −10 dB under the voice and ducked ~5 dB while it speaks, pulse, foley and beds below; bus compression on music, pulse, foley and beds only; sub-bass high-passed at 38 Hz (46 Hz on hits) with a −5 dB shelf below 62 Hz; master stage to −14.4 LUFS with a true-peak limiter at −4.6 dBTP so `mux.sh` stays linear. The film measures −14.0 LUFS, peak −3.9 dBFS, LRA 2.4 LU (`demo/tools/audiocheck.py` for the impacts and the silence).

## Palette & props

- Background #05080A; canopy ramp #1F3F35 → #5C9A7A → #E2F3DC by height above ground (0–28 m), intensity on value; ground returns #C8B38C; surface #BDB5A6 lit from azimuth 315°, 26° up; fronts #D4FFF0; accent #FFB347 (walls, readings, section); chart green #83C495.
- Props: the 2016 NAIP photo draped on a 1 m canopy surface; 4,789,797 returns; a 0.5 m ground model; 22 walls traced by hand on a local relief model and snapped to the crests (`demo/data/walls_traced.json` → `walls.json`); wall C's cross-section (`data/profile_C.json`).
- The survey window: x < 235 m (east of it are a gravel lane and houses, kept as dim unpeeled points).
- Narrator: Kokoro `bm_george`, speed 1.0.

## End card

Left third over the dimmed field system while the canopy regrows: 林下的田 (Noto Sans SC 500), *The Fields Under the Forest*, a short amber rule, `LIDAR SURVEY · 点云测绘`, `LemoLab × Claude Opus 5.5`. 4.1 s. The "LemoLab × Claude Opus 5.5" sign-off belongs to this library's demo only; a user's film carries no LemoLab credit and no copy of this card.

## Build notes

```
demo/
  build.sh          one command: (data) → voice → speech check → cues → events → video → mix → master → .srt → checks → poster
  index.html        two canvases (WebGL scene, 2D overlay), fonts
  film.js           render(t): points / surface / photo shaders, camera spline, fronts, cutting plane, overlay, subtitles, EV
  timeline.js       beats, cues, peel steps, narration, camera keys (single source; tools/export.mjs → timeline.json, cues.json, voice/lines.json)
  mix.py            score, foley, beds, voice, mix → out/mix.wav + out/stems/
  data/             walls_traced.json (hand tracing), walls.json, profile_C.json, facts.json (all on-screen numbers)
  tools/            fetch_ept.py, terrain.py, load.py, walls.py, trace.py, profile.py, build_data.py, fetch_naip.py, fonts.py,
                    scout_dem.py (finding the site); export.mjs (voice/cues); cuecheck.py, subcheck.mjs, audiocheck.py, motioncheck.py (checks)
  assets/raw/       ept/ (EPT nodes), work/ (DTM, relief), build/ (points.bin, ground.bin, canopy.bin, naip.jpg), fonts/, .venv (laspy, lazrs, scikit-image)
  FACTS.md, CREDITS, stills/styleframe.jpg
```

- `sh demo/build.sh` takes about 5 minutes on Apple silicon (the picture renders in ~30 s with 3 workers; Kokoro and the Whisper check take most of the rest). With no data yet, or `FETCH=1`, it first fetches and builds the data (~3 minutes, ~350 MB in `assets/raw/`).
- Fonts (Barlow Condensed, IBM Plex Mono, Noto Sans SC) are not in git: `tools/fonts.py` fetches them from github.com/google/fonts when missing and subsets the CJK font. The data tools run in a private venv (`assets/raw/.venv`: laspy, lazrs, scikit-image, fonttools) that build.sh creates.
- Checks it runs: `asr_check.py` with `small.en` (0 mismatches), cue overlap from real voice durations, cue grid, subtitle single-line widths with the real fonts (widest 595 px against 1100 px), `readcheck.mjs`, motion per second (no flat stretch > 1 s, no cut-like jump).
- Data notes: the EPT copy is Web Mercator; everything is converted to a local metric frame around 41.8875° N, 72.1960° W. The provider's class 1 mixes vegetation and buildings; low vegetation just above the ground survives a cut at 0 m, so the plane finishes at −6 m. The ground model is triangulated from class-2 returns (1.3 M) at 0.5 m.
- Demo-specific pitfalls: the leaf-off canopy reads as a flat carpet from more than ~150 m, so the peel is shot low and close; a pond in the north-east has no returns (a black hole outside the window); the regular scan-line striping of the ground returns is strongest at grazing angles; the second scan must start just outside the frame or the first frames jump.
