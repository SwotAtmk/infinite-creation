---
name: h3-prompt-writing
description: Write MiniMax H3 video generation prompts for T2VA, I2VA, FL2VA, L2VA, and Ref2VA. Use when rewriting multimodal requests into H3 prompt structures, composing integrated_multimodal_description, overall_soundscape, and non_diegetic_music, aligning keyframes, or defining reference labels for images, videos, and audio. Also covers storyboard-contract driven multi-segment generation: drafting a storyboard.json from a novel/script with a local or remote LLM, then compiling it into consistent per-segment H3 prompts (Ref2VA/T2VA first segment + FL2VA continuations) with no repeated segments and no positional or identity drift.
compatibility: Portable to any agent that can read local files — no external API calls, MiniMax Hub tools, or proprietary runtime required. The agents/openai.yaml file only adds optional ChatGPT/Codex UI metadata; it does not restrict the skill to OpenAI agents.
---

# H3 Prompt Writing

## Workflow

1. Identify the input mode: T2VA, I2VA, FL2VA, L2VA, or full-reference Ref2VA.
   - If the model supports image input, view each unique character/scene/prop reference image ONCE via `view_asset` and reuse it across shots — do NOT re-view the same image per shot; use `view_shot_references(shot_id)` only when a shot introduces an asset you have not yet seen.
2. For base text/keyframe modes, read `references/base-en.txt` and follow its final prompt structure.
3. For full-reference mode, read `references/ref-en.txt` and follow its six-section rewrite format.
4. Preserve the exact field names, section order, labels, and timing notation from the selected guide.
5. For a multi-segment short film (hardware limits prevent one long H3 generation), compile from a storyboard contract instead of writing prompts by hand — see “Storyboard-Driven Multi-Segment” below.

## Base Modes

- T2VA: build the full audiovisual timeline from text.
- I2VA: start from the first frame and develop forward from it.
- FL2VA: describe the continuous path between the first and last frames.
- L2VA: infer a plausible opening and converge to the supplied last frame.

Use `integrated_multimodal_description`, `overall_soundscape`, and `non_diegetic_music` in the order shown in `references/base-en.txt`.

## Full-Reference Mode

Ref2VA rewrites use `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, and `non_diegetic_music` in that order. Reference labels stay consistent across all sections.

Read `references/ref-en.txt` for label rules, retention analysis, and complete examples.

## Output Rules

- Write rewrite sections in English; preserve dialogue, lyrics, and visible scene text in their original language.
- Describe each shot by composition, subjects, environment, actions, camera, sound, and the exact point where referenced content appears.
- **Make every character action emotion-driven and physically specific**: never write only inert/still verbs (stands / sits / walks / looks) with no force. State the action's intensity, speed, and body language so the motion has visible energy (e.g. `slams the table`, `paces frantically`, `clenches his fists`, `leans in intensely`, `snatches the letter`, `stumbles back breathless`) — and keep the action consistent with that line's emotion. Static characters plus a monotonous read come across as lazy; give each beat visible, purposeful movement.
- Avoid plot summaries, unresolved reference labels, and timing that does not match the requested duration.
- **Annotate every spoken line's delivery (emotion + speech pace + tone/volume) with a bias toward high energy**: before each `<d>…</d>`, after the speaker ID `(Sx)`, explicitly state how the line is spoken — emotion (furious / ecstatic / frantic / explosive / urgent / breathless / anxious / annoyed / amused / sad / nervous / hesitant / calm …), pace (fast / hurried / breathless / rapid-fire / measured / slow / drawn-out / hesitant …), and tone or volume (shout / cry out / whisper / murmur / rising / trembling / flat …). Pick the high-tension end of these lists unless the beat genuinely calls for calm. Never write a bare `S1 says, <d>…</d>` with no delivery description. Vary delivery and intensity between lines, speakers, and emotional turns within the same shot instead of one flat monotone. Follow the delivery wording shown in `references/ref-en.txt` (e.g. `exclaims with light annoyance`, `says in a casual young male voice with a playful tone and an easy conversational pace`, `replies … with an amused cadence`) — and prefer its higher-energy phrasings for conflict, urgency, or strong emotion.

## Storyboard-Driven Multi-Segment

When H3 cannot generate the whole film in one pass, generation is split into short segments chained by the previous segment's last frame. Drive this from a **data contract** rather than hand-copied prompts, so segments stay consistent and none of them silently repeats another.

> **Runner note (this repo):** the in-app Agent has **no shell tool** — it cannot execute `python scripts/...`. Write `storyboard.json` with the domain tools (`set_storyboard` / `update_shot`); the `scripts/*.py` compiler helpers are for a **human/offline terminal**, not a runtime step. Do not attempt to run them.

1. Author `storyboard.json` (see `references/storyboard.schema.json`). Keep every prompt-bearing value in English.
   - **From a novel/script**: `python scripts/gen_storyboard_llm.py --novel-file novel.md --out storyboard.json` drafts the contract with a local/remote OpenAI-compatible LLM and feeds compiler errors back to it until the gates pass — see `references/storyboard-from-novel.md`. The generator's few-shot style example is passed with `--example-file <path>` (the repo-shipped sample was moved out of the tree, so point it at a local copy, e.g. `--example-file ../../docs/test/storyboard.example.json`); it strongly affects output depth and reliability.
   - **By hand / migration**: follow `references/storyboard.schema.json` and the `prompt.txt` migration mapping in `references/storyboard-contract.md`.
   - **Examples** (kept locally under `docs/test/`, not committed): `storyboard.example.json` (3 shots, with reference images → Ref2VA opener) and `storyboard.example-novel.json` (a verified 8-shot run over a local test novel → T2VA opener, zero errors/warnings).
2. Read `references/storyboard-contract.md` for the field roles, the segment rules, and the contract→H3 section mapping.
3. Compile prompts: `python scripts/compile_storyboard.py --storyboard-file storyboard.json --dry-run` (inspect) or `--out segments/` (write one `.prompt.txt` per segment + `segments.json` + `continuity-ledger.json`). When assets live in a library and `refs` leave paths empty, build the index once with `python scripts/build_manifest.py --storyboard storyboard.json --out manifest.json` and compile with `--manifest manifest.json` (see `references/manifest.example.json`).
4. The compiler enforces the gates; fix every `error` before generating: zero-pronoun (no "previous shot / 同上 / 保持原样"), duration coverage, field completeness, executable camera moves, **no duplicated segment action**, and the **fidelity lock** (`beats[].source`: `original`/`added`/`tbd`; `--strict-fidelity` turns an unconfirmed `tbd` into an error).
5. Segment typing: the film's first segment is **Ref2VA** when the opening shot has reference images, or **T2VA** (text-only, three-section) when it has none; every later segment is FL2VA with `refs` empty — its prompt must restate identity, on-screen position, and lighting in words, because the node has no reference-image input.

Notes:
- A segment that restates the characters' identity/position/lighting is **not** a "repeated segment"; the no-repeat rule compares the **action** only. Mark a genuinely repeating-action shot with `"allow_repeat": true`.
- A shot longer than the per-segment limit is auto-split into sub-segments that reuse the same prompt (the action replays). The compiler warns; shorten `duration` or split the action into separate shots instead.
- Compilation is the portable, machine-independent half. Submitting to a runner (local ComfyUI via `references/comfyui-node-adapter.md`, or a Hub tool) stays outside this skill. The stage-confirmation gate (`--confirm`) and the fallback ladder (H3 failure → shrink the segment → ask the user) are an **interface contract** every runner must follow — see `references/fallback-policy.md`.

## Tips for Better Results
- Always match the total duration of the description to the requested video length (2–15 seconds), driven by content rhythm: a single short line of dialogue needs only 2–4 seconds — do not pad short shots to 10+ seconds.
- Keep reference labels consistent (e.g. `<Picture 1>`, `<Video 1>`, `<Audio 1>`) across every section.
- Prefer concrete visual and audio details over abstract words like "cinematic" or "beautiful".
- Give every spoken line a concrete delivery description (emotion + pace + tone) with real intensity so the speech carries feeling, speed variation, and emotional thrust instead of a lazy flat monotone; pair loud/urgent delivery with big physical actions.
- When using keyframes (I2VA / FL2VA / L2VA), clearly state how the first and/or last frame connects to the timeline.
