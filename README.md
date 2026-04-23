# Career-Ops

<p align="center">
  <img src="docs/hero-banner.jpg" alt="Career-Ops — local AI job search pipeline" width="800">
</p>

Local-first toolkit for tracking a job pipeline, scoring fit against your CV, generating tailored résumé outputs, scanning portals, and browsing everything in a small web dashboard. **Human-in-the-loop:** nothing is submitted to employers automatically; you review every action.

**Maintainer (this fork):** Nam.

---

## Requirements

- **Node.js** 18+ (20+ recommended)
- **npm** (ships with Node)
- **Playwright Chromium** — for PDF/HTML generation and for scraping job pages (dashboard interview prep, shared scrape helper)
- **Optional:** [Ollama](https://ollama.com/) on the same machine for local CV generation (`ollama-cv-pipeline.mjs`)
- **Optional:** Google **Gemini** API key for `gemini-eval.mjs`

---

## Installation

```bash
# 1. Clone your copy of the repo and enter the project root
git clone <YOUR_REPOSITORY_URL>
cd career-ops

# 2. Install Node dependencies
npm install

# 3. Install the browser used by Playwright (required for PDF pipeline and job scraping)
npx playwright install chromium

# 4. Environment (secrets stay out of git)
cp .env.example .env
# Edit .env — at minimum set keys you actually use (e.g. GEMINI_API_KEY, RAPIDAPI_KEY).

# 5. Profile and portals (first-time)
cp config/profile.example.yml config/profile.yml
# Edit config/profile.yml with your name, roles, location, etc.

cp templates/portals.example.yml portals.yml
# Edit portals.yml for companies and title filters.

# 6. CV and personalization files (first-time)
# Create cv.md in the repo root (markdown CV — source of truth for evaluations/PDF).
# Copy modes/_profile.template.md → modes/_profile.md and edit for your archetypes and preferences.

# 7. Sanity check
npm run doctor
```

**Upstream / locale packs:** If optional language mode packs are missing from `modes/de`, `modes/fr`, etc., restore them from the upstream project or run `node update-system.mjs check` then `node update-system.mjs apply` when an update is available.

---

## Read / write data layout

| Path | Role |
|------|------|
| `cv.md` | Your CV (markdown) — read by scoring and PDF flows |
| `config/profile.yml` | Targets, comp, location — **you edit** |
| `modes/_profile.md` | Narrative, archetypes, weights — **you edit** (do not put personal content in `modes/_shared.md` if you plan to merge upstream) |
| `data/pipeline.md` | Inbox of jobs (`- [ ] url \| company \| title`) — dashboard and scripts read/write |
| `data/applications.md` | Application tracker table — dashboard can append/update rows |
| `data/scan-history.tsv` | Scanner dedup history |
| `reports/*.md` | Evaluation reports — created by your agent workflow or scripts |
| `output/*.pdf` (and related) | Generated résumés — Playwright / Ollama |
| `interview-prep/*.md` | Per-job prep notes — `interview-prep.mjs` writes here; `story-bank.md` is the shared behavioral story file |

Sensitive paths are normally gitignored; keep secrets in `.env` only.

---

## npm commands (project scripts)

| Command | What it does |
|---------|----------------|
| `npm run doctor` | Validate prerequisites and key files |
| `npm run verify` | Pipeline integrity (`verify-pipeline.mjs`) |
| `npm run normalize` | Normalize tracker statuses |
| `npm run dedup` | Deduplicate tracker |
| `npm run merge` | Merge batch tracker TSV additions |
| `npm run pdf` | Generate PDF from HTML template (`generate-pdf.mjs`) |
| `npm run sync-check` | CV sync check |
| `npm run update:check` / `npm run update` / `npm run rollback` | System update helper |
| `npm run liveness` | Posting liveness checker |
| `npm run scan` | Portal scanner (`scan.mjs`) |
| `npm run gemini:eval` | Evaluate JD text via Gemini API (`gemini-eval.mjs`) |
| `npm run ollama:cv` | Local Ollama CV pipeline (`ollama-cv-pipeline.mjs`) |
| `npm run fetch:jobs` | RapidAPI JSearch fetch (`fetch-jobs.mjs`) |
| `npm run dashboard` | Web dashboard + API server (`dashboard.mjs`, default **port 3000**) |
| `npm run dev` | Same as dashboard with `node --watch` |

---

## CLI scripts (direct `node` usage)

```bash
# Gemini (needs GEMINI_API_KEY in .env)
node gemini-eval.mjs "JD text…"
node gemini-eval.mjs --file ./jds/some-job.txt

# Local Ollama tailored CV / HTML (needs Ollama running + model pulled, e.g. llama3.2:3b)
node ollama-cv-pipeline.mjs --latest-only
node ollama-cv-pipeline.mjs --job-id 12
# Optional: CAREER_OPS_OLLAMA_LOW_MEM=1 for smaller context (see scripts/run-pipeline.mjs)

# Evaluate jobs listed in data/pipeline.md (when evaluate-pipeline.mjs is configured in your workflow)
node evaluate-pipeline.mjs --file ./data/pipeline.md
node evaluate-pipeline.mjs --file ./data/pipeline.md --job-id 3

# Interview prep file for one pipeline row (scrapes job URL with Playwright unless disabled)
node interview-prep.mjs --job-id 12
# Skip scrape (title/company + cv only in the doc):
node interview-prep.mjs --job-id 12 --no-scrape
# or: INTERVIEW_PREP_NO_SCRAPE=1 node interview-prep.mjs --job-id 12
```

**Shared scrape:** `scrape-pipeline-job.mjs` exports `ensureChromium`, `scrapePipelineJob`, and `closeChromiumBrowser` for consistent Playwright-based job page text extraction.

---

## Web dashboard

Start the server from the repo root:

```bash
npm run dashboard
```

Open **http://127.0.0.1:3000/** (or `http://localhost:3000/`). The UI loads `dashboard-ui.html`; the server reads/writes `data/pipeline.md`, `data/applications.md`, and serves files under `reports/` and `output/`.

### HTTP API (JSON unless noted)

Base URL: `http://127.0.0.1:3000`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Serves the dashboard HTML |
| GET | `/dashboard-ui.html` | Same UI asset |
| GET | `/api/stats` | Aggregate stats for the UI |
| GET | `/api/jobs` | Parsed pipeline jobs, enriched. Query: `autoScore=0` to disable heuristic score fill |
| POST | `/api/jobs` | **Body (JSON):** `{ "url", "company", "title", "status"?, "addToApplications"? }` — appends a line to `data/pipeline.md`; optionally adds a tracker row. `status` is normalized (e.g. `applied`, `evaluated`). Returns `{ ok, trackerRow?, trackerNote? }` or `400`/`409` |
| GET | `/api/resumes` | Lists résumé files under `output/` (skips heavy `output/ollama-html` for performance) |
| GET | `/api/reports` | Lists `reports/*.md` |
| GET | `/api/job/:id/report` | **Per-job report payload:** `{ filename, markdown, matched, placeholder }`. Uses a real `reports/*.md` when URL/slug match; otherwise returns **placeholder** markdown so every job id always has readable content |
| GET | `/api/history` | Last lines of `data/scan-history.tsv` |
| GET | `/api/report/:filename` | Raw markdown for one report file (basename only) |
| GET | `/api/resume/:filename` | Download one file from `output/` |
| GET | `/api/resume?path=` | Download with relative path under `output/` (slashes normalized) |
| POST | `/api/job/:id/status` | **Body:** `{ "status" }` — updates checkbox mark in pipeline + tries to sync applications row |
| POST | `/api/application/:id/status` | **Body:** `{ "status" }` — updates tracker row by table index |
| GET | `/api/config` | Non-secret profile bits + flags for optional API keys |
| GET | `/api/updates` | **SSE** — subscribe for `refresh` events when data changes |
| GET | `/api/run/:script` | **SSE** — streams stdout/stderr from a whitelisted script (see below) |

### SSE: `/api/run/:script`

Server-Sent Events stream. Events include `ready`, `data` (log lines), `error` (stderr lines), `done` `{ ok, code }`.

**Allowed `script` names** (see `scripts/run-pipeline.mjs`):

| `script` | Query params | Runs |
|----------|----------------|------|
| `scan` | — | `node scan.mjs` |
| `fetch` | — | `node fetch-jobs.mjs` |
| `evaluate` | `jobId` or `job` (optional) | `node evaluate-pipeline.mjs --file ./data/pipeline.md` (+ `--job-id` if set) |
| `pdf` | `jobId` / `job`, optional `force=1` | `node ollama-cv-pipeline.mjs` (optional `--low-mem` if `CAREER_OPS_OLLAMA_LOW_MEM=1`) |
| `interview-prep` | `jobId` or `job` (optional) | `node interview-prep.mjs` (+ `--job-id` if set) |

Only one script run at a time per server process.

---

## Environment variables (summary)

Copy `.env.example` to `.env` and set what you need:

- **Gemini:** `GEMINI_API_KEY`, optional `GEMINI_MODEL`
- **JSearch:** `RAPIDAPI_KEY` for `fetch-jobs.mjs`
- **Ollama:** `OLLAMA_HOST`, `OLLAMA_MODEL`, `OLLAMA_EVAL_MODEL`, timeouts, `OLLAMA_NUM_CTX`, `CAREER_OPS_OLLAMA_LOW_MEM`, etc. (see comments in `.env.example`)
- **Interview prep:** `INTERVIEW_PREP_NO_SCRAPE=1` to disable Playwright scrape for that run

---

## Ethical use

Use this to **filter** and apply with intent, not to spam ATS or recruiters. Prefer fewer, stronger applications. Never let any automation submit forms or send mail without your explicit review.

---

## License

MIT — see `LICENSE`.
