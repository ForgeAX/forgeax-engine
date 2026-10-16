# Instances ownership and September regression audit

## Scope and historical evidence

The audit baseline is Engine `609da6822097c22cfdfb35a0e58e3dc4e5af73ea`.
The primary target is [September 12 commit 46cb8923e](https://github.com/ForgeaX-Games/forgeax-engine/commit/46cb8923eef3852c89a86de4270a7a0bc3e49f33)
([PR #3008](https://github.com/ForgeaX-Games/forgeax-engine/pull/3008)).
Dates below are Beijing time.

| Time | Change | Effect |
|:--|:--|:--|
| September 8, 15:09 | [#3056](https://github.com/ForgeaX-Games/forgeax-engine/pull/3056), `f37209f3a` | Replaced World matrix authoring with Renderer-owned collection IDs |
| September 8, 23:33 | [#3072](https://github.com/ForgeaX-Games/forgeax-engine/pull/3072), `0e3ca9366` | Included the World-ownership correction developed in #3071 |
| September 9, 00:33 | [#3071](https://github.com/ForgeaX-Games/forgeax-engine/pull/3071) | Explicitly restored renderer-independent Scene/glTF authoring and large managed-array allocations |
| September 12, 07:54 | #3008, `46cb8923e` | Reintroduced collection IDs, removed the ownership regression test and removed two skin-palette invariants |

The September 12 change spans 341 files. This repair is not a wholesale revert:
GPU-driven PBR, shadow and skinning features and subsequent valid changes remain.
History proves that earlier fixes were overwritten; it does not establish an
individual author's intent or explain iPhone jetsam.

## Confirmed defects and permanent regressions

| Defect | Reproduction | Repair and gate |
|:--|:--|:--|
| Scene/glTF instance layouts require a live Renderer ID | World rejects `Instances.transforms`; the pure glTF bridge omits Instances without a caller-provided ID map | Restore World-owned arrays; [ownership test](src/__tests__/instances-world-ownership.integration.test.ts), [Scene roundtrip](../runtime/src/__tests__/instances-scene-roundtrip.unit.test.ts), existing glTF and picking tests |
| Recycled skin slices exceed the fixed dynamic binding window | Retire a 255-joint allocation, split it into two one-joint slices: second offset 256 + window 16320 exceeds buffer size 16320 | Check the complete binding window before consuming a free range; [unit invariants](src/__tests__/skin-motion-regression.unit.test.ts), [real Dawn submission/readback](src/__tests__/skin-palette-recycling.dawn.test.ts) |
| Instance allocation failure silently draws one identity instance | Inject a failed RHI buffer allocation into the real direct instance resolver; it returns a one-instance fallback draw | Fail closed; [allocation-failure gate](src/__tests__/instance-allocation-failure.unit.test.ts) |

The first two are verified overwritten fixes. The third is an adjacent current
failure discovered while checking recovery; its introduction is not attributed
to September 12 without separate historical proof.

The old uniform-palette isolation test also disappeared. Its invariant already
holds under the current persistent allocator; the test is restored using that
API, not the deleted historical allocation API.

## Design conformance

Relevant design authorities are the GPU Scene design (2026-08-12), GPU-driven
PBR/shadow/skinning expansion, and current World-state projection design
(2026-09-18) in the Engine harness. The requested exception is public
Renderer-owned instance authoring. Their other ownership and timing boundaries
remain in force; the current [Render contract](README.md#world-owned-instances-and-cpu-bounds)
documents the implemented public surface.

| Boundary | Implemented rule |
|:--|:--|
| Author facts | `Instances.transforms` is the sole World/Scene matrix input; no game binding plugin, public collection lifecycle or persisted runtime ID |
| CPU projection | Renderer-private detached snapshots, keyed by full World/entity identity; accepted only after RenderScene applies prepared changes |
| Changes | Existing ECS current-state/version evidence drives extraction; no restored structural journal, manual shared-ref marker or stable-frame full matrix scan |
| Submission | GPU Scene and direct fallback consume the same accepted source; current persistent skin receipts, shadow identities and Surface paths remain |
| GPU residency | Upload state is distinct from CPU acceptance and successful submission; fresh/recovered buffers receive complete content |
| Recovery | Retained CPU state seeds candidate-owned resources; no World rescan, old-device GPU handles or second recovery owner; fully GPU-owned frames do not preallocate legacy instance buffers |
| Lifetime | Repeated Scene instantiation is independent; removal/unload retires the projection; renderer disposal never destroys authored World data |

An additional red/green regression in
[mixed projection updates](src/__tests__/render-scene-mixed-updates.integration.test.ts)
throws after partial extraction and verifies that inspection does not publish
the failed candidate. This protects the new implementation's acceptance boundary.
The retained CPU projection is a necessary copy; this change does not claim
zero-copy matrices or measured iPhone memory improvement.

## Recent-history sweep

The sweep inspected first-parent history since September 6, using August 1
history as the earlier file-blob baseline. Exact returns to an older blob are
only candidate signals: 148 events were found, of which 42 still matched the
audit baseline. Partial-file changes and deleted tests were also inspected in
the primary September 12 diff. This is a bounded regression audit, not proof
that every recent PR is defect-free.

| Candidate group | Disposition |
|:--|:--|
| #3072 ECS errors and array-vocabulary gates | Intentional restoration of World ownership; preserve |
| #3008 Instances and skin-palette tests | Confirmed defects repaired above |
| #3008 mesh-buffer usage surface | Adds shadow-pass coverage; preserve |
| #3008 UV layout and animated glTF bounds | Legitimate owner-level derivation and conservative animated bounds; preserve |
| #3008 asset watcher test | Adds real add/change/unlink and startup batching coverage; no owning watcher implementation was reverted in that commit |
| #3136 temporal topology test | Removes ancestry/symbol assertions while retaining semantic topology gates; do not reinstate historical implementation restrictions over later TAAU |
| #3202 Probe changes | Explicit revert of #3194, not an unexplained overwrite; preserve the deliberate revert and later Surface work |
| `3c7153509` physical-material evidence | Manifest/evaluator return to v5 and the checked reference is also v5/r5; no mixed-reference version reproduced |
| #3253 canonical cook receipt | Generated receipt matches earlier output; not evidence of a source-behavior regression |

## Verification boundaries

Focused gates cover 1500/10000/20000 World-authored instances, skipped updates
across independent Renderers, Scene save/JSON/native-load/fresh-World roundtrip,
duplicate Scene instantiation, picking, empty layouts, visibility, temporal
identity, removal and renderer recovery. Existing instance Browser/Dawn tests
continue to exercise real submission and pixels, including uniform chunking.

Required delivery gates remain the full Hello/Learn-render 60-frame smoke
roster, `pnpm test:browser`, `pnpm test:dawn`, relevant unit/type/lint gates and
complete latest-head PR CI. Their run results belong to the PR checks; this
document is not a substitute for those results. Software GPU evidence is not
physical iPhone evidence. Studio UI save/reopen and iPhone jetsam acceptance
are separate downstream checks, not claimed by the Engine unit roundtrip.
