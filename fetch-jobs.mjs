#!/usr/bin/env node
/**
 * fetch-jobs.mjs — RapidAPI JSearch → data/pipeline.md + data/scan-history.tsv
 *
 * Uses the same pipeline line format as scan.mjs:
 *   - [ ] {url} | {company} | {title}
 *
 * Requires: RAPIDAPI_KEY in .env or .env.example, portals.yml for title_filter (fallback: built-in list)
 *
 * Usage: node fetch-jobs.mjs
 *        node fetch-jobs.mjs --dry-run
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { loadProjectEnv } from './load-project-env.mjs';
import { estimateJobScore } from './job-score-heuristic.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
await loadProjectEnv(ROOT);

const RAPIDAPI_KEY = (process.env.RAPIDAPI_KEY || '').trim();
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const SCAN_HISTORY_PATH = join(ROOT, 'data', 'scan-history.tsv');
const PORTALS_PATH = join(ROOT, 'portals.yml');

const JSEARCH_URL = 'https://jsearch.p.rapidapi.com/search';

const SEARCH_QUERIES = [
  'Machine Learning Engineer remote',
  'Senior ML Engineer remote',
  'Applied AI Engineer remote',
  'LLMOps Engineer remote',
  'MLOps Engineer remote',
  'Data Scientist AI NLP remote',
  'Healthcare AI Machine Learning Engineer',
  'Clinical NLP Engineer remote',
  'LLM Engineer NLP remote',
  'AI Platform Engineer ML remote',
];

const DEFAULT_TITLE_FILTER = {
  positive: [
    'Machine Learning Engineer',
    'ML Engineer',
    'AI Engineer',
    'Applied AI Engineer',
    'Applied ML',
    'Applied Scientist',
    'Research Engineer',
    'AI Platform Engineer',
    'Data Scientist',
    'Senior Data Scientist',
    'Staff Data Scientist',
    'ML Data Scientist',
    'AI Data Scientist',
    'LLM',
    'GenAI',
    'Generative AI',
    'NLP Engineer',
    'Prompt Engineer',
    'AI Infrastructure',
    'MLOps',
    'LLMOps',
    'ML Platform',
    'ML Infrastructure',
    'Model Deployment',
    'AI Platform',
    'Clinical AI',
    'Health AI',
    'Healthcare ML',
    'Clinical NLP',
    'Cloud ML',
    'AI/ML',
    'ML Systems',
  ],
  negative: [
    'Intern',
    'Junior',
    'Entry Level',
    'Forward Deployed',
    'Solutions Architect',
    'Solutions Engineer',
    'Product Manager',
    'Developer Advocate',
    'DevRel',
    'Sales',
    'Account',
    'Marketing',
    'Designer',
    'iOS',
    'Android',
    'PHP',
    'Ruby',
    'Embedded',
    'Firmware',
    'Blockchain',
    'Web3',
    'Crypto',
    'COBOL',
    'Mainframe',
  ],
  seniority_boost: ['Senior', 'Staff', 'Principal', 'Lead', 'Head of'],
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map((k) => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map((k) => k.toLowerCase());
  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some((k) => lower.includes(k));
    const hasNegative = negative.some((k) => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

function hasSeniorityBoost(title, boosts) {
  const lower = title.toLowerCase();
  return (boosts || []).some((b) => lower.includes(String(b).toLowerCase()));
}

function loadTitleFilterFromPortals() {
  if (!existsSync(PORTALS_PATH)) {
    console.warn(`Warning: ${PORTALS_PATH} not found — using embedded title_filter.`);
    return DEFAULT_TITLE_FILTER;
  }
  try {
    const cfg = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
    const tf = cfg?.title_filter;
    if (!tf?.positive?.length) {
      console.warn('Warning: portals.yml has no title_filter.positive — using embedded list.');
      return DEFAULT_TITLE_FILTER;
    }
    return {
      positive: tf.positive || DEFAULT_TITLE_FILTER.positive,
      negative: tf.negative?.length ? tf.negative : DEFAULT_TITLE_FILTER.negative,
      seniority_boost: tf.seniority_boost || DEFAULT_TITLE_FILTER.seniority_boost,
    };
  } catch (e) {
    console.warn(`Warning: could not parse portals.yml (${e.message}) — using embedded title_filter.`);
    return DEFAULT_TITLE_FILTER;
  }
}

/** URLs from pipeline + scan-history + applications-style links */
function loadSeenUrls() {
  const seen = new Set();
  if (existsSync(SCAN_HISTORY_PATH)) {
    for (const line of readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n').slice(1)) {
      const url = line.split('\t')[0]?.trim();
      if (url?.startsWith('http')) seen.add(url);
    }
  }
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const m of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(m[0]);
    }
  }
  return seen;
}

/** "company::title" normalized */
function loadSeenCompanyTitleKeys() {
  const keys = new Set();
  if (!existsSync(PIPELINE_PATH)) return keys;
  const text = readFileSync(PIPELINE_PATH, 'utf-8');
  for (const line of text.split('\n')) {
    const m = line.match(/^-\s*\[[ x!]\]\s+(https?:\/\/\S+)\s*\|\s*([^|]*)\s*\|\s*(.+)$/);
    if (m) {
      const company = m[2].trim().toLowerCase();
      const title = m[3].trim().toLowerCase();
      keys.add(`${company}::${title}`);
    }
  }
  return keys;
}

function ensurePipelineFile() {
  if (existsSync(PIPELINE_PATH)) return;
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  const initial = `# Pipeline — job URL inbox

## Pendientes

## Procesadas

`;
  writeFileSync(PIPELINE_PATH, initial, 'utf-8');
}

function ensureScanHistoryHeader() {
  if (existsSync(SCAN_HISTORY_PATH)) return;
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
}

/** Same checkbox rows the dashboard counts as Job Pipeline # (1-based). */
function countPipelineCheckboxRows() {
  if (!existsSync(PIPELINE_PATH)) return 0;
  const text = readFileSync(PIPELINE_PATH, 'utf-8');
  let n = 0;
  const re = /^\s*-\s*\[[^\]]*\]\s+https?:\/\/\S+\s*\|\s*[^|]+\s*\|\s*.+/;
  for (const line of text.split(/\r?\n/)) {
    if (re.test(line)) n++;
  }
  return n;
}

function appendToPipeline(offers, dateIso) {
  if (offers.length === 0) return;
  ensurePipelineFile();
  let text = readFileSync(PIPELINE_PATH, 'utf-8');
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  const block =
    offers.map((o) => `- [ ] ${o.url} | ${o.company} | ${o.title}`).join('\n') + '\n';

  if (idx === -1) {
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    text =
      text.slice(0, insertAt) +
      `\n${marker}\n\n${block}\n` +
      text.slice(insertAt);
  } else {
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;
    text = text.slice(0, insertAt) + '\n' + block + text.slice(insertAt);
  }
  writeFileSync(PIPELINE_PATH, text, 'utf-8');

  ensureScanHistoryHeader();
  const lines = offers.map(
    (o) => `${o.url}\t${dateIso}\t${o.source}\t${o.title}\t${o.company}\tadded`
  );
  appendFileSync(SCAN_HISTORY_PATH, lines.join('\n') + '\n', 'utf-8');
}

function normalizeJob(j) {
  const title = (j.job_title || '').trim() || 'Unknown title';
  const company = (j.employer_name || '').trim() || 'Unknown company';
  const url = (j.job_apply_link || j.job_google_link || '').trim();
  return { title, company, url, raw: j };
}

async function jsearchFetch(query, dryRun) {
  const params = new URLSearchParams({
    query,
    page: '1',
    num_pages: '1',
    date_posted: 'today',
    country: 'us',
  });
  params.set('work_from_home', 'true');

  const url = `${JSEARCH_URL}?${params.toString()}`;

  const headers = {
    'X-RapidAPI-Key': RAPIDAPI_KEY,
    'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
  };

  const doRequest = async () => {
    const res = await fetch(url, { method: 'GET', headers });
    return res;
  };

  let res = await doRequest();

  if (res.status === 429) {
    console.warn('  → HTTP 429 rate limit — waiting 60s and retrying once…');
    await sleep(60_000);
    res = await doRequest();
  }

  if (res.status === 403) {
    throw new Error('HTTP 403 — Check your RapidAPI key and JSearch subscription on rapidapi.com');
  }

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
  }

  const json = await res.json();
  const data = Array.isArray(json.data) ? json.data : [];
  return data.map(normalizeJob).filter((x) => x.url && x.url.startsWith('http'));
}

// ── Main ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

if (!RAPIDAPI_KEY) {
  const envInRoot = join(ROOT, '.env');
  const exampleInRoot = join(ROOT, '.env.example');
  const envInCwd = join(process.cwd(), '.env');
  console.error(`
Fatal: RAPIDAPI_KEY is not set after loading env files.

  Set in .env or .env.example (exact name, no quotes needed):
     RAPIDAPI_KEY=your_key_here

  Checked:
    • ${envInRoot} ${existsSync(envInRoot) ? '(exists)' : '(missing)'}
    • ${exampleInRoot} ${existsSync(exampleInRoot) ? '(exists)' : '(missing)'}
    • ${envInCwd} ${envInCwd !== envInRoot ? (existsSync(envInCwd) ? '(exists)' : '(missing)') : '(same as root .env)'}

  Project root (where fetch-jobs.mjs lives):
    ${ROOT}

  1. Subscribe: https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch
  2. Add RAPIDAPI_KEY to .env (recommended) or .env.example in that folder.
  3. Or one session:  set RAPIDAPI_KEY=...   (CMD)  /  export RAPIDAPI_KEY=...  (Git Bash)
`);
  process.exit(1);
}

const titleCfg = loadTitleFilterFromPortals();
const titleOk = buildTitleFilter(titleCfg);
const boosts = titleCfg.seniority_boost || DEFAULT_TITLE_FILTER.seniority_boost;

const today = new Date().toISOString().slice(0, 10);

console.log('=== RapidAPI JSearch Fetch ===');
console.log(`Date: ${today}`);
console.log(`Running ${SEARCH_QUERIES.length} queries (sequential, 1s between calls)…\n`);

const seenUrls = loadSeenUrls();
const seenKeys = loadSeenCompanyTitleKeys();

let totalFetched = 0;
let totalPassed = 0;
let totalDeduped = 0;
const newOffers = [];

for (let i = 0; i < SEARCH_QUERIES.length; i++) {
  const q = SEARCH_QUERIES[i];
  console.log(`[${i + 1}/${SEARCH_QUERIES.length}] "${q}"`);

  let jobs = [];
  try {
    jobs = await jsearchFetch(q, dryRun);
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
    if (i < SEARCH_QUERIES.length - 1) await sleep(1000);
    continue;
  }

  const nFetched = jobs.length;
  totalFetched += nFetched;
  console.log(`  → ${nFetched} results fetched`);

  let passed = 0;
  let deduped = 0;
  let addedHere = 0;

  for (const job of jobs) {
    if (!titleOk(job.title)) continue;
    passed++;
    totalPassed++;

    if (hasSeniorityBoost(job.title, boosts)) {
      console.log(`     [seniority signal] ${job.title} @ ${job.company}`);
    }

    const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
    if (seenUrls.has(job.url) || seenKeys.has(key)) {
      deduped++;
      totalDeduped++;
      continue;
    }

    seenUrls.add(job.url);
    seenKeys.add(key);

    newOffers.push({
      url: job.url,
      company: job.company,
      title: job.title,
      source: 'jsearch',
    });
    addedHere++;
  }

  console.log(`  → ${passed} passed title filter`);
  console.log(`  → ${deduped} deduplicated (already in pipeline/history or duplicate company+title)`);
  console.log(`  → ${addedHere} new jobs queued this query`);

  if (i < SEARCH_QUERIES.length - 1) await sleep(1000);
}

const pipelineRowBase = countPipelineCheckboxRows();
if (!dryRun && newOffers.length > 0) {
  appendToPipeline(newOffers, today);
}

console.log('\n=== Summary ===');
console.log(`Total fetched:     ${totalFetched}`);
console.log(`Passed filter:     ${totalPassed}`);
console.log(`Deduplicated:      ${totalDeduped}`);
console.log(`New jobs added:    ${dryRun ? `(would add ${newOffers.length})` : newOffers.length}${dryRun ? ' — dry-run, no files written' : ''}`);
if (!dryRun) {
  console.log(`Written to:        ${PIPELINE_PATH}`);
  console.log(`Scan history:      ${SCAN_HISTORY_PATH}`);
}

console.log(`
Next steps:
  • Run \`node scan.mjs\` to continue with direct ATS company scans from portals.yml
  • Process pending URLs with Claude Code \`/career-ops pipeline\`, or evaluate locally with Ollama:
      node ollama-eval.mjs "paste JD text here"
    (Optional API path: node gemini-eval.mjs "…" — expects JD text, not the whole pipeline file.)

New jobs this run (pipeline # after write, heuristic score = dashboard “Auto-score” until you run Evaluate):`);
if (newOffers.length === 0) {
  console.log('  (none)');
} else {
  newOffers.forEach((o, idx) => {
    const pipelineNum = pipelineRowBase + idx + 1;
    const score = estimateJobScore(o.title);
    console.log(`  #${pipelineNum}  ${score}  ${o.company} — ${o.title}`);
    console.log(`         ${o.url}`);
  });
}

process.exit(0);
