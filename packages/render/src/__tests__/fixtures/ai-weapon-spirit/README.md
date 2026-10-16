# ai-weapon-spirit material regression fixture

Frozen on 2026-09-09 from the consumer working tree, including its uncommitted
0.1.25 migration. The WGSL files are verbatim copies, not approximations.
Tests use this local closure and never read the consumer checkout.

| Source file in ai-weapon-spirit | SHA-256 |
|:--|:--|
| `src/shaders/low-poly-toon.wgsl` | `ebdd63714683f2178a973d9392911bd0d5e607ad1df198a0c3b70f277c34b371` |
| `src/shaders/includes/painterly-surface.wgsl` | `48573786f86c3b6be1d5231797ed77b2206c54563f83d8edc6f597575805f1bb` |

The root parameter layout is the game's 11-field Toon contract (80 bytes).
The fixture exercises its migrated same-module Forward + ShadowCaster path,
and the intended Toon Forward + Engine ShadowCaster composition. Child values
include emissionStrength=0, pigmentStrength=0, surfaceMetallic=0 and sideShade=0.84.
A successful cook is only the compiler checkpoint: the runtime regression must
also submit real WebGPU draws, inspect validation errors and prove shadow pixels.

Source feedback: Engine Harness `2026-09-09-engine-025-material-contract-composition`,
especially cases D (child scalar decoding) and E (shadow material bind group).
