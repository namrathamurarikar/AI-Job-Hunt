#!/usr/bin/env node
/**
 * Dashboard "Interview prep" — fetches the job URL with Chromium (same scrape as PDF pipeline),
 * reads cv.md + story-bank, links reports/*.md when possible, and writes interview-prep/{company}-{role}.md.
 * No chat LLM here; use `/career-ops interview-prep` in Cursor/Claude for deeper company research.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { closeChromiumBrowser, scrapePipelineJob } from './scrape-pipeline-job.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const REPORTS_DIR = join(ROOT, 'reports');
const INTERVIEW_PREP_DIR = join(ROOT, 'interview-prep');
const CV_PATH = join(ROOT, 'cv.md');
const STORY_BANK_PATH = join(ROOT, 'interview-prep', 'story-bank.md');

function slug(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function parseJobIdArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--job-id') {
      const n = parseInt(String(argv[i + 1] || ''), 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
  }
  return null;
}

function parsePipelineJobs(md) {
  const out = [];
  let id = 1;
  for (const line of String(md || '').split(/\r?\n/)) {
    const m = line.match(/^\s*-\s*\[([^\]]*)\]\s+(https?:\/\/\S+)\s*\|\s*([^|]+)\s*\|\s*(.+)\s*$/i);
    if (!m) continue;
    out.push({
      id: id++,
      mark: String(m[1] || '').trim(),
      url: m[2].trim(),
      company: m[3].trim(),
      role: m[4].trim(),
    });
  }
  return out;
}

function findBestReport(company, role) {
  if (!existsSync(REPORTS_DIR)) return null;
  const names = readdirSync(REPORTS_DIR).filter((f) => f.toLowerCase().endsWith('.md'));
  if (names.length === 0) return null;
  const c = slug(company);
  const r = slug(role);

  function newestMatch(filtered) {
    if (filtered.length === 0) return null;
    let best = null;
    let bestT = -1;
    for (const name of filtered) {
      const p = join(REPORTS_DIR, name);
      const t = statSync(p).mtimeMs;
      if (t > bestT) {
        bestT = t;
        best = name;
      }
    }
    return best ? { name: best, mtime: bestT } : null;
  }

  const both = names.filter((n) => slug(n).includes(c) && slug(n).includes(r));
  const byBoth = newestMatch(both);
  if (byBoth) return byBoth;

  const co = names.filter((n) => slug(n).includes(c));
  return newestMatch(co);
}

function normalizeUrlForMatch(u) {
  return String(u || '')
    .trim()
    .replace(/\/+$/, '');
}

function findReportByJobUrl(jobUrl) {
  const needle = normalizeUrlForMatch(jobUrl);
  if (!needle || !existsSync(REPORTS_DIR)) return null;
  const names = readdirSync(REPORTS_DIR).filter((f) => f.toLowerCase().endsWith('.md'));
  const headBytes = 96 * 1024;
  let best = null;
  let bestT = -1;
  for (const name of names) {
    const p = join(REPORTS_DIR, name);
    let text;
    try {
      const buf = readFileSync(p);
      text = buf.length > headBytes ? buf.subarray(0, headBytes).toString('utf8') : buf.toString('utf8');
    } catch {
      continue;
    }
    if (!text.includes(needle)) continue;
    const t = statSync(p).mtimeMs;
    if (t > bestT) {
      bestT = t;
      best = name;
    }
  }
  return best ? { name: best, mtime: bestT } : null;
}

function ensureDir(path) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function getSection(md, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|(?![\\s\\S]))`, 'm');
  const m = String(md || '').match(re);
  return m ? m[1].trim() : '';
}

function parseCvInsights(cvMd) {
  const summary = getSection(cvMd, 'Professional Summary').split(/\n+/).join(' ').trim();
  const work = getSection(cvMd, 'Work Experience');
  const workBullets = work
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2))
    .slice(0, 8);

  let skillsSection = getSection(cvMd, 'Core Technical Skills');
  if (!skillsSection) skillsSection = getSection(cvMd, 'Skills');
  const skillRows = skillsSection
    .split(/\r?\n/)
    .filter((l) => l.includes('|') && !/^\|[\s|-]+\|$/.test(l) && !/^\|\s*Category/i.test(l))
    .map((line) => line.split('|').map((x) => x.trim()).filter(Boolean))
    .filter((cells) => cells.length >= 2)
    .map(([category, skills]) => ({
      category: category.replace(/\*\*/g, ''),
      skills: skills.split(',').map((x) => x.trim()).filter(Boolean),
    }));

  return { summary, workBullets, skillRows };
}

function parseStoryBankTitles(storyBankMd) {
  return String(storyBankMd || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^###\s+/.test(l))
    .map((l) => l.replace(/^###\s+/, ''))
    .slice(0, 8);
}

/** Posting keywords that overlap CV skills (no LLM — string match). */
function jdCvOverlapLines(jdText, skillRows) {
  const jd = String(jdText || '').toLowerCase();
  const lines = [];
  const seen = new Set();
  for (const row of skillRows) {
    for (const sk of row.skills) {
      const key = sk.trim();
      if (key.length < 2) continue;
      const k = key.toLowerCase();
      const compact = k.replace(/\s+/g, '');
      if (jd.includes(k) || (compact.length > 2 && jd.includes(compact))) {
        if (seen.has(k)) continue;
        seen.add(k);
        lines.push(`- **${key}** — appears in the job posting; tie to a concrete CV bullet or STAR story.`);
      }
    }
  }
  return lines.slice(0, 16);
}

function inferredTechQuestions(job, skills, jdText) {
  const role = String(job.role || '').toLowerCase();
  const jd = String(jdText || '').toLowerCase();
  const allSkills = skills.flatMap((s) => s.skills).map((s) => s.toLowerCase());
  const has = (k) => role.includes(k) || allSkills.some((s) => s.includes(k)) || jd.includes(k);

  const qs = [];

  if (has('machine learning') || has('ml') || jd.includes('machine learning')) {
    qs.push('Design an end-to-end ML system for production deployment at scale.');
    qs.push('How do you monitor model drift and trigger retraining safely?');
  }
  if (has('llm') || has('generative') || jd.includes('llm') || jd.includes('generative')) {
    qs.push('How would you evaluate and guardrail an LLM feature before launch?');
  }
  if (has('python') || jd.includes('python')) qs.push('What Python performance and reliability patterns do you use in production services?');
  if (has('aws') || jd.includes('aws') || jd.includes('amazon web')) {
    qs.push('How would you design a fault-tolerant AWS pipeline for real-time inference?');
  }
  if (has('kubernetes') || has('devops') || jd.includes('kubernetes') || jd.includes('k8s')) {
    qs.push('How do you deploy and roll back model-serving workloads in Kubernetes?');
  }
  if (has('data') || jd.includes('data pipeline') || jd.includes('etl')) {
    qs.push('How do you validate data quality and schema evolution in event-driven pipelines?');
  }
  if (jd.includes('sql') || jd.includes('postgres')) {
    qs.push('How do you balance analytical SQL workloads with online feature-serving latency?');
  }
  if (jd.includes('torch') || jd.includes('pytorch') || jd.includes('tensorflow')) {
    qs.push('Walk through how you take a model from notebook to a monitored production endpoint.');
  }

  if (qs.length === 0) {
    qs.push('Walk through a technically complex project you shipped from design to production.');
    qs.push('How do you balance experimentation speed with production reliability?');
  }
  return qs.slice(0, 8);
}

function inferredBehavioralQuestions() {
  return [
    'Tell me about a high-impact project where you improved measurable business outcomes.',
    'Describe a time you handled ambiguity while collaborating across engineering and product.',
    'Tell me about a production incident and how you drove recovery and prevention.',
    'Describe a disagreement with stakeholders and how you aligned on a decision.',
  ];
}

function inferredRoleSpecificQuestions(job) {
  return [
    `What does success look like for a ${job.role} in the first 90 days?`,
    'How do you prioritize model quality, latency, and cost trade-offs?',
    'How do you evaluate whether an ML feature should be a model update vs product logic change?',
  ];
}

function escapeForMdFence(s) {
  return String(s || '').replace(/```/g, "'''");
}

function buildTemplate(job, reportName, cvInsights, storyTitles, scrapeBundle) {
  const today = new Date().toISOString().slice(0, 10);
  const reportRef = reportName ? `reports/${reportName}` : 'N/A';
  const jdSnippet = scrapeBundle?.jdSnippet?.trim() || '';
  const live = scrapeBundle?.live;

  const technicalQs = inferredTechQuestions(job, cvInsights.skillRows, jdSnippet);
  const behavioralQs = inferredBehavioralQuestions();
  const roleQs = inferredRoleSpecificQuestions(job);
  const topSkills = cvInsights.skillRows.flatMap((x) => x.skills).slice(0, 10);
  const proofPoints = cvInsights.workBullets.slice(0, 4);
  const storyRows = (storyTitles.length > 0 ? storyTitles : ['No stories yet in story-bank.md']).slice(0, 3);
  const overlap = jdSnippet ? jdCvOverlapLines(jdSnippet, cvInsights.skillRows) : [];

  let sourcesLine =
    '**Sources:** cv.md + pipeline role title only (scraping disabled or failed — re-run without INTERVIEW_PREP_NO_SCRAPE / --no-scrape).';
  if (jdSnippet) {
    sourcesLine = `**Sources:** Scraped job page visible text (${jdSnippet.length} chars) + cv.md + story-bank when present.`;
  }

  const livenessLine =
    live && jdSnippet
      ? `**Posting liveness (heuristic):** \`${live.result}\`${live.reason ? ` — ${live.reason}` : ''}`
      : '';

  const jdBlock =
    jdSnippet.length > 0
      ? `## Job posting (visible text from URL)

Trimmed for size; read the live posting for full detail.

\`\`\`text
${escapeForMdFence(jdSnippet.slice(0, 12_000))}
\`\`\`

## CV ↔ posting overlap (keyword match)

${overlap.length > 0 ? overlap.join('\n') : '- No obvious skill-token overlap detected; still align stories to responsibilities in the posting above.'}

`
      : `## Job posting (visible text from URL)

*Not included — scraping was skipped or failed. Run again with Playwright available, or paste JD bullets here manually.*

`;

  return `# Interview Intel: ${job.company} — ${job.role}

**Report:** ${reportRef}
**Researched:** ${today}
${sourcesLine}
**Job URL:** ${job.url}
${livenessLine ? `${livenessLine}\n` : ''}
${jdBlock}
## How This File Works
- Generated by the dashboard Interview prep button (scrapes the job URL when possible, same engine as the PDF pipeline).
- Pre-filled from your CV, story-bank, and the posting text above.
- Run \`/career-ops interview-prep\` in chat with this company + role to add research-backed company intel.
- Keep final prep notes here so you have one source of truth before interviews.

## Suggested Prompt
\`\`\`
/career-ops interview-prep
Company: ${job.company}
Role: ${job.role}
Job URL: ${job.url}
Report: ${reportRef}
\`\`\`

## Process Overview
- **Rounds:** likely 4-6 for this role family \`[inferred from role]\`
- **Format:** recruiter screen -> technical coding/ML -> system design -> behavioral/hiring manager \`[inferred]\`
- **Difficulty:** medium-high for ML engineering roles \`[inferred]\`
- **Positive experience rate:** unknown — requires external sources
- **Known quirks:** unknown — requires external sources
- **Grounding:** ${jdSnippet ? 'Questions below are biased toward keywords found in the scraped posting + your CV.' : 'Posting text missing — questions lean on role title + CV only.'}

## Round-by-Round Breakdown
### Round 1: Recruiter Screen
- **Duration:** 30-45 min \`[inferred]\`
- **Conducted by:** recruiter
- **What they evaluate:** role fit, motivation, communication, compensation alignment
- **Reported questions:** no sourced questions yet
- **How to prepare:** concise "why this role / why now" + 2 measurable impact stories

### Round 2: Technical Deep Dive
- **Duration:** 45-60 min \`[inferred]\`
- **Conducted by:** senior engineer / panel
- **What they evaluate:** coding quality, ML fundamentals, production trade-offs
- **Reported questions:** use "Likely Questions → Technical" below
- **How to prepare:** rehearse architecture walk-throughs from your strongest projects

### Round 3: System Design / ML System Design
- **Duration:** 45-60 min \`[inferred]\`
- **Conducted by:** tech lead / manager
- **What they evaluate:** distributed systems, reliability, experimentation strategy
- **Reported questions:** use role-specific prompts below
- **How to prepare:** practice one end-to-end design with latency/cost/quality trade-offs

## Likely Questions
### Technical
${technicalQs.map((q) => `- ${q} \`[inferred from posting + role + CV]\``).join('\n')}

### Behavioral
${behavioralQs.map((q) => `- ${q} \`[inferred]\``).join('\n')}

### Role-Specific
${roleQs.map((q) => `- ${q} \`[inferred from role title]\``).join('\n')}

### Background Red Flags
- How do you bridge software engineering and ML ownership in production systems? \`[inferred]\`
- You have strong healthcare AI experience; how transferable is that to this domain? \`[inferred]\`
- Concise framing: emphasize reusable platform skills (LLM integration, reliability, cloud infra, data quality) across domains.

## Story Bank Mapping
| # | Likely question/topic | Best story from story-bank.md | Fit | Gap? |
|---|----------------------|-------------------------------|-----|------|
${storyRows
  .map((t, i) => `| ${i + 1} | High-impact delivery under constraints | ${t} | partial | refine with metrics |`)
  .join('\n')}

## Technical Prep Checklist
${topSkills.slice(0, 8).map((s) => `- [ ] ${s} — why: appears in your CV and likely interview scope for this role`).join('\n')}

## CV Proof Points To Rehearse
${proofPoints.length > 0 ? proofPoints.map((p) => `- ${p}`).join('\n') : '- Add 3-5 measurable accomplishments from cv.md'}

## Company Signals
- **Values they screen for:** ownership, technical depth, collaboration \`[inferred]\`
- **Vocabulary to use:** model reliability, latency budgets, evaluation rigor, production safety
- **Things to avoid:** generic answers without metrics or trade-offs
- **Questions to ask them:** "How is ML quality measured in production?" / "What are the biggest reliability constraints today?"
`;
}

async function main() {
  const argv = process.argv.slice(2);
  const noScrape = process.env.INTERVIEW_PREP_NO_SCRAPE === '1' || argv.includes('--no-scrape');

  console.log('interview-prep: starting…');
  if (!existsSync(PIPELINE_PATH)) {
    console.error(`Missing ${PIPELINE_PATH}`);
    process.exit(1);
  }

  const pipelineMd = readFileSync(PIPELINE_PATH, 'utf-8');
  const jobs = parsePipelineJobs(pipelineMd);
  if (jobs.length === 0) {
    console.error('No checkbox jobs found in data/pipeline.md');
    process.exit(1);
  }

  const requestedId = parseJobIdArg(argv);
  let job = null;
  if (requestedId) {
    job = jobs.find((j) => j.id === requestedId) || null;
    if (!job) {
      console.error(`--job-id ${requestedId} not found. Available range: 1-${jobs.length}`);
      process.exit(1);
    }
  } else {
    job = jobs[jobs.length - 1];
  }

  console.log(`interview-prep: job #${job.id} ${job.company} — ${job.role}`);
  console.log('interview-prep: matching evaluation report in reports/ (filename slugs, then job URL in file)…');
  let report = findBestReport(job.company, job.role);
  if (!report) {
    report = findReportByJobUrl(job.url);
    if (report) console.log(`interview-prep: linked report by URL match → reports/${report.name}`);
  }
  if (!report) {
    console.log(
      'interview-prep: no report matched (filename slugs or job URL inside reports/*.md). Evaluation report optional for this doc.',
    );
  }

  let scrapeBundle = null;
  if (!noScrape) {
    console.log('interview-prep: fetching job page (Chromium — same stack as ollama-cv-pipeline step 1)…');
    try {
      scrapeBundle = await scrapePipelineJob(job.url, (m) => console.log(m));
      if (scrapeBundle?.jdSnippet?.trim()) {
        console.log(`interview-prep: captured ${scrapeBundle.jdSnippet.length} chars of visible posting text.`);
      } else {
        console.log('interview-prep: scrape returned little or no body text (blocked page or empty DOM).');
      }
    } catch (e) {
      console.error(`interview-prep: scrape failed: ${e?.message || e}`);
    }
  } else {
    console.log('interview-prep: scrape skipped (--no-scrape or INTERVIEW_PREP_NO_SCRAPE=1).');
  }

  try {
    ensureDir(INTERVIEW_PREP_DIR);
    const cvMd = existsSync(CV_PATH) ? readFileSync(CV_PATH, 'utf-8') : '';
    const storyBankMd = existsSync(STORY_BANK_PATH) ? readFileSync(STORY_BANK_PATH, 'utf-8') : '';
    const cvInsights = parseCvInsights(cvMd);
    const storyTitles = parseStoryBankTitles(storyBankMd);

    const fileName = `${slug(job.company)}-${slug(job.role)}.md`;
    const targetPath = join(INTERVIEW_PREP_DIR, fileName);
    const md = buildTemplate(job, report?.name || null, cvInsights, storyTitles, scrapeBundle);
    writeFileSync(targetPath, md, 'utf-8');

    console.log(`Interview prep file written: ${targetPath}`);
    console.log(`Job: #${job.id} ${job.company} — ${job.role}`);
    console.log(`Report linked: ${report ? `reports/${report.name}` : 'N/A'}`);
    console.log('Next step: in chat, run `/career-ops interview-prep` with the Suggested Prompt block for deeper company research.');
  } finally {
    await closeChromiumBrowser().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
