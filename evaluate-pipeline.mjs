#!/usr/bin/env node
/**
 * Dashboard / CLI entry: runs local Ollama evaluation only (ollama-eval.mjs).
 * For ad-hoc Gemini API evaluation, run: node gemini-eval.mjs "<JD>" or --file ...
 */
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function parseArgValue(flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return '';
  return String(args[idx + 1] || '').trim();
}

function parseJobIds(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((x) => parseInt(x.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function parsePipelineRows(md) {
  const rows = [];
  let id = 1;
  for (const line of String(md || '').split(/\r?\n/)) {
    const m = line.match(/^\s*-\s*\[([^\]]*)\]\s+(https?:\/\/\S+)\s*\|\s*([^|]+)\s*\|\s*(.+)\s*$/i);
    if (!m) continue;
    rows.push({ id: id++, mark: String(m[1] || '').trim(), url: m[2].trim(), company: m[3].trim(), title: m[4].trim() });
  }
  return rows;
}

function runNodeScript(scriptName, scriptArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, scriptName), ...scriptArgs], {
      cwd: ROOT,
      shell: false,
      env: process.env,
    });

    let merged = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      merged += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      merged += text;
      process.stderr.write(text);
    });
    child.on('close', (code) => resolve({ code: code ?? 1, output: merged }));
  });
}

async function evaluateOneText(text, label) {
  console.log(`\n=== Evaluating ${label} (Ollama) ===\n`);
  const ollamaResult = await runNodeScript('ollama-eval.mjs', [text]);
  return ollamaResult.code;
}

const ids = parseJobIds(parseArgValue('--job-id'));
const fileArg = parseArgValue('--file');

if (ids.length > 0) {
  const pipelinePath = fileArg || './data/pipeline.md';
  const absolute = join(ROOT, pipelinePath.replace(/^\.\//, ''));
  if (!existsSync(absolute)) {
    console.error(`Pipeline file not found: ${pipelinePath}`);
    process.exit(1);
  }
  const rows = parsePipelineRows(readFileSync(absolute, 'utf-8'));
  if (rows.length === 0) {
    console.error('No checkbox rows found in pipeline.');
    process.exit(1);
  }

  let failures = 0;
  for (const id of ids) {
    const row = rows.find((r) => r.id === id);
    if (!row) {
      console.error(`Job #${id} not found in pipeline (available: 1-${rows.length}).`);
      failures++;
      continue;
    }
    const quickText = `Pipeline quick-evaluation context:
- Company: ${row.company}
- Role: ${row.title}
- Job URL: ${row.url}
- Pipeline row: ${row.id}

Use role title + company context + URL string as available evidence. If exact JD details are not present, clearly mark assumptions and keep confidence conservative.`;
    const code = await evaluateOneText(quickText, `job #${row.id} (${row.company} — ${row.title})`);
    if (code !== 0) failures++;
  }
  process.exit(failures === 0 ? 0 : 1);
}

const ollamaResult = await runNodeScript('ollama-eval.mjs', args);
process.exit(ollamaResult.code);
