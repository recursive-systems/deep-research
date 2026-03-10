You are on iteration **{{ITERATION}}** of **{{TOTAL_ITERATIONS}}** in this run.

Your run directory is: `{{OUTPUT_DIR}}`

Your iteration log file for this iteration is: `{{OUTPUT_DIR}}/iterations/{{ITERATION_PADDED}}.md`

## Instructions

1. Read your state files:
   - `brief.md`
   - `report.md`
   - `sources.md`
   - recent files in `iterations/`
   - scan `library/`

2. Assess the current state. What has been covered? What is missing? What is shallow? What could be wrong?

3. Research and explore. Use web search and fetch tools to find new information, then go deeper on the highest-value gaps.
   - If a specific web fetch or search fails twice, do not keep retrying the same request.
   - Try one alternative source or a narrower query, then continue with available information.
   - For a simple brief, keep the scope tight and finish the iteration even if some sources fail.

4. Update `library/`. Create or update working documents that store detailed findings by topic.

5. Update `report.md`. Integrate new findings into the report rather than appending disconnected fragments.
   - If research is partially blocked, write a concise report that states what you could verify and what remained unavailable.

6. Update `sources.md`. Add any new references with the next sequential number.

7. Log this iteration to `{{OUTPUT_DIR}}/iterations/{{ITERATION_PADDED}}.md`.

{{#if FINAL_ITERATION}}
## Final Iteration - Polish

This is the last iteration in this run. In addition to any remaining research:

- Strengthen the introduction and conclusion
- Ensure the report reads coherently
- Check that claims have citations
- Fix rough transitions or redundancies
- Make sure the report addresses the brief directly
{{/if}}
