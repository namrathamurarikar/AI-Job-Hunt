/**
 * Shared job score + light metadata fallbacks (dashboard pipeline list + CLI evaluators).
 * Keeps heuristic scoring in one place so pipeline UI and Ollama/Gemini reports stay aligned.
 */

export function extractPipelineQuickFields(jdText) {
  const t = String(jdText || '');
  const pick = (re) => {
    const m = t.match(re);
    return m ? m[1].trim() : '';
  };
  return {
    company: pick(/^- Company:\s*(.+)$/im) || pick(/(?:^|\n)-\s*Company:\s*(.+)/im) || pick(/Company:\s*(.+)/im),
    role: pick(/^- Role:\s*(.+)$/im) || pick(/(?:^|\n)-\s*Role:\s*(.+)/im) || pick(/Role:\s*(.+)/im),
    url: pick(/Job URL:\s*(\S+)/i),
  };
}

export function guessMetaFromEvaluationBody(text) {
  const t = String(text || '');
  let role =
    (t.match(/\*\*Job Title:\*\*\s*(.+)/i) || [])[1]?.trim() ||
    (t.match(/\*\*Role:\*\*\s*(.+)/i) || [])[1]?.trim() ||
    '';
  let company =
    (t.match(/\*\*Company Context:\*\*\s*(.+)/i) || [])[1]?.trim() ||
    (t.match(/\*\*Company:\*\*\s*(.+)/i) || [])[1]?.trim() ||
    '';
  company = company.replace(/\s*\(no additional information[^)]*\)\s*$/i, '').trim();
  if (/^none\b/i.test(company)) company = '';
  return { role, company };
}

/** Returns "X.X" in [1,5] or null. */
export function normalizeScoreOneToFive(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/\s*\/\s*5\s*$/i, '');
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  const c = Math.max(1, Math.min(5, n));
  return c.toFixed(1);
}

export function tryParseScoreFromEvaluationText(text) {
  const t = String(text || '');
  const patterns = [
    /\*\*Overall(?:\s+Score)?:\*\*\s*([0-5](?:\.\d+)?)\s*\/\s*5/i,
    /\*\*Global\s+Score:\*\*\s*([0-5](?:\.\d+)?)\s*\/\s*5/i,
    /\*\*Score:\*\*\s*([0-5](?:\.\d+)?)\s*\/\s*5/i,
    /\*\*Final\s+Score:\*\*\s*([0-5](?:\.\d+)?)\s*\/\s*5/i,
    /Overall\s+score[:\s]+([0-5](?:\.\d+)?)\s*\/\s*5/i,
    /\bScore\s*[:=]\s*([0-5](?:\.\d+)?)\s*\/\s*5/i,
    /\b([0-5](?:\.\d+)?)\s*\/\s*5\s*\(overall\)/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const n = normalizeScoreOneToFive(m[1]);
      if (n) return n;
    }
  }
  return null;
}

/** Same 1–5 title heuristic as the dashboard job pipeline (auto-score). */
export function estimateJobScore(title) {
  const t = String(title || '').toLowerCase();
  let score = 2.8;

  if (/\b(machine learning|ml engineer|ai engineer|applied ai|applied ml|llm|genai|mlops|llmops|ai platform)\b/.test(t)) score += 1.3;
  if (/\b(research engineer|staff|senior|principal|lead)\b/.test(t)) score += 0.3;
  if (/\b(platform|infrastructure|systems|observability|reliability)\b/.test(t)) score += 0.2;

  if (/\b(intern|junior|entry level|frontend|designer|sales|marketing|account)\b/.test(t)) score -= 1.2;
  if (/\b(product manager|pm|developer advocate|devrel)\b/.test(t)) score -= 0.8;

  score = Math.max(1.0, Math.min(5.0, score));
  return `${score.toFixed(1)}/5`;
}

export function heuristicArchetypeFromTitle(title) {
  const t = String(title || '').toLowerCase();
  if (!t.trim()) return 'General';
  if (/\b(machine learning|ml engineer|deep learning|mlops)\b/.test(t)) return 'ML Engineering';
  if (/\b(ai engineer|genai|llm|applied ai|nlp)\b/.test(t)) return 'AI / Applied ML';
  if (/\b(data scientist|analytics engineer)\b/.test(t)) return 'Data Science';
  if (/\b(backend|server|api|distributed)\b/.test(t)) return 'Backend';
  if (/\b(frontend|react|vue|ui engineer)\b/.test(t)) return 'Frontend';
  if (/\b(devops|sre|platform engineer)\b/.test(t)) return 'DevOps / Platform';
  return 'General';
}

function normalizeLegitimacyLabel(s) {
  const v = String(s || '').toLowerCase();
  if (/suspicious|spam|scam|fake\s*listing/.test(v)) return 'Suspicious';
  if (/high\s*confidence/.test(v) && !/caution/.test(v)) return 'High Confidence';
  if (/proceed\s+with\s+caution|medium|low\s*confidence|caution/.test(v)) return 'Proceed with Caution';
  if (v.includes('high')) return 'High Confidence';
  return 'Proceed with Caution';
}

export function fallbackLegitimacyFromSignals({ url, jdTextLength, parsedLegitimacy }) {
  const p = String(parsedLegitimacy || '').trim();
  if (p && !/^unknown$/i.test(p)) return normalizeLegitimacyLabel(p);
  const u = String(url || '').toLowerCase();
  if (
    /whatjobs|indeed\.com\/(rc|viewjob)|glassdoor|ziprecruiter|talent\.com|neuvoo|simplyhired|jobrapido/i.test(
      u,
    )
  ) {
    return 'Proceed with Caution';
  }
  if (Number(jdTextLength) > 0 && Number(jdTextLength) < 500) return 'Proceed with Caution';
  return 'Proceed with Caution';
}

/**
 * Fill company/role/score/archetype/legitimacy when the model skips ---SCORE_SUMMARY---
 * or returns placeholders — mirrors dashboard pipeline auto-score for the numeric score.
 */
export function enrichEvalSummary({ jdText, bodyText, company, role, score, archetype, legitimacy }) {
  const quick = extractPipelineQuickFields(jdText);
  const guess = guessMetaFromEvaluationBody(bodyText);

  let co = String(company || '').trim();
  if (!co || /^unknown$/i.test(co)) co = quick.company || guess.company || 'Unknown';

  let ro = String(role || '').trim();
  if (!ro || /^unknown$/i.test(ro)) ro = quick.role || guess.role || 'Unknown';

  let sc = normalizeScoreOneToFive(score);
  if (!sc) sc = tryParseScoreFromEvaluationText(bodyText);
  if (!sc) sc = normalizeScoreOneToFive(estimateJobScore(ro));

  let ar = String(archetype || '').trim();
  if (!ar || /^unknown$/i.test(ar)) ar = heuristicArchetypeFromTitle(ro);

  const leg = fallbackLegitimacyFromSignals({
    url: quick.url,
    jdTextLength: String(jdText || '').length,
    parsedLegitimacy: legitimacy,
  });

  return { company: co, role: ro, score: sc, archetype: ar, legitimacy: leg };
}
