# Style Name — Style Prompt

> One or two sentences: what the medium is and what it does on screen. No demo title, no story.
> References (grammar only): films, artists or traditions to learn the grammar from, and what to take from each. Never copy their characters, layouts, typefaces or music, and never name them in the film.

<!--
How to fill this template (delete this comment):
- This file holds only what stays true for EVERY film in this style: look, material, colour logic, type, motion quality,
  camera vocabulary, sound palette, the medium's native moves and pitfalls. 6–11 KB.
- No story, arc, beat-by-beat shot table, prescribed opening or ending, score arc, BPM or key, demo durations, demo palette or props, end card or sign-off.
  All of that goes to DEMO.md.
- A number measured in the demo becomes a rule here ("the subject fills ≥ 1/3 of the frame"); the demo's actual value
  can stay as an example in DEMO.md.
- Write rules, not history. "Pitfalls" are pitfalls of the medium, not of one demo prop.
- Section numbers are fixed: other guides refer to them.
-->

## 1. Essence, and what it is not

What makes a frame read as this style in one glance (3–5 defining traits). Then the styles it is easily confused with and the line between them ("not a keynote, not a blueprint, not a product render").

## 2. Materials & rendering

The physical medium and how code imitates it: surfaces, marks, layers, edges, texture, light. Name the rendering model (layers, blend modes, noise, stepping of marks). Say which effects must be procedural and anchored to the world, and which live in screen space.

## 3. Colour logic

Rules, not a palette: how many hues, what the neutral ground is, what the accent is reserved for, how values are ordered, what may never be coloured. Give one example palette at most, marked as an example.

## 4. Type & subtitles

Typefaces (licence-free), roles (title, subtitle, micro data), sizes as ranges, how subtitles belong to the world of the style (inscription, caption, HUD plate…), reading-time rule: hold ≥ max(1.8 s, speech + 0.6 s).

## 5. Motion quality

Frame rate and stepping (on ones / twos, what boils), easing families, weight, jitter, how things appear and disappear. What never moves.

## 6. Camera grammar

A vocabulary, not a route: the moves this medium does well, what each expresses, and a few kinds of moment it can serve. Opening and ending come from the topic.

| Move | What it expresses | Can serve |
|---|---|---|
| e.g. slow lateral pan | … | a journey; a list; time passing |
| e.g. locked frame | … | a decision; a reveal; reading time |
| e.g. push-in | … | tension; the one detail that matters |

No row names the single move for an opening, a climax or an ending. If the demo's route is worth keeping, it goes to DEMO.md "Shots". Framing rules that always hold (subject size, safe areas, where text lives). Allowed and forbidden transitions.

## 7. Sound palette

Instruments and timbres, articulations, tuning or mode families, foley materials (what the style's matter sounds like), ambience, silence as a tool (what it may contain, how it is cut), mix character (ducking, loudness −14 LUFS), voice character. A technique may be written as one option ("divide the beat to accelerate instead of changing tempo"). No score arc, no section sequence, no BPM or key: those are the demo's and go to DEMO.md "Score structure".

## 8. Native moves

A menu of moments only this medium can do: use the ones your story needs. For each: what it is, how to build it, and **fits content like…** with three or more examples unlike the demo.

- **Move name.** What it does on screen. *Fits content like:* a …; a …; a ….

## 9. Pitfalls of the medium

Mistakes that come from the medium itself, each with its fix. Pitfalls tied to one demo prop go to DEMO.md.

## 10. Engine

Which files in `demo/` hold reusable recipes (engine, rig, compositor, sampler set-up), their main functions and parameters, and a minimal example that draws something that is not in the demo. Point to the code; don't restate it.

## 11. Variation space

What the agent decides for each film (structure, characters, opening, ending, camera path, pacing, palette within the colour logic). Then, one line each and all far from the demo: **three structures**, **three openings** and **three endings**, to show the range.

Scene styles (a practical scene whose demo reads its words from `demo/content.json`) add here their **use cases** as information-order grammar: for each job, the order in which information arrives and how long each layer stays on screen. Swapping `content.json` is a technical check of the engine, not a way to make a film.

---

How our demo was made (story, shots, score, end card, build): [DEMO.md](DEMO.md). Read it after your treatment exists.
