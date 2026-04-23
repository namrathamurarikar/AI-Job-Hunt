/**
 * When the LLM returns HTML that still contains {{SUMMARY_TEXT}}, {{EXPERIENCE}}, etc.,
 * fill those slots deterministically from cv.md so PDFs are never empty shells.
 */

const DYNAMIC_PLACEHOLDERS = [
  'SUMMARY_TEXT',
  'COMPETENCIES',
  'EXPERIENCE',
  'PROJECTS',
  'EDUCATION',
  'CERTIFICATIONS',
  'SKILLS',
];

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** **bold** segments (pairs of **) → <strong> after escaping inner text */
function inlineMdToHtml(s) {
  if (!s) return '';
  const segments = String(s).split(/\*\*/);
  let out = '';
  for (let k = 0; k < segments.length; k++) {
    const chunk = escapeHtml(segments[k]);
    out += k % 2 === 1 ? `<strong>${chunk}</strong>` : chunk;
  }
  return out;
}

function getSection(md, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Next `## ` heading OR true end of string. Do not use `$` here: with flag `m`,
  // `$` matches before *every* newline, so non-greedy captures would stop after the first line.
  const re = new RegExp(`^##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|(?![\\s\\S]))`, 'm');
  const m = md.match(re);
  return m ? m[1].trim() : '';
}

function summaryFromCv(md) {
  let t = getSection(md, 'Professional Summary');
  t = t.replace(/\n---\s*$/, '').trim();
  if (!t) return '<p></p>';
  const paras = t.split(/\n\n+/).filter(Boolean);
  return paras.map((p) => `<p>${inlineMdToHtml(p.replace(/\n/g, ' '))}</p>`).join('');
}

function competenciesFromCv(md) {
  let s = getSection(md, 'Core Technical Skills');
  if (!s) s = getSection(md, 'Skills');
  if (!s) return '<span class="competency-tag">Update cv.md — Core Technical Skills</span>';
  const tags = [];
  const rows = s.split('\n');
  for (const line of rows) {
    if (!line.includes('|') || /^\|[\s-|]+\|/.test(line) || /^Category/i.test(line)) continue;
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    const skillsCell = cells[1];
    const parts = skillsCell.split(',').map((x) => x.trim()).filter(Boolean);
    for (const p of parts) {
      tags.push(p);
      if (tags.length >= 10) break;
    }
    if (tags.length >= 10) break;
  }
  const pick = tags.slice(0, 8);
  if (pick.length === 0) return '<span class="competency-tag">Skills</span>';
  return pick.map((t) => `<span class="competency-tag">${escapeHtml(t)}</span>`).join('\n      ');
}

function experienceFromCv(md) {
  const section = getSection(md, 'Work Experience');
  if (!section) return '<p></p>';
  const blocks = section.split(/\n(?=###\s)/).filter((b) => /^###\s/m.test(b.trim()));
  const parts = [];
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const role = lines[0].replace(/^###\s+/, '').trim();
    const meta = (lines[1] || '').trim();
    const metaMatch = meta.match(/^\*\*([^*]+)\*\*\s*\|\s*(.+)$/);
    let company = meta;
    let period = '';
    let location = '';
    if (metaMatch) {
      company = metaMatch[1].trim();
      const rest = metaMatch[2].split('|').map((x) => x.trim());
      period = rest[0] || '';
      location = rest[1] || '';
    }
    const bullets = [];
    for (let j = 2; j < lines.length; j++) {
      const line = lines[j].trim();
      if (line.startsWith('- ')) bullets.push(line.slice(2));
    }
    parts.push(`<div class="job avoid-break">
  <div class="job-header">
    <span class="job-company">${escapeHtml(company)}</span>
    <span class="job-period">${escapeHtml(period)}</span>
  </div>
  <div class="job-role">${escapeHtml(role)}</div>
  ${location ? `<div class="job-location">${escapeHtml(location)}</div>` : ''}
  <ul>
    ${bullets.map((b) => `    <li>${inlineMdToHtml(b)}</li>`).join('\n')}
  </ul>
</div>`);
  }
  return parts.join('\n');
}

function projectsFromCv(md) {
  const section = getSection(md, 'Projects');
  if (!section) return '<p></p>';
  const blocks = section.split(/\n(?=###\s)/).filter((b) => /^###\s/m.test(b.trim()));
  const parts = [];
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const title = lines[0].replace(/^###\s+/, '').trim();
    const bullets = [];
    for (let j = 1; j < lines.length; j++) {
      const line = lines[j].trim();
      if (line.startsWith('- ')) bullets.push(line.slice(2));
    }
    const descHtml = bullets.length
      ? `<div class="project-desc">${bullets.map((b) => `<p>${inlineMdToHtml(b)}</p>`).join('')}</div>`
      : '';
    parts.push(`<div class="project avoid-break">
  <div class="project-title">${escapeHtml(title)}</div>
  ${descHtml}
</div>`);
  }
  return parts.join('\n');
}

function educationFromCv(md) {
  const section = getSection(md, 'Education');
  if (!section) return '<p></p>';
  const lines = section.split('\n').filter((l) => l.trim().startsWith('- '));
  return lines
    .map((line) => {
      const raw = line.replace(/^-\s*/, '').trim();
      return `<div class="edu-item avoid-break"><div class="edu-header"><span class="edu-title">${inlineMdToHtml(raw)}</span></div></div>`;
    })
    .join('\n');
}

function certificationsFromCv(md) {
  const section = getSection(md, 'Certifications');
  if (!section) return '<p></p>';
  const lines = section.split('\n').filter((l) => l.trim().startsWith('- '));
  return lines
    .map((line) => {
      const raw = line.replace(/^-\s*/, '').trim();
      return `<div class="cert-item avoid-break"><span class="cert-title">${inlineMdToHtml(raw)}</span></div>`;
    })
    .join('\n');
}

function skillsFromCv(md) {
  let section = getSection(md, 'Core Technical Skills');
  if (!section) section = getSection(md, 'Skills');
  if (!section) return '<div class="skills-grid"></div>';
  const rows = section.split('\n').filter((l) => {
    if (!l.includes('|')) return false;
    if (/^\|[\s-|]+\|/.test(l)) return false;
    if (/^\|\s*Category/i.test(l)) return false;
    return true;
  });
  const chunks = [];
  for (const line of rows) {
    const cells = line.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
    if (cells.length < 2) continue;
    const cat = cells[0].replace(/\*\*/g, '').trim();
    const skills = cells[1];
    chunks.push(
      `<div><span class="skill-category">${escapeHtml(cat)}:</span> <span class="skill-item">${inlineMdToHtml(skills)}</span></div>`
    );
  }
  return `<div class="skills-grid">${chunks.join('\n')}</div>`;
}

const builders = {
  SUMMARY_TEXT: summaryFromCv,
  COMPETENCIES: competenciesFromCv,
  EXPERIENCE: experienceFromCv,
  PROJECTS: projectsFromCv,
  EDUCATION: educationFromCv,
  CERTIFICATIONS: certificationsFromCv,
  SKILLS: skillsFromCv,
};

export function listUnresolvedDynamicPlaceholders(html) {
  return DYNAMIC_PLACEHOLDERS.filter((p) => html.includes(`{{${p}}}`));
}

/**
 * Replace any remaining {{SUMMARY_TEXT}} … {{SKILLS}} using cv.md.
 * @param {string} html
 * @param {string} cvMd
 * @returns {string}
 */
export function applyDynamicPlaceholdersFromCvMd(html, cvMd) {
  let out = html;
  for (const key of DYNAMIC_PLACEHOLDERS) {
    const token = `{{${key}}}`;
    if (!out.includes(token)) continue;
    const fn = builders[key];
    if (typeof fn !== 'function') continue;
    const fragment = fn(cvMd);
    out = out.split(token).join(fragment);
  }
  return out;
}

function stripTags(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function roughBodyVisibleTextLen(html) {
  const body = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [null, html])[1];
  return stripTags(body).length;
}

function extractSummaryTextInner(html) {
  const m = html.match(/<div[^>]*class="summary-text"[^>]*>([\s\S]*?)<\/div>/i);
  return m ? stripTags(m[1]) : '';
}

function countMarkdownH3(md) {
  return (md.match(/^###\s/gm) || []).length;
}

function estimatedCvBodyChars(cvMd) {
  return [
    'Professional Summary',
    'Work Experience',
    'Projects',
    'Education',
    'Certifications',
    'Core Technical Skills',
  ]
    .map((h) => getSection(cvMd, h))
    .join('\n').length;
}

/**
 * True when model output still has placeholders, or when placeholders were removed but the
 * résumé body is empty / wrong structure (common with small local LLMs): headings only, no jobs, etc.
 */
export function resumeHtmlNeedsCvFullRebuild(html, cvMd) {
  if (listUnresolvedDynamicPlaceholders(html).length > 0) return true;

  const cvWork = getSection(cvMd, 'Work Experience');
  const cvJobs = countMarkdownH3(cvWork);
  // Match only role blocks — not `job-header`, `job-role`, etc. (avoid /job\\b/ false positives)
  const htmlJobs = (html.match(/<div class="job avoid-break"/g) || []).length;
  if (cvJobs >= 1 && htmlJobs < cvJobs) return true;

  const cvProj = getSection(cvMd, 'Projects');
  const nCvProj = countMarkdownH3(cvProj);
  const htmlProj = (html.match(/<div class="project avoid-break"/g) || []).length;
  if (nCvProj >= 1 && htmlProj < nCvProj) return true;

  const sumCv = getSection(cvMd, 'Professional Summary').replace(/\n---[\s\S]*$/m, '').trim();
  const sumHtml = extractSummaryTextInner(html);
  if (sumCv.length > 80 && sumHtml.length < 40) return true;

  const skillsMd = getSection(cvMd, 'Core Technical Skills');
  const nComp = (html.match(/class="competency-tag"/g) || []).length;
  if (skillsMd.length > 100 && nComp === 0) return true;

  const cvEst = estimatedCvBodyChars(cvMd);
  const bodyLen = roughBodyVisibleTextLen(html);
  if (cvEst > 1200 && bodyLen < 700) return true;

  return false;
}

/**
 * Small / truncated prompts often yield HTML with only a tailored Professional Summary.
 * Always materialize experience, competencies, projects, etc. from cv.md, then optionally
 * keep the model's summary-text if it looks substantive (JD-tuned).
 */
export function mergeOllamaOutputWithCvBody(modelHtml, basePrefilled, cvMd) {
  const fullFromCv = applyDynamicPlaceholdersFromCvMd(basePrefilled, cvMd);
  if (process.env.OLLAMA_USE_CV_ONLY === '1') {
    return { html: fullFromCv, usedModelSummary: false };
  }
  const m = modelHtml.match(/<div[^>]*\bsummary-text\b[^>]*>([\s\S]*?)<\/div>/i);
  if (!m) {
    return { html: fullFromCv, usedModelSummary: false };
  }
  const inner = m[1].trim();
  const stripped = stripTags(inner);
  if (stripped.length < 60) {
    return { html: fullFromCv, usedModelSummary: false };
  }
  if (/\{\{\s*SUMMARY_TEXT\s*\}\}/.test(inner)) {
    return { html: fullFromCv, usedModelSummary: false };
  }
  const merged = fullFromCv.replace(
    /(<div[^>]*\bsummary-text\b[^>]*>)([\s\S]*?)(<\/div>)/i,
    (_all, openTag, _oldInner, closeTag) => `${openTag}${inner}${closeTag}`,
  );
  return { html: merged, usedModelSummary: true };
}
