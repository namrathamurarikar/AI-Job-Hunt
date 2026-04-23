import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OLLAMA_CV_SCRIPT = join(ROOT, 'ollama-cv-pipeline.mjs');

const SCRIPT_MAP = {
  scan: { cmd: 'node', args: ['scan.mjs'] },
  fetch: { cmd: 'node', args: ['fetch-jobs.mjs'] },
  evaluate: { cmd: 'node', args: ['evaluate-pipeline.mjs', '--file', './data/pipeline.md'] },
  'interview-prep': { cmd: 'node', args: ['interview-prep.mjs'] },
};

/**
 * @param {string} name
 * @param {Record<string, string>} [query] - URL query from dashboard (e.g. { jobId: '12' })
 */
export function getScriptArgs(name, query = {}) {
  if (name === 'pdf') {
    // Invoke node directly (not `npm run`) so stdout streams to the dashboard log without extra buffering.
    // Do NOT pass --low-mem by default: it forces num_ctx=4096 and the real system prompt alone exceeds that,
    // which crashes llama with "runner process has terminated: exit status 2". Use CAREER_OPS_OLLAMA_LOW_MEM=1 to enable.
    const args = [OLLAMA_CV_SCRIPT];
    if (process.env.CAREER_OPS_OLLAMA_LOW_MEM === '1') {
      args.push('--low-mem');
    }
    const jid = parseInt(String(query.jobId ?? query.job ?? ''), 10);
    if (Number.isFinite(jid) && jid > 0) {
      args.push('--job-id', String(jid));
    } else {
      args.push('--latest-only');
    }
    if (query.force === '1' || query.force === 'true') {
      args.push('--force');
    }
    return { cmd: process.execPath, args };
  }
  if (name === 'interview-prep') {
    const args = ['interview-prep.mjs'];
    const jid = parseInt(String(query.jobId ?? query.job ?? ''), 10);
    if (Number.isFinite(jid) && jid > 0) {
      args.push('--job-id', String(jid));
    }
    return { cmd: process.execPath, args };
  }
  if (name === 'evaluate') {
    const args = ['evaluate-pipeline.mjs', '--file', './data/pipeline.md'];
    const idsRaw = String(query.jobId ?? query.job ?? '').trim();
    if (idsRaw) {
      args.push('--job-id', idsRaw);
    }
    return { cmd: process.execPath, args };
  }
  return SCRIPT_MAP[name] || null;
}

export function runScript(name, onEvent, query = {}) {
  const spec = getScriptArgs(name, query);
  if (!spec) {
    throw new Error(`Unsupported script "${name}"`);
  }

  const child = spawn(spec.cmd, spec.args, {
    cwd: ROOT,
    shell: false,
    env: process.env,
    /** ignore stdin so nothing waits on an open pipe; line-buffer friendly stdout/stderr */
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const emitLines = (type, chunk) => {
    const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      onEvent(type, line);
    }
  };

  child.stdout.on('data', (chunk) => emitLines('data', chunk));
  child.stderr.on('data', (chunk) => emitLines('error', chunk));

  return child;
}
