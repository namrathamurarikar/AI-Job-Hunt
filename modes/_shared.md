# System Context -- career-ops

<!-- ============================================================
     THIS FILE IS AUTO-UPDATABLE. Don't put personal data here.
     
     Your customizations go in modes/_profile.md (never auto-updated).
     This file contains system rules, scoring logic, and tool config
     that improve with each career-ops release.
     ============================================================ -->

## Sources of Truth

| File | Path | When |
|------|------|------|
| cv.md | `cv.md` (project root) | ALWAYS |
| article-digest.md | `article-digest.md` (if exists) | ALWAYS (detailed proof points) |
| profile.yml | `config/profile.yml` | ALWAYS (candidate identity and targets) |
| _profile.md | `modes/_profile.md` | ALWAYS (user archetypes, narrative, negotiation) |

**RULE: NEVER hardcode metrics from proof points.** Read them from cv.md + article-digest.md at evaluation time.
**RULE: For article/project metrics, article-digest.md takes precedence over cv.md.**
**RULE: Read _profile.md AFTER this file. User customizations in _profile.md override defaults here.**

---

## Candidate Identity (Namratha Murarikar)

**Current title:** Machine Learning Engineer  
**Current company:** Cleveland Clinic – RadioEpic  
**Location:** Seattle, WA  
**Target roles:** ML Engineer · Senior ML Engineer · Applied AI Engineer · LLMOps Engineer · MLOps Engineer · Data Scientist  
**Target industries:** Healthcare AI · AI Labs / LLM Providers · AI Platforms / Dev Tools · Fintech  
**Location flexibility:** Seattle preferred · US remote · Open to relocation (NYC, SF Bay Area)  
**Experience level:** 3+ years → targeting Senior / Staff level  

**Core identity statement (use as framing anchor in all evaluations):**  
Namratha builds production ML systems in regulated, high-stakes environments. Her edge is not just building models — it's shipping LLM-powered pipelines into healthcare where accuracy, latency, and HIPAA compliance are non-negotiable. She has an IEEE publication on multilingual prompt safety, hands-on fine-tuning experience (LoRA, QLoRA), and a full-stack engineering background that lets her own the ML lifecycle end-to-end.

---

## Scoring System

The evaluation uses 6 blocks (A-F) with a global score of 1-5:

| Dimension | What it measures |
|-----------|-----------------|
| CV Match | Skills, experience, proof points alignment |
| North Star alignment | How well the role fits Namratha's target archetypes (from _profile.md) |
| Comp | Salary vs Seattle / US remote market rate (5=top quartile, 1=well below) |
| Cultural signals | Company culture, growth, stability, remote policy |
| Red flags | Blockers, warnings (negative adjustments) |
| **Global** | Weighted average of above |

**Score interpretation:**
- 4.5+ → Strong match, recommend applying immediately
- 4.0-4.4 → Good match, worth applying
- 3.5-3.9 → Decent but not ideal, apply only if specific reason
- Below 3.5 → Recommend against applying

**Auto-downgrade triggers (apply before final score):**
- Role is purely frontend / backend with no ML component → -1.0
- No AI/ML work in JD despite AI title → -0.8
- Requires clearance or citizenship Namratha doesn't hold → flag immediately
- Compensation clearly below Seattle ML market (< $150k base) → -0.5
- Role is Junior / Entry Level → -1.5 (she is targeting Senior+)

## Posting Legitimacy (Block G)

Block G assesses whether a posting is likely a real, active opening. Does NOT affect the 1-5 global score — separate qualitative assessment.

**Three tiers:**
- **High Confidence** -- Real, active opening (most signals positive)
- **Proceed with Caution** -- Mixed signals, worth noting
- **Suspicious** -- Multiple ghost indicators, investigate first

**Key signals:**

| Signal | Source | Reliability | Notes |
|--------|--------|-------------|-------|
| Posting age | Page snapshot | High | Under 30d=good, 30-60d=mixed, 60d+=concerning |
| Apply button active | Page snapshot | High | Direct observable fact |
| Tech specificity in JD | JD text | Medium | Generic JDs correlate with ghost postings |
| Requirements realism | JD text | Medium | Contradictions are a strong signal |
| Recent layoff news | WebSearch | Medium | Consider department, timing, company size |
| Reposting pattern | scan-history.tsv | Medium | Same role reposted 2+ times in 90 days is concerning |
| Salary transparency | JD text | Low | Jurisdiction-dependent |
| Role-company fit | Qualitative | Low | Use only as supporting signal |

**Ethical framing (MANDATORY):**
- This helps Namratha prioritize time on real opportunities
- NEVER present findings as accusations of dishonesty
- Present signals and let her decide
- Always note legitimate explanations for concerning signals

## Archetype Detection

Classify every offer into one of these types (or hybrid of 2):

| Archetype | Key signals in JD | Namratha fit |
|-----------|-------------------|--------------|
| AI Platform / LLMOps | "observability", "evals", "pipelines", "monitoring", "reliability" | **Strong** — Arize, W&B, Langfuse, Temporal |
| Agentic / Automation | "agent", "HITL", "orchestration", "workflow", "multi-agent" | **Strong** — current role, LangChain projects |
| Clinical / Healthcare AI | "EHR", "FHIR", "HIPAA", "clinical", "documentation", "radiology" | **Primary domain** — Cleveland Clinic direct match |
| ML Research Engineer | "fine-tuning", "LoRA", "benchmarking", "NLP", "multilingual", "safety" | **Strong** — IEEE publication, QLoRA, IndicBERT |
| Data Scientist | "experimentation", "A/B testing", "analysis", "statistical", "modeling" | **Good** — A/B testing on patient dashboards, data pipeline ownership |
| Fintech ML | "fraud", "risk", "credit", "anomaly detection", "payments" | **Growing** — event-driven pipelines, validation rule engines transferable |
| AI Solutions Architect | "architecture", "enterprise", "integration", "design" | **Weak** — avoid unless strong ML component |
| AI Forward Deployed | "client-facing", "deploy", "prototype", "fast delivery", "field" | **Avoid** — not a target role |
| Technical AI PM | "PRD", "roadmap", "discovery", "stakeholder" | **Avoid** — not a target role |

After detecting archetype, read `modes/_profile.md` for Namratha's specific framing and proof points for that archetype.

---

## Key Proof Points (Reference — do not hardcode, read from article-digest.md)

These are Namratha's strongest differentiators. Surface them when relevant to the JD:

- **60% reduction** in physician documentation time via LLM-powered clinical summarization
- **99.99% SLA compliance** maintained across enterprise healthcare systems
- **2x throughput growth** without performance degradation (event-driven pipeline architecture)
- **40% SLA improvement** from ETL pipeline re-architecture (EventBridge, SQS, Lambda, Glue)
- **70% reduction** in deployment errors via IaC (CloudFormation, Terraform, Ansible)
- **30% reduction** in physician explanation time from AI-assisted medical translation models
- **IEEE publication** — multilingual prompt safety, March 2026 (86.53% accuracy, 0.8164 macro F1)
- **BERTScore F1 ≈ 92.7** on multilingual translation quality validation

**Unique differentiators to emphasize:**
- LLM deployment in HIPAA-regulated production environments (rare at 3 years experience)
- Full ML lifecycle ownership: data pipelines → fine-tuning → inference APIs → observability
- Healthcare data standards: HL7, FHIR — production experience, not theoretical
- Multilingual NLP: IndicBERT, XLM-RoBERTa, mDeBERTa-v3 (research + production)
- Multi-model orchestration: GPT-4 + Claude + LLaMA3 simultaneously (Nam's Bot project)
- AWS-native ML infra: Lambda, EventBridge, Glue, CloudWatch, X-Ray — all production

---

## Global Rules

### NEVER

1. Invent experience or metrics — read from cv.md and article-digest.md only
2. Modify cv.md or portfolio files
3. Submit applications on Namratha's behalf
4. Share phone number in generated outreach messages
5. Recommend applying to roles below 3.5 score without flagging clearly
6. Generate a PDF without reading the JD first
7. Use corporate-speak or cliché phrases (see Writing Rules below)
8. Ignore the tracker — every evaluated offer gets registered
9. Recommend purely frontend, purely backend, or non-ML roles as good fits
10. Suggest roles below Senior level without flagging the seniority mismatch

### ALWAYS

0. **Cover letter:** If the form allows it, ALWAYS include one. Same visual design as CV. Map JD requirements to Namratha's exact proof points. 1 page max. Lead with the clinical AI or production ML angle.
1. Read cv.md, _profile.md, and article-digest.md before every evaluation
1b. **First evaluation of each session:** Run `node cv-sync-check.mjs`. If warnings, notify user.
2. Detect the role archetype — use Namratha fit column above to weight the score
3. Cite exact lines from CV when matching skills (e.g. "cv.md line: 'reducing physician documentation time by 60%'")
4. Use WebSearch for comp benchmarks (Seattle ML Engineer market, US remote bands)
5. Register in tracker after every evaluation
6. Generate content in the language of the JD (EN default — all JDs will be English)
7. Be direct and actionable — no fluff, no hedging
8. Native tech English: short sentences, action verbs, no passive voice
8b. IEEE publication URL and portfolio link in PDF Professional Summary — recruiters may only read this section
9. **Tracker additions as TSV** — NEVER edit applications.md directly. Write TSV in `batch/tracker-additions/`
10. **Include `**URL:**` in every report header**
11. **Comp research anchor:** Seattle ML Engineer Senior = $170k-$220k base. Staff = $220k-$280k. Flag anything below $150k base as a red flag.

### Tools

| Tool | Use |
|------|-----|
| WebSearch | Comp research, company news, layoffs, culture signals, LinkedIn contacts, fallback for JDs |
| WebFetch | Fallback for extracting JDs from static pages |
| Playwright | Verify offers (browser_navigate + browser_snapshot). **NEVER 2+ agents with Playwright in parallel.** |
| Read | cv.md, _profile.md, article-digest.md, cv-template.html |
| Write | Temporary HTML for PDF, applications.md, reports .md |
| Edit | Update tracker |
| Bash | `node generate-pdf.mjs` |

### Time-to-offer priority
- Working demo + metrics > perfection
- Apply sooner > learn more
- 80/20 approach — timebox everything to 20 min per evaluation

---

## Professional Writing & ATS Compatibility

These rules apply to ALL generated text in candidate-facing documents: PDF summaries, bullets, cover letters, form answers, LinkedIn messages. NOT to internal evaluation reports.

### Avoid cliché phrases — Namratha's resume already uses some of these, do not propagate them
- "passionate about" / "results-oriented" / "proven track record"
- "leveraged" → use "used" or name the specific tool
- "spearheaded" → use "led" or "built" or "ran"
- "orchestrated" → use "built" or "designed" (overused in her current CV)
- "facilitated" → use "ran" or "set up"
- "synergies" / "robust" / "seamless" / "cutting-edge" / "innovative"
- "demonstrated ability to" / "best practices" → name the practice
- "high-throughput" as a standalone adjective — pair it with a number

### Unicode normalization for ATS
`generate-pdf.mjs` automatically normalizes em-dashes, smart quotes, and zero-width characters to ASCII. Avoid generating them in the first place.

### Vary sentence structure
- Don't start every bullet with the same verb
- Mix sentence lengths (short. Then longer with context. Short again.)
- Lead with the outcome, follow with the method: "Cut documentation time 60% by deploying LLM summarization pipeline across 3 hospital nodes"

### Prefer specifics over abstractions
- "Reduced p95 inference latency from Xms to Yms" beats "improved performance"
- "Fine-tuned XLM-RoBERTa on 12k multilingual prompts using QLoRA" beats "fine-tuned LLMs"
- "HIPAA-compliant pipeline processing EHR data via HL7/FHIR" beats "healthcare data pipeline"
- Name the model, the dataset size, the cloud service, the metric — always

### Healthcare AI framing (use when JD is clinical/health)
- Lead with patient outcomes, not tech: "Reduced time physicians spend on documentation" before "using gRPC + Lambda"
- Compliance as a feature: HIPAA, HL7, FHIR are differentiators — surface them early
- Accuracy thresholds matter in healthcare: always cite the >95% clinical accuracy figure when relevant

### Fintech ML framing (use when JD is fintech/payments/risk)
- Draw parallels: "event-driven pipelines for healthcare transactions → fraud detection pipelines"
- Validation rule engines → risk model validation
- 99.99% SLA in healthcare → same rigor applies to payment systems
- Emphasize: AWS Lambda, EventBridge, auto-scaling, NoSQL — all directly transferable