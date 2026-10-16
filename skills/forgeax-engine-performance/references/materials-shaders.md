# Material and shader work

## Move work to its change frequency

| Value or decision | Appropriate owner | Verify |
| --- | --- | --- |
| Authored material UV angle/offset/scale | Material upload/cook-derived ABI | CPU rounding, coefficient placement, rigid/skinned/temporal/displacement agreement |
| Material feature choice | Static author contract before cooking | Macro, parameter layout, bindings and program identity agree |
| Runtime animated numeric value | Existing uniform/storage update | Changing the value is visible without inventing a new shader variant |
| Fragment-dependent noise/derivative/receiver position | Shader evaluation | Spatial behavior remains correct; material-constant precomputation does not apply |
| Resource declaration absent from the selected graph | Compiler's active contract | No material-map UV transform/sample/decode work survives the variant |

The [coordinate writer](../../../packages/render/src/material-texture-coordinates.ts)
is shared by direct uniforms and GPU Scene rows. It evaluates trigonometry from
the f32-rounded authored angle, then the
[WGSL helper](../../../packages/shader/src/texture-coordinates.wgsl) consumes the
coefficients. Keep the packed layout derived from
[parameter schema](../../../packages/types/src/derive-paramschema.ts); changing
only one uploader or shader family produces an ABI mismatch.

CPU-precomputed UV rotation removes repeated material-constant fragment work.
It does not justify moving screen-position-dependent Vogel rotation to the CPU.
Branch-free source is useful when it removes divergent or redundant work;
retaining a cheap branch can be appropriate if it avoids much more expensive
work. Compare generated code and actual workload rather than counting `if`s. The
[bilateral AO negative case](cases/full-scene-resources-20261016.md#bilateral-ao-qualify-the-shader-operation-on-the-actual-backend)
shows fewer taps losing both local quality and GPU time, while an exact-pixel
arithmetic rewrite also failed to save GPU time.

## Static material specialization

Use `MaterialAsset.staticSwitches` or `Materials.standard({ staticSwitches })`.
The closed vocabulary and active-parameter rules live in
[static-switches.ts](../../../packages/types/src/material/static-switches.ts);
[material cooking](../../../packages/shader-compiler/src/material/cook.ts) owns
publication. Do not add a second mutable `.defines` authority.

```ts
import { Materials } from '@forgeax/engine/render';

const material = Materials.standard({
  baseColor: [0.6, 0.6, 0.6],
  roughness: 0.7,
  staticSwitches: {
    textures: false,
    clearcoat: false,
    transmission: false,
  },
});
```

This selects constant material-map values and omits the disabled layer work.
Scene lighting and environment resources still follow their own contract.
The optional BRDF layers clearcoat, sheen, anisotropy, iridescence and diffuse
transmission require explicit `true`; omitted choices compile without them even
when authored weights are nonzero. Transmission and subsurface diffusion retain
their existing declaration and pipeline policy. Other omitted/true
switches preserve eligible declarations. Choices never create missing fields.
An explicitly enabled layer remains dynamic at zero weight so it can animate.
Stock map-dependent parameters and vertex inputs follow the selected graph;
custom Surfaces retain their explicit input contract. GPU Scene material rows
use their actual published stride and 16-byte addresses, rather than padding
all materials to the canonical maximum. Keep original author declarations so
a child can override an inherited false choice; the child's selected variant must be cooked/published.
Runtime admission refuses missing or mismatched specialization.

| Inspect the active variant | Evidence |
| --- | --- |
| Active graph and parameter schema | Disabled feature parameters/defaults are removed before runtime projection |
| Macros and WGSL | Disabled material maps/layers omit their coordinate, sampling and decode execution |
| Uniform/storage layout | CPU writers, reflection, shader structs and stride derive the same contract |
| Texture/sampler publication | References used only by disabled work are absent; shared active dependencies survive |
| Shader identity | Real code/layout changes produce distinct programs; identical compiled contracts can reuse artifacts |
| Parent/child and pass routing | Root pipeline authority survives inheritance; child re-enable selects a valid published variant |
| Backend/target behavior | Real compiler validation, actual draws, maps/UVs and pixels still agree |

Use the real [specialization regression](../../../packages/shader-compiler/src/material/__tests__/material-static-switches.integration.test.ts)
and [runtime admission](../../../packages/assets-runtime/src/material/runtime-shader.ts)
paths. Shader text/layout tests establish mechanism; GPU readback and ordinary
asset loading establish rendering behavior. Measure cook/cache/package growth
as well as runtime benefit before adding many independent static choices.

For a matched compiled-WGSL example and its CPU/GPU evidence limits, read the
[compiled graph case](cases/compiled-material-pruning.md).

## Separate cold resource boundaries

| First-use stage | Evidence to collect | Preparation boundary |
| --- | --- | --- |
| Encoded/cooked asset loading | Actual GUID, selected cooked program key and readiness receipt | Asset readiness does not prove a device pipeline or decoded audio buffer exists |
| Receiver material admission | Source/epoch/revision/frame, new program key and source-fact derivation | Use the existing accepted publication owner; equal source under another key is not automatically duplicate admission |
| GPU module/pipeline creation | Exact module/program label, device generation, pass/layout and frame | Preserve layout, visual outputs and recovery; avoid all-library prewarming without an identified first-use owner |
| Host PCM decoding | Exact clip/request and prepared/rejected receipt | Prepare through the audio owner's bounded cache without a voice or fake shot |

Map a late program key back to actual mesh/material resources before choosing a
pre-Ready change. Keep arrival, accepted/submitted and completed receipts
separate. The [resource update case](cases/full-scene-resources-20261016.md#cold-boundaries-and-unexplained-time)
records a source-fact speedup and a separate PCM preparation contract; neither
establishes the cause of an unexplained picture interval.

## Attribute build cache misses to their producer inputs

Compare per-Pack keys and final hit/miss decisions, source bytes, executing
cooker/dependency bytes, Native compiler fingerprints and collected shader
namespaces. A preflight probe and the actual build can report the same Pack
twice; deduplicate by source identity before reporting a miss count.

The [project shader case](cases/full-scene-resources-20261016.md#project-shader-cache-invalidation)
shows unchanged map materials missing after one unrelated WGSL addition because
the current material cooker hashes the complete project shader namespace. Keep
that valid cold result. Narrowing requires actual entry/slot/transitive imports,
all produced variants and current catalog validation, including duplicate or
reserved module errors. Moving old entries to a new key does not establish that
proof. Runtime Render changes alone do not explain a changed cook identity.
