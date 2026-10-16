# Shadow workload and sampling

## Freeze the profile before comparing

Read the actual [DirectionalLight](../../../packages/render/src/components/directional-light.ts),
[filter vocabulary](../../../packages/render/src/components/directional-shadow-filter.ts),
[camera](../../../packages/render/src/components/camera.ts) and
[CSM extraction](../../../packages/render/src/render-system-extract.ts) sources.
Record effective camera-capped coverage, not only an authored maximum.

| Control | Changes | Cost/correctness checks |
| --- | --- | --- |
| Camera far and shadow distance | Receiver range and selected caster coverage | Near/far views, camera motion and missing distant/behind-camera casters |
| Cascade count and resolution per cascade | Render targets, projection precision and caster work | Actual attachments/atlas extent, memory and shadow raster timing |
| Filter and radius | Texture comparison calls and sampled footprint | Penumbra, aliasing/noise, edge clamps and temporal stability |
| Receiver bias and blending | Visible result and valid retained coverage | Grazing normals, blend overlap, acne and detached shadows |
| Dirty rect/caster retention | Work performed after light/view/scene changes | Content changes at unchanged bounds, program changes, removal and device recovery |

World units follow the authored scene scale. A light-space shadow camera depth
range is not automatically the observer-camera distance. Compare a reference
engine's actual current source/fixture and unit scale before translating its
numbers. Keep imported examples separate from this Engine's schema authority.

Increasing linear map resolution from R to 2R gives four times the texel area
per cascade; it does not imply four times total frame time. Inspect the actual
atlas/array allocation and measure the pass. Fewer receiver taps also do not
remove shadow caster rendering or CPU preparation.

## Compare filtering mechanisms

The current [PCF implementation](../../../packages/shader/src/shadow-pcf.wgsl)
owns both grid and Vogel sampling. A 5-by-5 PCF grid issues 25 comparison samples;
the fixed five-tap Vogel option issues 5. Hardware-linear comparison sampling,
radius, bias, receiver gradients and boundary handling affect their result and
cost. The call-count reduction is a mechanism fact, not an 80% frame-time claim.

Evaluate the same camera, caster set, materials, resolutions and light settings.
Keep the grid control and check an independent sampling reference, partly lit
pixels and edge/grazing views. Receiver-position rotation can trade visible
patterns for noise; inspect motion as well as still frames.

A default-profile change is separate from a fixed-quality optimization. For
example, earlier three-cascade 1024/grid-PCF captures do not qualify a later
2048/Vogel capture as A/B merely because both are called the default.

## Preserve cache coverage

A retained projection must still contain the receiver slice, blend overlap,
filter footprint, receiver bias and raster guard band. Exact matrix/coverage
reuse must respond to geometry, light and material-program changes. Scope
invalidation to affected caster/publication facts while retaining exceptional
and device-recovery paths.

Read [retention tests](../../../packages/render/src/__tests__/directional-shadow-retention.unit.test.ts)
and [shadow views](../../../packages/render/src/gpu-driven/shadow-views.ts) when
changing coverage or shared preparation. Each view retains its own frustum and
visibility even when candidate facts are shared. Publish saved raster work,
projection/claim preparation time and invalidation reasons alongside GPU timing;
a static image or cache hit count alone cannot qualify reuse.
