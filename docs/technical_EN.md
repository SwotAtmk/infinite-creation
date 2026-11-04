# Technical Documentation · Agent Infinite Creation

Developer and deployment guide: tech stack, directory structure, environment setup and startup, first-time configuration, usage flow, API, external-writing interface, tests and limitations.

> [← Back to README](../README_EN.md) · 中文：[技术文档](./technical.md)

## Table of Contents

- [Tech Stack](#tech-stack)
- [Directory Structure](#directory-structure)
- [Environment Setup and Startup](#environment-setup-and-startup)
- [First-Time Configuration](#first-time-configuration)
- [Usage Flow](#usage-flow)
- [Self-Iteration: New Workflow → New Skill](#self-iteration-new-workflow--new-skill)
- [API Overview](#api-overview)
- [External Writing: Let Claude Code / opencode Write Content](#external-writing-let-claude-code--opencode-write-content)
- [Tests](#tests)
- [Notes & Limitations](#notes--limitations)

## Tech Stack

- Backend: Node.js (Next.js custom server) + `node:sqlite` + ComfyUI REST/WebSocket + ffmpeg, zero native-compilation dependencies.
- Rank Shadow: bundled lemo-opuscar code-film skill (Node + three.js + ffmpeg + optional Python/Chromium); the Agent generates render scripts and produces the film entirely without ComfyUI.
- Agent: built-in openclaude kernel (in-process SDK) + optional external Agent runtime (local CLI via an MCP tool bridge), tool registry + skill engine + skill factory.
- Frontend: Next.js 15 + React 18 (classic UI, App Router) · Studio UI: Vite + React 18 (`studio/`).
- Structure: single package — `app/` (pages + 30+ API endpoints) · `lib/` (reusable core/agent/shared logic) · `server.js` (custom server: WebSocket progress push + `/files` static hosting with Range-based video streaming).

## Directory Structure

```
infinite-creation/
├── app/                 # Next.js App Router (pages + API endpoints)
├── studio/              # Studio frontend (Vite + React 18; default UI, includes the Rank Shadow workspace)
├── public/samples/      # Built-in sample library (one sample.json + film + materials per folder; preview / one-click trial)
├── lib/                 # Reusable logic: core (ComfyUI/LLM/DB/ffmpeg) · agent (built-in openclaude + external agents + skills) · shared (constants)
│   └── agent/external/  #   External Agent runtime: defs/ (one definition file per CLI) · registry · detect · mcp-config · mcp-server (MCP service) · runner
├── server.js            # Custom server (WebSocket progress push + /files static hosting, Range streaming)
├── workflows/           # ComfyUI workflow templates (MiniMax H3 video / Qwen-Image 2.1 image & text / Krea2 / Qwen3-TTS, incl. GGUF quantized editions)
├── start-studio.sh / start-studio.bat   # Background launcher (Studio frontend 4710 + dedicated backend 4610)
├── start-infinite-creation.bat    # Windows one-click background startup (classic UI, 4600)
├── stop-infinite-creation.bat     # Windows service stop
├── skills/              # Skill library (9 official + novel-to-video + lemo-opuscar (66 styles) + custom)
├── scripts/install-skills.mjs   # Pull MiniMax-H3 official skills
├── scripts/dev.mjs      # pnpm run dev launcher: foreground with live logs; --background for background startup
├── tests/               # Unit tests: unit.test.mjs + external-agents.test.mjs (agent defs / custom command / MCP handshake)
├── vendor/openclaude/           # Agent kernel source (dist/ build artifacts not committed; requires local build)
└── data/                # Runtime (gitignored): SQLite + projects/<id>/…
```

> **About node_modules**: Dependencies are not committed. pnpm generates a single `node_modules` at the project root (real dependencies live under `node_modules/.pnpm/`). **Just run `pnpm install` once at the project root.**

## Environment Setup and Startup

### Prerequisites

- Node.js ≥ 22 (backend uses built-in `node:sqlite`; Agent kernel requires `>= 22`)
- pnpm ≥ 9 (`npm i -g pnpm`)
- Bun (`pnpm install` uses it to build the Agent kernel once; install at <https://bun.sh>)
- ffmpeg (required for merging films, see <https://ffmpeg.org/download.html>)

### Steps

```bash
# Clone the project locally
git clone https://github.com/SwotAtmk/infinite-creation.git
cd infinite-creation

# 1. Install all dependencies (run once at root; builds the Agent kernel automatically)
pnpm install

# 2. Pull MiniMax-H3 official skills (optional; repo already contains an offline snapshot)
pnpm run install:skills

# 3. Dev mode: foreground Studio by default (dedicated backend 4610 + frontend 4710, live logs)
pnpm run dev
# Open http://127.0.0.1:4710 in your browser
# Ctrl+C stops both frontend and backend

# For a background launch (logs written to files)
pnpm run dev:background

# Classic UI (single port 4600) dev mode
pnpm run dev:classic
# Open http://127.0.0.1:4600 in your browser

# 4. Production mode
# Classic UI: single port 4600, frontend build artifacts hosted by the backend
pnpm run build && pnpm start
# Open http://127.0.0.1:4600 in your browser

# Studio: build the frontend + dedicated backend (production)
./start-studio-prod.sh        # Windows: start-studio-prod.bat
# Open http://127.0.0.1:4710 in your browser
```

> Windows users can double-click `start-studio.bat` (Studio, backend 4610 + frontend 4710) or `start-infinite-creation.bat` (classic UI, 4600) for one-click background startup; stop them with `stop-studio.bat` / `stop-infinite-creation.bat`.

> **Studio is the default dev UI**: `pnpm run dev` runs the dedicated backend on 4610 and the Studio frontend on 4710 in the foreground, streams logs to your terminal, and stops both on `Ctrl+C`. Use `pnpm run dev:background` for a background launch (it invokes `start-studio.sh` / `start-studio.bat`).
> ```bash
> pnpm run dev:background       # background, logs in logs/ and studio/logs/
> ./start-studio.sh             # equivalent background script (macOS / Linux)
> ./stop-studio.sh              # stop Studio only
> ./start-infinite-creation.sh  # classic UI, open http://127.0.0.1:4600
> ```
> See [studio/README.md](../studio/README.md) for Studio configuration.

> The Agent kernel `vendor/openclaude/dist/` is a build artifact and not committed; `pnpm install` builds it automatically once (idempotent — skips if present). You only need to manually rerun `pnpm build:agent` after modifying `vendor/openclaude/src/` source. See [agent-architecture.md](./agent-architecture.md) for build details.

### Starting Studio and the Classic UI Separately

The two UIs can run independently and share the same `config.json` and database:

```bash
# ── Studio (default, backend 4610 + frontend 4710) ────────
pnpm run dev                 # foreground: live logs, Ctrl+C stops both
pnpm run dev:background      # background: logs in logs/ and studio/logs/

# Or start manually in two terminals:
# Terminal 1: Studio backend (dev)
PORT=4610 NEXT_DIST_DIR=.next-studio-dev pnpm run dev:classic
# Terminal 2: Studio frontend
pnpm --filter studio dev

# Studio production
./start-studio-prod.sh       # Windows: start-studio-prod.bat

# ── Classic UI (single process, 4600) ─────────────────────
pnpm run dev:classic         # development
pnpm run build && pnpm start # production
```

Setting environment variables in Windows `cmd`:

```bat
set PORT=4610
set NEXT_DIST_DIR=.next-studio-dev
pnpm run dev:classic
```

> The open-source edition does not include accounts, an admin dashboard, credit billing, or content moderation; system settings (ComfyUI / LLM / workflows / hardware / generation) are open directly.
>
> If a production build fails with `EPERM ... Application Data`, Next's file tracing is scanning the user home directory. Point HOME/USERPROFILE at a local directory for the build (already handled in `start-studio-prod.bat`):
> ```bash
> HOME="$PWD/.build-home" USERPROFILE="$(cygpath -w "$PWD/.build-home")" pnpm build
> ```

## First-Time Configuration

Click ⚙ in the top-right corner:

1. ComfyUI service URL: default `http://127.0.0.1:8188`, click "Test Connection" to confirm.
2. Agent runtime (optional): defaults to "Built-in openclaude"; you can also switch to "External Agent (local CLI)" and pick a locally installed CLI agent (Claude Code / Codex CLI / Gemini CLI / Qwen Code / Cursor Agent / Qoder CLI / Grok Build / Hermes / custom command) to take over the pipeline via a local MCP tool bridge.
3. LLM (the Agent's brain, OpenAI-compatible): fill in Base URL (must end with `/v1`), model, and API Key. Default model is `deepseek-v4-flash-vision-exp` (the built-in openclaude uses this; external agents use their own model and sign-in state).
4. Generation maintenance (optional): set "release ComfyUI VRAM every N generations" (default on = 3, 0 = off), counted across **all ComfyUI generation tasks** (text-to-image / image-to-image / costume change / voice / video all count — on AMD GPUs with Dynamic VRAM, any consecutive generation gradually slows down). After a release, the next generation reloads models (about 1–3 minutes extra). When ComfyUI is detected as having Dynamic VRAM disabled, the UI shows a prompt recommending it be turned on.

Configuration is saved to `config.json` at the root (not committed). Generation parameters (timeout minutes, concurrency, release frequency) can be edited directly in the `generation` section of `config.json`.

### Database: SQLite / PostgreSQL

SQLite is used by default (`data/ic.db`) — zero install, starts immediately. For production you can switch to PostgreSQL; **both share the same table schema**, so business code needs no changes.

Environment variables take precedence (recommended):

```bash
# Quick start (default)
IC_DB=sqlite IC_DB_SQLITE_PATH=/data/ic.db

# Production
IC_DB=postgres DATABASE_URL=postgres://user:pass@127.0.0.1:5432/infinite_creation

# Fixed media directory (Docker mount)
IC_MEDIA_DIR=/data/projects
# Keep the config file on a mounted volume too (otherwise it lands in the image layer)
IC_CONFIG=/data/config.json
```

They can also live in the `db` section of `config.json` (see `config.example.json`), but environment variables win. If `DATABASE_URL` is set and `IC_DB` is not, PostgreSQL is selected automatically.

**Migrating / syncing data** (both sides reuse the same `initSchema`, so schemas cannot drift):

```bash
# SQLite → PostgreSQL
node scripts/db-migrate.mjs --from sqlite --to postgres \
  --to-url postgres://user:pass@127.0.0.1:5432/infinite_creation

# PostgreSQL → SQLite
node scripts/db-migrate.mjs --from postgres --to sqlite \
  --from-url postgres://user:pass@127.0.0.1:5432/infinite_creation \
  --to-sqlite data/ic-pg-copy.db

# Truncate target tables first (default is upsert by id, re-runnable)
node scripts/db-migrate.mjs --from sqlite --to postgres --replace
```

Migration upserts by primary key and copies projects / assets / shots / jobs / queue / change log. Media files are not in the database: images and videos live under `IC_MEDIA_DIR` (default `<data>/projects`); after switching databases, keep using the same directory or Docker volume — no regeneration needed.

> Note: PostgreSQL is exposed through a synchronous facade backed by a worker thread (the business layer uses synchronous SQL). That guarantees a zero-refactor switch, but every query blocks the current process event loop; run PostgreSQL on the same machine / Docker network as this service, not a high-latency remote database. Remote databases would require making the repository async.
>
> When packaging Docker, keep `lib/core/pg-worker.mjs` and `node_modules/pg`: the PostgreSQL driver is loaded by file path inside the worker thread and is not picked up by Next's static tracing. Point media, the SQLite file, and the config file at mounted volumes via `IC_MEDIA_DIR`, `IC_DB_SQLITE_PATH`, `IC_CONFIG`.

### ComfyUI Installation and Cloud Compute

Installing ComfyUI, the required workflows and models, and RunningHub cloud compute access have moved to the [ComfyUI Setup](../README_EN.md#comfyui-setup) section of the README.

## Usage Flow

1. New project → paste the novel text (or a one-line idea) + style.
2. In "Chapter Management", click a chapter's "Actions", check the stages to run (text creation / asset image generation / voice design / storyboard video; you can check only a subset for resuming), click ▶ Start → watch progress in the console in real time (no intermediate actions needed).
3. After the video stage finishes, background music is generated automatically and the film is merged; go to "Shot Review" to preview segment by segment and click ↻ to regenerate any unsatisfactory shot (optional feedback); the "Background Music" page lets you manually generate / preview / select a track and apply it to multiple chapters.
4. Go to the "Final Film" page to preview online (draggable progress bar) and download the subtitled video, the subtitle-free video, or the SRT as needed; delete unwanted exports individually or in batch.

### Rank Shadow (Code Film) Usage Flow

1. Open **Rank Shadow** from the left menu, filter style cards by category (66 templates), and click "Use this style"; or switch to "Custom style" and describe the look yourself.
2. In the create dialog, upload any materials (images / audio / video / documents / data / fonts, etc.); images, videos and audio show thumbnails. Fill in the prompt and click "Create job". "Clear form" resets everything in one click.
3. Click "Preview samples" in the top-right corner to watch a built-in sample film, inspect its materials and prompt, and use "Try it now" to upload the sample materials into the current project and prefill the form.
4. The Agent renders the film locally through the lemo-opuscar skill and does not occupy the ComfyUI queue. In "Generation records" you can query, edit, regenerate, stop, delete or batch-delete jobs; running jobs expose a live "Run log".

> The first use of Rank Shadow requires installing the skill dependencies (Node.js, ffmpeg, Python, and a headless Chromium for rendering):
> `sh skills/lemo-opuscar/plugin/skills/lemo-opuscar/scripts/setup.sh deps` (append `voice` / `music` only if you need TTS / music).

## Self-Iteration: New Workflow → New Skill

On the Workflows page, paste a new ComfyUI workflow JSON → "Analyze nodes/roles" → "Register workflow + generate skill". The system: parses nodes (loaders / prompts / sizes / seeds / saves…) → derives the workflow spec (roles/media/outputs) → registers it to `workflows/` + DB → calls the LLM to draft a `SKILL.md` and installs it as a routable skill → the Agent can then call it as a new "work mode".

## API Overview

| Method   | Path                                      | Description                          |
| -------- | ----------------------------------------- | ------------------------------------ |
| GET/POST | /api/projects                             | List projects / Create               |
| POST     | /api/projects/:id/run                     | Start fully automated generation     |
| POST     | /api/projects/:id/stop                    | Stop a running task                  |
| GET      | /api/projects/:id/assets?category=        | Assets (by category)                 |
| GET      | /api/projects/:id/shots                   | Shots                                |
| POST     | /api/projects/:id/shots/:sid/regenerate   | Regenerate a single shot             |
| POST     | /api/projects/:id/export                  | Merge & export the final film (burns subtitles per project toggle, plus a subtitle-free copy and SRT) |
| GET/DELETE | /api/projects/:id/exports               | List / delete exports (batch supported; cleans up the subtitle-free copy and SRT too) |
| GET      | /api/projects/:id/stages                  | Pending counts + stage definitions   |
| POST     | /api/projects/:id/stages                  | Run by stages (check llm/image/tts/video to start a batch, incl. preflight) |
| POST     | /api/projects/:id/music                   | Generate background music (create / regenerate a music asset) |
| POST     | /api/projects/:id/music/apply             | Apply background music to multiple chapters and re-merge the final film |
| GET/PUT  | /api/projects/:id/context                 | Context: character bible / style / continuity (also written to context/*.md) |
| PUT      | /api/projects/:id/chapters/:cid/storyboard | Write a whole chapter's shots in one call (≤500 per call) |
| POST/DELETE | /api/projects/:id/shots                | Create / delete a single shot        |
| PATCH    | /api/projects/:id/shots/:sid              | Edit a single shot's content (generated-result fields are not writable) |
| GET      | /api/projects/:id/logs                    | Change log: who changed what, when (the basis for rollback) |
| POST     | /api/projects/:id/logs/rollback           | Roll back: one entry / a whole batch / everything since a timestamp |
| POST     | /api/projects/:id/jobs/:jobId/cancel      | Cancel / stop a job (including Rank Shadow jobs) |
| GET      | /api/opuscar/styles                       | Rank Shadow style templates (from lemo-opuscar, with categories and preview images) |
| GET      | /api/opuscar/samples                      | Built-in samples (`public/samples/`, returns film and material URLs) |
| GET/POST | /api/projects/:id/opuscar                 | List records / create a render (pass `asset_id` to regenerate) |
| GET      | /api/skills                               | Skill list                           |
| GET/POST | /api/workflows                            | Workflow list / register (self-iteration) |
| GET/PUT  | /api/config                               | Configuration                        |
| WS       | /ws                                       | Task progress push                   |

## External Writing: Let Claude Code / opencode Write Content

Besides clicking through the UI, you can let a local AI coding tool (Claude Code, opencode, Codex, Trae, …) write **text content** straight into a running project: create a project, write novel text, write scripts, write shots, write the character bible / style. The typical case: you already have a long novel and want to import it in bulk and split it into chapters.

It writes **text only**: it will not generate images, videos, voices or music, and it will not export a film — those still happen from the UI.

### Three steps

```bash
# 1. Install the skill (once; restart your AI tool afterwards so it discovers it)
pnpm run install:ic-writer     # installs to ~/.agents/skills/ic-writer/ by default

# 2. Start the service (Studio by default: UI http://127.0.0.1:4710, API 4610)
pnpm run dev

# 3. Just talk to your AI tool, for example:
#    "Write this novel into infinite-creation, one chapter per section"
#    "Write 3 chapters of script for this project"
#    "Rewrite the storyboard of chapter 2"
```

> The writer skill connects to `http://127.0.0.1:4600` (classic backend) by default; when using Studio, point it at the Studio backend: `IC_BASE_URL=http://127.0.0.1:4610`.

The skill source lives in this repo: `harness-skills/ic-writer/SKILL.md` (`pnpm run install:ic-writer` copies it into your skills directory). To install it elsewhere: `node scripts/install-writer-skill.mjs --target <your-skills-dir>`.

### What it can and cannot write

|  |  |
|---|---|
| ✅ Can write | Project fields, novel text, scripts, shots (dialogue / visual / camera / duration, …), character bible / style / continuity, asset prompts; **already generated** versions of all of these can be overwritten too |
| ❌ Cannot write | Generated-result fields such as `status` and `video_path` — they are rejected, so nobody can fake "already generated" |
| ❌ Never touches | Image / video / voice / music generation and final export (`/run`, `/stages`, `/regenerate`, `/music`, `/export`) |
| ❌ Not available | Deleting projects (no such API, by design) |

### Limits and caveats

- **Local use only**: the skill talks to `127.0.0.1:4600` by default (Studio backend is `4610`; set `IC_BASE_URL` to override). That instance has **no authentication** — if you change `server.host` in `config.json` to `0.0.0.0`, you expose an endpoint on your LAN that can read every project, edit content and roll it back. Don't.
- **Don't write while the project is running**: if `status` from `GET /api/projects/:id` is `running`, wait for it to finish (deleting writes are rejected with 409; content writes may be overwritten by the task's stale data, leaving the final film and the storyboard out of sync).
- **Shots must pass the app's business rules** or the API returns 400: duration 1–15 s; dialogue length ≤ duration × 5.5 (over-fast lines get squeezed into unintelligible audio); at most 2 speakers per shot; resolution / aspect ratio must be one of the fixed enums.
- **HTTP API only**: read and write through `{base}/api/...`. Never open `data/ic.db` directly (not even read-only) and never hand-edit files under `data/` or `config.json` — bypassing the API means no change log and nothing to roll back.
- **Every step is reversible**: one call = one batch; roll back a single entry, a whole batch (`batch_id`), or everything since a timestamp. Rollback restores database rows only — image/video files on disk are not deleted (re-upload them).
- **Works on any machine**: none of the commands above depend on a specific directory — just run them from the project root; the skill installs into your home directory (`~/.agents/skills/`).

See section 6 of [SKILL.md](../SKILL.md) (the full contract for the agent) and [writer-api-plan.md](./writer-api-plan.md) (design trade-offs and round-by-round log).

## Tests

```bash
pnpm test   # node --test tests/unit.test.mjs
```

## Notes & Limitations

- Videos are generated shot-by-shot serially (ComfyUI has limited single-GPU concurrency); a single shot takes minutes-level; total film time depends on the number of shots and duration.
- H3 reference limits: images ≤9, audio/video ≤3 (exceeding them errors out automatically).
- Final films are uniformly transcoded to H.264 + AAC (24fps) to ensure playability.
- Tasks are background-persistent; you can resume after refreshing the page / restarting the service (idempotent skip of completed items).
- Default single-video timeout is 90 minutes (normal single shots are far below this — fallback only); adjustable via `generation.videoTimeoutMinutes` in `config.json`.
- Every N generation tasks, ComfyUI `/free` is called once to release VRAM (`generation.freeAfterEvery`, default 3, 0 = off; also compatible with the old key `videoFreeAfterEvery`), covering all rendering and countering the speed degradation of AMD Dynamic VRAM after consecutive generations; cleanup takes effect after the next task completes, and failure doesn't affect output.
- LLM runtime watchdog: when model output is truncated (`[Response truncated …]`) or the upstream stalls, tasks no longer hang indefinitely — 3 consecutive pure-truncation no-progress events, or 20 minutes without a message (tool-rendering window excluded), auto-abort and mark as failed; slow local models can loosen the no-message threshold via `generation.agentStallMinutes` (default 20).
