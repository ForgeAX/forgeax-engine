# Contributions from later sessions

## Choose the owner of the new knowledge

| Contribution | Update |
| --- | --- |
| Generalizable decision or recurring pitfall | Its existing topic reference |
| New independent topic with substantial guidance | A focused reference and a row in SKILL.md |
| Dated benchmark/failed candidate with source-specific facts | `references/cases/<topic>.md`, linked from its relevant topic |
| Large-function phase or temporary-collection experiment | Observation method in [Measurement](measurement.md#keep-observation-cost-separate), semantic controls in [CPU ownership](cpu-submission.md#remove-temporary-collection-work-at-its-owner), numbers in one scoped case |
| Repeated deterministic analysis | A `scripts/` helper, Toolbox entry and meaningful `scripts/__tests__/` regressions |
| Platform-specific collection/device procedure | Existing WeChat/RHI/CLI owner; link it from Toolbox |

Read the current checkout and nearby reference before editing. Preserve unrelated
changes in an isolated worktree and reconcile current contributions before
pushing. Do not replace this directory wholesale with an older session copy.
A skill entrypoint routes decisions; it is not a transcript or a second API
catalogue. Keep the authority once and link it from other topics.

## Make a scoped technique reviewable

| Field | What to preserve |
| --- | --- |
| Problem and owner | Actual trigger, hot stage and affected producer/consumer boundary |
| Mechanism | Work removed/moved, change frequency and why reuse stays correct |
| Source/date/target | Revisions/build evidence, backend/device and where the behavior was observed |
| Workload and method | Scene, quality, sampling, instrumentation, counts and statistic definitions |
| Outcome | Measured improvement, regression, implementation-only proof or unverified candidate |
| Counterexample | Case that invalidates the proposed cache/optimization or refuses the comparison |
| Evidence | Repository source/tests and durable PR/report links; raw private artifacts stay outside the skill |
| Limit and next action | Remaining runtime/performance acceptance or the experiment that can falsify it |

Use existing artifact formats when an actual consumer already owns one. Cases
are Markdown-first; do not create a parallel mandatory JSON ledger just to mirror
prose. Document source-specific observations as dated facts. A later successful
candidate does not erase the original failure; amend the interpretation and
link the new evidence. Do not copy private reference-engine source or session
credentials into the skill.

## Keep scripts portable and honest

Use the existing producer or analyzer before implementing another one. New
helpers should accept explicit input/output paths, expose `--help`, preserve
units/identity/completeness and fail on malformed data. The common
[analysis library](../scripts/lib.mjs) owns JSON Pointer lookup, hashing,
nearest-rank statistics and input-overwrite protection for this toolbox.
Do not hardcode one machine, repository path, process ID or private browser URL.

A regression should prove analytical behavior: overlapping GPU intervals,
recursive CPU attribution, quality mismatch, stale/partial evidence or invalid
units/counts. Assertions that merely match headings or generated prose do not
establish tool correctness. Replay a retained real capture when its format is
available; replay qualifies analysis, not a new live hardware benchmark.

For private owner instrumentation, retain plain/transformed bundle hashes,
source-map authority, frame/work conservation and the complete-owner perturbation
comparison. Reuse a retained runner only with its exact declared inputs and
carrier; [the VFX phase case](cases/vfx-plan-phases-20261017.md) distinguishes
Node/Null diagnosis from Chrome and product acceptance.

## Validate the contribution

From the Engine root:

```sh
node --test skills/forgeax-engine-performance/scripts/__tests__/*.test.mjs
node scripts/forgeax/check-engine-skills.mjs
node scripts/check-test-layout.mjs
git diff --check
```

Run the affected formatter/English gate from the checkout and the skill-creator
frontmatter validator when available. Inspect every local link and execute
changed CLI examples against representative data. Check the owning runtime
regressions too if the contribution changes production code; these offline
analysis tests do not replace rendering, Browser or Dawn acceptance.

Add useful topic/tool navigation, then re-read the entrypoint from a fresh
session's perspective. Remove repeated facts and unfinished placeholders.
