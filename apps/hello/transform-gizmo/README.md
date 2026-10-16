# Transform gizmo

A solid 3D helper moves, rotates and scales an editable box. The toolbar chooses
mode and coordinate space; optional snapping, a rotated nonuniform parent and an
orthographic camera make projection and hierarchy behavior directly testable.
Escape, pointer cancellation, capture loss and window blur restore the drag-start
pose. Canvas resize keeps physical pointer coordinates and projection in sync.

| Command | Evidence |
|:--|:--|
| `pnpm --filter @forgeax/hello-transform-gizmo dev` | Interactive scene |
| `pnpm --filter @forgeax/hello-transform-gizmo build` | Production bundle and shader manifest |
| `pnpm --filter @forgeax/hello-transform-gizmo smoke` | Real Dawn frames, RGB overlay coverage in all modes, transform writeback and cleanup |
| `pnpm --filter @forgeax/hello-transform-gizmo smoke:browser` | Actual pointer drags, screenshots and two rounds of resource transitions, after at least 60 completed frames |
| `pnpm --filter @forgeax/hello-transform-gizmo verify:performance` | Same interaction checks plus two paired rounds of 30 warmup + 180 CPU/GPU samples per phase and 10000 hit tests |
| `pnpm --filter @forgeax/hello-transform-gizmo verify:rhi` | Captured GPU matrices/material slots, retained geometry, fresh-device replay and live/replay pixels |

The scripts start and stop their own Vite Host. To reuse an explicit Host, set
`GIZMO_URL` and enable capture when starting Vite: `FORGEAX_ENGINE_RHI_DEBUG=1 pnpm --filter
@forgeax/hello-transform-gizmo dev --port 5199 --strictPort`. Run verification
scripts from the repository root. `GIZMO_EVIDENCE_DIR` selects the output folder;
`GIZMO_MODE=translate|rotate|scale` selects an RHI capture. The RHI script transfers
compressed tape chunks to avoid serializing large shadow snapshots through
DevTools network request bodies; decoding and replay consume the original v7
bytes and validate their digest.

Dawn defaults to 60 requested completed frames, with additional warmup/cleanup
frames reported separately in its receipt. `GIZMO_FALSIFY=1` removes the overlay
and must fail RGB/changed-pixel assertions. Static pixel comparison uses identity
alignment and ε≤0.05 for whole-frame mean, covered mean and every RGB channel.
Hardware performance reports identify the adapter, output size, warmup and sample
count. Software GPU pixels are correctness evidence only.
Long hardware measurements are explicit: `verify:performance`, or
`GIZMO_PERF_FRAMES=180 node apps/hello/transform-gizmo/scripts/smoke-browser.mjs`.
The ordinary 300-second CI smoke keeps every interaction/resource assertion and
the 60-frame minimum, without a hardware benchmark soak.

See the [public interaction contract](../../../packages/interaction/README.md)
for supported constraints, hierarchy boundaries and recovery states.
