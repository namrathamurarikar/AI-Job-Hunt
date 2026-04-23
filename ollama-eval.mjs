#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { setGlobalDispatcher, Agent } from 'undici';
import { loadProjectEnv } from './load-project-env.mjs';
import { enrichEvalSummary } from './job-score-heuristic.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
await loadProjectEnv(ROOT);

/** Same idea as ollama-cv-pipeline: default Node fetch/undici body timeout is too low for big prompts + slow local inference. */
const OLLAMA_EVAL_TIMEOUT_MS = Math.max(
  120_000,
  parseInt(
    process.env.OLLAMA_EVAL_TIMEOUT_MS || process.env.OLLAMA_TIMEOUT_MS || '1800000',
    10,
  ) || 1_800_000,
);
setGlobalDispatcher(
  new Agent({
    headersTimeout: OLLAMA_EVAL_TIMEOUT_MS,
    bodyTimeout: OLLAMA_EVAL_TIMEOUT_MS,
    connectTimeout: 180_000,
  }),
);

const PATHS = {
  shared: join(ROOT, 'modes', '_shared.md'),
  oferta: join(ROOT, 'modes', 'oferta.md'),
  cv: join(ROOT, 'cv.md'),
  reports: join(ROOT, 'reports'),
};

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_EVAL_MODEL || process.env.OLLAMA_MODEL || 'llama3.2:3b';

const args = process.argv.slice(2);
let jdText = '';
let saveReport = true;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file' && args[i + 1]) {
    const p = args[++i];
    if (!existsSync(p)) {
      console.error(`File not found: ${p}`);
      process.exit(1);
    }
    jdText = readFileSync(p, 'utf-8').trim();
  } else if (args[i] === '--no-save') {
    saveReport = false;
  } else if (!args[i].startsWith('--')) {
    jdText += (jdText ? '\n' : '') + args[i];
  }
}
if (!jdText) {
  console.error('No job description provided. Use --file <path> or pass text.');
  process.exit(1);
}

function safeRead(path, fallback = '') {
  if (!existsSync(path)) return fallback;
  return readFileSync(path, 'utf-8');
}

function nextReportNumber() {
  if (!existsSync(PATHS.reports)) return '001';
  const nums = readdirSync(PATHS.reports)
    .filter((f) => /^\d{3}-/.test(f))
    .map((f) => parseInt(f.slice(0, 3), 10))
    .filter((n) => Number.isFinite(n));
  if (nums.length === 0) return '001';
  return String(Math.max(...nums) + 1).padStart(3, '0');
}

function extractSummaryValue(block, key, fallback = 'unknown') {
  const m = String(block || '').match(new RegExp(`${key}:\\s*(.+)`));
  return m ? m[1].trim() : fallback;
}

function slug(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const shared = safeRead(PATHS.shared, '[modes/_shared.md not found]');
const oferta = safeRead(PATHS.oferta, '[modes/oferta.md not found]');
const cv = safeRead(PATHS.cv, '[cv.md not found]');

const systemPrompt = `You are career-ops, an AI job evaluator.
Use this scoring logic:

===== _shared.md =====
${shared}

===== oferta.md =====
${oferta}

===== cv.md =====
${cv}

Output the complete evaluation text, then end with:

---SCORE_SUMMARY---
COMPANY: <company name or "Unknown">
ROLE: <role title>
SCORE: <global score as decimal, e.g. 3.8>
ARCHETYPE: <detected archetype>
LEGITIMACY: <High Confidence | Proceed with Caution | Suspicious>
---END_SUMMARY---
`;

console.log(`🤖 Calling Ollama (${OLLAMA_MODEL})... (HTTP body timeout ${Math.round(OLLAMA_EVAL_TIMEOUT_MS / 1000)}s — set OLLAMA_EVAL_TIMEOUT_MS or OLLAMA_TIMEOUT_MS to raise)`);
let text = '';

async function listLocalModels() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.models) ? data.models.map((m) => m.name).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function ollamaChat() {
  const chatBody = {
    model: OLLAMA_MODEL,
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `JOB DESCRIPTION TO EVALUATE:\n\n${jdText}` },
    ],
  };

  const chatRes = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(chatBody),
  });

  // Older Ollama builds may not expose /api/chat; fallback to /api/generate.
  if (chatRes.status === 404) {
    const prompt = `${systemPrompt}\n\nJOB DESCRIPTION TO EVALUATE:\n\n${jdText}`;
    const genRes = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, stream: false, prompt }),
    });
    if (!genRes.ok) throw new Error(`Ollama HTTP ${genRes.status} on /api/generate`);
    const genData = await genRes.json();
    return genData?.response || '';
  }

  if (!chatRes.ok) throw new Error(`Ollama HTTP ${chatRes.status} on /api/chat`);
  const chatData = await chatRes.json();
  return chatData?.message?.content || '';
}

try {
  text = await ollamaChat();
} catch (e) {
  const cause = e?.cause;
  const causeMsg = cause ? ` (cause: ${cause.code || ''} ${cause.message || cause})` : '';
  console.error(`Ollama error: ${e.message}${causeMsg}`);
  console.error(`Host: ${OLLAMA_HOST}`);
  if (/fetch failed|timeout|aborted/i.test(String(e.message) + causeMsg)) {
    console.error(
      `If this happened after ~5 minutes, increase timeout: OLLAMA_EVAL_TIMEOUT_MS=3600000 (or reuse OLLAMA_TIMEOUT_MS).`,
    );
  }
  const locals = await listLocalModels();
  if (String(e.message).includes('404') && locals.length > 0) {
    console.error(`Requested model "${OLLAMA_MODEL}" not found locally.`);
    console.error(`Available local models: ${locals.join(', ')}`);
    console.error(`Tip: set OLLAMA_EVAL_MODEL to one of the available models in .env.`);
  }
  console.error(`Make sure Ollama is running and model is available (try: ollama pull ${OLLAMA_MODEL}).`);
  console.error('If you use a non-default Ollama host, set OLLAMA_HOST in .env (example: http://127.0.0.1:11434).');
  process.exit(1);
}

if (!text.trim()) {
  console.error('Ollama returned empty output.');
  process.exit(1);
}

console.log('\n' + '═'.repeat(66));
console.log('  CAREER-OPS EVALUATION — powered by Ollama');
console.log('═'.repeat(66) + '\n');
console.log(text);

const summaryMatch = text.match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);
const summary = summaryMatch ? summaryMatch[1] : '';
let company = extractSummaryValue(summary, 'COMPANY');
let role = extractSummaryValue(summary, 'ROLE');
let score = extractSummaryValue(summary, 'SCORE', '?');
let archetype = extractSummaryValue(summary, 'ARCHETYPE');
let legitimacy = extractSummaryValue(summary, 'LEGITIMACY');

const enriched = enrichEvalSummary({
  jdText,
  bodyText: text,
  company,
  role,
  score,
  archetype,
  legitimacy,
});
({ company, role, score, archetype, legitimacy } = enriched);

if (saveReport) {
  try {
    if (!existsSync(PATHS.reports)) mkdirSync(PATHS.reports, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const num = nextReportNumber();
    const file = `${num}-${slug(company)}-${today}.md`;
    const out = `# Evaluation: ${company} — ${role}

**Date:** ${today}
**Archetype:** ${archetype}
**Score:** ${score}/5
**Legitimacy:** ${legitimacy}
**PDF:** pending
**Tool:** Ollama (${OLLAMA_MODEL})

---

${text.replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, '').trim()}
`;
    writeFileSync(join(PATHS.reports, file), out, 'utf-8');
    console.log(`\n✅ Report saved: reports/${file}`);
  } catch (e) {
    console.warn(`Could not save report: ${e.message}`);
  }
}

console.log('\n' + '─'.repeat(66));
console.log(`  Score: ${score}/5  |  Archetype: ${archetype}  |  Legitimacy: ${legitimacy}`);
console.log('─'.repeat(66) + '\n');
