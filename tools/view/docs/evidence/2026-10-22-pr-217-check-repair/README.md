# PR #217 Check Repair

## 2026-10-23 CI Configuration Update

View main `8c87c3f` includes administrator commit `037d177`, which replaces
the fixed Engine revision with `ref: view`. The build job publishes its resolved
Engine SHA and every browser shard checks out that same SHA. This PR now merges
that main unchanged; no new workflow configuration was authored here.

The older run `39785276595` was rerun as attempt 2 at the user's request, but
that attempt retains the old workflow snapshot. A new push is required to
execute the updated configuration. The remote Engine `view` head at inspection
was `49f9477213e739b699773496a9864b478e4c4504`; the new job's checkout log is
the authority for the actual built revision.

The fixed-pin patch below is historical and must not be applied to the updated
workflow. The administrator action described below has been superseded.
Earlier local verification remains evidence for its explicitly named revisions;
the new remote run establishes acceptance of the updated pair.

## Historical Repair

The UV preview branch merges View main `eb7c0815e176818518f2e5b491a3c249717f057d`
at `a91631df1e88af976aa585d648c24fbeede61e40`. The decision index preserves
the newer Material references and Mesh camera decisions alongside UV inspection.

The native presentation lifecycle tests use Engine's normal bounded startup
budget. A parallel source run reproduced a timeout with every reported Fiber
already ACTIVE under the old 120 ms override. Failure, provider removal,
restoration and cleanup assertions remain; an explicit 120 ms negative case
still checks rejection and cleanup of a required child with no provider.

## Paired Verification

The selected remote Engine `view` head and local Engine checkout were both
`dde5e9c7a45612334000c7cc87390a26bb0146e8`. View resolves the built public
Engine facades from that checkout. Engine source and Git state were not changed.
Its `tools/view` gitlink, `e487d9b931311996fd213ee49943eb1d7c3eb1a7`, is an
ancestor of this View candidate.

- All 631 tests pass on Node 24.19.0 with the complete ordinary source command,
  including sync-harness and release tests, without a concurrency override.
- Strict package type checking and production Viewer/native module builds pass.
- Architecture reports zero violations; architecture guardrail tests and
  `git diff --check` pass.
- Real `verify-resource-preview-lifecycle.mjs` passes at DPR 1 and 2. It checks
  UV channels 0/1/2, six complete islands, out-of-range red geometry, pixel
  readback, local zoom/pan, dense 49,152-triangle navigation, camera isolation,
  unchanged UV query counts during navigation, cancellation and exact preview
  retirement/reopening.

The initial sandboxed source run was rejected by local port permissions. The
complete rerun allowed temporary loopback servers; no assertions were bypassed.
An initially incomplete local dependency graph for the newly merged Parameters
package was repaired through ignored dependency links before strict type checking.

## Browser Repair (2026-10-23)

Run `39897322648` confirms the Engine update worked: build checked out Engine
`view` at `49f9477213e739b699773496a9864b478e4c4504`, and architecture/build
passed. Browser shard 3 passed. Shards 0, 1 and 2 all timed out while searching
for Content Browser in the old page-local edge tabs. View main had moved that
Shell-home panel to the Shell's bottom drawer.

The three affected integration probes now reveal Content Browser through the
existing public `presentation.panel.reveal` operation and retain their visible
panel assertions. This keeps the probes bound to the panel owner instead of a
specific Dockview location. The presentation/dock suite passes all 48 tests;
Node syntax checks and `git diff --check` pass.

The follow-up browser shard exposed a bad test-only access path in the plugin
boundary probe: `__forgeaxViewReady.mounted` has no `frontendHost` property.
That probe now routes through the existing native backend ToolApi workspace call,
the same presentation owner used by the page-plugin integration probe. Its
`succeeded` result and live panel visibility are asserted.
A local real-browser rerun stopped before browser startup because this machine's
Engine package graph is incomplete (`@forgeax/engine-codec` is missing); it
provides no result for the panel change. A new CI run is required to confirm all
four shards and bootstrap pass.

The earlier fixed-Engine-pin repair and its patch are historical. The current
workflow is inherited from View main and uses the Engine `view` revision resolved
by the build job for each browser shard.
