# PR 226 Conflict and Browser Check Repair

The original PR head was `8f099053c57dce850479cb8be4a58de047145223`.
Its architecture, build, sensitive scan and browser shards 2/3 passed. Browser
shards 0/1 failed; bootstrap was a downstream aggregate failure.

## Root Cause

Both failed shards timed out at the same View-owned runtime-content assertion:
`panel-mesh-properties.getByText('Default', { exact: true })`. Mesh now presents
the indexed slot heading `0 · Default` inside `mesh-material-slot-0`.

- Browser 0 log: TypeScript runtime-content timeout; the Game 3D journey passed.
- Browser 1 log: JavaScript runtime-content timeout at the same assertion.

The hash-mismatch assertion messages earlier in shard 0 are intentional negative
tests. `verify-view-panels-falsifier.mjs` explicitly reported success with exit
code 0; these are not additional defects.

## Resolution

PR #225 merged its View test repair as `5d61c35`. The repaired assertion scopes to
`mesh-material-slot-0` and checks `0 · Default`, preserving the subsequent native
capture, binding, generation, restore and GPU-cleanup assertions. Main also
retains #225's completed-startup/focus preconditions for the Game 3D input test.

PR #226 replays only its Material feature onto merged main `83665a9`. This removes
the duplicate shared-card prerequisite commit, resolves the merge conflict and
inherits the maintained test repair directly. There is no remaining modification
to either browser script relative to main, no new timeout, and no weakened gate.
Engine, View CI configuration and the CI Engine pin remain unchanged.

## Validation

The rebased branch passes 623 unit tests, strict package type checking,
architecture checks (53 tests, zero violations), the product build and the
Material texture-reference browser regression. Native runtime-content validation
uses the existing installed Engine `284f102`, sandboxed Chromium, disposable
projects and the CI workload: 1000 x 700, at least 60 completed Scene frames and
two repeated resource retirement cycles. It never starts Play or replaces the
user's running View. Both JavaScript and TypeScript live journeys passed the
indexed-slot assertion and all subsequent generation, publication, geometry,
save/restore and retirement checks, with no captured page errors. The bounded
[result summary](check-repair-results.json) retains frame and resource evidence
without connection credentials or image payloads.

Local native results and exact-head remote CI are recorded separately. The
unchanged CI selects Engine `635e6bce`; the relevant public workspace/publication
interfaces are unchanged between that revision and the installed local Engine.
