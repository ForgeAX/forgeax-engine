# PR #212 Check Repair

## Superseding Rebase: 2026-10-23

The branch is now rebased onto View main
`45f99020463f20d16785076a1420675c3ed57d6c`. Its CI file is identical to that
main commit: build resolves Engine `view`, and every browser shard checks out
that build's `engine_sha`. The older pin instructions and unapplied patch below
are historical; do not apply them to the current workflow.

The first rebase onto `8c87c3f` resolved only the decision index and preserved
all six feature/repair commits. Run `39898018097` on head `58b975d` passed every
check, including all four browser shards and bootstrap. While those checks ran,
main advanced through #234, introducing an overlapping panel repair.

The follow-up rebase resolves the three probe conflicts by retaining main's
unconditional public reveal action and the already-qualified native ToolApi
path in the borrowed-Page library probe. It preserves both owner-returned
visibility and DOM visibility assertions, without assuming a page-global mount
object shape. The feature, fixture isolation and startup repairs remain intact.
That head (`f72b162`) subsequently passed every check in run `39901485116` on
Engine `96e0218`, after one unchanged failed-job rerun for an observed GPU
device loss during RHI replay. No rendering or timeout assertion changed.

Main then advanced through #235, which supplies the ordinary workspace-client
implementation for the embedded probe and a Pack draft binding repair. The
final refresh adopts that main commit and drops the redundant branch-specific
panel probe patch. Current panel probes are inherited from main, while the
triangle selection, fixture isolation and startup test repairs remain.
After rebase, all 644 source tests pass with no skips; architecture reports
19 packages, 384 source files and zero violations. `git diff --check` passes.
The remote Engine `view` head at rebase was
`49f9477213e739b699773496a9864b478e4c4504`; the new CI checkout log is the
authority for its actual selected revision.

## Historical Delivery

The triangle selection branch merges View main
`eb7c0815e176818518f2e5b491a3c249717f057d` at
`c94a211cde42f3deaa88464349a5f0758b60d926`. The conflict in the decision
index preserves both newer decisions and the Scene triangle selection contract.

## Failed Check Audit

Raw logs for run `39563706475` on the previous PR head identify two producer
failures: browser shard 1 disconnects during `verify-startup-boundaries.mjs`,
and shard 3 waits for the old `Parameters` tab in the Engine integration Pack
authoring probe. Architecture, build and browser shards 0/2 passed; bootstrap
failed downstream. These logs selected Engine
`284f102afad1c3d33527064ecc0b84b11262e2e9`.

The merged View main contains the current Parameters contribution and Pack
authoring integration workflow. Both failing runtime paths pass against the
selected current Engine `view`; no unrelated production workaround was added.

## Paired Verification

The remote Engine `view` head and local checkout were both
`dde5e9c7a45612334000c7cc87390a26bb0146e8`. Engine files and Git state remain
unchanged. View consumes its built public exports. Engine's `tools/view`
gitlink, `e487d9b931311996fd213ee49943eb1d7c3eb1a7`, is an ancestor of this
View candidate.

- All 625 tests pass on Node 24.19.0 with the complete ordinary source command,
  including sync-harness and release tests, without a concurrency override.
- Strict package types, production Viewer/native module builds, architecture
  with zero violations, guardrail tests and `git diff --check` pass.
- Real startup boundaries pass: browser-free backend/UI startup, malformed
  Pack isolation, renderer failure, exact observation and View stop/restart.
- Real workspace experience passes: the first pointer click selects the Cube
  behind the hollow foreground mesh; direct bounds/triangle queries retain
  their distinct results and never change View selection. Camera focus,
  rollback, orbit and navigation pass. Play submits 60 frames; four reloads
  preserve the project/session and the exact independent AI run without
  replaying resources, selection or Play. No page/console errors were reported.
- The complete current Pack authoring integration probe passes, including
  Generation Parameters, unsupported-source recovery, 100 live edits,
  Generate, save/reopen, runtime-only fields and conflict detection. A temporary
  runner adapts only checkout/module/output paths for this side-by-side layout;
  the probe's assertions are unchanged and all projects/evidence stay in /tmp.

The first sandboxed source run could not open loopback ports; the complete
rerun allowed its temporary servers. Missing local type links for the newly
merged Parameters package were restored in ignored dependencies before typecheck.
Neither local setup issue required product or CI changes.

## CI Owner Action

The inherited View main workflow fixes Engine to
`635e6bce68445fc4a22c9fa9dbd8a92b5c9fa778`, before the merged triangle
picking implementation. An authorized administrator must apply
[engine-view-pin.patch](engine-view-pin.patch) to this branch, or apply it to
main and merge main here, then run ordinary build/browser/bootstrap admission.
Read-only `git apply --check` passes; the patch remains unapplied and the
workflow is identical to merged View main.

Engine #4215 and #4261 are merged into `view`. The same pin supports View #212
and #217 independently. Local paired results do not establish remote CI
acceptance against the older workflow pin. Neither PR was merged.
