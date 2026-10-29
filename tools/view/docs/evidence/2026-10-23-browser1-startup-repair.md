# Browser Shard 1: Detached Startup Probe

## Later Qualification

Run `39894141134` passes the entire startup probe and logs inherited `CI=true`.
The EOF injection below demonstrates a real exit path, but does not independently
prove the cause of the original remote exit. That later run instead exposes
the removed Content Browser Dock-tab selector in browser shards 0, 1 and 2.
Those probes now use the existing `presentation.panel.reveal` action and retain
both the returned visibility fact and the DOM visibility assertion.

The branch was subsequently rebased onto View main `8c87c3f`, with every check
passing in run `39898018097`, and then refreshed onto main
`3a189f9a59467193b9f27e86eebeeb8feb873798` after overlapping #234 landed.
Run `39901485116` then passed all checks (one GPU-device-loss retry), before a
final refresh onto main `45f99020463f20d16785076a1420675c3ed57d6c` adopted #235's
workspace-client probe and Pack draft binding fix. The redundant panel-probe
patch is now upstream rather than a separate branch change.
Both rebases preserve these repairs and the
upstream frame-progress changes. CI now follows Engine `view` and shares its
resolved build SHA with all browser shards. The fixed-pin handoff referenced
below is historical, not a current CI owner action.

## Original Audit

Run `39785269779`, View head `ed34a341a840865d03d6e5b8a8622c9b20aa9bda`,
fails in `verify-startup-boundaries.mjs` while opening the malformed-Pack
fixture. Its Engine pin is `635e6bce68445fc4a22c9fa9dbd8a92b5c9fa778`.
The client receives `host-transport-failure` for `host/socket`; the backend log
ends after Pack diagnostics and Vite's alias warning, without an exception or
the native backend's normal disposal trace. The other browser shards, build
and architecture pass; bootstrap fails downstream.

## Reproduced Exit Path

The unchanged probe passes locally with Node 24 and CI's Node 22.22.3,
including the CI diagnostic frontend build. A controlled stdin EOF injection
with `CI=1` reproduces the same failure at the same startup stage. The captured
exit stack identifies Vite's `ReadStream.parentSigtermCallback` and
`closeServerAndExit`: Vite installs its interactive stdin shutdown listener
unless `process.env.CI` is exactly `"true"`.

The probe launches a detached native backend with ignored stdin. It now sets
`CI=true` while starting that child and restores its caller's original value
afterwards. Browser availability faults remain scoped exactly as before. The
backend retains the noninteractive setting for later project server creation.
No Engine file, workflow, candidate-selection rule, timeout or assertion changes.

The original remote artifact does not record the inherited CI value, so it
does not independently establish that value. The repaired probe logs both the
inherited and selected values and reports its current stage/backend status on
failure, retaining evidence for any distinct failure on the new head.

## Verification

- Node 22.22.3, CI diagnostic frontend build and the controlled EOF injection:
  before repair, the backend exits and the transport fails; after repair, all
  original startup assertions pass.
- The committed fault preload `test/support/startup-stdin-eof.mjs` also passes
  the complete real probe with inherited `CI=1` after repair.
- The complete 625-test source suite passes without skips or concurrency changes.
- `git diff --check` passes.

Example regression command from the View root:

```sh
CI=1 NODE_OPTIONS=--import=./test/support/startup-stdin-eof.mjs \
  node scripts/verify-startup-boundaries.mjs
```

Local runtime verification uses built public Engine exports from the unchanged
checkout at `dde5e9c7a45612334000c7cc87390a26bb0146e8`. The current remote
Engine `view` head was also resolved as
`a96224c15d2e8c5a489b601583af2d6802102825`; no local alignment with that newer
commit is claimed. Remote qualification must be read from the repaired head.

The existing older Engine pin also lacks triangle target picking, which the
later workspace experience probe requires. That separate CI owner action
remains documented in the [previous handoff](2026-10-22-pr-212-check-repair/README.md).
The startup probe repair does not suppress or bypass that later dependency gate.
