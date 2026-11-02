# Exploded Teardown — our demo

One example among many. Don't reuse its story, arc, shots, props or timings.

Demo: *21 Keys, Opened* 《二十一键》 (38.75 s) · `teardown.mp4` · source in [`demo/`](demo/)

One half of the open-source Corne v4 split keyboard (foostan/crkbd, CC BY 4.0 / MIT), built from the project's own KiCad board, switch-plate file, case STEP, bill of materials and build guide. Chinese on screen, English narration, bilingual subtitles (Chinese line above, English below). Every number on screen and in the voice is in [`demo/FACTS.md`](demo/FACTS.md). The project's name and logo are not shown in the picture (only in the end-card credit line); the chip and part numbers are component designations from the BOM, and no package top carries a marking. This is an unofficial film made from the project's published files; the Corne project and its author (foostan) did not make or endorse it.

## Story & structure

Logline: twenty-one keys look like one object; opened, they are six layers drawn in public files, down to the chip, the lights and the sockets; closed again, every size on them is a published number.

Arc: touch (a grazing macro over the keycaps, one real keystroke) → the opening (one orbit, layers lift top first, keys in a wave, six labels) → inside (a dive into the room between the board and the case, looking up at the back of the board: the RP2040, the flash, a reverse-mounted LED; then a rise through the plate to the switch pins) → back together (a fast pull back, bottom-first closing, keys land with their stroke) → the numbers on the object (key pitch, width, depth, height as dimension lines) → end card.

Native moves spent: *one real keystroke* in the opening; *the wave lift* at the separation; *inside the gap* and *the leader that lands on the part* for the three stops; *lights on inside* at the LED; *dimensions drawn on the thing* before the card.

## Shots

One continuous camera. Times in seconds; 96 BPM, bar = 2.5 s.

| # | Time | Shot | Camera | Native move / note |
|---|---|---|---|---|
| 1 | 0.0–2.5 | keycap tops, the orange 1.5u key in the foreground, a soft light gliding across | grazing macro dolly, eye 33 mm above the floor, lens 30° | hook: material, a light sweep |
| 2 | 2.5–4.4 | the orange key travels its 4 mm stroke at 3.13 and returns; pull up to the whole half | dolly → three-quarter hero, 330 mm | one real keystroke |
| 3 | 4.4–5.0 | held | orbit continues | silence 1 (room tone, a rising suck) |
| 4 | 5.0–7.5 | keys rise in a wave from the back-left corner, then switches, plate, board, spacers, case; feet stay on the floor | orbit −31° → −9°, pulls back to 432 mm, model slides left (view offset 170 px) | the wave lift; hit at 5.0 |
| 5 | 6.9–11.9 | six labels draw in down the right column: 键帽 1u ×20 · 1.5u ×1, 机械轴体 十字轴 ×21, 定位板 FR-4 1.6 mm, 电路板 双层 1.6 mm, 铜柱 M2 × 7.5 mm ×4, 外壳 底厚 2.0 mm | slow orbit to +18°; at 10.0 the board and everything above rise 30 mm more | signature frame at 9.75 (poster) |
| 6 | 12.5–15.0 | down past the plate and the board edge into the gap; the case's interior lights up | dive, 452 mm → 30 mm, tilting up | the dive swoosh starts 0.35 s before |
| 7 | 15.0–18.1 | the back of the board: RP2040 (7 × 7 mm), flash (16 MB), crystal, 0402 parts, sockets, all at footprint positions | held macro, eye 24 mm under the board, slow drift | leader lands on the chip |
| 8 | 18.1–21.3 | slide to LED10: the reverse-mounted LED; the lights on the top side come on | macro slide 9 mm | lights on inside |
| 9 | 21.3–22.3 | out from under the board, up past the plate | rise through the stack | transition |
| 10 | 22.3–25.0 | the thumb-row switches seen from below: pins over the hot-swap holes; label 热插拔 ×21 | held macro at pin height, switches lifted a further 16 mm | silence 2 at 24.6–25.0 |
| 11 | 25.0–27.6 | fast pull back; the case comes up, board, plate, switches; the keys land last in a wave, each with its stroke | pull to 380 mm, three-quarter high | the loudest moment (26.6) |
| 12 | 27.5–33.7 | dimension lines on the closed half: 键距 19.05 mm, 138.4 mm, 97.6 mm, 11.1 mm | high three-quarter drift, az 20° → 40°, 374 → 336 mm | dimensions drawn on the thing |
| 13 | 33.75–38.75 | end card on the left, the keyboard turning on the right | drift az 40° → 59°, view offset −230 px | |

## Score structure

96 BPM, 4/4, D (Dm9 – B♭maj7 – F – C/E per bar), D major on the card. Every hit sits on a beat or half-beat of `src/timeline.js`.

| Section | Time | Palette | Notes |
|---|---|---|---|
| Touch | 0–4.4 | marimba in 8ths (soft), bowed vibraphone, room tone | the keystroke: switch click + low thock + return clack |
| Silence 1 | 4.4–5.0 | room tone, a filtered-noise suck | |
| Opening | 5.0–12.5 | marimba 16ths, electric bass, synth kick on 1 and 3, claves on 2 and 4, closed hi-hat 16ths | 21 plastic ticks in the wave, swooshes per layer, a ring for the brass, a thud for the case, a tick per label |
| Inside | 12.5–24.4 | bowed vibraphone chords, glass motif, pedal hi-hat in 8ths, sub kick once a bar | glockenspiel pings on each stop (A5, D6, E6), an arpeggio for the lights |
| Silence 2 | 24.6–25.0 | room tone only | |
| Closing | 25.0–33.75 | groove returns, four on the floor | 21 key landings (clack + click), board taps, the case thud; a pen hiss per dimension |
| Card | 33.75–38.75 | D-major marimba roll, bowed vibraphone D–F♯–A, bass D, glockenspiel answers | long tail |

Mix (`demo/mix.py`): voice compressed and about 8–10 dB over the music while it speaks (music ducked 55 % on the voice envelope), music high-passed at 44 Hz, foley at 36 Hz; loudest moments in order: the landings (26.6), the card, the pull back (25.0), the opening hit (5.0). The film measures −14.2 LUFS integrated, LRA 4.9 LU, true peak about −1 dBTP; 20–60 Hz sits 12.5 dB under the full band.

## Palette & props

- Ground #34363a → #0d0e10; ink #f1efe9; accent #ff6b3d (labels' indices, dimension lines, the 1.5u key, the switch stems).
- Keycaps: off-white #d9d4c9, grey #686c73 on the outer column and thumbs, the 1.5u thumb key orange; uniform-height sculpted profile drawn in code. Switches: cross-stem generic (14 mm bottom, 15.6 mm top housing), drawn in code. Plate black FR-4 with a warm core edge; board green mask, gold pads; brass hex spacers; dark screws; anodised-look case (the files do not name a material; the look is a render choice).
- Narrator: Kokoro `am_michael`, speed 0.95.

## End card

二十一键 (Noto Sans SC 500), *21 Keys, Opened* (Inter Light), `产品拆解 · EXPLODED TEARDOWN`, `CAD：foostan/crkbd · CC BY 4.0`, `LemoLab × Claude Opus 5.5`, an orange rule; the closed keyboard drifting on the right. 5 s. The "LemoLab × Claude Opus 5.5" sign-off belongs to this library's demo only; a user's film carries no LemoLab credit and no copy of this card.

## Build notes

```
demo/
  build.sh          one command: voice → speech check → cues → events → video → mix → master → .srt → checks → poster
  index.html        WebGL canvas + 2D marks canvas, fonts
  src/timeline.js   the single timeline: beats, layer timings, gaps, narration, label windows, camera keys
  src/main.js       scene, layers, explode/gap, camera (monotone keys), lights, render(t), window.EV
  src/parts.js      keycap, switch, outline extrusion, spacer, screw geometry
  src/pcbtex.js     board textures painted from the KiCad data
  src/comps.js      back-side parts at footprint positions
  src/overlay.js    labels, dimensions, subtitles, end card, readcheck texts, subtitle width check
  mix.py            score (sampler), foley (synthesised), voice, mix → out/mix.wav + out/stems/
  tools/            extract_pcb.py, kicad_geom.py, sexp.py, step2mesh.mjs, fetch_cad.sh (data); fetch_fonts.py;
                    export.mjs (voice lines, cues, timeline.json); subcheck.mjs, motioncheck.py (checks)
  data/             pcb.json (left half, extracted), case.bin (case mesh)
  FACTS.md, CREDITS, stills/styleframe.jpg
```

- `sh demo/build.sh` takes about 3 minutes on Apple silicon (picture about 60 s with 4 workers). In a clean clone it first rebuilds what git does not carry: `data/case.bin` and `data/pcb.json` from the CAD at the pinned commit (network, and npm for a temporary occt-import-js), the fonts from Google Fonts, and any missing library pack (HDRI, Kokoro, the vcsl / freepats / vsco2ce samples). `FETCH=1` forces the CAD and fonts.
- Checks it runs: `asr_check.py` with `small.en` (two lines carry the words Whisper writes: "RP 2040", "19.05 millimeters"), subtitle single-line widths with the real fonts (widest 552 px against 1500), `readcheck.mjs` (all 19 texts pass), `motioncheck.py` (no one-frame black tiles; motion per second).
- Demo-specific pitfalls: the v4 board file is a panel with breakaway tabs, so the board outline is the 3x6 plate outline inset 0.4 mm (the plate's 21 cutouts sit 0.4 mm off the switch footprints, measured, and corrected); the case STEP has y up and must be flipped and shifted onto the board (offsets in `tools/step2mesh.mjs`), checked by the four screw holes; the project logo footprint is skipped at extraction; the Kokoro voice reads "RP2040" badly, so the spoken text says "R P twenty forty".
