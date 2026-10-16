# Landscape terrain

This scene consumes an actual Scriptable Pack with three Standard layers, a 125×125 author heightfield and sixteen 32×32 subsections. Its orange kinematic actor is a real terrain-dependent World writer. The scene freezes that writer during replacement until collision and a completed submitted-frame height query agree on the root handle.

| Command | Evidence |
|:--|:--|
| `pnpm --filter @forgeax/hello-terrain build` | Production Pack and cooked shader closure |
| `pnpm --filter @forgeax/hello-terrain smoke` | 60 ready Dawn frames per foundation/ID subject, author/physical/submitted queries and nonblack readback |
| `pnpm --filter @forgeax/hello-terrain smoke:browser` | Dev Pack fetch, browser validation, actual tape, fresh Browser pixel replay and Dawn inspect |
| `pnpm --filter @forgeax/hello-terrain smoke:worker` | Real Engine/Render Workers, 60 completed Source frames, query identity and collision proof, fresh Dawn replay |
| `node apps/hello/terrain/scripts/smoke-hmr.mjs` | Real GUID height replacements, actual writer freeze/resume, same-root retry and rejected queue submission |
| `pnpm --filter @forgeax/hello-terrain perf` | Static/moving camera cases, raw GPU timestamps, CPU update/draw/completion intervals and PNGs |

The HMR probe temporarily edits only `HEIGHT_OFFSET` in its Pack source and restores the exact original bytes in `finally`. Negative-control errors are explicit fixture evidence; ordinary capture rejects them. Performance runs require an exclusive physical-GPU interval. Correctness and heavy producers respect the shared machine coordination lock when used locally.

See the [runtime contract](../../../packages/terrain/README.md). This is the Landscape foundation; Delta Force virtual textures, streaming and biome systems remain separate stages.

`verify:normal-app` runs the normal App clock and the actual Update writer after a tool intent. It freezes 60 response submission IDs, settles the entire submission window, and validates independent author height, real terrain collision identity and collision publication. Raw timestamps describe response latency; they do not replace the separate manual-draw performance budgets or prove keyboard input.

`verify:curved-shadow` compares the actual unflattened landscape with shadows enabled and disabled, including a vertical-light heightfield with no independent caster and the original 2/255 pixel budget. `verify:fold-shadow` checks the cooked horizontal-to-slope-to-horizontal source at full LOD0, two texel phases, both graph paths and PCF3/5. `verify:receiver` retains planar, grazing and real-caster controls. These complement the effect gallery; replay equality alone is not image-quality acceptance.

## Material specialization pair

`?material=weights` and `?material=ids` select two production Cook outputs from the same pure-weight author source: 127×127 samples, four 64×64 subsections and four textured Standard layers. The original height/alpha scene remains the default. Both routes use the same scene assembly and producer-owned replacement gate, including the selected root GUID in Worker bootstrap data.

| Command | Evidence |
|:--|:--|
| `node apps/hello/terrain/scripts/material-id-evidence.mjs effects` | Forward/Deferred, LOD0/auto/LOD2/moving images, two-byte paired pixel gate, actual source closure costs, RHI controls/array lineage and fresh replay |
| `node apps/hello/terrain/scripts/material-id-browser.mjs [host\|1\|engine]` | Actual selected roots through Browser JSON/Worker paths, native capture/replay and source identity |
| `node apps/hello/terrain/scripts/material-id-evidence.mjs perf` | Three ABBA series per graph path, each 60 warmup + 60 measured frames, actual GPU coverage and CPU/completion intervals |

Use the shared physical-GPU lock for local runs. Performance has no recorder and subtracts no observer overhead; image/capture runs are separate. Original 8 ms CPU draw, 16.67 ms GPU interval union and 33.34 ms frame completion p95 budgets remain unchanged. A paired quality pass is independent of a performance-budget verdict.
