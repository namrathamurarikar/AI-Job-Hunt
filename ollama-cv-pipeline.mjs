#!/usr/bin/env node
/**
 * ollama-cv-pipeline.mjs — Tailored CV HTML + PDF for each pending pipeline URL (local Ollama)
 *
 * Prerequisites:
 *   - Ollama running (default http://127.0.0.1:11434)
 *   - A model that fits your RAM (default: llama3.2:3b ~6–8 GB with context; tighter: llama3.2:1b — not 70B-class models)
 *   - cv.md, config/profile.yml, templates/cv-template.html
 *   - modes/_shared.md + modes/_profile.md (optional) + modes/pdf.md (same prompt stack as Claude /career-ops pdf)
 *
 * Usage:
 *   node ollama-cv-pipeline.mjs
 *   node ollama-cv-pipeline.mjs --only-active
 *   node ollama-cv-pipeline.mjs --dedupe-jd --model llama3.1:8b
 *   node ollama-cv-pipeline.mjs --pipeline data/pipeline.md --ollama http://127.0.0.1:11434
 *   node ollama-cv-pipeline.mjs --job-id 12   # single row: 1-based index = # column in Job Pipeline (any checkbox state)
 */

import { readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync, writeSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import yaml from 'js-yaml';
import { ensureChromium, scrapePipelineJob, closeChromiumBrowser } from './scrape-pipeline-job.mjs';
import {
  applyDynamicPlaceholdersFromCvMd,
  listUnresolvedDynamicPlaceholders,
  mergeOllamaOutputWithCvBody,
  resumeHtmlNeedsCvFullRebuild,
} from './cv-html-fallback-from-md.mjs';
import { setGlobalDispatcher, Agent } from 'undici';
import { loadProjectEnv } from './load-project-env.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
await loadProjectEnv(ROOT);

/** Piped stdout (e.g. dashboard spawn) can be block-buffered on Windows — force line delivery for progress. */
function logLine(msg) {
  try {
    writeSync(1, `${msg}\n`);
  } catch {
    console.log(msg);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  process.stdout._handle?.setBlocking?.(true);
  process.stderr._handle?.setBlocking?.(true);
} catch {
  /* ignore */
}

/** Node's fetch (Undici) defaults to a short headers timeout — Ollama can sit silent while loading model / processing huge prompts. */
const OLLAMA_TIMEOUT_MS = Math.max(
  120_000,
  parseInt(process.env.OLLAMA_TIMEOUT_MS || '1800000', 10) || 1_800_000
);

setGlobalDispatcher(
  new Agent({
    headersTimeout: OLLAMA_TIMEOUT_MS,
    bodyTimeout: OLLAMA_TIMEOUT_MS,
    connectTimeout: 180_000,
  })
);

// ── CLI ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function argVal(name, def) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : def;
}

const PIPELINE_PATH = argVal('--pipeline', 'data/pipeline.md');
const OLLAMA_BASE = process.env.OLLAMA_HOST || argVal('--ollama', 'http://127.0.0.1:11434');
/** Requested tag; resolved to an installed name via /api/tags (e.g. llama3.2 → llama3.2:latest). */
const MODEL_REQUESTED = process.env.OLLAMA_MODEL || argVal('--model', 'llama3.2:3b');
/** Set after checkOllamaAndResolveModel() — exact tag Ollama accepts (e.g. llama3.2:3b). */
let effectiveOllamaModel = MODEL_REQUESTED;
const ONLY_ACTIVE = args.includes('--only-active');
const DEDUPE_JD = args.includes('--dedupe-jd');
const DRY_RUN = args.includes('--dry-run');
const STOP_ON_ERROR = args.includes('--stop-on-error');
/** Smaller num_ctx — use with 8–16 GB RAM; pair with a small model (e.g. llama3.2:3b). */
const LOW_MEM = args.includes('--low-mem');
/** Process only the newest pending item in pipeline.md (last - [ ] line). Ignored when --job-id is set. */
const LATEST_ONLY = args.includes('--latest-only');
/** 1-based index matching dashboard Job Pipeline # (all checkbox lines in file order). */
const JOB_ID = (() => {
  const raw = argVal('--job-id', '');
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();
/** Skip resume-index dedupe (always run Ollama + PDF). */
const FORCE = args.includes('--force');

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node ollama-cv-pipeline.mjs [options]

  --pipeline <path>   Default: data/pipeline.md (only unchecked "- [ ]" lines)
  --ollama <url>      Ollama API base (default \$OLLAMA_HOST or http://127.0.0.1:11434)
  --model <name>      Model name (default \$OLLAMA_MODEL or llama3.2:3b — must be pulled in Ollama)
  --only-active       Skip URLs that fail liveness (same heuristics as check-liveness.mjs)
  --dedupe-jd         Reuse the same PDF when two JD word-bags are ≥72% similar (Jaccard)
  --latest-only       Process only the newest pending URL (last "- [ ]" item in pipeline.md); ignored if --job-id is set
  --job-id <n>        Process only row n: same 1-based # as the Job Pipeline table (any [ ]/[x]/[a]/… line with URL)
  --force             Ignore resume-index dedupe; rewrite PDF even if index says it exists (use if output was deleted)
  --dry-run           List jobs only; no Ollama / no PDF
  --stop-on-error     Abort on first failure (default: continue)
  --low-mem           Use num_ctx=4096 (less RAM). Still need a small model if you have <16 GB — see below.

Environment:
  OLLAMA_HOST, OLLAMA_MODEL, OLLAMA_NUM_CTX (default 8192, or 4096 with --low-mem)
  OLLAMA_MAX_NUM_CTX  Cap when auto-raising context (default 6144; raise only if you have spare RAM)
  OLLAMA_TIMEOUT_MS  Max wait per Ollama request in ms (default 1800000 = 30 min; fixes UND_ERR_HEADERS_TIMEOUT on slow runs)
  OLLAMA_STREAM      Set to 0 to disable streaming (default: stream on — shows token progress in logs)
  OLLAMA_MIN_NUM_CTX_ON_RETRY  Floor when auto-shrinking num_ctx after runner exit 2 (default 2048)

Low RAM (~8 GB): pull a small model, then:
  ollama pull llama3.2:3b
  set OLLAMA_MODEL=llama3.2:3b
  npm run ollama:cv -- --low-mem

Requires: ollama serve, cv.md, config/profile.yml, templates/cv-template.html, modes/pdf.md (+ modes/_shared.md)
`);
  process.exit(0);
}

// ── Stopwords (minimal) for JD dedupe ───────────────────────────────

const STOP = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'she', 'use', 'her', 'many', 'than', 'them', 'these', 'this', 'that', 'with', 'from', 'have', 'will', 'your', 'what', 'when', 'where', 'which', 'while', 'about', 'after', 'before', 'being', 'each', 'more', 'most', 'other', 'some', 'such', 'their', 'there', 'through', 'during', 'would', 'could', 'should',
]);

function tokenSet(text) {
  const words = (text || '').toLowerCase().match(/[a-z]{3,}/g) || [];
  return new Set(words.filter((w) => !STOP.has(w)));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// ── Pipeline parsing (pending only) ─────────────────────────────────

function parsePendingJobs(markdown) {
  const jobs = [];
  for (const line of markdown.split('\n')) {
    const t = line.trim();
    const m = t.match(/^-\s*\[\s+\]\s+(https?:\/\/\S+)(?:\s*\|\s*([^|]*?)\s*\|\s*(.+))?$/);
    if (!m) continue;
    jobs.push({
      url: m[1],
      company: (m[2] || 'unknown-company').trim(),
      title: (m[3] || 'role').trim(),
    });
  }
  return jobs;
}

/** Every checkbox pipeline line in file order (# column in dashboard = 1 … n). */
function parseAllPipelineJobs(markdown) {
  const jobs = [];
  for (const line of markdown.split('\n')) {
    const t = line.trim();
    const m = t.match(/^\s*-\s*\[([^\]]*)\]\s+(https?:\/\/\S+)\s*\|\s*([^|]+)\s*\|\s*(.+)\s*$/i);
    if (!m) continue;
    jobs.push({
      rawMark: (m[1] || '').trim(),
      url: m[2].trim(),
      company: m[3].trim(),
      title: m[4].trim(),
    });
  }
  return jobs;
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72) || 'job';
}

function stableHash(text) {
  return createHash('sha1')
    .update(String(text || '').replace(/\s+/g, ' ').trim().toLowerCase())
    .digest('hex');
}

function readOptionalUtf8(relPath) {
  const p = join(ROOT, relPath);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf-8').trim();
}

/**
 * Same context as Claude Code `/career-ops pdf`: _shared.md + _profile.md + pdf.md
 * (see SKILL.md "Modes that require _shared.md + their mode file").
 * Gemini CLI does not ship a separate CV prompt; evaluation uses oferta.md — CV generation is pdf.md only.
 */
function buildCareerOpsPdfSystemPrompt() {
  const shared = readOptionalUtf8(join('modes', '_shared.md'));
  const profileMd = readOptionalUtf8(join('modes', '_profile.md'));
  const pdfPath = join(ROOT, 'modes', 'pdf.md');
  if (!existsSync(pdfPath)) {
    throw new Error(`Missing ${pdfPath} — required for CV generation (same as Claude pdf mode).`);
  }
  const pdfMode = readFileSync(pdfPath, 'utf-8').trim();

  if (!shared) {
    console.warn('Warning: modes/_shared.md not found — continuing with pdf.md only (Claude normally loads both).');
  }

  const profileBlock = profileMd
    ? `
═══════════════════════════════════════════════════════
USER PROFILE OVERRIDES (_profile.md) — read AFTER _shared.md
═══════════════════════════════════════════════════════
${profileMd}
`
    : '';

  return `You are career-ops, an AI-powered job search assistant.
You generate ATS-optimized HTML résumés from the candidate's cv.md and profile data using the methodology defined below. Follow it exactly.

═══════════════════════════════════════════════════════
SYSTEM CONTEXT (_shared.md)
═══════════════════════════════════════════════════════
${shared || '[modes/_shared.md not found on disk]'}
${profileBlock}
═══════════════════════════════════════════════════════
PDF MODE — CV / HTML generation (pdf.md)
═══════════════════════════════════════════════════════
${pdfMode}

═══════════════════════════════════════════════════════
IMPORTANT OPERATING RULES FOR THIS CLI SESSION
═══════════════════════════════════════════════════════
1. You do NOT have access to WebSearch, interactive Playwright, Canva MCP, Bash, or file-writing tools beyond producing the HTML string in your reply. The host script already fetched job page text and will run \`node generate-pdf.mjs\` after you respond — do not duplicate those steps.
2. Ignore the Canva workflow section(s) in pdf.md for this run; use the HTML + \`templates/cv-template.html\` path only.
3. Where pdf.md references running shell commands or browser tools, skip the command and use only the job page excerpt and cv.md supplied in the user message.
4. Generate Blocks per pdf.md (keyword extraction, summary, competencies, reorder experience, projects, etc.) using truth from cv.md — NEVER invent employers, degrees, metrics, or skills the candidate does not have.
5. Output ONE complete HTML document only: no markdown fences, no preamble or commentary outside the HTML.
6. CRITICAL — Template placeholders: The user message contains PREFILLED HTML that still includes the strings {{SUMMARY_TEXT}}, {{COMPETENCIES}}, {{EXPERIENCE}}, {{PROJECTS}}, {{EDUCATION}}, {{CERTIFICATIONS}}, and {{SKILLS}}. You MUST replace EVERY ONE of these with real HTML (paragraphs, lists, competency spans, etc.). Your final answer MUST NOT contain the literal characters {{SUMMARY_TEXT}} or any other {{NAME}}-style placeholder from that list — if you echo them unchanged, the PDF will show empty boilerplate and the candidate's résumé will be broken
`;
}

/** Smaller system message for local LLMs — avoids exceeding num_ctx when full _shared + _profile + pdf is huge. */
function buildCompactPdfSystemPrompt() {
  const pdfPath = join(ROOT, 'modes', 'pdf.md');
  if (!existsSync(pdfPath)) {
    throw new Error(`Missing ${pdfPath}`);
  }
  const pdfMode = readFileSync(pdfPath, 'utf-8').trim();
  const cap = 12_000;
  const excerpt =
    pdfMode.length > cap
      ? `${pdfMode.slice(0, cap)}\n\n… [remainder of modes/pdf.md omitted — file on disk] …\n`
      : pdfMode;
  return `You are career-ops. Output exactly ONE complete HTML document (no markdown fences, no text before <!DOCTYPE or after </html>).

Hard rules:
- Use ONLY facts from cv.md in the user message. Never invent employers, degrees, dates, or skills.
- Replace every dynamic placeholder in the prefilled template: {{SUMMARY_TEXT}}, {{COMPETENCIES}}, {{EXPERIENCE}}, {{PROJECTS}}, {{EDUCATION}}, {{CERTIFICATIONS}}, {{SKILLS}} with real HTML. The string "{{SUMMARY_TEXT}}" must not appear in your output.
- Tailor phrasing using the JOB POSTING excerpt and the methodology below; inject JD keywords only where they match real experience.

Condensed pdf.md:
${excerpt}
`;
}

/** ~few hundred tokens — used when compact pdf excerpt + cv + template still exceed OLLAMA_MAX_NUM_CTX. */
function buildMinimalPdfSystemPrompt() {
  return `You are career-ops. Output exactly ONE complete HTML document (no markdown code fences, no commentary outside the HTML).
ATS-friendly: single column, selectable text.

Rules:
- Use ONLY facts from the cv.md section of the user message. Never invent employers, degrees, dates, or skills.
- The user message includes prefilled HTML from templates/cv-template.html. Replace every {{SUMMARY_TEXT}}, {{COMPETENCIES}}, {{EXPERIENCE}}, {{PROJECTS}}, {{EDUCATION}}, {{CERTIFICATIONS}}, {{SKILLS}} with real HTML lists/paragraphs. Those placeholders must not appear in your output.
- Use the JOB POSTING excerpt for keyword alignment where it matches real experience.
`;
}

// ── Playwright scrape: shared module scrape-pipeline-job.mjs ────────

// ── Profile + template prefill ──────────────────────────────────────

function loadProfile() {
  const p = join(ROOT, 'config', 'profile.yml');
  if (!existsSync(p)) throw new Error(`Missing ${p}`);
  return yaml.load(readFileSync(p, 'utf-8'));
}

function linkedinUrls(raw) {
  const s = String(raw || '').trim();
  if (!s) return { url: '#', display: '' };
  const url = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  const display = s.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
  return { url, display };
}

function prefillTemplateStatic(templateHtml, profile) {
  const c = profile.candidate || {};
  const li = linkedinUrls(c.linkedin);
  const portfolio = String(c.portfolio_url || '').trim();
  const portfolioDisplay = portfolio ? portfolio.replace(/^https?:\/\//i, '').replace(/\/$/, '') : '';

  const pageWidth = '8.5in';
  const lang = 'en';

  const map = {
    '{{LANG}}': lang,
    '{{PAGE_WIDTH}}': pageWidth,
    '{{NAME}}': c.full_name || 'Candidate',
    '{{PHONE}}': c.phone || '',
    '{{EMAIL}}': c.email || '',
    '{{LINKEDIN_URL}}': li.url,
    '{{LINKEDIN_DISPLAY}}': li.display || 'LinkedIn',
    '{{PORTFOLIO_URL}}': portfolio || '#',
    '{{PORTFOLIO_DISPLAY}}': portfolioDisplay || 'Portfolio',
    '{{LOCATION}}': c.location || '',
    '{{SECTION_SUMMARY}}': 'Professional Summary',
    '{{SECTION_COMPETENCIES}}': 'Core Competencies',
    '{{SECTION_EXPERIENCE}}': 'Work Experience',
    '{{SECTION_PROJECTS}}': 'Projects',
    '{{SECTION_EDUCATION}}': 'Education',
    '{{SECTION_CERTIFICATIONS}}': 'Certifications',
    '{{SECTION_SKILLS}}': 'Skills',
  };

  let out = templateHtml;
  for (const [k, v] of Object.entries(map)) {
    out = out.split(k).join(v);
  }
  return out;
}

// ── Ollama ──────────────────────────────────────────────────────────

/** Base num_ctx; auto-bump is capped by OLLAMA_MAX_NUM_CTX (KV cache RAM grows with context). */
const NUM_CTX = Math.min(
  parseInt(
    process.env.OLLAMA_NUM_CTX || (LOW_MEM ? '4096' : '8192'),
    10
  ) || (LOW_MEM ? 4096 : 8192),
  131072
);

/**
 * Hard cap when raising context for long prompts — KV cache RAM grows with num_ctx (8B + 8k ctx often needs ~12+ GiB).
 * Default 6144 is safer on 16 GB PCs; set OLLAMA_MAX_NUM_CTX=8192+ only if Ollama still has headroom.
 */
const OLLAMA_MAX_NUM_CTX_CAP = Math.min(
  131072,
  Math.max(2048, parseInt(process.env.OLLAMA_MAX_NUM_CTX || '6144', 10) || 6144),
);

function formatNodeFetchError(err) {
  const cause = err?.cause;
  const code = cause?.code || cause?.errno || '';
  const msg = err?.message || String(err);
  let hint = '';
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(msg)) {
    hint =
      '\n  → Nothing is listening on that address. Start Ollama: `ollama serve` or open the Ollama app (Windows), then check `OLLAMA_HOST` matches (default http://127.0.0.1:11434).';
  } else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    hint = '\n  → DNS/host error — check OLLAMA_HOST.';
  } else if (code === 'UND_ERR_HEADERS_TIMEOUT' || /HEADERS_TIMEOUT/i.test(msg)) {
    hint = `\n  → Undici waited too long for HTTP headers from Ollama (often: first inference after pull, or huge prompt). Already raising limits via undici Agent; try OLLAMA_TIMEOUT_MS=3600000 (1h) or trim modes/pdf prompt size.`;
  } else if (code === 'ETIMEDOUT' || /aborted|timeout/i.test(msg)) {
    hint = `\n  → Request timed out. Increase OLLAMA_TIMEOUT_MS (ms) or use a smaller prompt; model may be overloaded.`;
  } else if (msg === 'fetch failed' || !code) {
    hint =
      '\n  → Usually: Ollama not running, wrong port, or firewall. Test: `curl -s http://127.0.0.1:11434/api/tags`';
  }
  return `${msg}${code ? ` (${code})` : ''}${hint}`;
}

/** Default: streaming so logs show progress; set OLLAMA_STREAM=0 to use one-shot /api/chat (no tokens until done). */
const OLLAMA_STREAM = process.env.OLLAMA_STREAM !== '0';

function estimatePromptTokens(text) {
  return Math.ceil(String(text).length / 3.5);
}

/** Shorten the JOB POSTING block first (JD is often huge vs cv.md). Never shrink below minKeep chars total. */
function shrinkUserPromptByTruncatingJobPosting(user, targetMaxChars, minKeep = 12_000) {
  const floor = Math.max(minKeep, Math.min(targetMaxChars, user.length));
  if (user.length <= floor) return user;
  const candidateMarker = '\n═══════════════════════════════════════════════════════\nCANDIDATE RESUME (cv.md)';
  const ci = user.indexOf(candidateMarker);
  if (ci === -1) {
    return user.slice(0, Math.max(floor, targetMaxChars)) + '\n[… truncated …]\n';
  }
  const head = user.slice(0, ci);
  const tail = user.slice(ci);
  const over = user.length - Math.max(floor, targetMaxChars);
  const jdLabel = 'JOB POSTING / PAGE TEXT';
  const ji = head.indexOf(jdLabel);
  if (ji === -1) {
    return head.slice(0, Math.max(0, head.length - over - 50)) + '\n[… truncated …]\n' + tail;
  }
  const afterBars = head.indexOf('═\n', ji + 40);
  if (afterBars === -1) return user.slice(0, Math.max(floor, targetMaxChars)) + '\n[… truncated …]\n';
  const jdTextStart = head.indexOf('\n', afterBars + 2);
  if (jdTextStart === -1) return user.slice(0, Math.max(floor, targetMaxChars)) + '\n[… truncated …]\n';
  let jd = head.slice(jdTextStart + 1, ci);
  const beforeJd = head.slice(0, jdTextStart + 1);
  if (jd.length < 400) return user;
  const newJdLen = Math.max(800, jd.length - Math.max(0, over) - 200);
  jd = jd.slice(0, newJdLen) + '\n[… job posting text truncated for LLM context window …]\n';
  return beforeJd + jd + tail;
}

/** The prefilled cv-template.html copy is huge (CSS). Truncate the HTML tail, keep cv.md + instructions. */
function truncatePrefillHtmlInUser(user, maxHtmlChars) {
  const d = user.lastIndexOf('<!DOCTYPE html>');
  if (d === -1) return user;
  const before = user.slice(0, d);
  const html = user.slice(d);
  if (html.length <= maxHtmlChars) return user;
  return (
    before +
    html.slice(0, maxHtmlChars) +
    '\n<!-- … template HTML truncated for LLM RAM/context — placeholders {{SUMMARY_TEXT}} etc. must still be replaced … -->\n'
  );
}

function resolveSystemUserAndNumCtx(fullSys, compactSys, minimalSys, user, baseNumCtx) {
  /** Reserve for model output; keep modest so borderline prompts fit under OLLAMA_MAX_NUM_CTX. */
  const reserveOut = 2200;
  const need = (sys, u) => estimatePromptTokens(sys) + estimatePromptTokens(u) + reserveOut;
  const maxCtx = OLLAMA_MAX_NUM_CTX_CAP;
  const base = Math.min(baseNumCtx, maxCtx);
  if (baseNumCtx > maxCtx) {
    logLine(`  → Clamping OLLAMA_NUM_CTX (${baseNumCtx}) to OLLAMA_MAX_NUM_CTX (${maxCtx}) so the model fits in RAM.`);
  }

  const bumpCtx = (nTok) =>
    Math.min(maxCtx, Math.max(base, Math.ceil(nTok / 2048) * 2048));

  let sys = fullSys;
  let u = user;
  let n = need(sys, u);

  if (need(compactSys, u) < n) {
    sys = compactSys;
    n = need(sys, u);
    logLine('  → Using compact system prompt (full _shared/_profile stack omitted; files still on disk).');
  }

  let numCtx = bumpCtx(n);

  // 1) Truncate JD only while prompt is long (never shred cv+template with 0.72^n)
  let jdIter = 0;
  while (n > numCtx - 200 && jdIter < 12 && u.length > 22_000) {
    jdIter++;
    const nextTarget = Math.max(16_000, Math.floor(u.length * 0.88));
    const u2 = shrinkUserPromptByTruncatingJobPosting(u, nextTarget, 16_000);
    if (u2.length >= u.length - 30) break;
    u = u2;
    n = need(sys, u);
    numCtx = bumpCtx(n);
    logLine(`  → Truncating job-posting block; prompt ~${u.length} chars (num_ctx cap ${maxCtx}).`);
  }

  // 2) Prefilled HTML (CSS) is the next largest piece
  if (n > numCtx - 200) {
    u = truncatePrefillHtmlInUser(u, 14_000);
    n = need(sys, u);
    numCtx = bumpCtx(n);
    logLine(`  → Truncated prefilled HTML template (~${u.length} chars).`);
  }
  if (n > numCtx - 200) {
    u = truncatePrefillHtmlInUser(u, 9000);
    n = need(sys, u);
    numCtx = bumpCtx(n);
    logLine(`  → Truncated prefilled HTML further (~${u.length} chars).`);
  }

  // 3) Drop pdf.md excerpt — minimal instructions only
  if (n > numCtx - 200) {
    sys = minimalSys;
    n = need(sys, u);
    numCtx = bumpCtx(n);
    logLine('  → Using minimal system prompt (fits under OLLAMA_MAX_NUM_CTX with your cv + template).');
  }

  if (n > numCtx - 200) {
    u = truncatePrefillHtmlInUser(u, 6500);
    n = need(sys, u);
    numCtx = bumpCtx(n);
  }

  if (n > numCtx - 200 && u.length > 12_000) {
    u = `${u.slice(0, 12_000)}\n[… tail truncated — shorten cv.md if output quality drops …]\n`;
    n = need(sys, u);
    numCtx = bumpCtx(n);
  }

  if (n > numCtx) {
    u = truncatePrefillHtmlInUser(u, 4000);
    n = need(sys, u);
    numCtx = bumpCtx(n);
  }
  if (n > numCtx && u.length > 14_000) {
    u = `${u.slice(0, 14_000)}\n[… hard-truncated user message for context cap ${maxCtx} — shorten cv.md …]\n`;
    n = need(sys, u);
    numCtx = bumpCtx(n);
  }

  if (n > numCtx) {
    throw new Error(
      `Estimated prompt ~${n} tokens still exceeds num_ctx=${numCtx} (OLLAMA_MAX_NUM_CTX cap ${maxCtx}). Shorten cv.md or set OLLAMA_MAX_NUM_CTX higher if you have RAM.`,
    );
  }

  if (numCtx > base) {
    logLine(
      `  → num_ctx=${numCtx} (effective base: ${base}, cap: ${maxCtx}; ~${estimatePromptTokens(sys) + estimatePromptTokens(u)} tok in + reserve).`,
    );
  }

  return { system: sys, user: u, numCtx };
}

function logPromptSizeHint(system, user, ctxUsed) {
  const promptChars = system.length + user.length;
  const roughTok = Math.ceil(promptChars / 4);
  logLine(
    `  → Prompt size: ~${promptChars} chars (~${roughTok} tok est.), system=${system.length}, user=${user.length}, num_ctx=${ctxUsed}`,
  );
  if (roughTok > ctxUsed * 0.92) {
    logLine(
      `  ⚠ Prompt is large vs num_ctx=${ctxUsed}. If the runner crashes, increase OLLAMA_NUM_CTX or trim cv.md / modes.`,
    );
  }
}

/**
 * NDJSON stream from POST /api/chat with stream:true — proves Ollama is producing output (vs silent buffer wait).
 */
async function readOllamaChatStream(res, signal) {
  if (!res.body) throw new Error('Ollama returned no response body (stream)');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  let lastLog = Date.now();
  const LOG_MS = 12_000;

  while (true) {
    const { done, value } = await reader.read();
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      const e = new Error('Aborted');
      e.name = 'AbortError';
      throw e;
    }
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const line of parts) {
      const t = line.trim();
      if (!t) continue;
      let j;
      try {
        j = JSON.parse(t);
      } catch {
        continue;
      }
      if (j.error) throw new Error(`Ollama: ${j.error}`);
      const piece = j.message?.content;
      if (piece) full += piece;
    }
    if (Date.now() - lastLog > LOG_MS) {
      logLine(`  … Ollama stream: ${full.length} chars received so far`);
      lastLog = Date.now();
    }
  }
  const tail = buf.trim();
  if (tail) {
    try {
      const j = JSON.parse(tail);
      if (j.error) throw new Error(`Ollama: ${j.error}`);
      const piece = j.message?.content;
      if (piece) full += piece;
    } catch (e) {
      if (String(e?.message || '').startsWith('Ollama:')) throw e;
    }
  }
  return full;
}

/** Parse Ollama error JSON; flags are from the server string only (not our appended hints). */
function classifyOllamaErrorJson(t) {
  let err = '';
  try {
    const j = JSON.parse(t);
    err = String(j.error || '');
  } catch {
    return { err: '', oomFromServer: false, runnerExit2: false };
  }
  const oomFromServer =
    /memory|GiB|RAM|available|system memory|insufficient vram|out of memory/i.test(err);
  const runnerExit2 = /runner process has terminated|exit status 2/i.test(err);
  return { err, oomFromServer, runnerExit2 };
}

function ollamaHttpErrorHint(errBody) {
  const err = String(errBody || '');
  if (/memory|GiB|RAM|available|system memory|insufficient vram|out of memory/i.test(err)) {
    return `

→ Ollama needs more **system RAM** than is free (KV cache grows with num_ctx; 8B models spike past ~12 GiB easily).
  1) **Best on 8–16 GB machines:** use a smaller model:
       ollama pull llama3.2:3b
       In .env: OLLAMA_MODEL=llama3.2:3b
     (Alternatives: gemma2:2b, phi3:mini)
  2) **Lower context = less RAM:** in .env set e.g.
       OLLAMA_NUM_CTX=4096
       OLLAMA_MAX_NUM_CTX=6144
     (defaults are already conservative; raising MAX only if you have spare RAM.)
  3) Close browsers/IDE so Ollama has headroom.
  4) With **32+ GB** RAM you can run llama3.1 8B with higher OLLAMA_MAX_NUM_CTX.`;
  }
  if (/runner process has terminated|exit status 2/i.test(err)) {
    return `

→ Often: **KV cache / prompt vs num_ctx**, or the runner needs more **free system headroom** than Ollama has (exit 2). Try \`OLLAMA_MODEL=llama3.2:3b\` or \`llama3.2:1b\`, lower \`OLLAMA_MAX_NUM_CTX\`, or raise the cap only if your machine can spare it. Remove \`CAREER_OPS_OLLAMA_LOW_MEM\` if you forced a very small num_ctx.`;
  }
  return '';
}

async function ollamaChat(system, user, numCtxForRequest = NUM_CTX) {
  const url = `${OLLAMA_BASE.replace(/\/$/, '')}/api/chat`;
  logPromptSizeHint(system, user, numCtxForRequest);

  let lastFetchErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let ctxTry = numCtxForRequest;
    if (attempt > 1) {
      logLine(`  → Ollama retry ${attempt}/3…`);
      logPromptSizeHint(system, user, ctxTry);
    } else {
      logLine(
        OLLAMA_STREAM
          ? `  → POST ${url} (streaming — progress lines every ~12s while tokens arrive)…`
          : `  → POST ${url} (non-streaming — **no** output until the full HTML is ready)…`,
      );
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), OLLAMA_TIMEOUT_MS);
    try {
      let res;
      // Runner exit 2: retry with smaller num_ctx (often RAM pressure; avoids false "OOM abort" on hints).
      while (true) {
        const streamMode = OLLAMA_STREAM;
        const payload = JSON.stringify({
          model: effectiveOllamaModel,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          options: { temperature: 0.35, num_ctx: ctxTry },
          stream: streamMode,
        });

        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          signal: ac.signal,
        });

        if (res.ok) break;

        const t = await res.text();
        const { err, oomFromServer, runnerExit2 } = classifyOllamaErrorJson(t);
        const floor = Math.max(
          2048,
          parseInt(process.env.OLLAMA_MIN_NUM_CTX_ON_RETRY || '2048', 10) || 2048,
        );
        if (runnerExit2 && !oomFromServer && ctxTry > floor) {
          const next = Math.max(floor, Math.floor(ctxTry * 0.55));
          if (next < ctxTry) {
            logLine(`  → Ollama runner exited (HTTP ${res.status}); retrying with num_ctx=${next} (was ${ctxTry}).`);
            ctxTry = next;
            continue;
          }
        }

        clearTimeout(timer);
        const hint = ollamaHttpErrorHint(err);
        const msg = `Ollama HTTP ${res.status}: ${t.slice(0, 400)}${hint}`;
        const ex = new Error(msg);
        ex.ollamaInsufficientMemory = oomFromServer;
        throw ex;
      }

      let text;
      const streamMode = OLLAMA_STREAM;
      if (streamMode) {
        text = await readOllamaChatStream(res, ac.signal);
        clearTimeout(timer);
        if (!text?.trim()) throw new Error('Ollama stream returned empty assistant content');
        logLine(`  → Ollama stream finished: ${text.length} chars total`);
      } else {
        const data = await res.json();
        clearTimeout(timer);
        text = data.message?.content;
        if (!text) throw new Error('Ollama returned empty message');
      }

      lastFetchErr = null;
      return text;
    } catch (err) {
      clearTimeout(timer);
      const m = String(err?.message || '');
      if (
        m.startsWith('Ollama HTTP') ||
        m === 'Ollama returned empty message' ||
        /empty assistant content/i.test(m)
      ) {
        throw err;
      }

      lastFetchErr = err;
      const isAbort = err?.name === 'AbortError';
      const retryable =
        isAbort ||
        /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket/i.test(
          m + String(err?.cause?.code || '')
        );
      if (attempt < 3 && retryable) {
        console.warn(`  ⚠ Ollama request failed (attempt ${attempt}/3), retrying…`);
        await sleep(1000 * attempt);
        continue;
      }
      throw new Error(formatNodeFetchError(err));
    }
  }
  throw new Error(formatNodeFetchError(lastFetchErr || new Error('Ollama: unknown failure')));
}

function stripCodeFences(html) {
  let s = html.trim();
  const m = s.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (m) s = m[1].trim();
  return s;
}

/** True only when Ollama's JSON error indicates host OOM — do not match our appended hints (would false-positive on "exit 2"). */
function isOllamaInsufficientMemoryError(err) {
  return err?.ollamaInsufficientMemory === true;
}

// ── Main ────────────────────────────────────────────────────────────

async function checkOllamaAndResolveModel() {
  const base = OLLAMA_BASE.replace(/\/$/, '');
  const res = await fetch(`${base}/api/tags`);
  if (!res.ok) {
    console.error(`Fatal: Ollama not reachable at ${OLLAMA_BASE} (GET /api/tags → HTTP ${res.status}). Is \`ollama serve\` running?`);
    return null;
  }
  const data = await res.json();
  const names = (data.models || []).map((m) => m.name);
  const req = MODEL_REQUESTED;

  if (names.length === 0) {
    console.error(`
No Ollama models are installed.

  ollama pull llama3.2:3b

Then run: ollama list
`);
    return null;
  }

  if (names.includes(req)) return req;

  const tagged = names.find(
    (n) => n === `${req}:latest` || (!req.includes(':') && n.startsWith(`${req}:`))
  );
  if (tagged) return tagged;

  const baseName = req.split(':')[0];
  const sameFamily = names.find((n) => n.split(':')[0] === baseName);
  if (sameFamily) return sameFamily;

  console.error(`No installed Ollama model matches "${req}".`);
  console.error(`Installed: ${names.join(', ')}`);
  console.error(`\nInstall one, e.g.:  ollama pull ${baseName}\n  or:  set OLLAMA_MODEL=${names[0]}`);
  return null;
}

const CV_PATH = join(ROOT, 'cv.md');
const TEMPLATE_PATH = join(ROOT, 'templates', 'cv-template.html');
const OUT_HTML_DIR = join(ROOT, 'output', 'ollama-html');
const OUT_PDF_DIR = join(ROOT, 'output');
const RESUME_INDEX_PATH = join(ROOT, 'output', 'resume-index.json');

if (!existsSync(CV_PATH)) {
  console.error('Fatal: cv.md not found in project root.');
  process.exit(1);
}
if (!existsSync(TEMPLATE_PATH)) {
  console.error('Fatal: templates/cv-template.html not found.');
  process.exit(1);
}
if (!existsSync(PIPELINE_PATH)) {
  console.error(`Fatal: ${PIPELINE_PATH} not found.`);
  process.exit(1);
}

const pipelineMd = readFileSync(PIPELINE_PATH, 'utf-8');
let jobs;
if (JOB_ID > 0) {
  const all = parseAllPipelineJobs(pipelineMd);
  if (JOB_ID > all.length) {
    console.error(
      `--job-id ${JOB_ID}: ${PIPELINE_PATH} has only ${all.length} checkbox line(s). Use the # column from the dashboard Job Pipeline table.`,
    );
    process.exit(1);
  }
  const row = all[JOB_ID - 1];
  jobs = [{ url: row.url, company: row.company, title: row.title }];
  console.log(
    `Single-job mode --job-id ${JOB_ID}: ${row.company} | ${row.title} (checkbox mark: "${row.rawMark || ' '}")`,
  );
} else {
  jobs = parsePendingJobs(pipelineMd);
  if (LATEST_ONLY && jobs.length > 0) {
    jobs = [jobs[jobs.length - 1]];
  }
  if (jobs.length === 0) {
    console.log('No pending items (- [ ]) with URLs in pipeline. Nothing to do. (Use --job-id <n> to target a specific row by #.)');
    process.exit(0);
  }
}

console.log(
  `Found ${jobs.length} job(s) to process in ${PIPELINE_PATH}${JOB_ID > 0 ? ' (--job-id)' : ''}`,
);
if (DRY_RUN) {
  jobs.forEach((j, i) => console.log(`  ${i + 1}. ${j.company} | ${j.title} | ${j.url}`));
  process.exit(0);
}

effectiveOllamaModel = await checkOllamaAndResolveModel();
if (!effectiveOllamaModel) process.exit(1);
console.log(`Ollama: ${OLLAMA_BASE}  model: ${effectiveOllamaModel}  (requested: ${MODEL_REQUESTED})`);

const profile = loadProfile();
const cvMd = readFileSync(CV_PATH, 'utf-8');
const templateRaw = readFileSync(TEMPLATE_PATH, 'utf-8');
const basePrefilled = prefillTemplateStatic(templateRaw, profile);

const DYNAMIC = ['{{SUMMARY_TEXT}}', '{{COMPETENCIES}}', '{{EXPERIENCE}}', '{{PROJECTS}}', '{{EDUCATION}}', '{{CERTIFICATIONS}}', '{{SKILLS}}'];
for (const d of DYNAMIC) {
  if (!basePrefilled.includes(d)) {
    console.warn(`Warning: template missing ${d} — generation may fail.`);
  }
}

mkdirSync(OUT_HTML_DIR, { recursive: true });
mkdirSync(OUT_PDF_DIR, { recursive: true });

const systemPromptFull = buildCareerOpsPdfSystemPrompt();
const systemPromptCompact = buildCompactPdfSystemPrompt();
const systemPromptMinimal = buildMinimalPdfSystemPrompt();
const profileYamlRaw = readFileSync(join(ROOT, 'config', 'profile.yml'), 'utf-8');
const articleDigest = readOptionalUtf8('article-digest.md');

console.log(
  `Context: modes/pdf.md + modes/_shared.md + modes/_profile.md (num_ctx=${NUM_CTX}, http timeout=${OLLAMA_TIMEOUT_MS}ms${LOW_MEM ? ', --low-mem' : ''})`
);

await ensureChromium(false);

const jdBuckets = []; // { tokens, pdfPath }
let resumeIndex = { items: [] };
if (existsSync(RESUME_INDEX_PATH)) {
  try {
    resumeIndex = JSON.parse(readFileSync(RESUME_INDEX_PATH, 'utf-8'));
    if (!Array.isArray(resumeIndex.items)) resumeIndex = { items: [] };
  } catch {
    resumeIndex = { items: [] };
  }
}

let ok = 0;
let fail = 0;
const date = new Date().toISOString().slice(0, 10);

for (let i = 0; i < jobs.length; i++) {
  const job = jobs[i];
  const label = `${job.company} — ${job.title}`;
  logLine('');
  logLine(`[${i + 1}/${jobs.length}] ${label}`);
  logLine(
    '  → Step 1/3: Fetching job page (Chromium). Next lines show progress; if nothing appears for >2 min, the site may be blocking automation.',
  );

  let jdSnippet;
  let tokens;

  try {
    const scraped = await scrapePipelineJob(job.url, logLine);
    jdSnippet = scraped.jdSnippet;
    const jdHash = stableHash(jdSnippet);

    const byUrl = resumeIndex.items.find((x) => x.url === job.url && x.jdHash === jdHash && x.pdfPath);
    if (!FORCE && byUrl) {
      const pdfOnDisk = resolve(String(byUrl.pdfPath));
      if (existsSync(pdfOnDisk)) {
        console.log(`  Skip (already generated for same URL+JD): ${pdfOnDisk}`);
        ok++;
        continue;
      }
      console.warn(
        `  resume-index references a missing PDF (regenerating): ${pdfOnDisk}\n  Fix: delete stale entries in output/resume-index.json or run with --force`,
      );
      resumeIndex.items = resumeIndex.items.filter((x) => !(x.url === job.url && x.jdHash === jdHash));
    }

    if (ONLY_ACTIVE && scraped.live.result !== 'active') {
      console.log(`  Skip (not active: ${scraped.live.result} — ${scraped.live.reason})`);
      continue;
    }

    tokens = tokenSet(jdSnippet);

    if (DEDUPE_JD && jdBuckets.length > 0) {
      let best = null;
      let bestScore = 0;
      for (const b of jdBuckets) {
        const s = jaccard(b.tokens, tokens);
        if (s > bestScore) {
          bestScore = s;
          best = b;
        }
      }
      if (best && bestScore >= 0.72) {
        const destPdf = join(OUT_PDF_DIR, `cv-${slugify(job.company)}-${slugify(job.title)}-${date}.pdf`);
        copyFileSync(best.pdfPath, destPdf);
        console.log(`  Deduped (Jaccard ${bestScore.toFixed(2)}): copied → ${destPdf}`);
        ok++;
        continue;
      }
    }
  } catch (e) {
    console.error(`  Fetch error: ${e.message}`);
    fail++;
    if (STOP_ON_ERROR) break;
    continue;
  }

  const userPrompt = `TARGET ROLE (from pipeline)
Company: ${job.company}
Title: ${job.title}
URL: ${job.url}

═══════════════════════════════════════════════════════
JOB POSTING / PAGE TEXT (for tailoring — same role as Claude pdf mode would read via Playwright)
═══════════════════════════════════════════════════════
${jdSnippet}

═══════════════════════════════════════════════════════
CANDIDATE RESUME (cv.md) — source of truth; never fabricate beyond this
═══════════════════════════════════════════════════════
${cvMd}

${articleDigest ? `═══════════════════════════════════════════════════════
ARTICLE DIGEST (article-digest.md) — detailed proof points if present (_shared.md rule)
═══════════════════════════════════════════════════════
${articleDigest}

` : ''}═══════════════════════════════════════════════════════
config/profile.yml (raw — identity, links; template may already reflect this)
═══════════════════════════════════════════════════════
${profileYamlRaw}

═══════════════════════════════════════════════════════
PREFILLED templates/cv-template.html — replace ONLY remaining placeholders per pdf.md
═══════════════════════════════════════════════════════
Static placeholders (NAME, contact, section titles, LANG, PAGE_WIDTH, etc.) are already filled where applicable.
You MUST output a single complete HTML file with {{SUMMARY_TEXT}}, {{COMPETENCIES}}, {{EXPERIENCE}}, {{PROJECTS}}, {{EDUCATION}}, {{CERTIFICATIONS}}, and {{SKILLS}} replaced per modes/pdf.md instructions.
${basePrefilled}`;

  logLine(
    `  → Step 2/3: Ollama (${effectiveOllamaModel}) — tailoring HTML (logs show prompt size + streaming token progress unless OLLAMA_STREAM=0).`,
  );
  let html;
  let ollamaHb = null;
  if (!OLLAMA_STREAM) {
    ollamaHb = setInterval(() => {
      logLine(`  … still waiting on Ollama (${effectiveOllamaModel}) — non-streaming mode; no output until the full reply`);
    }, 30_000);
  }
  try {
    const resolved = resolveSystemUserAndNumCtx(
      systemPromptFull,
      systemPromptCompact,
      systemPromptMinimal,
      userPrompt,
      NUM_CTX,
    );
    html = await ollamaChat(resolved.system, resolved.user, resolved.numCtx);
    html = stripCodeFences(html);
    if (!html.includes('<!DOCTYPE') && !html.includes('<html')) {
      throw new Error('Model output does not look like HTML');
    }

    const merged = mergeOllamaOutputWithCvBody(html, basePrefilled, cvMd);
    html = merged.html;
    if (merged.usedModelSummary) {
      logLine(
        '  → Full résumé body from cv.md (experience, competencies, projects, education, certifications, skills); Professional Summary uses Ollama when it was substantive.',
      );
    } else {
      logLine(
        '  → Full résumé from cv.md for all sections (Ollama summary missing/short, or OLLAMA_USE_CV_ONLY=1).',
      );
    }

    const unresolved = listUnresolvedDynamicPlaceholders(html);
    if (unresolved.length > 0) {
      logLine(
        `  ⚠ ${unresolved.length} placeholder(s) left (${unresolved.join(', ')}) — filling from cv.md.`,
      );
      html = applyDynamicPlaceholdersFromCvMd(html, cvMd);
      const still = listUnresolvedDynamicPlaceholders(html);
      if (still.length > 0) {
        throw new Error(`After cv.md fallback, placeholders remain: ${still.join(', ')}`);
      }
    }

    if (resumeHtmlNeedsCvFullRebuild(html, cvMd)) {
      logLine(
        '  ⚠ Post-merge check: rebuilding full document from templates/cv-template.html + cv.md.',
      );
      html = applyDynamicPlaceholdersFromCvMd(basePrefilled, cvMd);
      const left = listUnresolvedDynamicPlaceholders(html);
      if (left.length > 0) {
        throw new Error(`Full cv.md rebuild still left placeholders: ${left.join(', ')}`);
      }
    }
  } catch (e) {
    console.error(`  Ollama error: ${e.message}`);
    fail++;
    if (isOllamaInsufficientMemoryError(e)) {
      console.error(
        `\nAborting pipeline: out-of-memory will repeat for every job. Fix model/RAM, then run again.\n`
      );
      break;
    }
    if (STOP_ON_ERROR) break;
    continue;
  } finally {
    if (ollamaHb) clearInterval(ollamaHb);
  }

  const baseName = `${slugify(job.company)}-${slugify(job.title)}-${String(i + 1).padStart(2, '0')}`;
  const htmlPath = join(OUT_HTML_DIR, `${baseName}.html`);
  const pdfPath = join(OUT_PDF_DIR, `cv-${slugify(job.company)}-${slugify(job.title)}-${date}.pdf`);

  writeFileSync(htmlPath, html, 'utf-8');
  logLine(`  HTML → ${htmlPath}`);

  mkdirSync(dirname(pdfPath), { recursive: true });

  logLine('  → Step 3/3: Rendering PDF (Playwright Chromium)…');
  try {
    execFileSync(process.execPath, [join(ROOT, 'generate-pdf.mjs'), htmlPath, pdfPath, '--format=letter'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    const absPdf = resolve(pdfPath);
    if (!existsSync(absPdf)) {
      throw new Error(`generate-pdf finished but file not found: ${absPdf}`);
    }
    logLine(`  PDF → ${absPdf}`);
  } catch (e) {
    console.error(`  PDF generation failed: ${e && e.message ? e.message : e}`);
    fail++;
    if (STOP_ON_ERROR) break;
    continue;
  }

  ok++;
  try {
    const freshHash = stableHash(jdSnippet);
    resumeIndex.items = resumeIndex.items.filter((x) => !(x.url === job.url && x.jdHash === freshHash));
    resumeIndex.items.push({
      url: job.url,
      company: job.company,
      title: job.title,
      htmlPath,
      pdfPath,
      jdHash: freshHash,
      generatedAt: new Date().toISOString(),
    });
    writeFileSync(RESUME_INDEX_PATH, JSON.stringify(resumeIndex, null, 2), 'utf-8');
  } catch {
    /* non-fatal index write error */
  }
  if (DEDUPE_JD) {
    jdBuckets.push({ tokens, pdfPath });
  }
}

await closeChromiumBrowser();

console.log(`\nDone. Success: ${ok}  Failed/skipped: ${fail}`);
if (fail > 0) process.exit(1);
