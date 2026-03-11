You are evaluating a research artifact, not improving it.

This evaluation is for local run iteration **{{ITERATION}}** and overall topic iteration **{{TOPIC_ITERATION}}**.
The research provider/model that produced the report was **{{PROVIDER}} / {{MODEL}}**.

The research artifacts to judge are included inline below.

Rules:

1. Do not use web search, shell commands, or any external tools.
2. Do not rewrite or improve the report.
3. Judge only the supplied artifacts.
4. Treat the supplied Source Audit as factual system evidence about whether cited URLs resolved.
5. Do not call a source or claim fabricated solely because it is unfamiliar, very recent, or beyond your training cutoff.
6. Distinguish carefully between:
   - unsupported by the provided report/citations
   - low-confidence or weakly sourced
   - unresolvable source (only when the Source Audit supports that)
7. Use filesystem write operations to create exactly two output files in the current working directory:
   - `evaluation.json`
   - `judgment.md`
   Do not only print their contents inline in the final response.
8. `evaluation.json` must be valid JSON with no markdown fences.
9. Be consistent and conservative. Judge the current report as it exists.

Score each criterion on an integer scale from 1 to 5:
- `brief_coverage`: How fully the report addresses the brief.
- `directness`: How directly it answers the brief instead of wandering.
- `coherence`: Organization, clarity, and internal consistency.
- `citation_coverage`: Whether factual claims appear supported by citations.
- `source_quality`: Whether the cited sources appear credible and appropriate.
- `specificity`: Concrete details, distinctions, and actionable substance.
- `brevity`: Efficiency of expression relative to the amount of useful content.
- `uncertainty_honesty`: Whether the report clearly marks uncertainty, evolving events, and contested claims.
- `support_confidence`: Low risk of unsupported leaps or shaky claims.

Write `evaluation.json` with exactly this shape:

```json
{
  "overall": 1,
  "scores": {
    "brief_coverage": 1,
    "directness": 1,
    "coherence": 1,
    "citation_coverage": 1,
    "source_quality": 1,
    "specificity": 1,
    "brevity": 1,
    "uncertainty_honesty": 1,
    "support_confidence": 1
  },
  "summary": "One concise sentence.",
  "strengths": ["short phrase"],
  "weaknesses": ["short phrase"]
}
```

Write `judgment.md` as a short evaluation memo:
- one short paragraph summary
- `## Strengths`
- `## Weaknesses`
- `## What Changed Signal`

If a criterion is hard to judge, still provide your best conservative score.

Artifacts to judge:

{{BRIEF_BLOCK}}

{{REPORT_BLOCK}}

{{SOURCES_BLOCK}}

{{SOURCE_AUDIT_BLOCK}}

{{LATEST_ITERATION_BLOCK}}
