> Historical validation: the local Actions emulator described below was retired on October 13. Use `pnpm ci:focus --kind <kind> --select <selector>` for current local reproduction.

# TencentOS local graphics and game CLI validation

> [!IMPORTANT]
> These are local software-rendering results from TencentOS 4.4 (Linux x64,
> glibc 2.38), using base commit `ec9ff334d` plus the uncommitted
> `fix/tencentos-local-ci` changes. They do not establish hardware GPU support,
> native macOS/Windows acceptance, or a green complete CI workflow.

## Changes and ownership

| Concern | Authority |
|:--|:--|
| Isolated Mesa/LLVM installation | `local-graphics.lock.json` owns archive hashes and installed library paths; `ci:graphics setup` installs into a lock-addressed user cache. |
| Vulkan ICD selection | `resolve-lavapipe-icd.mjs` is used directly by the workflow and local runner. Conflicting or missing explicit ICDs fail. |
| Browser CI launch profile | `browser-launch.json` is shared by the real capability probe and Vitest browser project. |
| Local job graph | `ci:local` projects `.github/workflows/ci.yml`; dry runs report PLAN and never claim test PASS. |
| CLI browser discovery | Resource capture/replay reuse DevKit's existing executable resolver, with Linux, macOS and Windows installation candidates. Explicit channel selection remains authoritative. |
| CLI output | Global `--json` reaches owners declaring that input, including `--input` requests; real `project preview` stdout is one parseable JSON envelope. |

The original system Mesa 23.1.4 path failed with
`Vulkan shaderUniform*ArrayDynamicIndexing required`. The isolated Mesa 25.2.8 /
LLVM 20.1.2 path reports Mesa / software / llvmpipe in Dawn. Chrome Beta
155.0.8059.5 reports Google / SwiftShader: setting a Lavapipe ICD does not prove
that Chrome selected it. Both probes draw, complete the queue, check validation,
and read `[64, 128, 191, 255]` from the real render target.

## Local gates

| Gate | Result |
|:--|:--|
| Fresh setup and repeated setup | PASS; archive hashes checked, system packages untouched by the installer. |
| Dawn and Browser capability probes | PASS; software adapter identity and pixel readback recorded. |
| Child failure propagation | PASS; requested command exit 37 remains exit 37. |
| CI execution/process lifecycle regression | PASS; 251 tests. |
| Local graphics / local workflow regression | PASS; 20 tests. |
| SDK/nightly workflow contracts | PASS; 28 tests. |
| DevKit complete tests | PASS; 298 tests across 66 files. |
| DevKit typecheck and build | PASS. |
| Lint, CI channel alignment, test layout | PASS; existing lint warnings remain. |
| Hello Triangle | PASS; 300 frames, pixels and completion receipt; frame loop 3,965 ms. |
| Focused browser depth comparison | PASS; real WebGPU depth32float comparison. |
| Complete Dawn | PASS; `pnpm test:dawn`, exit 0, 3,249,198 ms (54m09s). |
| Complete Browser | FAIL; group 23 stopped on the 15s GPU timing falsifier deadline after groups 1-22 passed; exit 1, 2,762,676 ms. |
| Focused GPU timing Browser rerun | PASS; all 3 tests with the original timeouts and assertions. |
| Browser groups 23-29 diagnostic continuation | FAIL; original groups 23-26 passed, group 27 exceeded its 300s bound on both attempts; exit 1, 1,214,963 ms. Groups 28-29 were selected separately afterward. |
| Browser original groups 28-29, separate diagnostic | FAIL; group 28 exceeded its 300s process bound on both attempts; exit 1, 604,458 ms. Group 29 was subsequently covered by an independent selection. |
| Browser original group 29, separate diagnostic | PASS; 4 executed files / 13 tests from the original 5-file selection; exit 0, 20,148 ms. |
| Complete CI workflow / complete hello and learn-render smoke fleet | Not run. Local workflow graph was dry-run validated. |
| Additional CI source contracts | 48 pass / 14 fail; the same 14 failures occur when changed contract inputs are read from base HEAD. These pre-existing contract discrepancies remain unresolved. |

The Dawn time is one local full-command observation with other verification work
running concurrently, not CI queue-to-terminal or P95 performance evidence. It
exceeds the 30-minute delivery target; no timeout or roster was reduced.

The additional source-contract comparison replaces only reads of the changed
workflow/config/package files with `git show HEAD:<path>` bytes, leaving test
assertions unchanged. It is a focused baseline diagnostic, not a complete
baseline build. Its reproducer is retained with the local evidence.

The browser failure is
`packages/render/src/__tests__/gpu-pass-timing.browser.test.ts`:
`keeps raster suppression as a test-only falsifier, never timing evidence`.
The full run exceeded its 15,000 ms test deadline at 15,184 ms; the isolated
three-test rerun passed in 20,890 ms total test time. The original eight-file
group also passed all 13 tests on diagnostic rerun. No timeout, assertion, or
retry classifier was changed. The remaining file selection is derived from the
existing split runner's dry-run plan, preserved as `browser-plan.txt` and
`browser-tail-files.json` in the evidence directory.

The continuation also exposed a repeated timeout in
`packages/runtime/src/__tests__/surface-standard-pipeline.browser.test.ts`:
`loads one published tuple per GUID and renders every cell through Runtime Renderer`.
Both attempts exceeded the original 120,000 ms test deadline (121,086 ms and
121,113 ms), then reached the 300,000 ms group bound. The existing runner
reclaimed both private process groups. This remains an unresolved failure;
neither capability preflight nor passing other groups establishes its cause.

The original group 28 (six Runtime wave1/material files plus the UI capture
determinism and host guard files) also reached the 300,000 ms process bound on
both attempts without a terminal test summary. Its runner reclaimed both process
groups and exited 1. The separate final group passed; it does not fill the
unresolved coverage in groups 27-28. Exact selections and terminal output are
preserved in `browser-final-files.json`, `browser-final.log`, and
`browser-last-group.log`.

These direct `pnpm test:browser` runs use the default local stability windows.
The workflow declares its own lightweight, fixed-smoke, viewport, settle-frame,
and on-demand pack settings; `ci:local` projects those settings from the workflow.
Consequently these direct runs are not measurements of the exact workflow job.
Other worktrees were also running tests on this host; `host-load.txt` preserves
a late-run snapshot. No isolated-host performance conclusion is inferred.

## `templates/game-3d` CLI acceptance

The fixture `/tmp/forgeax-tencentos-game-3d` contains the tracked source template
and uses `project engine use-local` to bind this worktree's built packages.
Its template test/typecheck scripts were retained under `test:template` and
`typecheck:template` before `project init`, which correctly rejects conflicting
scripts. This is source-development acceptance; SDK ZIP installation and
`project new` were not exercised.

| Operation | Result |
|:--|:--|
| Help discovery, project init/check, local Engine binding/check | PASS. |
| Asset list/inspect/resolve and verify after build | PASS; 33 cooked assets and ready GUID resolution. |
| Project test | PASS; 15 tests across 5 files. |
| Project build and Web ZIP package | PASS; static package produced. |
| Project preview | PASS; real static server, UI visible, submitted frames advance without page/console errors. |
| Dev start/status/find/focus | PASS. |
| Dev camera get/set/release, reload, stop | PASS. |
| Dev eval | PASS; reports the actual healthy execution/world state. |
| Dev capture, main and Engine Worker | PASS; both screenshots visually inspected. |
| Keyboard movement through the served game | PASS; W changes the player position and advances FixedTick. This is not the full collision journey. |
| Material preview (`material/rusted-iron`) | PASS; real capture and fresh replay have identical PNG digests. |
| Static mesh preview (`mesh/cube`) | PASS; subject/oracle binding, capture and fresh replay. |
| Skinned mesh preview (`mesh/player`) | FAIL; retained below. |

The Web ZIP is `/tmp/forgeax-tencentos-game-3d/release/game-3d-web.zip`,
30,571,393 bytes, SHA-256
`b93ec38f08a1ccb812a34ac0b9fc77d6bcc8949406827480d5b4299306dedcd3`.

### Remaining mesh-preview failure

The player mesh's authored materials select `forgeax::pbr-skin`, but standalone
resource preview spawns only Transform, MeshFilter and MeshRenderer. Browser
validation rejects `@group(2) @binding(1)` against `pbr-mesh-array-bgl` while
creating the skin pipeline. The same character renders correctly in its authored
game scene, which supplies Skin and joint bindings. This failure is not evidence
of a TencentOS-specific driver defect.

```bash
FORGEAX_SHARED_APP_INPUTS_MANIFEST="$PWD/shared-build-inputs/manifest.json" \
node packages/engine/dist/bin/forgeax.mjs asset preview \
  --root /tmp/forgeax-tencentos-game-3d --kind mesh \
  --guid 68903716-4867-5019-8f4e-cb0b30d7b90a \
  --backend software --headless true --width 640 --height 480 --json
```

The owning follow-up is a generic skinned resource-preview contract, including
its pose/skeleton authority, plus a real browser regression. No shader validation
was disabled and no template material or mesh was substituted to conceal this
failure.

## Evidence

Local evidence is retained under
[`artifacts/tencentos-local-ci`](../../artifacts/tencentos-local-ci/), with
per-command JSON in `cli/`, screenshots, and command logs in `logs/`.
These artifacts and the temporary game fixture are local verification output,
not committed distribution inputs.

The first broad DevKit attempt encountered a pre-existing `/tmp/node_modules`
link to another worktree. Repeating with short, isolated
`TMPDIR=/var/tmp/forgeax-ci-tests` and the prepared shared-input manifest removed
that contamination without changing assertions. A long temporary directory was
also rejected by Chrome's Unix socket path limit; the short path resolves that
host constraint.
